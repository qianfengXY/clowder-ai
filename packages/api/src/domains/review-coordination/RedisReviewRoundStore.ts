import { createHash } from 'node:crypto';
import type {
  CatId,
  ReviewConsensus,
  ReviewConsensusFinding,
  ReviewDraftFinding,
  ReviewPrivateDraft,
  ReviewRound,
  ReviewRoundSafeView,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  CreateReviewRoundInput,
  FinishReviewStageInput,
  IReviewRoundStore,
  PublishReviewConsensusInput,
  ReadBarrierDraftsInput,
  ReadPrivateReviewDraftInput,
  ReviewDraftFindingInput,
  ReviewRoundIdentityInput,
  ReviewWorkIdentityInput,
  SubmitIndependentDraftInput,
} from './ReviewRoundStore.js';

const FULL_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const SEVERITIES = new Set(['P1', 'P2', 'P3']);

const CREATE_ROUND_LUA = `
local existingJson = redis.call('GET', KEYS[1])
if existingJson then
  local existing = cjson.decode(existingJson)
  if existing._creationFingerprint ~= ARGV[1] then
    if existing.reviewThreadId ~= nil or existing._creationFingerprint ~= ARGV[5] then
      return 'IMMUTABLE_ROUND_CONFLICT'
    end
  end
  return 'OK:' .. existingJson
end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[4])
redis.call('SET', KEYS[3], ARGV[4])
return 'OK:' .. ARGV[2]
`;

const SUBMIT_DRAFT_LUA = `
local receiptJson = redis.call('GET', KEYS[3])
if receiptJson then
  local receipt = cjson.decode(receiptJson)
  if receipt.fingerprint ~= ARGV[1] then return 'IDEMPOTENCY_CONFLICT' end
  return 'OK:' .. cjson.encode(receipt.result)
end
local roundJson = redis.call('GET', KEYS[1])
if not roundJson then return 'NOT_FOUND' end
local round = cjson.decode(roundJson)
if round.ownerUserId ~= ARGV[2] then return 'NOT_FOUND' end
if round.phase ~= 'independent' then return 'BARRIER_ALREADY_OPEN' end
local reviewer = ARGV[3]
local inRoster = false
for _, catId in ipairs(round.reviewerCatIds) do if catId == reviewer then inRoster = true end end
if not inRoster then return 'REVIEWER_DENIED' end
for _, catId in ipairs(round.independentFinishedCatIds) do
  if catId == reviewer then return 'REVIEWER_ALREADY_FINISHED' end
end
local currentJson = redis.call('GET', KEYS[2])
local currentVersion = 0
if currentJson then currentVersion = tonumber(cjson.decode(currentJson).version) end
if currentVersion ~= tonumber(ARGV[4]) then return 'DRAFT_VERSION_CONFLICT:' .. tostring(currentVersion) end
local draft = cjson.decode(ARGV[5])
draft.version = currentVersion + 1
redis.call('SET', KEYS[2], cjson.encode(draft))
redis.call('SET', KEYS[3], cjson.encode({ fingerprint = ARGV[1], result = draft }))
return 'OK:' .. cjson.encode(draft)
`;

