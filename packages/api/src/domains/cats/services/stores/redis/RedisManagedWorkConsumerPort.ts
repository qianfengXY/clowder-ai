import { createHash } from 'node:crypto';
import {
  MANAGED_WORK_CONSUMER_IDS,
  type ManagedWorkConsumerId,
  type ManagedWorkConsumerSnapshot,
  type ManagedWorkConsumerState,
  type ManagedWorkEvidence,
  type ManagedWorkEvidenceInput,
  type ManagedWorkExecutorActor,
  type WorkAdmission,
  type WorkAttempt,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  AppendManagedWorkEvidenceInput,
  ClaimManagedWorkAttemptInput,
  CreateNextManagedWorkAttemptInput,
  IManagedWorkConsumerPort,
  ManagedWorkEvidenceAppendResult,
  ManagedWorkIdentityInput,
  TransitionManagedWorkInput,
} from '../ports/ManagedWorkConsumerPort.js';
import { deriveManagedWorkAttemptId, ManagedWorkKeys } from '../redis-keys/managed-work-keys.js';

const FULL_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;

const CLAIM_ATTEMPT_LUA = `
local receiptJson = redis.call('GET', KEYS[4])
if receiptJson then
  local receipt = cjson.decode(receiptJson)
  if receipt.fingerprint ~= ARGV[1] then return 'IDEMPOTENCY_CONFLICT' end
  return 'OK:' .. cjson.encode(receipt.result)
end

local admissionJson = redis.call('GET', KEYS[1])
local attemptJson = redis.call('GET', KEYS[2])
local stateJson = redis.call('GET', KEYS[3])
if not admissionJson or not attemptJson or not stateJson then return 'NOT_FOUND' end
local admission = cjson.decode(admissionJson)
local attempt = cjson.decode(attemptJson)
local state = cjson.decode(stateJson)
if admission.ownerUserId ~= ARGV[2] or admission.workId ~= ARGV[3] then return 'NOT_FOUND' end
if attempt.workId ~= ARGV[3] or attempt.attemptId ~= ARGV[4] then return 'NOT_FOUND' end
if state.consumerId ~= ARGV[5] or state.workId ~= ARGV[3] then return 'STATE_INVALID' end
if state.lifecycle ~= 'active' then return 'TERMINAL:' .. state.lifecycle end
if state.currentAttemptId ~= ARGV[4] then return 'STALE_ATTEMPT:' .. state.currentAttemptId end
if tonumber(state.version) ~= tonumber(ARGV[6]) then return 'VERSION_CONFLICT:' .. tostring(state.version) end

local executor = cjson.decode(ARGV[7])
if attempt.executorActor and attempt.executorActor ~= cjson.null then
  local sameExecutor = attempt.executorActor.kind == executor.kind
  if sameExecutor and executor.kind == 'cat' then
    sameExecutor = attempt.executorActor.catId == executor.catId
  elseif sameExecutor and executor.kind == 'external_actor' then
    sameExecutor = attempt.executorActor.actorId == executor.actorId
  end
  if not sameExecutor then return 'EXECUTOR_CONFLICT' end
elseif attempt.executorCatId and attempt.executorCatId ~= cjson.null and executor.kind ~= 'cat' then
  return 'EXECUTOR_CONFLICT'
elseif attempt.executorCatId and attempt.executorCatId ~= cjson.null and attempt.executorCatId ~= executor.catId then
  return 'EXECUTOR_CONFLICT'
end
attempt.executorActor = executor
if executor.kind == 'cat' then attempt.executorCatId = executor.catId else attempt.executorCatId = cjson.null end
if not attempt.executorBoundAt or attempt.executorBoundAt == cjson.null then
  attempt.executorBoundAt = tonumber(ARGV[8])
end
state.version = tonumber(state.version) + 1
redis.call('SET', KEYS[2], cjson.encode(attempt))
redis.call('SET', KEYS[3], cjson.encode(state))
local result = { admission = admission, attempt = attempt, state = state, evidence = {} }
redis.call('SET', KEYS[4], cjson.encode({ fingerprint = ARGV[1], result = result }))
return 'OK:' .. cjson.encode(result)
`;

