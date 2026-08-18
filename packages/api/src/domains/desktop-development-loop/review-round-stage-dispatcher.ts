import { createHash } from 'node:crypto';
import { buildFeatureWorkspaceThreadId, type CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ReviewRoundDisplayContext } from './review-round-display-context.js';

export type ReviewRoundDispatchStage = 'independent' | 'cross_review' | 'consensus';

export interface ReviewConsensusAuthorizationContext {
  readonly instruction: string;
  readonly authorizedByUserId: string;
  readonly authorizedAt: number;
}

export interface ReviewRoundDispatchInput {
  readonly stage: ReviewRoundDispatchStage;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly reviewHubThreadId: string;
  readonly roundId: string;
  readonly exactSha: string;
  /** Reviewers who should be invoked by this delivery. */
  readonly reviewerCatIds: readonly CatId[];
  /** Complete reviewer roster, including reviewers already finished. */
  readonly allReviewerCatIds?: readonly CatId[];
  readonly completedReviewerCatIds?: readonly CatId[];
  readonly recorderCatId: CatId;
  readonly displayContext?: ReviewRoundDisplayContext;
  /** Current F275 version to use when publishing consensus after an evidence mutation. */
  readonly managedWorkVersion?: number;
  /** Explicit user ruling for a consensus stage that could not otherwise converge. */
  readonly consensusAuthorization?: ReviewConsensusAuthorizationContext;
  /** Server-derived retry identity. Omitted for the first canonical delivery. */
  readonly deliveryKey?: string;
}

export interface IReviewRoundStageDispatcher {
  dispatch(input: ReviewRoundDispatchInput): Promise<void>;
}

interface MessageIngressRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly payload: {
    readonly content: string;
    readonly threadId: string;
    readonly idempotencyKey: string;
    readonly messageDisposition: 'next_work';
    readonly serverAuthoredKind: 'review_orchestration';
  };
}

interface MessageIngressResponse {
  readonly statusCode: number;
  readonly body: string;
}

export interface ReviewRoundStageDispatcherDeps {
  readonly sendMessage: (request: MessageIngressRequest) => Promise<MessageIngressResponse>;
  readonly resolveMentionHandle: (catId: string) => string | null;
}

interface ReviewRoundStageDispatcherOptions {
  readonly redis?: RedisClient;
  readonly recoveryIntervalMs?: number;
}

interface PendingReviewStageDispatch {
  readonly version: 1;
  readonly input: ReviewRoundDispatchInput;
  readonly recoveryAttempts: number;
}

type DeliveryOutcome = 'delivered' | 'queued' | 'recovery_started';

const PENDING_SET_KEY = 'desktop-development:pending-review-stage-dispatches';
const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 3;

/**
 * Sends server-authored review work through canonical message ingress while
 * preserving explicit orchestration provenance and durable retry intent.
 */
export class ReviewRoundStageDispatcher implements IReviewRoundStageDispatcher {
  private readonly redis?: RedisClient;
  private readonly active = new Map<string, Promise<void>>();
  private readonly latestDispatchByThread = new Map<string, string>();

  constructor(
    private readonly deps: ReviewRoundStageDispatcherDeps,
    options: ReviewRoundStageDispatcherOptions = {},
  ) {
    this.redis = options.redis;
    if (this.redis && options.recoveryIntervalMs !== 0) {
      const interval = setInterval(
        () => void this.recoverPendingDispatches().catch(() => undefined),
        options.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS,
      );
      interval.unref();
      queueMicrotask(() => void this.recoverPendingDispatches().catch(() => undefined));
    }
  }

  dispatch(input: ReviewRoundDispatchInput): Promise<void> {
    assertDisplayContext(input.displayContext);
    const dispatchId = deterministicMessageId(input.roundId, input.stage, input.deliveryKey);
    const previous = this.active.get(dispatchId) ?? Promise.resolve();
    const delivery = previous
      .catch(() => undefined)
      .then(async () => {
        await this.activateLatestDispatch(dispatchId, input);
        await this.persistAndDeliver(dispatchId, input);
      })
      .finally(() => {
        if (this.active.get(dispatchId) === delivery) this.active.delete(dispatchId);
      });
    this.active.set(dispatchId, delivery);
    return delivery;
  }

