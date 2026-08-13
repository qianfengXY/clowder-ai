import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { assertRedisIsolationOrThrow, cleanupPrefixedRedisKeys } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const REDIS_ISOLATED = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe(
  'F253 durable ReviewRound store',
  { skip: !REDIS_URL ? 'REDIS_URL not set' : !REDIS_ISOLATED ? 'Redis isolation flag not set' : false },
  () => {
    let redis;
    let store;
    let connected = false;

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'review-round-store');
      const { createRedisClient } = await import('@cat-cafe/shared/utils');
      const { RedisReviewRoundStore } = await import('../dist/domains/review-coordination/RedisReviewRoundStore.js');
      redis = createRedisClient({ url: REDIS_URL });
      try {
        await redis.ping();
        connected = true;
      } catch {
        await redis.quit().catch(() => {});
        return;
      }
      store = new RedisReviewRoundStore(redis);
    });

    after(async () => {
      if (!connected) return;
      await cleanupPrefixedRedisKeys(redis, ['review-round:*']);
      await redis.quit();
    });

    beforeEach(async (t) => {
      if (!connected) return t.skip('Redis not connected');
      await cleanupPrefixedRedisKeys(redis, ['review-round:*']);
    });

    function createInput(overrides = {}) {
      return {
        ownerUserId: 'owner-1',
        projectId: 'project-1',
        workId: 'work-1',
        attemptId: 'attempt-1',
        exactSha: SHA_A,
        author: { kind: 'external_actor', actorId: 'chatgpt-desktop-dev' },
        reviewerCatIds: ['cat-codex', 'cat-kimi'],
        recorderCatId: 'cat-codex',
        idempotencyKey: `create-${SHA_A}`,
        ...overrides,
      };
    }

    async function createRound(overrides = {}) {
      return store.createRound(createInput(overrides));
    }

    async function submitDraft(round, reviewerCatId, verdict, findings, suffix = reviewerCatId) {
      return store.submitIndependentDraft({
        ownerUserId: 'owner-1',
        roundId: round.roundId,
        reviewerCatId,
        expectedDraftVersion: 0,
        idempotencyKey: `draft-${suffix}`,
        verdict,
        findings,
      });
    }

    async function finishIndependent(round, reviewerCatId, expectedVersion, suffix = reviewerCatId) {
      return store.finishIndependent({
        ownerUserId: 'owner-1',
        roundId: round.roundId,
        reviewerCatId,
        expectedRoundVersion: expectedVersion,
        idempotencyKey: `finish-${suffix}`,
      });
    }

    async function finishCrossReview(roundId, reviewerCatId, expectedVersion, suffix = reviewerCatId) {
      return store.finishCrossReview({
        ownerUserId: 'owner-1',
        roundId,
        reviewerCatId,
        expectedRoundVersion: expectedVersion,
        idempotencyKey: `cross-${suffix}`,
      });
    }

    test('creates one immutable exact-SHA round with two distinct non-author reviewers and TTL=0', async () => {
      const round = await createRound();
      assert.equal(round.exactSha, SHA_A);
      assert.deepEqual(round.reviewerCatIds, ['cat-codex', 'cat-kimi']);
      assert.equal(round.phase, 'independent');
      assert.deepEqual(await createRound(), round);
      assert.deepEqual(await createRound({ idempotencyKey: 'same-round-new-operation-key' }), round);
      assert.deepEqual(
        await createRound({
          reviewThreadId: 'project-feature-review:project-1:backlog-1',
          idempotencyKey: 'post-migration-retry',
        }),
        round,
      );
      assert.equal(await redis.ttl(`review-round:round:${round.roundId}`), -1);
      const current = await store.readCurrentSafe({
        ownerUserId: 'owner-1',
        projectId: 'project-1',
        workId: 'work-1',
      });
      assert.equal(current.round.roundId, round.roundId);
      assert.equal(current.currentForWork, true);

      await assert.rejects(
        () => createRound({ author: { kind: 'cat', catId: 'cat-codex' }, idempotencyKey: 'self-review' }),
        /author cannot review/i,
      );
      await assert.rejects(
        () => createRound({ reviewerCatIds: ['cat-codex', 'cat-codex'], idempotencyKey: 'duplicate-reviewer' }),
        /two distinct reviewers/i,
      );
      await assert.rejects(() => createRound({ exactSha: 'short', idempotencyKey: 'short-sha' }), /full Git SHA/i);
      await assert.rejects(
        () => createRound({ reviewerCatIds: ['cat-codex', 'cat-third'], idempotencyKey: 'changed-roster' }),
        /immutable round conflict/i,
      );
      await assert.rejects(
        () => createRound({ attemptId: 'attempt-other', idempotencyKey: 'same-sha-other-attempt' }),
        /immutable round conflict/i,
      );
    });

    test('keeps drafts private until every reviewer independently finishes', async () => {
      let round = await createRound();
      const codexDraft = await submitDraft(round, 'cat-codex', 'findings', [
        { severity: 'P1', title: 'Unsafe transition', details: 'The transition lacks an epoch fence.' },
      ]);
      await submitDraft(round, 'cat-kimi', 'approve', []);
      assert.equal(codexDraft.version, 1);

      const safeBefore = await store.readSafe({ ownerUserId: 'owner-1', roundId: round.roundId });
      assert.equal(safeBefore.round.phase, 'independent');
      assert.equal(safeBefore.consensus, null);
      assert.deepEqual(safeBefore.findings, []);
      assert.deepEqual(safeBefore.progress, { independentFinished: 0, required: 2, crossReviewFinished: 0 });
      await assert.rejects(
        () =>
          store.readPrivateDraft({
            ownerUserId: 'owner-1',
            roundId: round.roundId,
            reviewerCatId: 'cat-kimi',
            draftOwnerCatId: 'cat-codex',
          }),
        /private draft access denied/i,
      );
      await assert.rejects(
        () => store.readBarrierDrafts({ ownerUserId: 'owner-1', roundId: round.roundId, reviewerCatId: 'cat-codex' }),
        /barrier is closed/i,
      );

      round = await finishIndependent(round, 'cat-codex', round.version);
      assert.equal(round.phase, 'independent');
      assert.equal(round.independentFinishedCatIds.length, 1);
      round = await finishIndependent(round, 'cat-kimi', round.version);
      assert.equal(round.phase, 'cross_review');
      assert.equal(round.barrierOpenedAt > 0, true);

      const drafts = await store.readBarrierDrafts({
        ownerUserId: 'owner-1',
        roundId: round.roundId,
        reviewerCatId: 'cat-kimi',
      });
      assert.equal(drafts.length, 2);
      assert.equal(drafts.find((draft) => draft.reviewerCatId === 'cat-codex').findings.length, 1);
    });

    test('opens the independent barrier atomically under concurrent finish calls', async () => {
      const round = await createRound();
      await submitDraft(round, 'cat-codex', 'approve', []);
      await submitDraft(round, 'cat-kimi', 'approve', []);
      const first = await finishIndependent(round, 'cat-codex', round.version);
      const results = await Promise.allSettled([
        finishIndependent(first, 'cat-kimi', first.version, 'kimi-a'),
        finishIndependent(first, 'cat-kimi', first.version, 'kimi-b'),
      ]);
      const winners = results.filter((result) => result.status === 'fulfilled');
      assert.equal(winners.length, 1);
      assert.equal(winners[0].value.phase, 'cross_review');
      const safe = await store.readSafe({ ownerUserId: 'owner-1', roundId: round.roundId });
      assert.equal(safe.round.phase, 'cross_review');
      assert.deepEqual(safe.round.independentFinishedCatIds.sort(), ['cat-codex', 'cat-kimi']);
    });

    test('requires every reviewer to cross-review before the designated recorder can publish consensus', async () => {
      let round = await createRound();
      await submitDraft(round, 'cat-codex', 'findings', [
        { severity: 'P2', title: 'Missing retry fence', details: 'A stale caller can retry.' },
      ]);
      await submitDraft(round, 'cat-kimi', 'approve', []);
      round = await finishIndependent(round, 'cat-codex', round.version);
      round = await finishIndependent(round, 'cat-kimi', round.version);

      await assert.rejects(
        () =>
          store.publishConsensus({
            ownerUserId: 'owner-1',
            roundId: round.roundId,
            recorderCatId: 'cat-kimi',
            expectedRoundVersion: round.version,
            idempotencyKey: 'early-wrong-recorder',
            verdict: 'changes_requested',
            checksPassed: false,
            findings: [],
            resolvedFindingIds: [],
          }),
        /designated recorder/i,
      );

      round = await finishCrossReview(round.roundId, 'cat-codex', round.version);
      assert.equal(round.phase, 'cross_review');
      round = await finishCrossReview(round.roundId, 'cat-kimi', round.version);
      assert.equal(round.phase, 'consensus_ready');

      const input = {
        ownerUserId: 'owner-1',
        roundId: round.roundId,
        recorderCatId: 'cat-codex',
        expectedRoundVersion: round.version,
        idempotencyKey: 'consensus-a',
        verdict: 'changes_requested',
        checksPassed: false,
        findings: [
          {
            severity: 'P2',
            title: 'Missing retry fence',
            details: 'A stale caller can retry.',
            evidence: ['packages/api/src/example.ts:10'],
          },
        ],
        resolvedFindingIds: [],
      };
      const published = await store.publishConsensus(input);
      assert.equal(published.round.phase, 'complete');
      assert.equal(published.consensus.verdict, 'changes_requested');
      assert.equal(published.findings.length, 1);
      assert.equal(published.findings[0].status, 'open');
      assert.deepEqual(await store.publishConsensus(input), published);
      assert.equal(await redis.ttl(`review-round:draft:${round.roundId}:cat-codex`), -1);
      assert.equal(await redis.ttl(`review-round:receipt:${round.roundId}:consensus:consensus-a`), -1);
      assert.equal(await redis.ttl(`review-round:work-findings:project-1:work-1`), -1);

      const safe = await store.readSafe({ ownerUserId: 'owner-1', roundId: round.roundId });
      assert.deepEqual(safe, published);
      await assert.rejects(
        () => store.readSafe({ ownerUserId: 'owner-2', roundId: round.roundId }),
        /review round not found/i,
      );
    });

    test('lets a later completed exact-SHA round resolve prior findings and approve only with green checks', async () => {
      let first = await createRound();
      await submitDraft(first, 'cat-codex', 'findings', [
        { severity: 'P2', title: 'Missing retry fence', details: 'A stale caller can retry.' },
      ]);
      await submitDraft(first, 'cat-kimi', 'approve', []);
      first = await finishIndependent(first, 'cat-codex', first.version);
      first = await finishIndependent(first, 'cat-kimi', first.version);
      first = await finishCrossReview(first.roundId, 'cat-codex', first.version);
      first = await finishCrossReview(first.roundId, 'cat-kimi', first.version);
      const blocked = await store.publishConsensus({
        ownerUserId: 'owner-1',
        roundId: first.roundId,
        recorderCatId: 'cat-codex',
        expectedRoundVersion: first.version,
        idempotencyKey: 'consensus-blocked',
        verdict: 'changes_requested',
        checksPassed: false,
        findings: [
          { severity: 'P2', title: 'Missing retry fence', details: 'A stale caller can retry.' },
          { severity: 'P3', title: 'Missing recovery evidence', details: 'Recovery cannot be audited.' },
        ],
        resolvedFindingIds: [],
      });
      const findingIds = blocked.findings.map((finding) => finding.findingId);

      let second = await createRound({
        attemptId: 'attempt-2',
        exactSha: SHA_B,
        idempotencyKey: `create-${SHA_B}`,
      });
      assert.equal((await store.readSafe({ ownerUserId: 'owner-1', roundId: first.roundId })).currentForWork, false);
      await submitDraft(second, 'cat-codex', 'approve', [], 'codex-b');
      await submitDraft(second, 'cat-kimi', 'approve', [], 'kimi-b');
      second = await finishIndependent(second, 'cat-codex', second.version, 'codex-b');
      second = await finishIndependent(second, 'cat-kimi', second.version, 'kimi-b');
      second = await finishCrossReview(second.roundId, 'cat-codex', second.version, 'codex-b');
      second = await finishCrossReview(second.roundId, 'cat-kimi', second.version, 'kimi-b');

      await assert.rejects(
        () =>
          store.publishConsensus({
            ownerUserId: 'owner-1',
            roundId: second.roundId,
            recorderCatId: 'cat-codex',
            expectedRoundVersion: second.version,
            idempotencyKey: 'consensus-not-green',
            verdict: 'approved',
            checksPassed: false,
            findings: [],
            resolvedFindingIds: findingIds,
          }),
        /approved consensus requires green checks/i,
      );
      await assert.rejects(
        () =>
          store.publishConsensus({
            ownerUserId: 'owner-1',
            roundId: second.roundId,
            recorderCatId: 'cat-codex',
            expectedRoundVersion: second.version,
            idempotencyKey: 'consensus-partial-resolution',
            verdict: 'approved',
            checksPassed: true,
            findings: [],
            resolvedFindingIds: [findingIds[0]],
          }),
        /zero open findings/i,
      );
      const stillOpen = await store.readSafe({ ownerUserId: 'owner-1', roundId: first.roundId });
      assert.deepEqual(
        stillOpen.findings.map((finding) => finding.status),
        ['open', 'open'],
      );

      const approved = await store.publishConsensus({
        ownerUserId: 'owner-1',
        roundId: second.roundId,
        recorderCatId: 'cat-codex',
        expectedRoundVersion: second.version,
        idempotencyKey: 'consensus-approved',
        verdict: 'approved',
        checksPassed: true,
        findings: [],
        resolvedFindingIds: findingIds,
      });
      assert.equal(approved.consensus.verdict, 'approved');
      assert.equal(approved.consensus.openFindingCount, 0);
      const oldSafe = await store.readSafe({ ownerUserId: 'owner-1', roundId: first.roundId });
      assert.deepEqual(
        oldSafe.findings.map((finding) => finding.status),
        ['resolved', 'resolved'],
      );
      assert.equal(oldSafe.findings[0].resolvedByRoundId, second.roundId);
      assert.equal(oldSafe.findings[0].resolvedExactSha, SHA_B);
      assert.equal(
        (await store.readCurrentSafe({ ownerUserId: 'owner-1', projectId: 'project-1', workId: 'work-1' })).round
          .roundId,
        second.roundId,
      );
      await createRound();
      assert.equal(
        (await store.readCurrentSafe({ ownerUserId: 'owner-1', projectId: 'project-1', workId: 'work-1' })).round
          .roundId,
        second.roundId,
      );
    });
  },
);