const CREATE_NEXT_ATTEMPT_LUA = `
local receiptJson = redis.call('GET', KEYS[5])
if receiptJson then
  local receipt = cjson.decode(receiptJson)
  if receipt.fingerprint ~= ARGV[1] then return 'IDEMPOTENCY_CONFLICT' end
  return 'OK:' .. cjson.encode(receipt.result)
end

local admissionJson = redis.call('GET', KEYS[1])
local fromAttemptJson = redis.call('GET', KEYS[2])
local stateJson = redis.call('GET', KEYS[3])
if not admissionJson or not fromAttemptJson or not stateJson then return 'NOT_FOUND' end
local admission = cjson.decode(admissionJson)
local fromAttempt = cjson.decode(fromAttemptJson)
local state = cjson.decode(stateJson)
if admission.ownerUserId ~= ARGV[2] or admission.workId ~= ARGV[3] then return 'NOT_FOUND' end
if fromAttempt.workId ~= ARGV[3] or fromAttempt.attemptId ~= ARGV[4] then return 'NOT_FOUND' end
if state.consumerId ~= ARGV[5] or state.workId ~= ARGV[3] then return 'STATE_INVALID' end
if state.lifecycle ~= 'active' then return 'TERMINAL:' .. state.lifecycle end
if state.currentAttemptId ~= ARGV[4] then return 'STALE_ATTEMPT:' .. state.currentAttemptId end
if tonumber(state.version) ~= tonumber(ARGV[6]) then return 'VERSION_CONFLICT:' .. tostring(state.version) end

local nextAttempt = cjson.decode(ARGV[7])
local expectedNumber = tonumber(state.currentAttemptNumber) + 1
if tonumber(nextAttempt.attemptNumber) ~= expectedNumber then return 'ATTEMPT_ORDER_CONFLICT' end
local existingNext = redis.call('GET', KEYS[4])
if existingNext then return 'ATTEMPT_ALREADY_EXISTS' end
state.currentAttemptId = nextAttempt.attemptId
state.currentAttemptNumber = nextAttempt.attemptNumber
state.version = tonumber(state.version) + 1
redis.call('SET', KEYS[4], cjson.encode(nextAttempt))
redis.call('SET', KEYS[3], cjson.encode(state))
local result = { admission = admission, attempt = nextAttempt, state = state, evidence = {} }
redis.call('SET', KEYS[5], cjson.encode({ fingerprint = ARGV[1], result = result }))
return 'OK:' .. cjson.encode(result)
`;

const APPEND_EVIDENCE_LUA = `
local receiptJson = redis.call('GET', KEYS[5])
if receiptJson then
  local receipt = cjson.decode(receiptJson)
  if receipt.fingerprint ~= ARGV[1] then return 'IDEMPOTENCY_CONFLICT' end
  return 'OK:' .. cjson.encode(receipt.result)
end

local admissionJson = redis.call('GET', KEYS[1])
local attemptJson = redis.call('GET', KEYS[2])
local stateJson = redis.call('GET', KEYS[3])
if not admissionJson or not attemptJson or not stateJson then return 'NOT_FOUND' end
local admission = cjson.decode(admissionJson)
local attempt = cjson.decode(attemptJson)
local state = cjson.decode(stateJson)
if admission.ownerUserId ~= ARGV[2] or admission.workId ~= ARGV[3] then return 'NOT_FOUND' end
if attempt.workId ~= ARGV[3] or attempt.attemptId ~= ARGV[4] then return 'NOT_FOUND' end
if state.consumerId ~= ARGV[5] or state.workId ~= ARGV[3] then return 'STATE_INVALID' end
if state.lifecycle ~= 'active' then return 'TERMINAL:' .. state.lifecycle end
if state.currentAttemptId ~= ARGV[4] then return 'STALE_ATTEMPT:' .. state.currentAttemptId end
if tonumber(state.version) ~= tonumber(ARGV[6]) then return 'VERSION_CONFLICT:' .. tostring(state.version) end

local evidence = cjson.decode(ARGV[7])
if redis.call('HEXISTS', KEYS[4], evidence.evidenceId) == 1 then return 'EVIDENCE_CONFLICT' end
state.version = tonumber(state.version) + 1
redis.call('HSET', KEYS[4], evidence.evidenceId, cjson.encode(evidence))
redis.call('SET', KEYS[3], cjson.encode(state))
local result = { evidence = evidence, state = state }
redis.call('SET', KEYS[5], cjson.encode({ fingerprint = ARGV[1], result = result }))
return 'OK:' .. cjson.encode(result)
`;