const FINISH_STAGE_LUA = `
local receiptJson = redis.call('GET', KEYS[3])
if receiptJson then
  local receipt = cjson.decode(receiptJson)
  if receipt.fingerprint ~= ARGV[1] then return 'IDEMPOTENCY_CONFLICT' end
  return 'OK:' .. cjson.encode(receipt.result)
end
local roundJson = redis.call('GET', KEYS[1])
if not roundJson then return 'NOT_FOUND' end
local round = cjson.decode(roundJson)
if round.ownerUserId ~= ARGV[2] then return 'NOT_FOUND' end
local reviewer = ARGV[3]
local inRoster = false
for _, catId in ipairs(round.reviewerCatIds) do if catId == reviewer then inRoster = true end end
if not inRoster then return 'REVIEWER_DENIED' end
if tonumber(round.version) ~= tonumber(ARGV[4]) then return 'ROUND_VERSION_CONFLICT:' .. tostring(round.version) end
local stage = ARGV[5]
local finishedField
if stage == 'independent' then
  if round.phase ~= 'independent' then return 'INVALID_PHASE:' .. round.phase end
  if redis.call('EXISTS', KEYS[2]) == 0 then return 'DRAFT_REQUIRED' end
  finishedField = 'independentFinishedCatIds'
else
  if round.phase ~= 'cross_review' then return 'INVALID_PHASE:' .. round.phase end
  finishedField = 'crossReviewFinishedCatIds'
end
for _, catId in ipairs(round[finishedField]) do if catId == reviewer then return 'REVIEWER_ALREADY_FINISHED' end end
table.insert(round[finishedField], reviewer)
if #round[finishedField] == #round.reviewerCatIds then
  if stage == 'independent' then
    round.phase = 'cross_review'
    round.barrierOpenedAt = tonumber(ARGV[6])
  else
    round.phase = 'consensus_ready'
  end
end
round.version = tonumber(round.version) + 1
redis.call('SET', KEYS[1], cjson.encode(round))
redis.call('SET', KEYS[3], cjson.encode({ fingerprint = ARGV[1], result = round }))
return 'OK:' .. cjson.encode(round)
`;

const PUBLISH_CONSENSUS_LUA = `
local receiptJson = redis.call('GET', KEYS[3])
if receiptJson then
  local receipt = cjson.decode(receiptJson)
  if receipt.fingerprint ~= ARGV[1] then return 'IDEMPOTENCY_CONFLICT' end
  return 'OK:' .. cjson.encode(receipt.result)
end
local roundJson = redis.call('GET', KEYS[1])
if not roundJson then return 'NOT_FOUND' end
local round = cjson.decode(roundJson)
if round.ownerUserId ~= ARGV[2] then return 'NOT_FOUND' end
if round.recorderCatId ~= ARGV[3] then return 'RECORDER_DENIED' end
if round.phase ~= 'consensus_ready' then return 'INVALID_PHASE:' .. round.phase end
if tonumber(round.version) ~= tonumber(ARGV[4]) then return 'ROUND_VERSION_CONFLICT:' .. tostring(round.version) end
local verdict = ARGV[5]
local checksPassed = ARGV[6] == 'true'
local newFindings = cjson.decode(ARGV[7])
local resolvedIds = cjson.decode(ARGV[8])
if verdict == 'approved' and not checksPassed then return 'APPROVED_REQUIRES_GREEN_CHECKS' end
if verdict == 'approved' and #newFindings > 0 then return 'APPROVED_WITH_NEW_FINDINGS' end

local resolved = {}
for _, findingId in ipairs(resolvedIds) do
  local findingJson = redis.call('HGET', KEYS[2], findingId)
  if not findingJson then return 'RESOLUTION_FINDING_NOT_FOUND:' .. findingId end
  local finding = cjson.decode(findingJson)
  if finding.projectId ~= round.projectId or finding.workId ~= round.workId then
    return 'RESOLUTION_SCOPE_CONFLICT:' .. findingId
  end
  if finding.status ~= 'open' then return 'RESOLUTION_STATUS_CONFLICT:' .. findingId end
  finding.status = 'resolved'
  finding.resolvedAt = tonumber(ARGV[9])
  finding.resolvedByRoundId = round.roundId
  finding.resolvedExactSha = round.exactSha
  table.insert(resolved, finding)
end
for _, finding in ipairs(newFindings) do
  if redis.call('HEXISTS', KEYS[2], finding.findingId) == 1 then return 'FINDING_CONFLICT' end
end

local currentOpenCount = 0
for _, findingJson in ipairs(redis.call('HVALS', KEYS[2])) do
  local finding = cjson.decode(findingJson)
  if finding.status == 'open' then currentOpenCount = currentOpenCount + 1 end
end
local projectedOpenCount = currentOpenCount - #resolved + #newFindings
if verdict == 'approved' and projectedOpenCount ~= 0 then
  return 'APPROVED_WITH_OPEN_FINDINGS:' .. tostring(projectedOpenCount)
end
if verdict == 'changes_requested' and projectedOpenCount == 0 then return 'CHANGES_REQUESTED_WITHOUT_FINDINGS' end

for _, finding in ipairs(resolved) do redis.call('HSET', KEYS[2], finding.findingId, cjson.encode(finding)) end
for _, finding in ipairs(newFindings) do redis.call('HSET', KEYS[2], finding.findingId, cjson.encode(finding)) end
local consensus = {
  roundId = round.roundId,
  recorderCatId = ARGV[3],
  verdict = verdict,
  checksPassed = checksPassed,
  openFindingCount = projectedOpenCount,
  publishedAt = tonumber(ARGV[9])
}
round.consensus = consensus
round.phase = 'complete'
round.completedAt = tonumber(ARGV[9])
round.version = tonumber(round.version) + 1
redis.call('SET', KEYS[1], cjson.encode(round))
redis.call('SET', KEYS[3], cjson.encode({ fingerprint = ARGV[1], result = round }))
return 'OK:' .. cjson.encode(round)
`;

