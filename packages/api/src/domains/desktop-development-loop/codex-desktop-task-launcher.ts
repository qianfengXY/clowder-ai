import { randomUUID } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { runCodexAppServerWithRecovery } from '../cats/services/agents/providers/CodexAppServerRunner.js';
import { createDirectAgentCarrierSession } from '../cats/services/agents/providers/DirectAgentCarrierSession.js';

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

/** Creates a native, persisted Codex Desktop task and lets its first turn connect through the scoped MCP flow. */
export class CodexDesktopTaskLauncher implements DesktopTaskLauncher {
  private readonly active = new Map<string, Promise<DesktopTaskLaunchResult>>();
  private readonly completed = new Map<string, DesktopTaskLaunchResult>();

  constructor(private readonly redis?: RedisClient) {}

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
      if (record.status === 'created' && exists) {
        const existing = { status: 'created', threadId: record.threadId } as const;
        this.completed.set(`${input.projectId}:${input.backlogItemId}`, existing);
        return existing;
      }
      if (!exists) {
        await this.clearRecord(input.projectId, input.backlogItemId);
        record = null;
      }
    }
    const resumableThreadId = record?.status === 'starting' ? record.threadId : undefined;
    const result = await this.start(input, resumableThreadId, async (threadId) => {
      await this.writeRecord(input.projectId, input.backlogItemId, { status: 'starting', threadId });
    });
    this.completed.set(`${input.projectId}:${input.backlogItemId}`, result);
    await this.writeRecord(input.projectId, input.backlogItemId, result);
    return result;
  }

  private async start(
    input: DesktopTaskLaunchInput,
    existingThreadId?: string,
    onThreadStarted?: (threadId: string) => Promise<void>,
  ): Promise<DesktopTaskLaunchResult> {
    let threadId: string | null = null;
    let accepted = false;
    let resolveThread!: (value: DesktopTaskLaunchResult) => void;
    let rejectThread!: (error: Error) => void;
    const threadReady = new Promise<DesktopTaskLaunchResult>((resolve, reject) => {
      resolveThread = resolve;
      rejectThread = reject;
    });
    const runtimeSessionId = randomUUID();
    const abortController = new AbortController();
    const taskName = buildDesktopTaskName(input.featureId, input.title);
    const prompt = [
      `开发功能：${taskName}`,
      '使用 catcafe-desktop-executor 技能执行这个已绑定的 Cat Café managed work。',
      `项目：${input.projectName}（${input.repository}）`,
      `功能：${input.featureId} — ${input.title}`,
      `Cat Café projectId：${input.projectId}`,
      `backlogItemId：${input.backlogItemId}`,
      `本任务的 runtimeSessionId：${runtimeSessionId}。连接与后续 heartbeat/report 必须复用这个值。`,
      '先从当前 Git workspace 验证仓库，再通过 Cat Café development-loop MCP 读取并连接唯一匹配的活跃工作。',
      '连接成功后，在这个任务中向用户说明当前 Resume Packet 和下一步；严格遵循技能中的权限、Review 与合入约束。',
    ].join('\n');

    void (async () => {
      try {
        for await (const event of runCodexAppServerWithRecovery({
          sessionFactory: createDirectAgentCarrierSession,
          sessionOptions: {
            command: process.env.CODEX_BIN?.trim() || 'codex',
            args: ['app-server', '--stdio'],
            cwd: input.sourcePath,
            invocationId: `desktop-feature-${input.backlogItemId}-${Date.now()}`,
          },
          runInput: {
            prompt,
            threadName: taskName,
            thread: existingThreadId ? { kind: 'resume', threadId: existingThreadId } : { kind: 'start' },
            cwd: input.sourcePath,
            sandbox: 'danger-full-access',
            approvalPolicy: 'on-request',
            signal: abortController.signal,
          },
          retryBudget: 0,
        })) {
          if (!threadId && isThreadStarted(event)) {
            threadId = event.thread_id;
            await onThreadStarted?.(threadId);
          }
          if (!accepted && threadId && isTurnAccepted(event)) {
            accepted = true;
            resolveThread({ status: 'created', threadId });
          }
        }
        if (!accepted) rejectThread(new Error('ChatGPT Desktop task ended before its first turn was accepted'));
      } catch (error) {
        if (!accepted) rejectThread(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    const timeout = setTimeout(
      () => abortController.abort(new Error('Timed out while creating the ChatGPT Desktop task')),
      15_000,
    );
    try {
      return await threadReady;
    } finally {
      clearTimeout(timeout);
    }
  }

  private storageKey(projectId: string, backlogItemId: string): string {
    return `desktop-development:feature-task:${projectId}:${backlogItemId}`;
  }

  private async readRecord(
    projectId: string,
    backlogItemId: string,
  ): Promise<{ readonly status: 'starting' | 'created'; readonly threadId: string } | null> {
    const raw = await this.redis?.get(this.storageKey(projectId, backlogItemId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { status?: unknown; threadId?: unknown };
      if (typeof parsed.threadId !== 'string') return null;
      return { status: parsed.status === 'starting' ? 'starting' : 'created', threadId: parsed.threadId };
    } catch {
      return null;
    }
  }

  private async writeRecord(
    projectId: string,
    backlogItemId: string,
    record: { readonly status: 'starting' | 'created'; readonly threadId: string },
  ): Promise<void> {
    await this.redis?.set(this.storageKey(projectId, backlogItemId), JSON.stringify(record));
  }

  private async clearRecord(projectId: string, backlogItemId: string): Promise<void> {
    this.completed.delete(`${projectId}:${backlogItemId}`);
    await this.redis?.del(this.storageKey(projectId, backlogItemId));
  }

  /** App-server read is used only on an explicit retry, not on the polling status path. */
  private async threadExists(input: DesktopTaskLaunchInput, threadId: string): Promise<boolean> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 5_000);
    const session = await createDirectAgentCarrierSession({
      command: process.env.CODEX_BIN?.trim() || 'codex',
      args: ['app-server', '--stdio'],
      cwd: input.sourcePath,
      invocationId: `desktop-feature-check-${input.backlogItemId}-${Date.now()}`,
      signal: abortController.signal,
    });
    try {
      await session.write({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'cat-cafe', title: 'Clowder AI', version: '1' }, capabilities: {} },
      });
      for await (const value of session.read()) {
        if (!value || typeof value !== 'object') continue;
        const message = value as { id?: unknown; error?: unknown; result?: unknown };
        if (message.id === 1) {
          await session.write({ method: 'initialized' });
          await session.write({ id: 2, method: 'thread/read', params: { threadId, includeTurns: false } });
        } else if (message.id === 2) {
          if (message.error !== undefined) {
            const detail = JSON.stringify(message.error);
            if (/not[ _-]?found|does not exist|unknown thread/i.test(detail)) return false;
            throw new Error(`Unable to validate the existing ChatGPT Desktop task: ${detail}`);
          }
          const result = message.result as { thread?: { archived?: unknown } } | undefined;
          return result?.thread?.archived !== true;
        }
      }
      throw new Error('ChatGPT Desktop task validation ended without a response');
    } catch (error) {
      if (abortController.signal.aborted) throw new Error('Timed out while validating the ChatGPT Desktop task');
      throw error;
    } finally {
      clearTimeout(timeout);
      await session.close();
    }
  }
}

function isThreadStarted(value: unknown): value is { type: 'thread.started'; thread_id: string } {
  if (!value || typeof value !== 'object') return false;
  const event = value as { type?: unknown; thread_id?: unknown };
  return event.type === 'thread.started' && typeof event.thread_id === 'string';
}

function isTurnAccepted(value: unknown): value is {
  type: 'app_server.lifecycle';
  lifecycle: { stage: 'turn_accepted'; turnAccepted: true };
} {
  if (!value || typeof value !== 'object') return false;
  const event = value as { type?: unknown; lifecycle?: { stage?: unknown; turnAccepted?: unknown } };
  return (
    event.type === 'app_server.lifecycle' &&
    event.lifecycle?.stage === 'turn_accepted' &&
    event.lifecycle.turnAccepted === true
  );
}