  async recoverPendingDispatches(): Promise<void> {
    if (!this.redis) return;
    const dispatchIds = await this.redis.smembers(PENDING_SET_KEY);
    for (const dispatchId of dispatchIds) {
      if (this.active.has(dispatchId)) continue;
      try {
        await this.recoverPendingDispatch(dispatchId);
      } catch {
        // The record remains durable for the next bounded recovery pass.
      }
    }
  }

  private async recoverPendingDispatch(dispatchId: string): Promise<void> {
    if (!this.redis) return;
    const raw = await this.redis.get(this.pendingKey(dispatchId));
    if (!raw) {
      await this.redis.srem(PENDING_SET_KEY, dispatchId);
      return;
    }
    const pending = parsePendingDispatch(raw);
    if (!(await this.isLatestDispatch(dispatchId, pending.input))) {
      await this.clearPending(dispatchId);
      return;
    }
    const recoveryAttempt =
      pending.recoveryAttempts < MAX_AUTOMATIC_RECOVERY_ATTEMPTS ? pending.recoveryAttempts + 1 : undefined;
    const outcome = await this.deliver(dispatchId, pending.input, recoveryAttempt);
    if (outcome === 'delivered') {
      await this.clearPending(dispatchId);
    } else if (outcome === 'recovery_started' && recoveryAttempt !== undefined) {
      await this.persistPending(dispatchId, { ...pending, recoveryAttempts: recoveryAttempt });
    }
  }

  private async persistAndDeliver(dispatchId: string, input: ReviewRoundDispatchInput): Promise<void> {
    if (this.redis) {
      await this.persistPending(dispatchId, { version: 1, input, recoveryAttempts: 0 });
    }
    try {
      const outcome = await this.deliver(dispatchId, input);
      if (outcome === 'delivered') await this.clearPending(dispatchId);
    } catch (error) {
      if (!this.redis) throw error;
    }
  }

