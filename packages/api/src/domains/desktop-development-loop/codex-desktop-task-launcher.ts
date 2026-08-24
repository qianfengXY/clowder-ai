import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { connectCodexAppServerSocket } from '../cats/services/agents/providers/CodexUnixWebSocketSession.js';
import { createDirectAgentCarrierSession } from '../cats/services/agents/providers/DirectAgentCarrierSession.js';
import type { AgentCarrierSession, AgentCarrierSessionFactory } from '../cats/services/types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_DAEMON_SOCKET = join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
const DEFAULT_DESKTOP_IPC_SOCKET = join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'ipc', 'ipc.sock');
const PENDING_WAKE_SET = 'desktop-development:pending-native-wakes';
const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
const CHATGPT_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex';
const DESKTOP_IPC_TIMEOUT_MS = 15_000;
const MAX_DESKTOP_IPC_FRAME_BYTES = 16 * 1024 * 1024;
const DESKTOP_OWNER_DISCOVERY_RETRIES = 12;
const DESKTOP_OWNER_DISCOVERY_RETRY_MS = 250;

export interface DesktopTaskLaunchInput {
  readonly projectId: string;
  readonly projectName: string;
  readonly repository: string;
  readonly sourcePath: string;
  readonly backlogItemId: string;
  readonly featureId: string;
  readonly title: string;
  readonly designBranch: string;
  readonly designExactSha: string;
  readonly designDocuments: readonly string[];
}

export interface DesktopTaskLaunchResult {
  readonly status: 'created';
  readonly threadId: string;
}

export interface DesktopDeliveryCycleResumeInput extends DesktopTaskLaunchInput {
  readonly workId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly deliveryCycleNumber: number;
  readonly previousLifecycle: 'accepted' | 'rejected';
}

export interface DesktopTaskActivationInput {
  readonly threadId: string;
  readonly sourcePath: string;
  readonly objective: string;
}

export interface DesktopTaskPauseInput {
  readonly threadId: string;
  readonly sourcePath: string;
}

export interface DesktopTaskActivator {
  activate(input: DesktopTaskActivationInput): Promise<void>;
}

export interface DesktopTaskGoalController extends DesktopTaskActivator {
  pause(input: DesktopTaskPauseInput): Promise<void>;
}

export interface DesktopTaskLauncher extends DesktopTaskGoalController {
  launch(input: DesktopTaskLaunchInput): Promise<DesktopTaskLaunchResult>;
  /** Reuse and wake the feature's original task when terminal work starts a new delivery cycle. */
  resumeDeliveryCycle?(input: DesktopDeliveryCycleResumeInput): Promise<DesktopTaskLaunchResult>;
  get(projectId: string, backlogItemId: string): Promise<DesktopTaskLaunchResult | null>;
}

interface DesktopTaskRecord {
  readonly status: 'starting' | 'created';
  readonly threadId: string;
  readonly runtimeSessionId?: string;
}

interface DesktopTaskLauncherOptions {
  readonly sessionFactory?: AgentCarrierSessionFactory;
  readonly goalSessionFactory?: AgentCarrierSessionFactory;
  readonly openThread?: (threadId: string) => Promise<void>;
  readonly sendDesktopTurn?: (threadId: string, objective: string, clientUserMessageId: string) => Promise<void>;
  readonly verifyDesktopTurn?: (
    threadId: string,
    sourcePath: string,
    objective: string,
    clientUserMessageId: string,
  ) => Promise<boolean>;
  readonly stopDesktopTurn?: (threadId: string, sourcePath: string) => Promise<void>;
  readonly daemonSocketPath?: string;
  readonly desktopIpcSocketPath?: string;
  readonly recoveryIntervalMs?: number;
  readonly command?: string;
}

type DesktopTaskGoalSignal =
  | ({ readonly kind: 'activate' } & DesktopTaskActivationInput)
  | ({ readonly kind: 'pause' } & DesktopTaskPauseInput);