const TRANSITION_LUA = `
local receiptJson = redis.call('GET', KEYS[5])
if receiptJson then
  local receipt = cjson.decode(receiptJson)
  if receipt.fingerprint ~= ARGV[1] then return 'IDEMPOTENCY_CONFLICT' end
  return 'OK:' .. cjson.encode(receipt.result)
end

local admissionJson = redis.call('GET', KEYS[1])
local attemptJson = redis.call('GET', KEYS[2])
local stateJson = redis.call('GET', KEYS[3])
if not admissionJson or not attemptJson or not stateJson then return 'NOT_FOUND' end
local admission = cjson.decode(admissionJson)
local attempt = cjson.decode(attemptJson)
local state = cjson.decode(stateJson)
if admission.ownerUserId ~= ARGV[2] or admission.workId ~= ARGV[3] then return 'NOT_FOUND' end
if attempt.workId ~= ARGV[3] or attempt.attemptId ~= ARGV[4] then return 'NOT_FOUND' end
if state.consumerId ~= ARGV[5] or state.workId ~= ARGV[3] then return 'STATE_INVALID' end
if state.lifecycle ~= 'active' then return 'TERMINAL:' .. state.lifecycle end
if state.currentAttemptId ~= ARGV[4] then return 'STALE_ATTEMPT:' .. state.currentAttemptId end
if tonumber(state.version) ~= tonumber(ARGV[6]) then return 'VERSION_CONFLICT:' .. tostring(state.version) end

local target = ARGV[7]
local exactSha = ARGV[8]
local implementation = false
local greenReview = false
local merged = false
local accepted = false
local rejected = false
local evidenceRows = redis.call('HVALS', KEYS[4])
for _, evidenceJson in ipairs(evidenceRows) do
  local evidence = cjson.decode(evidenceJson)
  if evidence.attemptId == ARGV[4] and evidence.exactSha == exactSha then
    if evidence.kind == 'implementation_committed' then implementation = true end
    if evidence.kind == 'review_completed'
      and tonumber(evidence.openFindingCount) == 0
      and evidence.checksPassed == true then greenReview = true end
    if evidence.kind == 'merged' then merged = true end
    if evidence.kind == 'acceptance_recorded' and evidence.accepted == true then accepted = true end
    if evidence.kind == 'acceptance_recorded' and evidence.accepted == false then rejected = true end
    if evidence.kind == 'work_rejected' then rejected = true end
  end
end

if target == 'accepted' and not (implementation and greenReview and merged and accepted) then
  return 'ACCEPTANCE_EVIDENCE_INCOMPLETE'
end
if target == 'rejected' and not rejected then return 'REJECTION_EVIDENCE_INCOMPLETE' end
state.lifecycle = target
state.terminalExactSha = exactSha
state.terminalAt = tonumber(ARGV[9])
state.version = tonumber(state.version) + 1
redis.call('SET', KEYS[3], cjson.encode(state))
redis.call('SET', KEYS[5], cjson.encode({ fingerprint = ARGV[1], result = state }))
return 'OK:' .. cjson.encode(state)
`;

export class RedisManagedWorkConsumerPort implements IManagedWorkConsumerPort {
  constructor(private readonly redis: RedisClient) {}