  private async deliver(
    dispatchId: string,
    input: ReviewRoundDispatchInput,
    recoveryAttempt?: number,
  ): Promise<DeliveryOutcome> {
    const targetCatIds = input.stage === 'consensus' ? [input.recorderCatId] : input.reviewerCatIds;
    const handles = new Map<string, string>();
    for (const catId of new Set([...(input.allReviewerCatIds ?? input.reviewerCatIds), ...targetCatIds])) {
      const handle = this.deps.resolveMentionHandle(catId);
      if (!handle) throw new Error(`Review dispatcher has no mention handle for reviewer ${catId}`);
      handles.set(catId, handle);
    }
    const routing = targetCatIds.map((catId) => handles.get(catId) as string);
    const response = await this.deps.sendMessage({
      headers: {
        'x-cat-cafe-user': input.ownerUserId,
        ...(recoveryAttempt !== undefined ? { 'x-cat-cafe-review-recovery-attempt': String(recoveryAttempt) } : {}),
      },
      payload: {
        content: buildStageMessage(input, routing, handles),
        threadId: input.reviewHubThreadId,
        idempotencyKey: dispatchId,
        messageDisposition: 'next_work',
        serverAuthoredKind: 'review_orchestration',
      },
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Review dispatcher message ingress failed (${response.statusCode}): ${response.body}`);
    }
    const responseStatus = parseIngressStatus(response.body);
    if (response.statusCode === 202 || responseStatus === 'queued' || responseStatus === 'recovery_started') {
      return responseStatus === 'recovery_started' ? 'recovery_started' : 'queued';
    }
    return 'delivered';
  }

  private async activateLatestDispatch(dispatchId: string, input: ReviewRoundDispatchInput): Promise<void> {
    this.latestDispatchByThread.set(input.reviewHubThreadId, dispatchId);
    if (!this.redis) return;
    await this.redis.set(this.latestKey(input.reviewHubThreadId), dispatchId);

    const pendingIds = await this.redis.smembers(PENDING_SET_KEY);
    for (const pendingId of pendingIds) {
      if (pendingId === dispatchId) continue;
      const raw = await this.redis.get(this.pendingKey(pendingId));
      if (!raw) {
        await this.redis.srem(PENDING_SET_KEY, pendingId);
        continue;
      }
      try {
        const pending = parsePendingDispatch(raw);
        if (pending.input.reviewHubThreadId === input.reviewHubThreadId) await this.clearPending(pendingId);
      } catch {
        // Preserve an unparseable record for the normal recovery path to diagnose/retry.
      }
    }
  }

  private async isLatestDispatch(dispatchId: string, input: ReviewRoundDispatchInput): Promise<boolean> {
    const latest = this.redis
      ? await this.redis.get(this.latestKey(input.reviewHubThreadId))
      : this.latestDispatchByThread.get(input.reviewHubThreadId);
    return latest === undefined || latest === null || latest === dispatchId;
  }

  private async persistPending(dispatchId: string, pending: PendingReviewStageDispatch): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(this.pendingKey(dispatchId), JSON.stringify(pending));
    await this.redis.sadd(PENDING_SET_KEY, dispatchId);
  }

  private pendingKey(dispatchId: string): string {
    return `desktop-development:review-stage-dispatch:${dispatchId}`;
  }

  private latestKey(reviewHubThreadId: string): string {
    const digest = createHash('sha256').update(reviewHubThreadId).digest('hex');
    return `desktop-development:review-stage-latest:${digest}`;
  }

  private async clearPending(dispatchId: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(this.pendingKey(dispatchId));
    await this.redis.srem(PENDING_SET_KEY, dispatchId);
  }
}

function buildStageMessage(
  input: ReviewRoundDispatchInput,
  routingHandles: readonly string[],
  allHandles: ReadonlyMap<string, string>,
): string {
  const context = input.displayContext as ReviewRoundDisplayContext;
  const planThreadId =
    context.planThreadId || buildFeatureWorkspaceThreadId(input.projectId, context.backlogItemId, 'plan');
  const routing = routingHandles.join('\n');
  const roster = input.allReviewerCatIds ?? input.reviewerCatIds;
  const completed = new Set(input.completedReviewerCatIds ?? []);
  const target = new Set(input.stage === 'consensus' ? [input.recorderCatId] : input.reviewerCatIds);
  const participants = roster
    .map((catId) => {
      const displayName = (allHandles.get(catId) ?? catId).replace(/^@/, '');
      const state = participantState(input.stage, catId, input.recorderCatId, completed, target);
      return `- ${displayName}：${state}`;
    })
    .join('\n');
  const completedCount = completed.size;
  const identity = [
    `【Review 系统消息｜${context.projectName} · ${context.featureId} ${context.featureTitle}】`,
    '',
    `阶段：${stageTitle(input.stage)}`,
    `检视对象：${context.projectName} 项目的 ${context.featureId}「${context.featureTitle}」`,
    `仓库：${context.repository}`,
    `权威方案会话：${planThreadId}`,
    `实现尝试：Attempt #${context.attemptNumber}`,
    `精确提交：${input.exactSha}`,
    ...(input.managedWorkVersion === undefined ? [] : [`Managed work version：${input.managedWorkVersion}`]),
    progressLine(input.stage, completedCount, roster.length),
    '',
    '本阶段参与者：',
    participants,
  ].join('\n');
  const authorization = input.consensusAuthorization
    ? [
        '【用户共识裁决授权】',
        `授权人：${input.consensusAuthorization.authorizedByUserId}`,
        `授权时间：${new Date(input.consensusAuthorization.authorizedAt).toISOString()}`,
        '裁决意见：',
        input.consensusAuthorization.instruction,
        '',
        '执行规则：',
        '1. 用户已介入并授权你以此裁决解决本轮 reviewer 分歧。',
        '2. 不再引入新 reviewer，不再等待 drafts 自行收敛。',
        '3. 直接将用户裁决映射为最终 findings/verdict，并立即调用 cat_cafe_review_consensus_publish。',
        '4. 仍须绑定本消息中的 Review Round、精确 SHA 与权威方案；不得修改代码、合并、推送或部署。',
      ].join('\n')
    : null;
  return `${routing}\n${identity}\n\n${authorization ? `${authorization}\n\n` : ''}${stageInstructions(input.stage, Boolean(authorization))}\n\nReview Round：${input.roundId}`;
}

function stageTitle(stage: ReviewRoundDispatchStage): string {
  if (stage === 'independent') return '独立检视';
  if (stage === 'cross_review') return '交叉检视';
  return '共识整理';
}

function stagePendingLabel(stage: ReviewRoundDispatchStage): string {
  if (stage === 'independent') return '等待独立检视';
  if (stage === 'cross_review') return '等待交叉检视';
  return '负责共识整理';
}

function participantState(
  stage: ReviewRoundDispatchStage,
  catId: CatId,
  recorderCatId: CatId,
  completed: ReadonlySet<CatId>,
  target: ReadonlySet<CatId>,
): string {
  if (stage === 'consensus') return catId === recorderCatId ? '负责共识整理' : '已完成交叉检视';
  if (completed.has(catId)) return '已完成';
  return target.has(catId) ? stagePendingLabel(stage) : '等待';
}

function progressLine(stage: ReviewRoundDispatchStage, completed: number, total: number): string {
  if (stage === 'independent') return `独立检视进度：${completed} / ${total}`;
  if (stage === 'cross_review') return `独立检视：${total} / ${total} 已完成\n交叉检视进度：${completed} / ${total}`;
  return `独立检视：${total} / ${total} 已完成\n交叉检视：${total} / ${total} 已完成`;
}

const VISIBLE_REVIEW_REPORT_CONTRACT = [
  '面向用户的 Review 输出格式（强制，GPT 与 Kimi 共用同一模板）：',
  '1. 完成本阶段工具调用后，最终可见回复必须按顺序包含下面两张 GFM Markdown 表格；不得改列、换序，也不得用列表或散文代替表格。',
  '2. 摘要表：',
  '| 项目 / 功能 | 阶段 | Review Round | Attempt | 精确提交 | Verdict |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 实际项目与功能 | 当前阶段 | 实际 Round ID | 实际 Attempt | 实际 SHA | 本阶段结论 |',
  '3. 检视意见表：',
  '| 编号 | 检视者 | 级别 | 结论 | 检视意见 | 证据 | 方案依据 | 处理要求 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 稳定编号 | 当前检视者 | P1/P2/P3/— | 阶段结论 | 具体问题或通过说明 | 文件、行号、测试或命令 | designRefs 或验收条件 | 必须采取的动作或“无需处理” |',
  '4. 每条 finding 单独一行；优先沿用 draftFindingId/findingId。单元格内换行使用 <br>，竖线必须转义为 \\|。不要把表格放进代码块。',
  '5. 没有 finding 时仍必须输出一行：级别填“—”、结论填“通过”、检视意见说明已完成的检查、处理要求填“无需处理”。不得只回复“通过”或一段总结。',
  '6. 独立检视阶段只展示当前检视者自己的结论，不得泄露、推测或占位展示其他 reviewer 的内容。',
  '7. 交叉检视阶段对每条独立 finding 标记“成立 / 不成立 / 重复 / 待用户决策”；共识阶段标记“纳入共识 / 驳回 / 已解决 / 待用户决策”。被驳回的意见也保留一行并写明依据。',
  '8. 表格前后不得再重复输出 findings 的纯文字清单；必要说明写入对应表格单元格。',
].join('\n');

function stageInstructions(stage: ReviewRoundDispatchStage, userAuthorized = false): string {
  const planBoundary = [
    '方案边界（强制）：',
    '1. 先读取上方“权威方案会话”的已确认设计与验收条件；所有 finding 必须服务于该方案的正确实现。',
    '2. 禁止把个人偏好、超出方案的重构或新增需求包装成 finding；安全与性能问题也必须引用方案中的约束、承诺或不变量。',
    '3. 每条 finding 必须填写非空 designRefs，并标记 scope=plan_conformance。',
    '4. 只有会迫使已确认方案发生重大架构变化的 P1 问题，才标记 scope=architecture_decision；不得给出越权改造结论，系统会暂停并申请用户决策。',
  ].join('\n');
  if (stage === 'independent') {
    return [
      planBoundary,
      '',
      '请仅针对以上精确提交检视该项目功能：',
      '1. 独立检查实现、测试及该功能的验收条件。',
      '2. Barrier 开启前，不读取或推测其他 reviewer 的意见。',
      '3. 使用 cat_cafe_review_draft_submit 提交私有 Review draft。',
      '4. 随后使用 cat_cafe_review_independent_finish 标记独立检视完成。',
      '5. 本阶段不要修改代码、提交、合并、推送或部署。',
      '',
      VISIBLE_REVIEW_REPORT_CONTRACT,
    ].join('\n');
  }
  if (stage === 'cross_review') {
    return [
      planBoundary,
      '',
      '独立检视 Barrier 已开启。请读取本轮全部独立 Review 意见并交叉核验：',
      '1. 验证每条 finding 的事实和代码证据。',
      '2. 合并重复问题，指出不成立或证据不足的问题。',
      '3. 使用 cat_cafe_review_cross_finish 标记交叉检视完成。',
      '4. 两位 reviewer 都完成后，系统将自动进入共识整理阶段。',
      '5. 本阶段不要修改代码、提交、合并、推送或部署。',
      '',
      VISIBLE_REVIEW_REPORT_CONTRACT,
    ].join('\n');
  }
  return [
    planBoundary,
    '',
    '你是系统指定的共识记录者。请读取 barrier-safe Review 结果：',
    '1. 核验并合并仍然成立的 findings。',
    '2. 使用 cat_cafe_review_consensus_publish 发布该精确提交的最终 verdict。',
    userAuthorized
      ? '3. 用户裁决是本轮 reviewer 分歧的最终依据；不得再次等待、索要或新增 reviewer。'
      : '3. 如 reviewer 无法形成共识，不要新增 reviewer；保留本轮在 consensus_ready，清楚列出分歧并等待用户在 Mission Hub 介入。',
    '4. 不要发布 Issue，也不要修改代码、合并、推送或部署。',
    '',
    VISIBLE_REVIEW_REPORT_CONTRACT,
  ].join('\n');
}

function deterministicMessageId(roundId: string, stage: ReviewRoundDispatchStage, deliveryKey?: string): string {
  const identity = deliveryKey
    ? `f289-review-dispatch:${roundId}:${stage}:${deliveryKey}`
    : `f289-review-dispatch:${roundId}:${stage}`;
  const hex = createHash('sha256').update(identity).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '0', 16) % 4] ?? '8';
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function parseIngressStatus(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { status?: unknown };
    return typeof parsed.status === 'string' ? parsed.status : undefined;
  } catch {
    return undefined;
  }
}