type StoredRound = ReviewRound & { readonly _creationFingerprint?: string; readonly consensus?: ReviewConsensus };

export class RedisReviewRoundStore implements IReviewRoundStore {
  constructor(private readonly redis: RedisClient) {}

  async createRound(input: CreateReviewRoundInput): Promise<ReviewRound> {
    const normalized = normalizeCreate(input);
    const roundId = deriveId('rr', [normalized.projectId, normalized.workId, normalized.exactSha]);
    const creationFingerprint = createFingerprint(normalized);
    const legacyCreationFingerprint = createFingerprint({ ...normalized, reviewThreadId: undefined });
    const round: StoredRound = {
      roundId,
      ownerUserId: normalized.ownerUserId,
      projectId: normalized.projectId,
      workId: normalized.workId,
      attemptId: normalized.attemptId,
      exactSha: normalized.exactSha,
      author: normalized.author,
      reviewerCatIds: normalized.reviewerCatIds,
      recorderCatId: normalized.recorderCatId,
      ...(normalized.reviewThreadId ? { reviewThreadId: normalized.reviewThreadId } : {}),
      phase: 'independent',
      independentFinishedCatIds: [],
      crossReviewFinishedCatIds: [],
      version: 1,
      createdAt: normalized.now,
      _creationFingerprint: creationFingerprint,
    };
    const raw = await this.redis.eval(
      CREATE_ROUND_LUA,
      3,
      roundKey(roundId),
      workIndexKey(normalized.projectId, normalized.workId),
      workCurrentKey(normalized.projectId, normalized.workId),
      creationFingerprint,
      JSON.stringify(round),
      String(normalized.now),
      roundId,
      legacyCreationFingerprint,
    );
    return parseRoundResult(raw);
  }

  async readSafe(input: ReviewRoundIdentityInput): Promise<ReviewRoundSafeView> {
    const normalized = normalizeIdentity(input);
    const round = await this.requireRound(normalized.ownerUserId, normalized.roundId);
    const findings = round.phase === 'complete' ? await this.readWorkFindings(round.projectId, round.workId) : [];
    const currentRoundId = await this.redis.get(workCurrentKey(round.projectId, round.workId));
    return safeView(round, findings, currentRoundId);
  }

  async readCurrentSafe(input: ReviewWorkIdentityInput): Promise<ReviewRoundSafeView | null> {
    const normalized = normalizeWorkIdentity(input);
    const currentRoundId = await this.redis.get(workCurrentKey(normalized.projectId, normalized.workId));
    if (!currentRoundId) return null;
    return this.readSafe({ ownerUserId: normalized.ownerUserId, roundId: currentRoundId });
  }