  async read(input: ManagedWorkIdentityInput): Promise<ManagedWorkConsumerSnapshot> {
    const normalized = normalizeIdentity(input);
    const admissionKey = ManagedWorkKeys.admission(normalized.workId);
    const attemptKey = ManagedWorkKeys.attempt(normalized.attemptId);
    const stateKey = ManagedWorkKeys.consumerState(normalized.consumerId, normalized.workId);
    const [admissionRaw, attemptRaw, stateRaw] = await this.redis.mget(admissionKey, attemptKey, stateKey);
    const admission = parseAdmission(admissionRaw, normalized);
    const attempt = parseAttempt(attemptRaw, normalized.workId, normalized.attemptId);
    let state = stateRaw ? parseState(stateRaw, normalized.consumerId, normalized.workId) : null;
    if (!state) {
      if (admission.initialAttemptId !== attempt.attemptId || attempt.attemptNumber !== 1) {
        throw new Error('Managed-work initial identity bundle is invalid');
      }
      const initial: ManagedWorkConsumerState = {
        consumerId: normalized.consumerId,
        workId: normalized.workId,
        currentAttemptId: admission.initialAttemptId,
        currentAttemptNumber: 1,
        lifecycle: 'active',
        version: 1,
      };
      await this.redis.set(stateKey, JSON.stringify(initial), 'NX');
      const canonical = await this.redis.get(stateKey);
      state = parseState(canonical, normalized.consumerId, normalized.workId);
    }
    const evidence = await this.readEvidence(normalized.consumerId, normalized.workId);
    return { admission, attempt, state, evidence };
  }

  async claimAttempt(input: ClaimManagedWorkAttemptInput): Promise<ManagedWorkConsumerSnapshot> {
    const normalized = normalizeClaim(input);
    await this.read(normalized);
    const fingerprint = operationFingerprint(normalized);
    const raw = await this.redis.eval(
      CLAIM_ATTEMPT_LUA,
      4,
      ManagedWorkKeys.admission(normalized.workId),
      ManagedWorkKeys.attempt(normalized.attemptId),
      ManagedWorkKeys.consumerState(normalized.consumerId, normalized.workId),
      ManagedWorkKeys.consumerReceipt(normalized.consumerId, normalized.workId, 'claim', normalized.idempotencyKey),
      fingerprint,
      normalized.ownerUserId,
      normalized.workId,
      normalized.attemptId,
      normalized.consumerId,
      String(normalized.expectedVersion),
      JSON.stringify(normalized.executor),
      String(normalized.now),
    );
    return parseSnapshotResult(raw);
  }

  async createNextAttempt(input: CreateNextManagedWorkAttemptInput): Promise<ManagedWorkConsumerSnapshot> {
    const normalized = normalizeNextAttempt(input);
    const current = await this.read({
      consumerId: normalized.consumerId,
      ownerUserId: normalized.ownerUserId,
      workId: normalized.workId,
      attemptId: normalized.fromAttemptId,
    });
    const attemptNumber = current.state.currentAttemptNumber + 1;
    const attemptId = deriveManagedWorkAttemptId(normalized.workId, attemptNumber);
    const attempt: WorkAttempt = {
      attemptId,
      workId: normalized.workId,
      attemptNumber,
      executorCatId: normalized.executor.kind === 'cat' ? normalized.executor.catId : null,
      executorActor: normalized.executor,
      createdAt: normalized.now,
      executorBoundAt: normalized.now,
    };
    const fingerprint = operationFingerprint(normalized);
    const raw = await this.redis.eval(
      CREATE_NEXT_ATTEMPT_LUA,
      5,
      ManagedWorkKeys.admission(normalized.workId),
      ManagedWorkKeys.attempt(normalized.fromAttemptId),
      ManagedWorkKeys.consumerState(normalized.consumerId, normalized.workId),
      ManagedWorkKeys.attempt(attemptId),
      ManagedWorkKeys.consumerReceipt(
        normalized.consumerId,
        normalized.workId,
        'next-attempt',
        normalized.idempotencyKey,
      ),
      fingerprint,
      normalized.ownerUserId,
      normalized.workId,
      normalized.fromAttemptId,
      normalized.consumerId,
      String(normalized.expectedVersion),
      JSON.stringify(attempt),
    );
    return parseSnapshotResult(raw);
  }

