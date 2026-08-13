import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { connectCodexAppServerSocket } from '../cats/services/agents/providers/CodexUnixWebSocketSession.js';
import type { AgentCarrierSession, AgentCarrierSessionFactory } from '../cats/services/types.js';

const execFileAsync = promisify(execFile);
const PENDING_WAKE_SET = 'desktop-development:pending-native-wakes';
const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
const DEFAULT_DAEMON_SOCKET = join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock');

export interface DesktopTaskLaunchInput {
  readonly projectId: string;
  readonly projectName: string;
  readonly repository: string;
  readonly sourcePath: string;
  readonly backlogItemId: string;
  readonly featureId: string;
  readonly title: string;
}

export interface DesktopTaskLaunchResult {
  readonly status: 'created';
  readonly threadId: string;
}

export interface DesktopTaskActivationInput {
  readonly threadId: string;
  readonly sourcePath: string;
  readonly objective: string;
}

export interface DesktopTaskActivator {
  activate(input: DesktopTaskActivationInput): Promise<void>;
}

export interface DesktopTaskLauncher extends DesktopTaskActivator {
  launch(input: DesktopTaskLaunchInput): Promise<DesktopTaskLaunchResult>;
  get(projectId: string, backlogItemId: string): Promise<DesktopTaskLaunchResult | null>;
}

interface DesktopTaskRecord {
  readonly status: 'starting' | 'created';
  readonly threadId: string;
  readonly runtimeSessionId?: string;
}

interface DesktopTaskLauncherOptions {
  readonly sessionFactory?: AgentCarrierSessionFactory;
  readonly openThread?: (threadId: string) => Promise<void>;
  readonly recoveryIntervalMs?: number;
  readonly daemonSocketPath?: string;
}

export function buildDesktopTaskName(featureId: string, title: string): string {
  const normalizedFeatureId = featureId.trim().toUpperCase();
  const featurePrefix = normalizedFeatureId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const featureName = title
    .trim()
    .replace(new RegExp(`^\\[${featurePrefix}\\]\\s*`, 'i'), '')
    .replace(new RegExp(`^${featurePrefix}\\s*[-—:：·]?\\s*`, 'i'), '')
    .trim();
  return featureName ? `${normalizedFeatureId} · ${featureName}` : normalizedFeatureId;
}

/**
 * Creates and wakes native ChatGPT Desktop tasks.
 *
 * Cat Cafe connects to the durable ChatGPT app-server daemon. The daemon owns
 * the turn after this short-lived proxy connection closes, while the codex://
 * deep link makes that same persisted thread visible in ChatGPT Desktop.
 */
export class CodexDesktopTaskLauncher implements DesktopTaskLauncher {
  private readonly active = new Map<string, Promise<DesktopTaskLaunchResult>>();
  private readonly activeWakes = new Map<string, Promise<void>>();
  private readonly completed = new Map<string, DesktopTaskLaunchResult>();
  private readonly sessionFactory: AgentCarrierSessionFactory;
  private readonly openThread: (threadId: string) => Promise<void>;
  private readonly daemonSocketPath: string;

  constructor(
    private readonly redis?: RedisClient,
    options: DesktopTaskLauncherOptions = {},
  ) {
    this.sessionFactory =
      options.sessionFactory ?? (async () => connectCodexAppServerSocket(this.daemonSocketPath));
    this.openThread = options.openThread ?? openChatGptThread;
    this.daemonSocketPath = options.daemonSocketPath ?? process.env.CODEX_APP_SERVER_SOCKET ?? DEFAULT_DAEMON_SOCKET;
    if (redis && options.recoveryIntervalMs !== 0) {
      const interval = setInterval(
        () => void this.recoverPendingActivations().catch(() => undefined),
        options.recoveryIntervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS,
      );
      interval.unref();
      queueMicrotask(() => void this.recoverPendingActivations().catch(() => undefined));
    }
  }

  async get(projectId: string, backlogItemId: string): Promise<DesktopTaskLaunchResult | null> {
    const key = `${projectId}:${backlogItemId}`;
    const cached = this.completed.get(key);
    if (cached) return cached;
    const record = await this.readRecord(projectId, backlogItemId);
    if (!record || record.status !== 'created') return null;
    const result = { status: 'created', threadId: record.threadId } as const;
    this.completed.set(key, result);
    return result;
  }