  async readPrivateDraft(input: ReadPrivateReviewDraftInput): Promise<ReviewPrivateDraft | null> {
    const normalized = normalizePrivateRead(input);
    const round = await this.requireRound(normalized.ownerUserId, normalized.roundId);
    requireReviewer(round, normalized.reviewerCatId);
    if (normalized.reviewerCatId !== normalized.draftOwnerCatId) throw new Error('Private draft access denied');
    const raw = await this.redis.get(draftKey(round.roundId, normalized.draftOwnerCatId));
    return raw ? parseDraft(raw) : null;
  }

  async readBarrierDrafts(input: ReadBarrierDraftsInput): Promise<readonly ReviewPrivateDraft[]> {
    const normalized = normalizeBarrierRead(input);
    const round = await this.requireRound(normalized.ownerUserId, normalized.roundId);
    requireReviewer(round, normalized.reviewerCatId);
    if (round.phase === 'independent') throw new Error('ReviewRound barrier is closed');
    const rows = await this.redis.mget(...round.reviewerCatIds.map((catId) => draftKey(round.roundId, catId)));
    if (rows.some((row) => !row)) throw new Error('ReviewRound draft set is incomplete');
    return rows.map((row) => parseDraft(row as string));
  }

  async submitIndependentDraft(input: SubmitIndependentDraftInput): Promise<ReviewPrivateDraft> {
    const normalized = normalizeDraft(input);
    const findings: ReviewDraftFinding[] = normalized.findings.map((finding, index) => ({
      ...finding,
      draftFindingId: deriveId('rdf', [
        normalized.roundId,
        normalized.reviewerCatId,
        normalized.idempotencyKey,
        String(index),
      ]),
      evidence: finding.evidence ?? [],
    }));
    const draft: ReviewPrivateDraft = {
      roundId: normalized.roundId,
      reviewerCatId: normalized.reviewerCatId,
      verdict: normalized.verdict,
      findings,
      version: 0,
      updatedAt: normalized.now,
    };
    const raw = await this.redis.eval(
      SUBMIT_DRAFT_LUA,
      3,
      roundKey(normalized.roundId),
      draftKey(normalized.roundId, normalized.reviewerCatId),
      receiptKey(normalized.roundId, 'draft', normalized.idempotencyKey),
      fingerprint(normalized),
      normalized.ownerUserId,
      normalized.reviewerCatId,
      String(normalized.expectedDraftVersion),
      JSON.stringify(draft),
    );
    return parseDraftResult(raw);
  }

  finishIndependent(input: FinishReviewStageInput): Promise<ReviewRound> {
    return this.finishStage(input, 'independent');
  }

  finishCrossReview(input: FinishReviewStageInput): Promise<ReviewRound> {
    return this.finishStage(input, 'cross-review');
  }

  async publishConsensus(input: PublishReviewConsensusInput): Promise<ReviewRoundSafeView> {
    const normalized = normalizeConsensus(input);
    const round = await this.requireRound(normalized.ownerUserId, normalized.roundId);
    const findings: ReviewConsensusFinding[] = normalized.findings.map((finding, index) => ({
      ...finding,
      evidence: finding.evidence ?? [],
      findingId: deriveId('rfi', [
        round.projectId,
        round.workId,
        round.roundId,
        normalized.idempotencyKey,
        String(index),
      ]),
      projectId: round.projectId,
      workId: round.workId,
      introducedByRoundId: round.roundId,
      introducedExactSha: round.exactSha,
      status: 'open',
      createdAt: normalized.now,
    }));
    const raw = await this.redis.eval(
      PUBLISH_CONSENSUS_LUA,
      3,
      roundKey(round.roundId),
      workFindingsKey(round.projectId, round.workId),
      receiptKey(round.roundId, 'consensus', normalized.idempotencyKey),
      fingerprint(normalized),
      normalized.ownerUserId,
      normalized.recorderCatId,
      String(normalized.expectedRoundVersion),
      normalized.verdict,
      String(normalized.checksPassed),
      JSON.stringify(findings),
      JSON.stringify(normalized.resolvedFindingIds),
      String(normalized.now),
    );
    const completedRound = parseRoundResult(raw);
    const currentRoundId = await this.redis.get(workCurrentKey(completedRound.projectId, completedRound.workId));
    return safeView(
      completedRound,
      await this.readWorkFindings(completedRound.projectId, completedRound.workId),
      currentRoundId,
    );
  }