  async appendEvidence(input: AppendManagedWorkEvidenceInput): Promise<ManagedWorkEvidenceAppendResult> {
    const normalized = normalizeEvidenceAppend(input);
    await this.read(normalized);
    const evidence: ManagedWorkEvidence = {
      ...normalized.evidence,
      evidenceId: deriveEvidenceId(
        normalized.consumerId,
        normalized.workId,
        normalized.attemptId,
        normalized.idempotencyKey,
      ),
      workId: normalized.workId,
      attemptId: normalized.attemptId,
      consumerId: normalized.consumerId,
      recordedAt: normalized.now,
    };
    const fingerprint = operationFingerprint(normalized);
    const raw = await this.redis.eval(
      APPEND_EVIDENCE_LUA,
      5,
      ManagedWorkKeys.admission(normalized.workId),
      ManagedWorkKeys.attempt(normalized.attemptId),
      ManagedWorkKeys.consumerState(normalized.consumerId, normalized.workId),
      ManagedWorkKeys.consumerEvidence(normalized.consumerId, normalized.workId),
      ManagedWorkKeys.consumerReceipt(
        normalized.consumerId,
        normalized.workId,
        'append-evidence',
        normalized.idempotencyKey,
      ),
      fingerprint,
      normalized.ownerUserId,
      normalized.workId,
      normalized.attemptId,
      normalized.consumerId,
      String(normalized.expectedVersion),
      JSON.stringify(evidence),
    );
    return parseEvidenceResult(raw);
  }

  async transition(input: TransitionManagedWorkInput): Promise<ManagedWorkConsumerState> {
    const normalized = normalizeTransition(input);
    await this.read(normalized);
    const fingerprint = operationFingerprint(normalized);
    const raw = await this.redis.eval(
      TRANSITION_LUA,
      5,
      ManagedWorkKeys.admission(normalized.workId),
      ManagedWorkKeys.attempt(normalized.attemptId),
      ManagedWorkKeys.consumerState(normalized.consumerId, normalized.workId),
      ManagedWorkKeys.consumerEvidence(normalized.consumerId, normalized.workId),
      ManagedWorkKeys.consumerReceipt(
        normalized.consumerId,
        normalized.workId,
        'transition',
        normalized.idempotencyKey,
      ),
      fingerprint,
      normalized.ownerUserId,
      normalized.workId,
      normalized.attemptId,
      normalized.consumerId,
      String(normalized.expectedVersion),
      normalized.target,
      normalized.exactSha,
      String(normalized.now),
    );
    return parseStateResult(raw, normalized.consumerId, normalized.workId);
  }

  private async readEvidence(consumerId: ManagedWorkConsumerId, workId: string): Promise<ManagedWorkEvidence[]> {
    const rows = await this.redis.hvals(ManagedWorkKeys.consumerEvidence(consumerId, workId));
    return rows
      .map((row) => parseJson<ManagedWorkEvidence>(row, 'managed-work evidence'))
      .sort((left, right) => left.recordedAt - right.recordedAt || left.evidenceId.localeCompare(right.evidenceId));
  }
}

function normalizeIdentity<T extends ManagedWorkIdentityInput>(input: T): T {
  assertConsumer(input.consumerId);
  assertId(input.ownerUserId, 'ownerUserId');
  assertId(input.workId, 'workId');
  assertId(input.attemptId, 'attemptId');
  return input;
}

function normalizeClaim(input: ClaimManagedWorkAttemptInput): Required<ClaimManagedWorkAttemptInput> {
  normalizeIdentity(input);
  assertExecutor(input.executor);
  assertPositiveInteger(input.expectedVersion, 'expectedVersion');
  assertId(input.idempotencyKey, 'idempotencyKey');
  const now = input.now ?? Date.now();
  assertTimestamp(now);
  return { ...input, now };
}

function normalizeNextAttempt(
  input: CreateNextManagedWorkAttemptInput,
): Required<CreateNextManagedWorkAttemptInput> {
  assertConsumer(input.consumerId);
  assertId(input.ownerUserId, 'ownerUserId');
  assertId(input.workId, 'workId');
  assertId(input.fromAttemptId, 'fromAttemptId');
  assertExecutor(input.executor);
  assertPositiveInteger(input.expectedVersion, 'expectedVersion');
  assertId(input.idempotencyKey, 'idempotencyKey');
  const now = input.now ?? Date.now();
  assertTimestamp(now);
  return { ...input, now };
}

