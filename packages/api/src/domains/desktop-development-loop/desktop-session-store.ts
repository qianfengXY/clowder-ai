import { isAbsolute } from 'node:path';
import {
  assertValidDesktopDefaultBranch,
  type DesktopSessionBinding,
  normalizeGitHubRepository,
  type WorkspaceBinding,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

export interface BindDesktopSessionInput {
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly runtimeSessionId: string;
  readonly chatRef?: string;
  readonly expectedEpoch: number;
  readonly idempotencyKey: string;
  readonly leaseDurationMs: number;
  readonly workspace: WorkspaceBinding;
  readonly now?: number;
}

export interface HeartbeatDesktopSessionInput {
  readonly projectId: string;
  readonly workId: string;
  readonly bindingEpoch: number;
  readonly runtimeSessionId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly leaseDurationMs: number;
  readonly workspace?: WorkspaceBinding;
  readonly now?: number;
}

type OperationReceipt = { readonly fingerprint: string; readonly binding: DesktopSessionBinding };
type MemorySessionState = {
  current: DesktopSessionBinding | null;
  history: Map<number, DesktopSessionBinding>;
  operations: Map<string, OperationReceipt>;
};

type StoreResult =
  | { kind: 'ok'; binding: DesktopSessionBinding }
  | { kind: 'idempotency_conflict' }
  | { kind: 'stale_epoch'; actualEpoch: number }
  | { kind: 'version_conflict'; actualVersion: number }
  | { kind: 'runtime_session_mismatch' }
  | { kind: 'not_found' };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const FULL_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_LEASE_DURATION_MS = 24 * 60 * 60 * 1_000;

const BIND_LUA = `
local operationField = 'operation:' .. ARGV[2]
local receiptJson = redis.call('HGET', KEYS[1], operationField)
if receiptJson then
  local receipt = cjson.decode(receiptJson)
  if receipt.fingerprint ~= ARGV[3] then
    return cjson.encode({ kind = 'idempotency_conflict' })
  end
  redis.call('SADD', KEYS[2], ARGV[5])
  return cjson.encode({ kind = 'ok', binding = receipt.binding })
end

local currentEpoch = tonumber(redis.call('HGET', KEYS[1], 'currentEpoch') or '0')
local expectedEpoch = tonumber(ARGV[1])
if currentEpoch ~= expectedEpoch then
  return cjson.encode({ kind = 'stale_epoch', actualEpoch = currentEpoch })
end

local currentJson = redis.call('HGET', KEYS[1], 'current')
if currentJson then
  local previous = cjson.decode(currentJson)
  previous.status = 'superseded'
  redis.call('HSET', KEYS[1], 'history:' .. tostring(currentEpoch), cjson.encode(previous))
end

local binding = cjson.decode(ARGV[4])
binding.bindingEpoch = currentEpoch + 1
binding.version = 1
binding.status = 'active'
local bindingJson = cjson.encode(binding)
local receipt = { fingerprint = ARGV[3], binding = binding }
redis.call('HSET', KEYS[1],
  'currentEpoch', tostring(binding.bindingEpoch),
  'current', bindingJson,
  operationField, cjson.encode(receipt))
redis.call('SADD', KEYS[2], ARGV[5])
return cjson.encode({ kind = 'ok', binding = binding })
`;

const HEARTBEAT_LUA = `
local operationField = 'operation:' .. ARGV[2]
local receiptJson = redis.call('HGET', KEYS[1], operationField)
if receiptJson then
  local receipt = cjson.decode(receiptJson)
  if receipt.fingerprint ~= ARGV[3] then
    return cjson.encode({ kind = 'idempotency_conflict' })
  end
  return cjson.encode({ kind = 'ok', binding = receipt.binding })
end

local currentJson = redis.call('HGET', KEYS[1], 'current')
if not currentJson then return cjson.encode({ kind = 'not_found' }) end
local current = cjson.decode(currentJson)
if tonumber(current.bindingEpoch) ~= tonumber(ARGV[1]) then
  return cjson.encode({ kind = 'stale_epoch', actualEpoch = tonumber(current.bindingEpoch) })
end
if current.runtimeSessionId ~= ARGV[4] then
  return cjson.encode({ kind = 'runtime_session_mismatch' })
end
if tonumber(current.version) ~= tonumber(ARGV[5]) then
  return cjson.encode({ kind = 'version_conflict', actualVersion = tonumber(current.version) })
end

local patch = cjson.decode(ARGV[6])
current.leaseExpiresAt = patch.leaseExpiresAt
current.status = 'active'
current.version = tonumber(current.version) + 1
if patch.workspace then current.workspace = patch.workspace end
local receipt = { fingerprint = ARGV[3], binding = current }
redis.call('HSET', KEYS[1],
  'current', cjson.encode(current),
  operationField, cjson.encode(receipt))
return cjson.encode({ kind = 'ok', binding = current })
`;

export class DesktopSessionStore {
  private readonly states = new Map<string, MemorySessionState>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly redis?: RedisClient) {}

  async bind(input: BindDesktopSessionInput): Promise<DesktopSessionBinding> {
    const normalized = normalizeBindInput(input);
    const key = sessionKey(normalized.projectId, normalized.workId);
    const fingerprint = operationFingerprint(normalized);
    const template: DesktopSessionBinding = {
      projectId: normalized.projectId,
      workId: normalized.workId,
      attemptId: normalized.attemptId,
      runtimeSessionId: normalized.runtimeSessionId,
      ...(normalized.chatRef ? { chatRef: normalized.chatRef } : {}),
      bindingEpoch: 0,
      leaseExpiresAt: normalized.now + normalized.leaseDurationMs,
      status: 'active',
      workspace: normalized.workspace,
      version: 0,
    };

    if (this.redis) {
      const raw = await this.redis.eval(
        BIND_LUA,
        2,
        key,
        projectSessionsKey(normalized.projectId),
        String(normalized.expectedEpoch),
        normalized.idempotencyKey,
        fingerprint,
        JSON.stringify(template),
        normalized.workId,
      );
      return unwrapResult(parseStoreResult(raw));
    }

    return this.withLock(key, () => {
      const state = this.requireMemoryState(key);
      const replay = state.operations.get(normalized.idempotencyKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw idempotencyConflict();
        return cloneBinding(replay.binding);
      }
      const currentEpoch = state.current?.bindingEpoch ?? 0;
      if (currentEpoch !== normalized.expectedEpoch) throw staleEpoch(normalized.expectedEpoch, currentEpoch);
      if (state.current) {
        state.history.set(state.current.bindingEpoch, { ...state.current, status: 'superseded' });
      }
      const binding: DesktopSessionBinding = {
        ...template,
        bindingEpoch: currentEpoch + 1,
        version: 1,
      };
      state.current = binding;
      state.operations.set(normalized.idempotencyKey, { fingerprint, binding });
      return cloneBinding(binding);
    });
  }

  async heartbeat(input: HeartbeatDesktopSessionInput): Promise<DesktopSessionBinding> {
    const normalized = normalizeHeartbeatInput(input);
    const key = sessionKey(normalized.projectId, normalized.workId);
    const fingerprint = operationFingerprint(normalized);

    if (this.redis) {
      const raw = await this.redis.eval(
        HEARTBEAT_LUA,
        1,
        key,
        String(normalized.bindingEpoch),
        normalized.idempotencyKey,
        fingerprint,
        normalized.runtimeSessionId,
        String(normalized.expectedVersion),
        JSON.stringify({
          leaseExpiresAt: normalized.now + normalized.leaseDurationMs,
          ...(normalized.workspace ? { workspace: normalized.workspace } : {}),
        }),
      );
      return unwrapResult(parseStoreResult(raw));
    }

    return this.withLock(key, () => {
      const state = this.requireMemoryState(key);
      const replay = state.operations.get(normalized.idempotencyKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw idempotencyConflict();
        return cloneBinding(replay.binding);
      }
      const current = state.current;
      if (!current) throw new Error('Desktop session binding not found');
      if (current.bindingEpoch !== normalized.bindingEpoch) {
        throw staleEpoch(normalized.bindingEpoch, current.bindingEpoch);
      }
      if (current.runtimeSessionId !== normalized.runtimeSessionId) {
        throw new Error('Desktop runtime session does not own the current binding epoch');
      }
      if (current.version !== normalized.expectedVersion) {
        throw new Error(
          `Desktop session binding version conflict: expected ${normalized.expectedVersion}, actual ${current.version}`,
        );
      }
      const binding: DesktopSessionBinding = {
        ...current,
        leaseExpiresAt: normalized.now + normalized.leaseDurationMs,
        status: 'active',
        ...(normalized.workspace ? { workspace: normalized.workspace } : {}),
        version: current.version + 1,
      };
      state.current = binding;
      state.operations.set(normalized.idempotencyKey, { fingerprint, binding });
      return cloneBinding(binding);
    });
  }

  async getCurrent(projectId: string, workId: string, now = Date.now()): Promise<DesktopSessionBinding | null> {
    assertId(projectId, 'projectId');
    assertId(workId, 'workId');
    assertTimestamp(now, 'now');
    const key = sessionKey(projectId, workId);
    const current = this.redis
      ? parseBinding(await this.redis.hget(key, 'current'))
      : (this.states.get(key)?.current ?? null);
    if (!current) return null;
    if (current.status === 'active' && current.leaseExpiresAt <= now) {
      return cloneBinding({ ...current, status: 'detached' });
    }
    return cloneBinding(current);
  }

  async listCurrentByProject(projectId: string, now = Date.now()): Promise<readonly DesktopSessionBinding[]> {
    assertId(projectId, 'projectId');
    assertTimestamp(now, 'now');
    let bindings: DesktopSessionBinding[];
    if (this.redis) {
      const workIds = (await this.redis.smembers(projectSessionsKey(projectId))).sort();
      if (workIds.length === 0) return [];
      const pipeline = this.redis.multi();
      for (const workId of workIds) pipeline.hget(sessionKey(projectId, workId), 'current');
      const rows = await pipeline.exec();
      bindings = (rows ?? []).flatMap(([error, value]) => {
        if (error) throw error;
        const binding = parseBinding(value);
        return binding ? [binding] : [];
      });
    } else {
      bindings = [...this.states.values()].flatMap((state) =>
        state.current?.projectId === projectId ? [state.current] : [],
      );
    }
    return bindings
      .map((binding) =>
        binding.status === 'active' && binding.leaseExpiresAt <= now
          ? cloneBinding({ ...binding, status: 'detached' })
          : cloneBinding(binding),
      )
      .sort((left, right) => left.workId.localeCompare(right.workId));
  }

  async getByEpoch(projectId: string, workId: string, epoch: number): Promise<DesktopSessionBinding | null> {
    assertId(projectId, 'projectId');
    assertId(workId, 'workId');
    assertPositiveInteger(epoch, 'bindingEpoch');
    const key = sessionKey(projectId, workId);
    if (this.redis) {
      const current = parseBinding(await this.redis.hget(key, 'current'));
      if (current?.bindingEpoch === epoch) return current;
      return parseBinding(await this.redis.hget(key, `history:${epoch}`));
    }
    const state = this.states.get(key);
    if (state?.current?.bindingEpoch === epoch) return cloneBinding(state.current);
    const historical = state?.history.get(epoch);
    return historical ? cloneBinding(historical) : null;
  }

  private requireMemoryState(key: string): MemorySessionState {
    const existing = this.states.get(key);
    if (existing) return existing;
    const created: MemorySessionState = { current: null, history: new Map(), operations: new Map() };
    this.states.set(key, created);
    return created;
  }

  private async withLock<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.then(
      () => current,
      () => current,
    );
    this.locks.set(key, next);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
}