function parsePendingDispatch(raw: string): PendingReviewStageDispatch {
  const parsed = JSON.parse(raw) as PendingReviewStageDispatch | ReviewRoundDispatchInput;
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    parsed.version === 1 &&
    'input' in parsed
  ) {
    assertDispatchInput(parsed.input);
    const recoveryAttempts =
      Number.isInteger(parsed.recoveryAttempts) && parsed.recoveryAttempts >= 0 ? parsed.recoveryAttempts : 0;
    return { version: 1, input: parsed.input, recoveryAttempts };
  }
  assertDispatchInput(parsed as ReviewRoundDispatchInput);
  return { version: 1, input: parsed as ReviewRoundDispatchInput, recoveryAttempts: 0 };
}

function assertDisplayContext(
  value: ReviewRoundDisplayContext | undefined,
): asserts value is ReviewRoundDisplayContext {
  if (
    !value ||
    !value.projectName.trim() ||
    !value.repository.trim() ||
    !value.featureId.trim() ||
    !value.featureTitle.trim() ||
    (value.planThreadId !== undefined && !value.planThreadId.trim()) ||
    !Number.isInteger(value.attemptNumber) ||
    value.attemptNumber < 1
  ) {
    throw new Error('Review dispatcher requires accurate project and feature display context');
  }
}

function assertDispatchInput(value: ReviewRoundDispatchInput): void {
  if (!value || !value.roundId || !value.reviewHubThreadId || !Array.isArray(value.reviewerCatIds)) {
    throw new Error('Invalid pending Review stage dispatch record');
  }
  if (
    value.consensusAuthorization &&
    (!value.consensusAuthorization.instruction.trim() ||
      !value.consensusAuthorization.authorizedByUserId.trim() ||
      !Number.isInteger(value.consensusAuthorization.authorizedAt) ||
      value.consensusAuthorization.authorizedAt < 1)
  ) {
    throw new Error('Invalid Review consensus authorization context');
  }
  assertDisplayContext(value.displayContext);
}