  private async finishStage(
    input: FinishReviewStageInput,
    stage: 'independent' | 'cross-review',
  ): Promise<ReviewRound> {
    const normalized = normalizeFinish(input);
    const raw = await this.redis.eval(
      FINISH_STAGE_LUA,
      3,
      roundKey(normalized.roundId),
      draftKey(normalized.roundId, normalized.reviewerCatId),
      receiptKey(normalized.roundId, stage, normalized.idempotencyKey),
      fingerprint(normalized),
      normalized.ownerUserId,
      normalized.reviewerCatId,
      String(normalized.expectedRoundVersion),
      stage,
      String(normalized.now),
    );
    return parseRoundResult(raw);
  }

  private async requireRound(ownerUserId: string, roundId: string): Promise<ReviewRound> {
    const raw = await this.redis.get(roundKey(roundId));
    if (!raw) throw reviewRoundNotFound();
    const round = parseRound(raw);
    if (round.ownerUserId !== ownerUserId) throw reviewRoundNotFound();
    return round;
  }

  private async readWorkFindings(projectId: string, workId: string): Promise<ReviewConsensusFinding[]> {
    const rows = await this.redis.hvals(workFindingsKey(projectId, workId));
    return rows
      .map(parseFinding)
      .sort((left, right) => left.createdAt - right.createdAt || left.findingId.localeCompare(right.findingId));
  }
}

function normalizeCreate(
  input: CreateReviewRoundInput,
): Omit<Required<CreateReviewRoundInput>, 'reviewThreadId'> & { readonly reviewThreadId?: string } {
  assertId(input.ownerUserId, 'ownerUserId');
  assertId(input.projectId, 'projectId');
  assertId(input.workId, 'workId');
  assertId(input.attemptId, 'attemptId');
  assertFullSha(input.exactSha, 'exactSha');
  assertActor(input.author);
  if (
    !Array.isArray(input.reviewerCatIds) ||
    new Set(input.reviewerCatIds).size < 2 ||
    new Set(input.reviewerCatIds).size !== input.reviewerCatIds.length
  ) {
    throw new Error('ReviewRound requires at least two distinct reviewers');
  }
  for (const catId of input.reviewerCatIds) assertId(catId, 'reviewerCatId');
  if (input.author.kind === 'cat' && input.reviewerCatIds.includes(input.author.catId)) {
    throw new Error('ReviewRound author cannot review their own work');
  }
  assertId(input.recorderCatId, 'recorderCatId');
  if (!input.reviewerCatIds.includes(input.recorderCatId)) throw new Error('Recorder must be a reviewer');
  if (input.reviewThreadId !== undefined) assertId(input.reviewThreadId, 'reviewThreadId');
  assertId(input.idempotencyKey, 'idempotencyKey');
  const now = input.now ?? Date.now();
  assertTimestamp(now);
  return {
    ...input,
    exactSha: input.exactSha.toLowerCase(),
    reviewerCatIds: [...input.reviewerCatIds].sort(),
    now,
  };
}

function normalizeIdentity<T extends ReviewRoundIdentityInput>(input: T): T {
  assertId(input.ownerUserId, 'ownerUserId');
  assertId(input.roundId, 'roundId');
  return input;
}

function normalizeWorkIdentity(input: ReviewWorkIdentityInput): ReviewWorkIdentityInput {
  assertId(input.ownerUserId, 'ownerUserId');
  assertId(input.projectId, 'projectId');
  assertId(input.workId, 'workId');
  return input;
}