function normalizeEvidenceAppend(
  input: AppendManagedWorkEvidenceInput,
): Required<AppendManagedWorkEvidenceInput> {
  normalizeIdentity(input);
  assertPositiveInteger(input.expectedVersion, 'expectedVersion');
  assertId(input.idempotencyKey, 'idempotencyKey');
  const now = input.now ?? Date.now();
  assertTimestamp(now);
  return { ...input, evidence: normalizeEvidence(input.evidence), now };
}

function normalizeTransition(input: TransitionManagedWorkInput): Required<TransitionManagedWorkInput> {
  normalizeIdentity(input);
  if (input.target !== 'accepted' && input.target !== 'rejected') throw new Error('Invalid managed-work transition');
  assertFullSha(input.exactSha, 'exactSha');
  assertPositiveInteger(input.expectedVersion, 'expectedVersion');
  assertId(input.idempotencyKey, 'idempotencyKey');
  const now = input.now ?? Date.now();
  assertTimestamp(now);
  return { ...input, exactSha: input.exactSha.toLowerCase(), now };
}

function normalizeEvidence(input: ManagedWorkEvidenceInput): ManagedWorkEvidenceInput {
  if (!input || typeof input !== 'object') throw new Error('Managed-work evidence must be an object');
  assertFullSha(input.exactSha, 'evidence.exactSha');
  const exactSha = input.exactSha.toLowerCase();
  switch (input.kind) {
    case 'implementation_committed':
      return { kind: input.kind, exactSha };
    case 'review_completed':
      assertId(input.reviewRoundId, 'reviewRoundId');
      if (!Number.isInteger(input.openFindingCount) || input.openFindingCount < 0) {
        throw new Error('openFindingCount is invalid');
      }
      if (typeof input.checksPassed !== 'boolean') throw new Error('checksPassed is invalid');
      return { ...input, exactSha };
    case 'merge_confirmed':
      assertPositiveInteger(input.bindingEpoch, 'bindingEpoch');
      assertId(input.confirmedByUserId, 'confirmedByUserId');
      return { ...input, exactSha };
    case 'merged':
      assertFullSha(input.mergeCommitSha, 'mergeCommitSha');
      return { ...input, exactSha, mergeCommitSha: input.mergeCommitSha.toLowerCase() };
    case 'acceptance_recorded':
      if (typeof input.accepted !== 'boolean') throw new Error('accepted is invalid');
      return { ...input, exactSha };
    case 'work_rejected':
      assertOpaqueString(input.reason, 'reason');
      return { ...input, exactSha, reason: input.reason.trim() };
    default:
      throw new Error('Unsupported managed-work evidence kind');
  }
}

function assertExecutor(executor: ManagedWorkExecutorActor): void {
  if (!executor || typeof executor !== 'object') throw new Error('executor is invalid');
  if (executor.kind === 'cat') {
    assertId(executor.catId, 'executor.catId');
    return;
  }
  if (executor.kind === 'external_actor' && executor.actorId === 'chatgpt-desktop-dev') return;
  throw new Error('executor is invalid');
}

function parseAdmission(raw: string | null, expected: ManagedWorkIdentityInput): WorkAdmission {
  if (!raw) throw managedWorkNotFound();
  const admission = parseJson<WorkAdmission>(raw, 'managed-work admission');
  if (admission.workId !== expected.workId || admission.ownerUserId !== expected.ownerUserId) {
    throw managedWorkNotFound();
  }
  return admission;
}

function parseAttempt(raw: string | null, workId: string, attemptId: string): WorkAttempt {
  if (!raw) throw managedWorkNotFound();
  const attempt = parseJson<WorkAttempt>(raw, 'managed-work attempt');
  if (attempt.workId !== workId || attempt.attemptId !== attemptId) throw managedWorkNotFound();
  if (!Number.isInteger(attempt.attemptNumber) || attempt.attemptNumber < 1) {
    throw new Error('Managed-work attempt is invalid');
  }
  return attempt.executorActor || !attempt.executorCatId
    ? attempt
    : { ...attempt, executorActor: { kind: 'cat', catId: attempt.executorCatId } };
}