type PendingDesktopTaskGoalSignal = DesktopTaskGoalSignal & {
  /**
   * The owning Desktop window accepted this exact start-turn request. Until
   * the turn becomes readable, recovery may verify it but must not send it a
   * second time.
   */
  readonly deliveryAcknowledgedAt?: number;
  readonly clientUserMessageId?: string;
};

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
 * Initial tasks use Cat Cafe's durable app-server daemon. Review completion
 * writes the durable goal separately, then asks the current ChatGPT Desktop
 * owner to start exactly one turn through Desktop IPC. Review execution remains
 * on Cat Cafe's independent provider sessions.
 */
export class CodexDesktopTaskLauncher implements DesktopTaskLauncher {
  private readonly active = new Map<string, Promise<DesktopTaskLaunchResult>>();
  private readonly activeWakes = new Map<string, Promise<void>>();
  private readonly completed = new Map<string, DesktopTaskLaunchResult>();
  private readonly sessionFactory: AgentCarrierSessionFactory;
  private readonly goalSessionFactory: AgentCarrierSessionFactory;
  private readonly openThread: (threadId: string) => Promise<void>;
  private readonly sendDesktopTurn: (threadId: string, objective: string, clientUserMessageId: string) => Promise<void>;
  private readonly verifyDesktopTurn: (
    threadId: string,
    sourcePath: string,
    objective: string,
    clientUserMessageId: string,
  ) => Promise<boolean>;
  private readonly stopDesktopTurn: (threadId: string, sourcePath: string) => Promise<void>;
  private readonly daemonSocketPath: string;
  private readonly command: string;

  constructor(
    private readonly redis?: RedisClient,
    options: DesktopTaskLauncherOptions = {},
  ) {
    this.sessionFactory = options.sessionFactory ?? (async () => connectCodexAppServerSocket(this.daemonSocketPath));
    this.goalSessionFactory = options.goalSessionFactory ?? options.sessionFactory ?? createDirectAgentCarrierSession;
    this.openThread = options.openThread ?? openChatGptThread;
    this.daemonSocketPath = options.daemonSocketPath ?? process.env.CODEX_APP_SERVER_SOCKET ?? DEFAULT_DAEMON_SOCKET;
    const desktopIpcSocketPath = options.desktopIpcSocketPath ?? DEFAULT_DESKTOP_IPC_SOCKET;
    this.sendDesktopTurn =
      options.sendDesktopTurn ??
      (async (threadId, objective, clientUserMessageId) =>
        sendChatGptDesktopTurn(desktopIpcSocketPath, threadId, objective, clientUserMessageId));
    this.verifyDesktopTurn =
      options.verifyDesktopTurn ??
      (options.sendDesktopTurn
        ? async () => true
        : async (threadId, sourcePath, objective, clientUserMessageId) =>
            this.desktopTurnExists(threadId, sourcePath, objective, clientUserMessageId));
    this.stopDesktopTurn =
      options.stopDesktopTurn ??
      (async (threadId, sourcePath) => steerChatGptDesktopTurnToStop(desktopIpcSocketPath, threadId, sourcePath));
    this.command = options.command ?? resolveChatGptCodexCommand();
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

  async resumeDeliveryCycle(input: DesktopDeliveryCycleResumeInput): Promise<DesktopTaskLaunchResult> {
    const previous = await this.get(input.projectId, input.backlogItemId);
    const task = await this.launch(input);
    // A replacement task already receives buildInitialObjective in its first
    // turn. Only an existing original task needs an explicit one-shot wake.
    if (previous?.threadId === task.threadId) {
      const record = await this.readRecord(input.projectId, input.backlogItemId);
      if (!record?.runtimeSessionId) throw new Error('Bound ChatGPT Desktop task is missing its runtimeSessionId');
      await this.activate({
        threadId: task.threadId,
        sourcePath: input.sourcePath,
        objective: buildDeliveryCycleObjective(input, record.runtimeSessionId),
      });
    }
    return task;
  }

  activate(input: DesktopTaskActivationInput): Promise<void> {
    return this.enqueueGoalSignal({ kind: 'activate', ...input });
  }

  pause(input: DesktopTaskPauseInput): Promise<void> {
    return this.enqueueGoalSignal({ kind: 'pause', ...input });
  }

  private enqueueGoalSignal(input: DesktopTaskGoalSignal): Promise<void> {
    const previous = this.activeWakes.get(input.threadId) ?? Promise.resolve();
    const wake = previous
      .catch(() => undefined)
      .then(() => this.persistAndDeliver(input))
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
      await this.recoverPendingGoalSignal(threadId);
    }
  }