function normalizePrivateRead(input: ReadPrivateReviewDraftInput): ReadPrivateReviewDraftInput {
  normalizeIdentity(input);
  assertId(input.reviewerCatId, 'reviewerCatId');
  assertId(input.draftOwnerCatId, 'draftOwnerCatId');
  return input;
}

function normalizeBarrierRead(input: ReadBarrierDraftsInput): ReadBarrierDraftsInput {
  normalizeIdentity(input);
  assertId(input.reviewerCatId, 'reviewerCatId');
  return input;
}

function normalizeDraft(input: SubmitIndependentDraftInput): Required<SubmitIndependentDraftInput> {
  normalizeIdentity(input);
  assertId(input.reviewerCatId, 'reviewerCatId');
  assertNonNegativeInteger(input.expectedDraftVersion, 'expectedDraftVersion');
  assertId(input.idempotencyKey, 'idempotencyKey');
  if (input.verdict !== 'approve' && input.verdict !== 'findings') throw new Error('Invalid draft verdict');
  const findings = normalizeFindingInputs(input.findings);
  if (input.verdict === 'approve' && findings.length > 0) throw new Error('Approve draft cannot contain findings');
  if (input.verdict === 'findings' && findings.length === 0) throw new Error('Findings draft must contain findings');
  const now = input.now ?? Date.now();
  assertTimestamp(now);
  return { ...input, findings, now };
}

function normalizeFinish(input: FinishReviewStageInput): Required<FinishReviewStageInput> {
  normalizeIdentity(input);
  assertId(input.reviewerCatId, 'reviewerCatId');
  assertPositiveInteger(input.expectedRoundVersion, 'expectedRoundVersion');
  assertId(input.idempotencyKey, 'idempotencyKey');
  const now = input.now ?? Date.now();
  assertTimestamp(now);
  return { ...input, now };
}

function normalizeConsensus(input: PublishReviewConsensusInput): Required<PublishReviewConsensusInput> {
  normalizeIdentity(input);
  assertId(input.recorderCatId, 'recorderCatId');
  assertPositiveInteger(input.expectedRoundVersion, 'expectedRoundVersion');
  assertId(input.idempotencyKey, 'idempotencyKey');
  if (input.verdict !== 'approved' && input.verdict !== 'changes_requested')
    throw new Error('Invalid consensus verdict');
  if (typeof input.checksPassed !== 'boolean') throw new Error('checksPassed is invalid');
  const findings = normalizeFindingInputs(input.findings);
  if (!Array.isArray(input.resolvedFindingIds)) throw new Error('resolvedFindingIds is invalid');
  const resolvedFindingIds = [...new Set(input.resolvedFindingIds)];
  for (const findingId of resolvedFindingIds) assertId(findingId, 'resolvedFindingId');
  const now = input.now ?? Date.now();
  assertTimestamp(now);
  return { ...input, findings, resolvedFindingIds, now };
}

function normalizeFindingInputs<T extends ReviewDraftFindingInput>(items: readonly T[]): T[] {
  if (!Array.isArray(items) || items.length > 100) throw new Error('Review findings are invalid');
  return items.map((item) => {
    if (!item || typeof item !== 'object' || !SEVERITIES.has(item.severity))
      throw new Error('Finding severity is invalid');
    assertText(item.title, 'finding.title', 240);
    assertText(item.details, 'finding.details', 8_000);
    const evidence = item.evidence ?? [];
    if (!Array.isArray(evidence) || evidence.length > 100) throw new Error('Finding evidence is invalid');
    for (const value of evidence) assertText(value, 'finding.evidence', 1_000);
    const designRefs = item.designRefs ?? evidence;
    if (!Array.isArray(designRefs) || designRefs.length > 100) throw new Error('Finding designRefs is invalid');
    for (const value of designRefs) assertText(value, 'finding.designRefs', 1_000);
    const scope = item.scope ?? 'plan_conformance';
    if (scope !== 'plan_conformance' && scope !== 'architecture_decision') {
      throw new Error('Finding scope is invalid');
    }
    if (scope === 'architecture_decision' && item.severity !== 'P1') {
      throw new Error('Architecture decision findings must use P1 severity');
    }
    return {
      ...item,
      title: item.title.trim(),
      details: item.details.trim(),
      evidence: [...evidence],
      designRefs: [...designRefs],
      scope,
    };
  });
}