function normalizeBindInput(input: BindDesktopSessionInput): Required<Omit<BindDesktopSessionInput, 'chatRef'>> & {
  chatRef?: string;
} {
  const now = input.now ?? Date.now();
  assertId(input.projectId, 'projectId');
  assertId(input.workId, 'workId');
  assertId(input.attemptId, 'attemptId');
  assertOpaqueString(input.runtimeSessionId, 'runtimeSessionId');
  if (input.chatRef !== undefined) assertOpaqueString(input.chatRef, 'chatRef');
  assertNonNegativeInteger(input.expectedEpoch, 'expectedEpoch');
  assertIdempotencyKey(input.idempotencyKey);
  assertLease(input.leaseDurationMs);
  assertTimestamp(now, 'now');
  const workspace = normalizeWorkspace(input.workspace);
  return { ...input, now, workspace };
}

function normalizeHeartbeatInput(
  input: HeartbeatDesktopSessionInput,
): Required<Omit<HeartbeatDesktopSessionInput, 'workspace'>> & { workspace?: WorkspaceBinding } {
  const now = input.now ?? Date.now();
  assertId(input.projectId, 'projectId');
  assertId(input.workId, 'workId');
  assertPositiveInteger(input.bindingEpoch, 'bindingEpoch');
  assertOpaqueString(input.runtimeSessionId, 'runtimeSessionId');
  assertPositiveInteger(input.expectedVersion, 'expectedVersion');
  assertIdempotencyKey(input.idempotencyKey);
  assertLease(input.leaseDurationMs);
  assertTimestamp(now, 'now');
  return { ...input, now, ...(input.workspace ? { workspace: normalizeWorkspace(input.workspace) } : {}) };
}