  private recoverPendingGoalSignal(threadId: string): Promise<void> {
    const existing = this.activeWakes.get(threadId);
    if (existing) return existing;
    const wake = this.deliverPendingGoalSignal(threadId).finally(() => {
      if (this.activeWakes.get(threadId) === wake) this.activeWakes.delete(threadId);
    });
    this.activeWakes.set(threadId, wake);
    return wake;
  }

  private async deliverPendingGoalSignal(threadId: string): Promise<void> {
    if (!this.redis) return;
    const raw = await this.redis.get(this.pendingWakeKey(threadId));
    if (!raw) {
      await this.redis.srem(PENDING_WAKE_SET, threadId);
      return;
    }
    try {
      const input = parsePendingGoalSignal(JSON.parse(raw));
      if (!input) throw new Error('Invalid pending ChatGPT Desktop goal signal');
      if (input.kind === 'activate' && input.deliveryAcknowledgedAt !== undefined) {
        const clientUserMessageId =
          input.clientUserMessageId ?? deterministicDesktopTurnMessageId(input.threadId, input.objective);
        if (await this.verifyDesktopTurn(input.threadId, input.sourcePath, input.objective, clientUserMessageId)) {
          await this.clearPendingWake(threadId);
        }
        return;
      }
      await this.deliverGoalSignal(input);
      await this.clearPendingWake(threadId);
    } catch {
      // Keep the durable record for the next bounded recovery pass.
    }
  }