function safeView(
  round: ReviewRound,
  findings: readonly ReviewConsensusFinding[],
  currentRoundId: string | null,
): ReviewRoundSafeView {
  const consensus = (round as StoredRound).consensus ?? null;
  return {
    round,
    currentForWork: currentRoundId === round.roundId,
    progress: {
      independentFinished: round.independentFinishedCatIds.length,
      required: round.reviewerCatIds.length,
      crossReviewFinished: round.crossReviewFinishedCatIds.length,
    },
    consensus,
    findings: round.phase === 'complete' ? findings : [],
  };
}

function parseRoundResult(raw: unknown): ReviewRound {
  const value = parseTagged(raw);
  return parseRound(value);
}

function parseDraftResult(raw: unknown): ReviewPrivateDraft {
  return parseDraft(parseTagged(raw));
}

function parseTagged(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Unexpected ReviewRound result');
  if (raw.startsWith('OK:')) return raw.slice(3);
  const exactErrors: Readonly<Record<string, string>> = {
    IMMUTABLE_ROUND_CONFLICT: 'ReviewRound immutable round conflict',
    IDEMPOTENCY_CONFLICT: 'ReviewRound idempotency key conflict',
    REVIEWER_DENIED: 'ReviewRound reviewer access denied',
    RECORDER_DENIED: 'Only the designated recorder can publish consensus',
    BARRIER_ALREADY_OPEN: 'ReviewRound independent barrier already opened',
    REVIEWER_ALREADY_FINISHED: 'ReviewRound reviewer already finished',
    DRAFT_REQUIRED: 'ReviewRound private draft is required',
    APPROVED_REQUIRES_GREEN_CHECKS: 'Approved consensus requires green checks',
    CHANGES_REQUESTED_WITHOUT_FINDINGS: 'Changes requested requires an open finding',
    FINDING_CONFLICT: 'Review finding conflict',
  };
  if (raw === 'NOT_FOUND') throw reviewRoundNotFound();
  const exactMessage = exactErrors[raw];
  if (exactMessage) throw new Error(exactMessage);
  if (raw === 'APPROVED_WITH_NEW_FINDINGS' || raw.startsWith('APPROVED_WITH_OPEN_FINDINGS:')) {
    throw new Error('Approved consensus requires zero open findings');
  }
  if (raw.startsWith('DRAFT_VERSION_CONFLICT:')) throw new Error(`Review draft version conflict: ${raw.split(':')[1]}`);
  if (raw.startsWith('ROUND_VERSION_CONFLICT:')) throw new Error(`Review round version conflict: ${raw.split(':')[1]}`);
  if (raw.startsWith('INVALID_PHASE:'))
    throw new Error(`ReviewRound phase does not allow this action: ${raw.split(':')[1]}`);
  if (raw.startsWith('RESOLUTION_')) throw new Error(`Review finding resolution conflict: ${raw}`);
  throw new Error(`Unexpected ReviewRound result: ${raw}`);
}

function parseRound(raw: string): ReviewRound {
  const stored = parseJson<StoredRound>(raw, 'ReviewRound');
  const { _creationFingerprint: _internalFingerprint, ...round } = stored;
  return {
    ...round,
    reviewerCatIds: asCatIdArray(round.reviewerCatIds),
    independentFinishedCatIds: asCatIdArray(round.independentFinishedCatIds),
    crossReviewFinishedCatIds: asCatIdArray(round.crossReviewFinishedCatIds),
  };
}