function normalizeWorkspace(input: WorkspaceBinding): WorkspaceBinding {
  const repository = normalizeGitHubRepository(input.repository?.fullName ?? '');
  if (
    input.repository.host !== repository.host ||
    input.repository.owner !== repository.owner ||
    input.repository.name !== repository.name
  ) {
    throw new Error('Workspace repository identity is inconsistent');
  }
  assertValidDesktopDefaultBranch(input.branch);
  assertFullSha(input.baseSha, 'baseSha');
  assertFullSha(input.currentSha, 'currentSha');
  assertFullSha(input.lastCommittedSha, 'lastCommittedSha');
  if (!isAbsolute(input.worktreePath)) throw new Error('worktreePath must be absolute');
  assertTimestamp(input.validatedAt, 'workspace.validatedAt');
  return { ...input, repository, branch: input.branch.trim() };
}

function sessionKey(projectId: string, workId: string): string {
  return `desktop-development:session:${encodeURIComponent(projectId)}:${encodeURIComponent(workId)}`;
}

function projectSessionsKey(projectId: string): string {
  return `desktop-development:project-sessions:${encodeURIComponent(projectId)}`;
}

function parseStoreResult(value: unknown): StoreResult {
  if (typeof value !== 'string') throw new Error('Invalid Desktop session store result');
  const result = JSON.parse(value) as StoreResult;
  if (!result || typeof result !== 'object' || typeof result.kind !== 'string') {
    throw new Error('Invalid Desktop session store result');
  }
  return result;
}

