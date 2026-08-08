import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { assertRedisIsolationOrThrow, cleanupPrefixedRedisKeys } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const REDIS_ISOLATED = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';
const CONSUMER_ID = 'f289_desktop_development_loop';
const EXACT_SHA = 'a'.repeat(40);

describe(
  'F275 named managed-work consumer port',
  { skip: !REDIS_URL ? 'REDIS_URL not set' : !REDIS_ISOLATED ? 'Redis isolation flag not set' : false },
  () => {
    let redis;
    let workflowStore;
    let port;
    let connected = false;

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'managed-work-consumer-port');
      const { createRedisClient } = await import('@cat-cafe/shared/utils');
      const { RedisWorkflowSopStore } = await import(
        '../dist/domains/cats/services/stores/redis/RedisWorkflowSopStore.js'
      );
      const { RedisManagedWorkConsumerPort } = await import(
        '../dist/domains/cats/services/stores/redis/RedisManagedWorkConsumerPort.js'
      );
      redis = createRedisClient({ url: REDIS_URL });
      try {
        await redis.ping();
        connected = true;
      } catch {
        await redis.quit().catch(() => {});
        return;
      }
      workflowStore = new RedisWorkflowSopStore(redis);
      port = new RedisManagedWorkConsumerPort(redis);
    });

    after(async () => {
      if (!connected) return;
      await cleanupPrefixedRedisKeys(redis, ['workflow:sop:*', 'managed-work:*']);
      await redis.quit();
    });

    beforeEach(async (t) => {
      if (!connected) return t.skip('Redis not connected');
      await cleanupPrefixedRedisKeys(redis, ['workflow:sop:*', 'managed-work:*']);
    });

    async function admit(anchor = 'f289-work') {
      await workflowStore.upsert(anchor, 'F289', {}, 'cat-idwxwjba', 'owner-1');
      return workflowStore.getManagedWorkAdmission('owner-1', anchor);
    }

    test('validates explicit work/attempt identity and never guesses across owners', async () => {
      const bundle = await admit();
      const snapshot = await port.read({
        consumerId: CONSUMER_ID,
        ownerUserId: 'owner-1',
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
      });
      assert.equal(snapshot.admission.workId, bundle.admission.workId);
      assert.equal(snapshot.state.currentAttemptId, bundle.attempt.attemptId);
      assert.equal(snapshot.state.lifecycle, 'active');
      assert.equal(snapshot.state.version, 1);

      await assert.rejects(
        () =>
          port.read({
            consumerId: CONSUMER_ID,
            ownerUserId: 'owner-2',
            workId: bundle.admission.workId,
            attemptId: bundle.attempt.attemptId,
          }),
        /managed work not found/i,
      );
      await assert.rejects(
        () =>
          port.read({
            consumerId: 'unknown_consumer',
            ownerUserId: 'owner-1',
            workId: bundle.admission.workId,
            attemptId: bundle.attempt.attemptId,
          }),
        /unsupported managed-work consumer/i,
      );
    });

    test('claims the initial attempt for the external Desktop actor exactly once', async () => {
      const bundle = await admit();
      const initial = await port.read({
        consumerId: CONSUMER_ID,
        ownerUserId: 'owner-1',
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
      });
      const input = {
        consumerId: CONSUMER_ID,
        ownerUserId: 'owner-1',
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        executor: { kind: 'external_actor', actorId: 'chatgpt-desktop-dev' },
        expectedVersion: initial.state.version,
        idempotencyKey: 'claim-initial',
      };
      const claimed = await port.claimAttempt(input);
      assert.deepEqual(claimed.attempt.executorActor, input.executor);
      assert.equal(claimed.state.version, 2);
      assert.deepEqual(await port.claimAttempt(input), claimed);

      await assert.rejects(
        () => workflowStore.bindManagedWorkAttempt('owner-1', 'f289-work', 'cat-other'),
        /already bound to chatgpt-desktop-dev/i,
      );

      const catBound = await admit('f289-work-cat-first');
      await workflowStore.bindManagedWorkAttempt('owner-1', 'f289-work-cat-first', 'cat-first');
      const catState = await port.read({
        consumerId: CONSUMER_ID,
        ownerUserId: 'owner-1',
        workId: catBound.admission.workId,
        attemptId: catBound.attempt.attemptId,
      });
      await assert.rejects(
        () =>
          port.claimAttempt({
            consumerId: CONSUMER_ID,
            ownerUserId: 'owner-1',
            workId: catBound.admission.workId,
            attemptId: catBound.attempt.attemptId,
            executor: { kind: 'external_actor', actorId: 'chatgpt-desktop-dev' },
            expectedVersion: catState.state.version,
            idempotencyKey: 'claim-after-cat',
          }),
        /executor conflict/i,
      );

      await assert.rejects(
        () =>
          port.claimAttempt({
            ...input,
            idempotencyKey: 'claim-other',
            expectedVersion: claimed.state.version,
            executor: { kind: 'cat', catId: 'cat-other' },
          }),
        /executor conflict/i,
      );
    });

    test('allocates one next ordered attempt under concurrent CAS and persists it without TTL', async () => {
      const bundle = await admit();
      const initial = await port.read({
        consumerId: CONSUMER_ID,
        ownerUserId: 'owner-1',
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
      });
      const claims = await Promise.allSettled(
        Array.from({ length: 10 }, (_, index) =>
          port.createNextAttempt({
            consumerId: CONSUMER_ID,
            ownerUserId: 'owner-1',
            workId: bundle.admission.workId,
            fromAttemptId: bundle.attempt.attemptId,
            executor: { kind: 'external_actor', actorId: 'chatgpt-desktop-dev' },
            expectedVersion: initial.state.version,
            idempotencyKey: `next-${index}`,
          }),
        ),
      );
      const winners = claims.filter((claim) => claim.status === 'fulfilled');
      assert.equal(winners.length, 1);
      assert.equal(winners[0].value.attempt.attemptNumber, 2);
      assert.equal(winners[0].value.state.currentAttemptNumber, 2);
      assert.equal(await redis.ttl(`managed-work:attempt:${winners[0].value.attempt.attemptId}`), -1);
      assert.equal(await redis.ttl(`managed-work:consumer:${CONSUMER_ID}:state:${bundle.admission.workId}`), -1);
    });

    test('appends typed evidence idempotently and rejects stale versions', async () => {
      const bundle = await admit();
      const initial = await port.read({
        consumerId: CONSUMER_ID,
        ownerUserId: 'owner-1',
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
      });
      const input = {
        consumerId: CONSUMER_ID,
        ownerUserId: 'owner-1',
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        expectedVersion: initial.state.version,
        idempotencyKey: 'evidence-implementation',
        evidence: { kind: 'implementation_committed', exactSha: EXACT_SHA },
      };
      const first = await port.appendEvidence(input);
      assert.equal(first.evidence.kind, 'implementation_committed');
      assert.equal(first.state.version, 2);
      assert.deepEqual(await port.appendEvidence(input), first);
      assert.equal(await redis.ttl(`managed-work:consumer:${CONSUMER_ID}:evidence:${bundle.admission.workId}`), -1);
      assert.equal(
        await redis.ttl(
          `managed-work:consumer:${CONSUMER_ID}:receipt:${bundle.admission.workId}:append-evidence:evidence-implementation`,
        ),
        -1,
      );
      await assert.rejects(
        () => port.appendEvidence({ ...input, idempotencyKey: 'evidence-stale' }),
        /version conflict/i,
      );
    });

    test('rejects only with explicit rejection evidence and keeps terminal state immutable', async () => {
      const bundle = await admit('f289-rejected-work');
      let snapshot = await port.read({
        consumerId: CONSUMER_ID,
        ownerUserId: 'owner-1',
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
      });
      const evidence = await port.appendEvidence({
        consumerId: CONSUMER_ID,
        ownerUserId: 'owner-1',
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        expectedVersion: snapshot.state.version,
        idempotencyKey: 'reject-evidence',
        evidence: { kind: 'work_rejected', exactSha: EXACT_SHA, reason: 'operator rejected acceptance' },
      });
      snapshot = { ...snapshot, state: evidence.state };
      const rejected = await port.transition({
        consumerId: CONSUMER_ID,
        ownerUserId: 'owner-1',
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        expectedVersion: snapshot.state.version,
        idempotencyKey: 'reject-final',
        target: 'rejected',
        exactSha: EXACT_SHA,
      });
      assert.equal(rejected.lifecycle, 'rejected');
      await assert.rejects(
        () =>
          port.appendEvidence({
            consumerId: CONSUMER_ID,
            ownerUserId: 'owner-1',
            workId: bundle.admission.workId,
            attemptId: bundle.attempt.attemptId,
            expectedVersion: rejected.version,
            idempotencyKey: 'late-evidence',
            evidence: { kind: 'implementation_committed', exactSha: EXACT_SHA },
          }),
        /managed work is terminal/i,
      );
    });

    test('accepts only after implementation, green review, merge, and final acceptance evidence', async () => {
      const bundle = await admit();
      let snapshot = await port.read({
        consumerId: CONSUMER_ID,
        ownerUserId: 'owner-1',
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
      });

      await assert.rejects(
        () =>
          port.transition({
            consumerId: CONSUMER_ID,
            ownerUserId: 'owner-1',
            workId: bundle.admission.workId,
            attemptId: bundle.attempt.attemptId,
            expectedVersion: snapshot.state.version,
            idempotencyKey: 'accept-too-early',
            target: 'accepted',
            exactSha: EXACT_SHA,
          }),
        /acceptance evidence incomplete/i,
      );

      const evidence = [
        { kind: 'implementation_committed', exactSha: EXACT_SHA },
        {
          kind: 'review_completed',
          exactSha: EXACT_SHA,
          reviewRoundId: 'round-1',
          openFindingCount: 0,
          checksPassed: true,
        },
        { kind: 'merged', exactSha: EXACT_SHA, mergeCommitSha: 'b'.repeat(40) },
        { kind: 'acceptance_recorded', exactSha: EXACT_SHA, accepted: true },
      ];
      for (const [index, item] of evidence.entries()) {
        const result = await port.appendEvidence({
          consumerId: CONSUMER_ID,
          ownerUserId: 'owner-1',
          workId: bundle.admission.workId,
          attemptId: bundle.attempt.attemptId,
          expectedVersion: snapshot.state.version,
          idempotencyKey: `accept-evidence-${index}`,
          evidence: item,
        });
        snapshot = { ...snapshot, state: result.state };
      }

      const accepted = await port.transition({
        consumerId: CONSUMER_ID,
        ownerUserId: 'owner-1',
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        expectedVersion: snapshot.state.version,
        idempotencyKey: 'accept-final',
        target: 'accepted',
        exactSha: EXACT_SHA,
      });
      assert.equal(accepted.lifecycle, 'accepted');
      assert.equal(accepted.terminalExactSha, EXACT_SHA);
      assert.deepEqual(
        await port.transition({
          consumerId: CONSUMER_ID,
          ownerUserId: 'owner-1',
          workId: bundle.admission.workId,
          attemptId: bundle.attempt.attemptId,
          expectedVersion: snapshot.state.version,
          idempotencyKey: 'accept-final',
          target: 'accepted',
          exactSha: EXACT_SHA,
        }),
        accepted,
      );
      await assert.rejects(
        () =>
          port.createNextAttempt({
            consumerId: CONSUMER_ID,
            ownerUserId: 'owner-1',
            workId: bundle.admission.workId,
            fromAttemptId: bundle.attempt.attemptId,
            executor: { kind: 'external_actor', actorId: 'chatgpt-desktop-dev' },
            expectedVersion: accepted.version,
            idempotencyKey: 'attempt-after-terminal',
          }),
        /managed work is terminal/i,
      );
    });
  },
);