  launch(input: DesktopTaskLaunchInput): Promise<DesktopTaskLaunchResult> {
    const key = `${input.projectId}:${input.backlogItemId}`;
    const existing = this.active.get(key);
    if (existing) return existing;
    const launch = this.launchOrReuse(input).finally(() => this.active.delete(key));
    this.active.set(key, launch);
    return launch;
  }

  activate(input: DesktopTaskActivationInput): Promise<void> {
    const previous = this.activeWakes.get(input.threadId) ?? Promise.resolve();
    const wake = previous
      .catch(() => undefined)
      .then(() => this.persistAndWake(input))
      .finally(() => {
        if (this.activeWakes.get(input.threadId) === wake) this.activeWakes.delete(input.threadId);
      });
    this.activeWakes.set(input.threadId, wake);
    return wake;
  }

  async recoverPendingActivations(): Promise<void> {
    if (!this.redis) return;
    const threadIds = await this.redis.smembers(PENDING_WAKE_SET);
    for (const threadId of threadIds) {
      if (this.activeWakes.has(threadId)) continue;
      const raw = await this.redis.get(this.pendingWakeKey(threadId));
      if (!raw) {
        await this.redis.srem(PENDING_WAKE_SET, threadId);
        continue;
      }
      try {
        const input = JSON.parse(raw) as DesktopTaskActivationInput;
        if (!isActivationInput(input)) throw new Error('Invalid pending ChatGPT Desktop wake record');
        await this.wake(input);
        await this.clearPendingWake(threadId);
      } catch {
        // Keep the record. The next bounded recovery pass retries the same wake.
      }
    }
  }

  private async launchOrReuse(input: DesktopTaskLaunchInput): Promise<DesktopTaskLaunchResult> {
    let record = await this.readRecord(input.projectId, input.backlogItemId);
    if (record) {
      const exists = await this.threadExists(input, record.threadId);
      if (exists) {
        const runtimeSessionId = record.runtimeSessionId ?? randomUUID();
        await this.activate({
          threadId: record.threadId,
          sourcePath: input.sourcePath,
          objective: buildInitialObjective(input, runtimeSessionId),
        });
        const existing = { status: 'created', threadId: record.threadId } as const;
        this.completed.set(`${input.projectId}:${input.backlogItemId}`, existing);
        await this.writeRecord(input.projectId, input.backlogItemId, { ...existing, runtimeSessionId });
        return existing;
      }
      await this.clearRecord(input.projectId, input.backlogItemId);
      record = null;
    }
    const result = await this.start(input, undefined, async (threadId, runtimeSessionId) => {
      await this.writeRecord(input.projectId, input.backlogItemId, {
        status: 'starting',
        threadId,
        runtimeSessionId,
      });
    });
    this.completed.set(`${input.projectId}:${input.backlogItemId}`, result);
    const persisted = await this.readRecord(input.projectId, input.backlogItemId);
    await this.writeRecord(input.projectId, input.backlogItemId, {
      ...result,
      ...(persisted?.runtimeSessionId ? { runtimeSessionId: persisted.runtimeSessionId } : {}),
    });
    return result;
  }

  private async start(
    input: DesktopTaskLaunchInput,
    _existingThreadId?: string,
    onThreadStarted?: (threadId: string, runtimeSessionId: string) => Promise<void>,
  ): Promise<DesktopTaskLaunchResult> {
    const runtimeSessionId = randomUUID();
    const taskName = buildDesktopTaskName(input.featureId, input.title);
    const threadId = await this.withProtocol(
      input.sourcePath,
      `desktop-feature-${input.backlogItemId}`,
      async (rpc) => {
        const result = asRecord(
          await rpc.request('thread/start', {
            cwd: input.sourcePath,
            sandbox: 'danger-full-access',
            approvalPolicy: 'on-request',
          }),
        );
        const thread = asRecord(result?.thread);
        if (typeof thread?.id !== 'string') throw new Error('ChatGPT app-server did not return a thread id');
        await onThreadStarted?.(thread.id, runtimeSessionId);
        await rpc.request('thread/name/set', { threadId: thread.id, name: taskName });
        await rpc.request('thread/goal/set', {
          threadId: thread.id,
          objective: buildInitialObjective(input, runtimeSessionId),
          status: 'active',
          tokenBudget: null,
        });
        await this.openThread(thread.id);
        await rpc.request('turn/start', {
          threadId: thread.id,
          input: [{ type: 'text', text: buildInitialObjective(input, runtimeSessionId) }],
          cwd: input.sourcePath,
          approvalPolicy: 'on-request',
        });
        return thread.id;
      },
    );
    return { status: 'created', threadId };
  }

