import { createHash } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ReviewRoundDisplayContext } from './review-round-display-context.js';

export type ReviewRoundDispatchStage = 'independent' | 'cross_review' | 'consensus';

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
    `实现尝试：Attempt #${context.attemptNumber}`,
    `精确提交：${input.exactSha}`,
    progressLine(input.stage, completedCount, roster.length),
    '',
    '本阶段参与者：',
    participants,
  ].join('\n');
  return `${routing}\n${identity}\n\n${stageInstructions(input.stage)}\n\nReview Round：${input.roundId}`;
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

function stageInstructions(stage: ReviewRoundDispatchStage): string {
  if (stage === 'independent') {
    return [
      '请仅针对以上精确提交检视该项目功能：',
      '1. 独立检查实现、测试及该功能的验收条件。',
      '2. Barrier 开启前，不读取或推测其他 reviewer 的意见。',
      '3. 使用 cat_cafe_review_draft_submit 提交私有 Review draft。',
      '4. 随后使用 cat_cafe_review_independent_finish 标记独立检视完成。',
      '5. 本阶段不要修改代码、提交、合并、推送或部署。',
    ].join('\n');
  }
  if (stage === 'cross_review') {
    return [
      '独立检视 Barrier 已开启。请读取本轮全部独立 Review 意见并交叉核验：',
      '1. 验证每条 finding 的事实和代码证据。',
      '2. 合并重复问题，指出不成立或证据不足的问题。',
      '3. 使用 cat_cafe_review_cross_finish 标记交叉检视完成。',
      '4. 两位 reviewer 都完成后，系统将自动进入共识整理阶段。',
      '5. 本阶段不要修改代码、提交、合并、推送或部署。',
    ].join('\n');
  }
  return [
    '你是系统指定的共识记录者。请读取 barrier-safe Review 结果：',
    '1. 核验并合并仍然成立的 findings。',
    '2. 使用 cat_cafe_review_consensus_publish 发布该精确提交的最终 verdict。',
    '3. 不要发布 Issue，也不要修改代码、合并、推送或部署。',
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
  assertDisplayContext(value.displayContext);
}