  private async launchOrReuse(input: DesktopTaskLaunchInput): Promise<DesktopTaskLaunchResult> {
    let record = await this.readRecord(input.projectId, input.backlogItemId);
    if (record) {
      const exists = await this.threadExists(input, record.threadId);
      if (exists) {
        const runtimeSessionId = record.runtimeSessionId ?? randomUUID();
        await this.openThread(record.threadId);
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
          status: 'paused',
          tokenBudget: null,
        });
        await rpc.request('turn/start', {
          threadId: thread.id,
          input: [{ type: 'text', text: buildInitialObjective(input, runtimeSessionId) }],
          cwd: input.sourcePath,
          approvalPolicy: 'on-request',
        });
        await this.openThread(thread.id);
        return thread.id;
      },
    );
    return { status: 'created', threadId };
  }

  private async persistAndDeliver(input: DesktopTaskGoalSignal): Promise<void> {
    if (this.redis) {
      await this.redis.set(this.pendingWakeKey(input.threadId), JSON.stringify(input));
      await this.redis.sadd(PENDING_WAKE_SET, input.threadId);
    }
    try {
      await this.deliverGoalSignal(input);
      await this.clearPendingWake(input.threadId);
    } catch (error) {
      // Review consensus is already committed. A temporary Desktop/app-server
      // failure must leave a recoverable wake instead of rolling consensus back.
      if (!this.redis) throw error;
    }
  }

  private async deliverGoalSignal(input: DesktopTaskGoalSignal): Promise<void> {
    if (input.kind === 'pause') {
      await this.pauseGoal(input);
      return;
    }
    await this.wake(input);
  }

  /** Ask the current Desktop owner to start one turn in the bound thread. */
  private async wake(input: DesktopTaskActivationInput): Promise<void> {
    const clientUserMessageId = deterministicDesktopTurnMessageId(input.threadId, input.objective);
    await this.withGoalProtocol(input.sourcePath, `desktop-review-goal-${input.threadId}`, async (rpc) => {
      await rpc.request('thread/goal/set', {
        threadId: input.threadId,
        objective: input.objective,
        status: 'paused',
        tokenBudget: null,
      });
    });
    await this.sendDesktopTurnToOwner(input.threadId, input.objective, clientUserMessageId);
    await this.markActivationDeliveryAcknowledged(input, clientUserMessageId);
    if (!(await this.verifyDesktopTurn(input.threadId, input.sourcePath, input.objective, clientUserMessageId))) {
      throw new Error('ChatGPT Desktop acknowledged the Review notification but the turn was not persisted');
    }
  }

  private async markActivationDeliveryAcknowledged(
    input: DesktopTaskActivationInput,
    clientUserMessageId: string,
  ): Promise<void> {
    if (!this.redis) return;
    const key = this.pendingWakeKey(input.threadId);
    const raw = await this.redis.get(key);
    const pending = raw ? parsePendingGoalSignal(JSON.parse(raw)) : null;
    if (
      pending?.kind !== 'activate' ||
      pending.sourcePath !== input.sourcePath ||
      pending.objective !== input.objective
    ) {
      return;
    }
    await this.redis.set(
      key,
      JSON.stringify({
        ...pending,
        deliveryAcknowledgedAt: Date.now(),
        clientUserMessageId,
      } satisfies PendingDesktopTaskGoalSignal),
    );
  }

  private async sendDesktopTurnToOwner(
    threadId: string,
    objective: string,
    clientUserMessageId: string,
  ): Promise<void> {
    try {
      await this.sendDesktopTurn(threadId, objective, clientUserMessageId);
      return;
    } catch (error) {
      if (!isDesktopOwnerUnavailable(error)) throw error;
    }

    // A dormant task has no IPC owner until ChatGPT loads it. Open the same
    // bound task (never a replacement), then give its window a bounded period
    // to register before retrying the deterministic message id.
    await this.openThread(threadId);
    let lastError: unknown = new Error(`No ChatGPT Desktop window owns bound thread ${threadId}`);
    for (let retry = 0; retry < DESKTOP_OWNER_DISCOVERY_RETRIES; retry += 1) {
      await wait(DESKTOP_OWNER_DISCOVERY_RETRY_MS);
      try {
        await this.sendDesktopTurn(threadId, objective, clientUserMessageId);
        return;
      } catch (error) {
        if (!isDesktopOwnerUnavailable(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  /** Stop the durable goal from creating another turn while Cat Cafe reviews. */
  private async pauseGoal(input: DesktopTaskPauseInput): Promise<void> {
    await this.withGoalProtocol(input.sourcePath, `desktop-review-pause-${input.threadId}`, async (rpc) => {
      await rpc.request('thread/goal/set', {
        threadId: input.threadId,
        status: 'paused',
      });
    });
    // The short-lived goal writer does not update the owner window's in-memory
    // Goal. Steer the still-running implementation turn so that Desktop itself
    // completes the Goal before returning to the user.
    await this.stopDesktopTurn(input.threadId, input.sourcePath);
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

  private async desktopTurnExists(
    threadId: string,
    sourcePath: string,
    objective: string,
    clientUserMessageId: string,
  ): Promise<boolean> {
    return this.withProtocol(sourcePath, `desktop-review-verify-${threadId}`, async (rpc) => {
      const result = await rpc.request('thread/read', { threadId, includeTurns: true });
      const thread = asRecord(asRecord(result)?.thread);
      const turns = Array.isArray(thread?.turns) ? thread.turns : [];
      const serialized = JSON.stringify(turns);
      return serialized.includes(clientUserMessageId) || serialized.includes(objective);
    });
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

  /** Goal metadata is persisted without competing for Desktop thread ownership. */
  private async withGoalProtocol<T>(
    cwd: string,
    invocationPrefix: string,
    operation: (rpc: SequentialRpcClient) => Promise<T>,
  ): Promise<T> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 15_000);
    const session = await this.goalSessionFactory({
      command: this.command,
      args: ['app-server', '--stdio'],
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
      if (abortController.signal.aborted) throw new Error('Timed out while updating the ChatGPT Desktop goal');
      throw error;
    } finally {
      clearTimeout(timeout);
      await session.close();
    }
  }
}

interface DesktopIpcResponse {
  readonly type: 'response';
  readonly requestId: string;
  readonly resultType: 'success' | 'error';
  readonly method: string;
  readonly handledByClientId?: string;
  readonly result?: unknown;
  readonly error?: unknown;
}

/**
 * Forward one message to the ChatGPT Desktop window that currently owns the
 * bound conversation. The owner window performs the real turn/start on its own
 * embedded app-server, so Cat Cafe never becomes a second writer.
 */
export async function sendChatGptDesktopTurn(
  socketPath: string,
  threadId: string,
  objective: string,
  clientUserMessageId = deterministicDesktopTurnMessageId(threadId, objective),
): Promise<void> {
  await sendChatGptDesktopOwnerRequest(socketPath, threadId, 'thread-follower-start-turn', {
    conversationId: threadId,
    turnStartParams: { input: [{ type: 'text', text: objective }], clientUserMessageId },
    mcpAppModelContextAttachments: [],
  });
}

export function deterministicDesktopTurnMessageId(threadId: string, objective: string): string {
  const hex = createHash('sha256')
    .update(`cat-cafe-desktop-turn:${threadId}:${objective}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '0', 16) % 4] ?? '8';
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export async function steerChatGptDesktopTurnToStop(
  socketPath: string,
  threadId: string,
  sourcePath: string,
): Promise<void> {
  await sendChatGptDesktopOwnerRequest(socketPath, threadId, 'thread-follower-steer-turn', {
    conversationId: threadId,
    input: [{ type: 'text', text: buildDesktopStopInstruction() }],
    restoreMessage: {
      cwd: sourcePath,
      context: { workspaceRoots: [sourcePath], collaborationMode: null },
      responsesapiClientMetadata: {},
    },
    attachments: [],
  });
}

async function sendChatGptDesktopOwnerRequest(
  socketPath: string,
  threadId: string,
  method: 'thread-follower-start-turn' | 'thread-follower-steer-turn',
  params: Record<string, unknown>,
): Promise<void> {
  const socket = createConnection(socketPath);
  const timeout = setTimeout(
    () => socket.destroy(new Error('Timed out while delivering the Review result to ChatGPT Desktop')),
    DESKTOP_IPC_TIMEOUT_MS,
  );
  try {
    await once(socket, 'connect');
    const reader = readDesktopIpcFrames(socket)[Symbol.asyncIterator]();
    let sourceClientId = 'initializing-client';
    const initialize = await requestDesktopIpc(reader, socket, {
      sourceClientId,
      version: 0,
      method: 'initialize',
      params: { clientType: 'cat-cafe' },
    });
    const initializedClientId = asRecord(initialize.result)?.clientId;
    if (typeof initializedClientId !== 'string') {
      throw new Error('ChatGPT Desktop IPC initialize response did not include a client id');
    }
    sourceClientId = initializedClientId;

    const discovery = await requestDesktopIpc(reader, socket, {
      sourceClientId,
      version: 1,
      method: 'thread-owner-discovery',
      params: { hostId: 'local', conversationId: threadId },
    });
    if (!discovery.handledByClientId) {
      throw new Error(`No ChatGPT Desktop window owns bound thread ${threadId}`);
    }

    await requestDesktopIpc(reader, socket, {
      sourceClientId,
      targetClientId: discovery.handledByClientId,
      version: 1,
      method,
      params,
    });
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
}

function buildDesktopStopInstruction(): string {
  return [
    '[Review 系统消息] 本轮 implementation report 已被 Cat Café 接收，独立 Review 已在后台开始。',
    '立即停止当前执行，不得读取或轮询 Resume Packet。',
    '调用 update_goal 将当前 Goal 标记为 complete，然后结束本轮；Review 完成后 Cat Café 会另行投递下一条消息。',
  ].join('\n');
}

async function requestDesktopIpc(
  reader: AsyncIterator<unknown>,
  socket: Socket,
  input: {
    readonly sourceClientId: string;
    readonly targetClientId?: string;
    readonly version: number;
    readonly method: string;
    readonly params: Record<string, unknown>;
  },
): Promise<DesktopIpcResponse> {
  const requestId = randomUUID();
  const body = Buffer.from(
    JSON.stringify({
      type: 'request',
      requestId,
      ...input,
    }),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  socket.write(Buffer.concat([header, body]));

  while (true) {
    const next = await reader.next();
    if (next.done) throw new Error(`ChatGPT Desktop IPC ended before responding to ${input.method}`);
    const message = asRecord(next.value);
    if (message?.type !== 'response' || message.requestId !== requestId) continue;
    if (message.resultType !== 'success') {
      throw new Error(`${input.method} failed: ${JSON.stringify(message.error ?? message)}`);
    }
    return message as unknown as DesktopIpcResponse;
  }
}

async function* readDesktopIpcFrames(socket: Socket): AsyncGenerator<unknown> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of socket) {
    buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buffered.length >= 4) {
      const frameBytes = buffered.readUInt32LE(0);
      if (frameBytes > MAX_DESKTOP_IPC_FRAME_BYTES) {
        throw new Error(`ChatGPT Desktop IPC frame is too large: ${frameBytes} bytes`);
      }
      if (buffered.length < frameBytes + 4) break;
      const body = buffered.subarray(4, frameBytes + 4).toString('utf8');
      buffered = buffered.subarray(frameBytes + 4);
      yield JSON.parse(body) as unknown;
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
    `方案分支：${input.designBranch}`,
    `方案提交：${input.designExactSha}`,
    `设计文档：${input.designDocuments.join('、')}`,
    '实现必须以这个方案提交中的所列设计文档为准；方案讨论会话只用于讨论，不是实现依据。',
    `Cat Café projectId：${input.projectId}`,
    `backlogItemId：${input.backlogItemId}`,
    `本任务的 runtimeSessionId：${runtimeSessionId}。连接与后续 heartbeat/report 必须复用这个值。`,
    '先从当前 Git workspace 验证仓库，再通过 Cat Café development-loop MCP 读取并连接唯一匹配的活跃工作。',
    '读取最新 Resume Packet，只执行本轮 nextLegalActions。提交 implementation report 后立即结束当前 turn；Cat Café Review 在后台独立完成，不要等待或轮询。',
    '收到 implementation report 的 Review 系统停止消息后，调用 update_goal 将当前 Goal 标为 complete；不得让 Goal 自动续跑。',
    '后续从原绑定窗口继续时重新读取最新 Resume Packet，再处理修复或用户验收后的合入；不要创建替代窗口。',
  ].join('\n');
}

export function buildDeliveryCycleObjective(input: DesktopDeliveryCycleResumeInput, runtimeSessionId: string): string {
  const action = input.previousLifecycle === 'rejected' ? '验收未通过后的修复交付' : '已验收功能的补充实现';
  return [
    `[开发闭环系统消息] ${input.projectName} · ${input.featureId} · ${input.title}`,
    `用户已开启第 ${input.deliveryCycleNumber} 个交付轮次：${action}。`,
    `Cat Café projectId：${input.projectId}`,
    `backlogItemId：${input.backlogItemId}`,
    `workId：${input.workId}`,
    `新 attemptId：${input.attemptId}`,
    `本交付轮次实现序号：${input.attemptNumber}`,
    `方案分支：${input.designBranch}`,
    `方案提交：${input.designExactSha}`,
    `设计文档：${input.designDocuments.join('、')}`,
    `继续复用 runtimeSessionId：${runtimeSessionId}。`,
    '使用 catcafe-desktop-executor 技能在这个原绑定窗口读取并连接唯一匹配的新活跃 attempt。',
    '实现必须以当前方案提交中的所列中文设计文档为准；旧交付轮次只作为历史证据，不能充当本轮完成证据。',
    '完成实现、测试与精确提交后报告 implementation，然后结束当前 turn；不要轮询 Review，也不要创建替代窗口。',
  ].join('\n');
}

export function buildReviewCompletionObjective(input: {
  readonly projectName: string;
  readonly featureId: string;
  readonly featureTitle: string;
  readonly attemptNumber: number;
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly reviewRoundId: string;
  readonly exactSha: string;
  readonly designBranch: string;
  readonly designExactSha: string;
  readonly designDocuments: readonly string[];
  readonly runtimeSessionId: string;
  readonly operatorDecisions?: readonly string[];
}): string {
  return [
    `[Review 系统消息] ${input.projectName} · ${input.featureId} · ${input.featureTitle}`,
    `第 ${input.attemptNumber} 轮实现的 Review 已完成。`,
    `Cat Café projectId：${input.projectId}`,
    `workId：${input.workId}`,
    `attemptId：${input.attemptId}`,
    `reviewRoundId：${input.reviewRoundId}`,
    `被检视的精确 SHA：${input.exactSha}`,
    `当前方案分支：${input.designBranch}`,
    `当前方案提交：${input.designExactSha}`,
    `本功能设计文档：${input.designDocuments.join('、')}`,
    `继续复用 runtimeSessionId：${input.runtimeSessionId}。`,
    ...(input.operatorDecisions?.length
      ? ['用户已在 Cat Café 作出的架构决策：', ...input.operatorDecisions.map((decision) => `- ${decision}`)]
      : []),
    '使用 catcafe-desktop-executor 技能读取最新 Resume Packet，只执行其中的 nextLegalActions。',
    '所有修复和继续实现都必须以 Resume Packet 中的方案分支精确提交及所列设计文档为准；不要用方案讨论会话替代方案提交。',
    '若需要修复，先在这个原窗口取得递增的新 attempt，再完成修复、测试、提交和报告；若已通过，则向用户展示下一项合法动作。',
    '这是一个单次通知 turn，durable Goal 保持非 active；本轮结束前将 Goal 标为 complete，禁止自动等待或续跑。',
    '本消息由 Cat Café 通过 ChatGPT Desktop 窗口 IPC 投递到原绑定窗口；禁止创建替代窗口或启动第二个 app-server。',
  ].join('\n');
}

async function openChatGptThread(threadId: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Native ChatGPT task wake currently requires macOS');
  await execFileAsync('/usr/bin/open', [`codex://threads/${encodeURIComponent(threadId)}`]);
}

function resolveChatGptCodexCommand(): string {
  const configured = process.env.CHATGPT_APP_CODEX_BIN?.trim() || process.env.CODEX_BIN?.trim();
  if (configured) return configured;
  if (process.platform === 'darwin' && existsSync(CHATGPT_CODEX_BIN)) return CHATGPT_CODEX_BIN;
  return 'codex';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isDesktopOwnerUnavailable(error: unknown): boolean {
  return /no-client-found|no chatgpt desktop window owns bound thread/i.test(String(error));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parsePendingGoalSignal(value: unknown): PendingDesktopTaskGoalSignal | null {
  const input = asRecord(value);
  if (typeof input?.threadId !== 'string' || typeof input.sourcePath !== 'string') return null;
  if (input.kind === 'pause') return { kind: 'pause', threadId: input.threadId, sourcePath: input.sourcePath };
  // Records written before goal pausing was introduced are activation records.
  if ((input.kind === undefined || input.kind === 'activate') && typeof input.objective === 'string') {
    return {
      kind: 'activate',
      threadId: input.threadId,
      sourcePath: input.sourcePath,
      objective: input.objective,
      ...(typeof input.deliveryAcknowledgedAt === 'number' && Number.isFinite(input.deliveryAcknowledgedAt)
        ? { deliveryAcknowledgedAt: input.deliveryAcknowledgedAt }
        : {}),
      ...(typeof input.clientUserMessageId === 'string' ? { clientUserMessageId: input.clientUserMessageId } : {}),
    };
  }
  return null;
}