  private async persistAndWake(input: DesktopTaskActivationInput): Promise<void> {
    if (this.redis) {
      await this.redis.set(this.pendingWakeKey(input.threadId), JSON.stringify(input));
      await this.redis.sadd(PENDING_WAKE_SET, input.threadId);
    }
    try {
      await this.wake(input);
      await this.clearPendingWake(input.threadId);
    } catch (error) {
      // Once Redis owns the wake request, Review completion must not be rolled
      // back just because ChatGPT was temporarily closed or unavailable.
      if (!this.redis) throw error;
    }
  }

  private async wake(input: DesktopTaskActivationInput): Promise<void> {
    await this.withProtocol(input.sourcePath, `desktop-wake-${input.threadId}`, async (rpc) => {
      await rpc.request('thread/resume', {
        threadId: input.threadId,
        cwd: input.sourcePath,
        sandbox: 'danger-full-access',
        approvalPolicy: 'on-request',
      });
      await rpc.request('thread/goal/set', {
        threadId: input.threadId,
        objective: input.objective,
        status: 'active',
        tokenBudget: null,
      });
      await this.openThread(input.threadId);
      await rpc.request('turn/start', {
        threadId: input.threadId,
        input: [{ type: 'text', text: input.objective }],
        cwd: input.sourcePath,
        approvalPolicy: 'on-request',
      });
    });
  }

  private storageKey(projectId: string, backlogItemId: string): string {
    return `desktop-development:feature-task:${projectId}:${backlogItemId}`;
  }

  private pendingWakeKey(threadId: string): string {
    return `desktop-development:native-wake:${encodeURIComponent(threadId)}`;
  }

  private async readRecord(projectId: string, backlogItemId: string): Promise<DesktopTaskRecord | null> {
    const raw = await this.redis?.get(this.storageKey(projectId, backlogItemId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { status?: unknown; threadId?: unknown; runtimeSessionId?: unknown };
      if (typeof parsed.threadId !== 'string') return null;
      return {
        status: parsed.status === 'starting' ? 'starting' : 'created',
        threadId: parsed.threadId,
        ...(typeof parsed.runtimeSessionId === 'string' ? { runtimeSessionId: parsed.runtimeSessionId } : {}),
      };
    } catch {
      return null;
    }
  }

  private async writeRecord(projectId: string, backlogItemId: string, record: DesktopTaskRecord): Promise<void> {
    await this.redis?.set(this.storageKey(projectId, backlogItemId), JSON.stringify(record));
  }

  private async clearRecord(projectId: string, backlogItemId: string): Promise<void> {
    this.completed.delete(`${projectId}:${backlogItemId}`);
    await this.redis?.del(this.storageKey(projectId, backlogItemId));
  }

  private async clearPendingWake(threadId: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.del(this.pendingWakeKey(threadId));
    await this.redis.srem(PENDING_WAKE_SET, threadId);
  }

  /** App-server read is used only on an explicit retry, not on the polling status path. */
  private async threadExists(input: DesktopTaskLaunchInput, threadId: string): Promise<boolean> {
    try {
      return await this.withProtocol(input.sourcePath, `desktop-feature-check-${input.backlogItemId}`, async (rpc) => {
        try {
          const result = asRecord(await rpc.request('thread/read', { threadId, includeTurns: false }));
          const thread = asRecord(result?.thread);
          return thread?.archived !== true;
        } catch (error) {
          if (/not[ _-]?found|does not exist|unknown thread/i.test(String(error))) return false;
          throw error;
        }
      });
    } catch (error) {
      throw new Error(`Unable to validate the existing ChatGPT Desktop task: ${String(error)}`);
    }
  }

  private async withProtocol<T>(
    cwd: string,
    invocationPrefix: string,
    operation: (rpc: SequentialRpcClient) => Promise<T>,
  ): Promise<T> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 15_000);
    const session = await this.sessionFactory({
      command: 'codex-app-server-daemon',
      args: [],
      cwd,
      invocationId: `${invocationPrefix}-${Date.now()}`,
      signal: abortController.signal,
    });
    const rpc = new SequentialRpcClient(session);
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'cat-cafe', title: 'Clowder AI', version: '1' },
        capabilities: { experimentalApi: true },
      });
      await session.write({ method: 'initialized' });
      return await operation(rpc);
    } catch (error) {
      if (abortController.signal.aborted) throw new Error('Timed out while waking the ChatGPT Desktop task');
      throw error;
    } finally {
      clearTimeout(timeout);
      await session.close();
    }
  }
}