function parseDraft(raw: string): ReviewPrivateDraft {
  const draft = parseJson<ReviewPrivateDraft>(raw, 'ReviewRound draft');
  return {
    ...draft,
    findings: asArray<ReviewDraftFinding>(draft.findings).map((finding) => ({
      ...finding,
      evidence: asStringArray(finding.evidence),
      designRefs: asStringArray(finding.designRefs),
      scope:
        finding.scope === 'architecture_decision' || finding.scope === 'plan_conformance'
          ? finding.scope
          : 'plan_conformance',
    })),
  };
}

function parseFinding(raw: string): ReviewConsensusFinding {
  const finding = parseJson<ReviewConsensusFinding>(raw, 'ReviewRound finding');
  return {
    ...finding,
    evidence: asStringArray(finding.evidence),
    designRefs: asStringArray(finding.designRefs),
    scope:
      finding.scope === 'architecture_decision' || finding.scope === 'plan_conformance'
        ? finding.scope
        : 'plan_conformance',
  };
}

function requireReviewer(round: ReviewRound, reviewerCatId: CatId): void {
  if (!round.reviewerCatIds.includes(reviewerCatId)) throw new Error('ReviewRound reviewer access denied');
}

function deriveId(prefix: string, parts: readonly string[]): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

function fingerprint<T extends { readonly now: number }>(value: T): string {
  const { now: _serverTime, ...stable } = value;
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function createFingerprint(value: CreateReviewRoundInput & { readonly now: number }): string {
  const { now: _serverTime, idempotencyKey: _operationKey, ...immutable } = value;
  return createHash('sha256').update(JSON.stringify(immutable)).digest('hex');
}

function roundKey(roundId: string): string {
  return `review-round:round:${roundId}`;
}
function draftKey(roundId: string, reviewerCatId: string): string {
  return `review-round:draft:${roundId}:${reviewerCatId}`;
}
function receiptKey(roundId: string, operation: string, key: string): string {
  return `review-round:receipt:${roundId}:${operation}:${key}`;
}
function workFindingsKey(projectId: string, workId: string): string {
  return `review-round:work-findings:${projectId}:${workId}`;
}
function workIndexKey(projectId: string, workId: string): string {
  return `review-round:work-index:${projectId}:${workId}`;
}
function workCurrentKey(projectId: string, workId: string): string {
  return `review-round:work-current:${projectId}:${workId}`;
}

function assertActor(actor: CreateReviewRoundInput['author']): void {
  if (!actor || typeof actor !== 'object') throw new Error('ReviewRound author is invalid');
  if (actor.kind === 'cat') {
    assertId(actor.catId, 'author.catId');
    return;
  }
  if (actor.kind === 'external_actor' && actor.actorId === 'chatgpt-desktop-dev') return;
  throw new Error('ReviewRound author is invalid');
}
function assertId(value: string, name: string): void {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`${name} is invalid`);
}
function assertFullSha(value: string, name: string): void {
  if (typeof value !== 'string' || !FULL_SHA_PATTERN.test(value)) throw new Error(`${name} must be a full Git SHA`);
}
function assertText(value: string, name: string, max: number): void {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} is invalid`);
}
function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} is invalid`);
}
function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} is invalid`);
}
function assertTimestamp(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error('now is invalid');
}
function reviewRoundNotFound(): Error {
  return new Error('Review round not found');
}
function parseJson<T>(raw: string, name: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid ${name}`);
  }
}
function asArray<T>(value: readonly T[] | unknown): T[] {
  return Array.isArray(value) ? [...value] : [];
}
function asStringArray(value: readonly string[] | unknown): string[] {
  return asArray<string>(value).filter((item) => typeof item === 'string');
}
function asCatIdArray(value: readonly CatId[] | unknown): CatId[] {
  return asStringArray(value) as CatId[];
}