function parseState(
  raw: string | null,
  consumerId: ManagedWorkConsumerId,
  workId: string,
): ManagedWorkConsumerState {
  if (!raw) throw new Error('Managed-work consumer state is unavailable');
  const state = parseJson<ManagedWorkConsumerState>(raw, 'managed-work consumer state');
  if (state.consumerId !== consumerId || state.workId !== workId) {
    throw new Error('Managed-work consumer state is invalid');
  }
  return state;
}

function parseSnapshotResult(raw: unknown): ManagedWorkConsumerSnapshot {
  return parseTaggedResult<ManagedWorkConsumerSnapshot>(raw);
}

function parseEvidenceResult(raw: unknown): ManagedWorkEvidenceAppendResult {
  return parseTaggedResult<ManagedWorkEvidenceAppendResult>(raw);
}

function parseStateResult(
  raw: unknown,
  consumerId: ManagedWorkConsumerId,
  workId: string,
): ManagedWorkConsumerState {
  const state = parseTaggedResult<ManagedWorkConsumerState>(raw);
  if (state.consumerId !== consumerId || state.workId !== workId) {
    throw new Error('Managed-work consumer state is invalid');
  }
  return state;
}

function parseTaggedResult<T>(raw: unknown): T {
  if (typeof raw !== 'string') throw new Error('Unexpected managed-work consumer result');
  if (raw.startsWith('OK:')) return parseJson<T>(raw.slice(3), 'managed-work consumer result');
  if (raw === 'NOT_FOUND') throw managedWorkNotFound();
  if (raw === 'IDEMPOTENCY_CONFLICT') throw new Error('Managed-work idempotency key reused with different input');
  if (raw === 'EXECUTOR_CONFLICT') throw new Error('Managed-work executor conflict');
  if (raw === 'STATE_INVALID') throw new Error('Managed-work consumer state is invalid');
  if (raw === 'ATTEMPT_ORDER_CONFLICT' || raw === 'ATTEMPT_ALREADY_EXISTS') {
    throw new Error('Managed-work attempt order conflict');
  }
  if (raw === 'EVIDENCE_CONFLICT') throw new Error('Managed-work evidence conflict');
  if (raw === 'ACCEPTANCE_EVIDENCE_INCOMPLETE') throw new Error('Managed-work acceptance evidence incomplete');
  if (raw === 'REJECTION_EVIDENCE_INCOMPLETE') throw new Error('Managed-work rejection evidence incomplete');
  if (raw.startsWith('VERSION_CONFLICT:')) {
    throw new Error(`Managed-work version conflict: actual ${raw.slice('VERSION_CONFLICT:'.length)}`);
  }
  if (raw.startsWith('STALE_ATTEMPT:')) {
    throw new Error(`Managed-work stale attempt: current ${raw.slice('STALE_ATTEMPT:'.length)}`);
  }
  if (raw.startsWith('TERMINAL:')) {
    throw new Error(`Managed work is terminal: ${raw.slice('TERMINAL:'.length)}`);
  }
  throw new Error(`Unexpected managed-work consumer result: ${raw}`);
}

function deriveEvidenceId(
  consumerId: ManagedWorkConsumerId,
  workId: string,
  attemptId: string,
  idempotencyKey: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([consumerId, workId, attemptId, idempotencyKey]))
    .digest('hex');
  return `mwe_${digest.slice(0, 32)}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function operationFingerprint<T extends { readonly now: number }>(value: T): string {
  const { now: _serverTime, ...stable } = value;
  return stableJson(stable);
}

function parseJson<T>(raw: string, name: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid ${name}`);
  }
}

function managedWorkNotFound(): Error {
  return new Error('Managed work not found');
}

function assertConsumer(value: string): asserts value is ManagedWorkConsumerId {
  if (!MANAGED_WORK_CONSUMER_IDS.includes(value as ManagedWorkConsumerId)) {
    throw new Error(`Unsupported managed-work consumer: ${value}`);
  }
}

function assertId(value: string, name: string): void {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`${name} is invalid`);
}

function assertOpaqueString(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2_000) {
    throw new Error(`${name} is invalid`);
  }
}

function assertFullSha(value: string, name: string): void {
  if (typeof value !== 'string' || !FULL_SHA_PATTERN.test(value)) throw new Error(`${name} must be a full Git SHA`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} is invalid`);
}

function assertTimestamp(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error('now is invalid');
}