class SequentialRpcClient {
  private readonly iterator: AsyncIterator<unknown>;
  private nextId = 1;

  constructor(private readonly session: AgentCarrierSession) {
    this.iterator = session.read()[Symbol.asyncIterator]();
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    await this.session.write({ id, method, params });
    while (true) {
      const next = await this.iterator.next();
      if (next.done) throw new Error(`ChatGPT app-server ended before responding to ${method}`);
      const message = asRecord(next.value);
      if (message?.id !== id) continue;
      if (message.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(message.error)}`);
      return message.result;
    }
  }
}

function buildInitialObjective(input: DesktopTaskLaunchInput, runtimeSessionId: string): string {
  const taskName = buildDesktopTaskName(input.featureId, input.title);
  return [
    `开发功能：${taskName}`,
    '使用 catcafe-desktop-executor 技能执行这个已绑定的 Cat Café managed work。',
    `项目：${input.projectName}（${input.repository}）`,
    `功能：${input.featureId} — ${input.title}`,
    `Cat Café projectId：${input.projectId}`,
    `backlogItemId：${input.backlogItemId}`,
    `本任务的 runtimeSessionId：${runtimeSessionId}。连接与后续 heartbeat/report 必须复用这个值。`,
    '先从当前 Git workspace 验证仓库，再通过 Cat Café development-loop MCP 读取并连接唯一匹配的活跃工作。',
    '持续读取最新 Resume Packet，只执行 nextLegalActions；Review 完成后处理修复或合入确认，直到进入需要用户验收或明确阻断的状态。',
  ].join('\n');
}

export function buildReviewCompletionObjective(input: {
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly reviewRoundId: string;
  readonly exactSha: string;
  readonly runtimeSessionId: string;
}): string {
  return [
    '继续执行当前 Cat Café managed work。该功能的 Review 已完成。',
    `Cat Café projectId：${input.projectId}`,
    `workId：${input.workId}`,
    `attemptId：${input.attemptId}`,
    `reviewRoundId：${input.reviewRoundId}`,
    `被检视的精确 SHA：${input.exactSha}`,
    `继续复用 runtimeSessionId：${input.runtimeSessionId}。`,
    '使用 catcafe-desktop-executor 技能读取最新 Resume Packet，只执行其中的 nextLegalActions。',
    '若需要修复，先按 Resume Packet 重连并取得新的 attempt，再在这个可见任务中完成修复、测试、提交和报告；若已通过，则向用户展示下一项合法动作。',
  ].join('\n');
}

async function openChatGptThread(threadId: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Native ChatGPT task wake currently requires macOS');
  await execFileAsync('/usr/bin/open', [`codex://threads/${encodeURIComponent(threadId)}`]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isActivationInput(value: unknown): value is DesktopTaskActivationInput {
  const input = asRecord(value);
  return (
    typeof input?.threadId === 'string' && typeof input.sourcePath === 'string' && typeof input.objective === 'string'
  );
}