function parseBinding(value: unknown): DesktopSessionBinding | null {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as DesktopSessionBinding;
  } catch {
    return null;
  }
}

function cloneBinding(binding: DesktopSessionBinding): DesktopSessionBinding {
  return {
    ...binding,
    workspace: {
      ...binding.workspace,
      repository: { ...binding.workspace.repository },
    },
  };
}

function operationFingerprint<T extends { readonly now: number }>(value: T): string {
  const { now: _serverTime, ...stable } = value;
  return JSON.stringify(stable);
}

function unwrapResult(result: StoreResult): DesktopSessionBinding {
  switch (result.kind) {
    case 'ok':
      return result.binding;
    case 'idempotency_conflict':
      throw idempotencyConflict();
    case 'stale_epoch':
      throw staleEpoch(-1, result.actualEpoch);
    case 'version_conflict':
      throw new Error(`Desktop session binding version conflict: actual ${result.actualVersion}`);
    case 'runtime_session_mismatch':
      throw new Error('Desktop runtime session does not own the current binding epoch');
    case 'not_found':
      throw new Error('Desktop session binding not found');
  }
}

function idempotencyConflict(): Error {
  return new Error('Desktop session idempotency key reused with different input');
}

function staleEpoch(expected: number, actual: number): Error {
  return new Error(`Stale binding epoch: expected ${expected}, actual ${actual}`);
}

function assertId(value: string, name: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`${name} is invalid`);
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_PATTERN.test(value)) throw new Error('idempotencyKey is invalid');
}

function assertOpaqueString(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
    throw new Error(`${name} is invalid`);
  }
}

function assertFullSha(value: string, name: string): void {
  if (!FULL_SHA_PATTERN.test(value)) throw new Error(`${name} must be a full Git SHA`);
}

function assertLease(value: number): void {
  if (!Number.isInteger(value) || value < 1_000 || value > MAX_LEASE_DURATION_MS) {
    throw new Error('leaseDurationMs is invalid');
  }
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} is invalid`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} is invalid`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} is invalid`);
}
