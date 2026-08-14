import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { connectCodexAppServerSocket } from '../cats/services/agents/providers/CodexUnixWebSocketSession.js';
import type { AgentCarrierSession, AgentCarrierSessionFactory } from '../cats/services/types.js';

const execFileAsync = promisify(execFile);
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

export interface DesktopTaskLauncher {
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
  private readonly completed = new Map<string, DesktopTaskLaunchResult>();
  private readonly sessionFactory: AgentCarrierSessionFactory;
  private readonly openThread: (threadId: string) => Promise<void>;
  private readonly daemonSocketPath: string;

  constructor(
    private readonly redis?: RedisClient,
    options: DesktopTaskLauncherOptions = {},
  ) {
    this.sessionFactory = options.sessionFactory ?? (async () => connectCodexAppServerSocket(this.daemonSocketPath));
    this.openThread = options.openThread ?? openChatGptThread;
    this.daemonSocketPath = options.daemonSocketPath ?? process.env.CODEX_APP_SERVER_SOCKET ?? DEFAULT_DAEMON_SOCKET;
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
          status: 'active',
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

  private storageKey(projectId: string, backlogItemId: string): string {
    return `desktop-development:feature-task:${projectId}:${backlogItemId}`;
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

async function openChatGptThread(threadId: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Native ChatGPT task wake currently requires macOS');
  await execFileAsync('/usr/bin/open', [`codex://threads/${encodeURIComponent(threadId)}`]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
