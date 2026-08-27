/**
 * RedisBacklogStore tests
 * 有 Redis → 测全量；无 Redis → skip
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisBacklogStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisBacklogStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;
  let originalDateNow;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisBacklogStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisBacklogStore.js');
    RedisBacklogStore = storeModule.RedisBacklogStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-backlog-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisBacklogStore(redis, { ttlSeconds: 120 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['backlog:item:*', 'backlog:items:user:*', 'thread:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['backlog:item:*', 'backlog:items:user:*', 'thread:*']);
    originalDateNow = Date.now;
  });

  afterEach(() => {
    if (originalDateNow) {
      Date.now = originalDateNow;
    }
  });

  async function createDispatchedItem(title) {
    const created = await store.create({
      userId: 'default-user',
      title,
      summary: `${title} summary`,
      priority: 'p1',
      tags: ['lease'],
      createdBy: 'user',
    });

    await store.suggestClaim(created.id, {
      catId: 'codex',
      why: 'ready',
      plan: 'dispatch + lease',
      requestedPhase: 'coding',
    });
    await store.decideClaim(created.id, {
      decision: 'approve',
      decidedBy: 'default-user',
    });
    await store.markDispatched(created.id, {
      threadId: `thread-${created.id}`,
      threadPhase: 'coding',
      dispatchedBy: 'default-user',
    });
    return created.id;
  }

  async function createThreadPhaseStore(threadId, phase = 'coding') {
    await redis.hset(`thread:${threadId}`, 'id', threadId, 'phase', phase);
    return {
      get: async (id) => {
        const data = await redis.hgetall(`thread:${id}`);
        return data.id ? { id: data.id, phase: data.phase } : null;
      },
      updatePhase: async (id, nextPhase) => {
        await redis.hset(`thread:${id}`, 'phase', nextPhase);
      },
    };
  }

  it('ensureTaskBackedItem atomically reuses one deterministic projection under concurrency', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const input = {
      userId: 'default-user',
      taskId: 'task-f287',
      featureId: 'F287',
      title: 'F287 durable task',
      summary: 'Task truth already exists in this thread',
      createdBy: 'codex-sol',
    };

    const [first, second] = await Promise.all([store.ensureTaskBackedItem(input), store.ensureTaskBackedItem(input)]);

    assert.equal(first.id, 'task:task-f287');
    assert.equal(second.id, first.id);
    assert.equal((await store.listByUser('default-user')).length, 1);
    assert.deepEqual(first.tags, ['source:task', 'feature:f287']);
  });

  it('create preserves an external project binding', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const created = await store.create({
      userId: 'default-user',
      title: '[F006] Workspace capability settings',
      summary: 'Imported from an external project roadmap',
      priority: 'p0',
      tags: ['source:docs-backlog', 'feature:f006'],
      createdBy: 'user',
      projectId: 'project-traqen',
    });

    assert.equal(created.projectId, 'project-traqen');
    assert.equal((await store.get(created.id))?.projectId, 'project-traqen');
    assert.equal((await store.listByUser('default-user'))[0]?.projectId, 'project-traqen');
  });

  it('reopen transitions a done item to open with an auditable correction reason', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const created = await store.create({
      userId: 'default-user',
      title: 'Imported F001',
      summary: 'must remain active',
      priority: 'p0',
      tags: ['feature:f001'],
      createdBy: 'user',
      projectId: 'project-traqen',
    });
    await store.markDone(created.id, { doneBy: 'default-user' });

    const reopened = await store.reopen(created.id, {
      userId: 'default-user',
      projectId: 'project-traqen',
      expectedStatus: 'done',
      reason: 'Correct cross-project import status collision',
    });

    assert.equal(reopened?.status, 'open');
    assert.equal(reopened?.doneAt, undefined);
    assert.equal(reopened?.audit.at(-1)?.action, 'reopened');
    assert.equal(reopened?.audit.at(-1)?.detail, 'Correct cross-project import status collision');
  });

  it('correctDispatchedPhase atomically preserves the dispatched thread and rejects stale targets', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const itemId = await createDispatchedItem('dispatch phase correction');
    const before = await store.get(itemId);
    assert.ok(before?.dispatchedThreadId);
    const threadStore = await createThreadPhaseStore(before.dispatchedThreadId);

    const corrected = await store.correctDispatchedPhase(
      itemId,
      {
        userId: 'default-user',
        expectedThreadId: before.dispatchedThreadId,
        threadPhase: 'research',
        reason: 'Correct initial dispatch phase',
      },
      threadStore,
    );
    assert.equal(corrected?.dispatchedThreadId, before.dispatchedThreadId);
    assert.equal(corrected?.dispatchedThreadPhase, 'research');
    assert.equal((await threadStore.get(before.dispatchedThreadId))?.phase, 'research');
    assert.equal(corrected?.audit.at(-1)?.action, 'dispatch_phase_corrected');

    await assert.rejects(
      store.correctDispatchedPhase(
        itemId,
        {
          userId: 'default-user',
          expectedThreadId: 'thread-stale',
          threadPhase: 'brainstorm',
          reason: 'A stale correction must not retarget the item',
        },
        threadStore,
      ),
      /dispatched thread mismatch/i,
    );
    assert.equal((await store.get(itemId))?.dispatchedThreadPhase, 'research');
  });

  it('keeps backlog, thread, and audit transitions consistent under concurrent corrections', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const itemId = await createDispatchedItem('concurrent dispatch phase correction');
    const before = await store.get(itemId);
    assert.ok(before?.dispatchedThreadId);
    const threadStore = await createThreadPhaseStore(before.dispatchedThreadId);
    const input = (threadPhase, reason) => ({
      userId: 'default-user',
      expectedThreadId: before.dispatchedThreadId,
      threadPhase,
      reason,
    });

    await Promise.all([
      store.correctDispatchedPhase(itemId, input('research', 'First concurrent correction'), threadStore),
      store.correctDispatchedPhase(itemId, input('brainstorm', 'Second concurrent correction'), threadStore),
    ]);

    const item = await store.get(itemId);
    const thread = await threadStore.get(before.dispatchedThreadId);
    assert.equal(item?.dispatchedThreadPhase, thread?.phase);
    const corrections = item?.audit.filter((entry) => entry.action === 'dispatch_phase_corrected') ?? [];
    assert.equal(corrections.length, 2);
    let previousPhase = 'coding';
    for (const correction of corrections) {
      const transition = correction.detail.slice(correction.detail.lastIndexOf(':') + 1).split(';')[0];
      const [from, to] = transition.split('→');
      assert.equal(from, previousPhase);
      previousPhase = to;
    }
    assert.equal(previousPhase, item?.dispatchedThreadPhase);
  });

  it('reopen is an atomic project-scoped CAS that clears persisted doneAt and retains all lifecycle bindings', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const created = await store.create({
      userId: 'default-user',
      title: 'Imported F001',
      summary: 'must retain its current workflow binding',
      priority: 'p0',
      tags: ['feature:f001'],
      createdBy: 'user',
      projectId: 'project-traqen',
    });
    await store.suggestClaim(created.id, {
      catId: 'codex',
      why: 'preserve suggestion',
      plan: 'reopen historical correction',
      requestedPhase: 'coding',
    });
    await store.decideClaim(created.id, { decision: 'approve', decidedBy: 'default-user' });
    await store.updateDispatchProgress(created.id, {
      updatedBy: 'default-user',
      dispatchAttemptId: 'attempt-1',
      pendingThreadId: 'thread-dispatched',
      kickoffMessageId: 'message-kickoff',
    });
    await store.markDispatched(created.id, {
      threadId: 'thread-dispatched',
      threadPhase: 'coding',
      dispatchedBy: 'default-user',
    });
    await store.acquireLease(created.id, { catId: 'codex', ttlMs: 60_000, actorId: 'default-user' });
    await store.markDone(created.id, { doneBy: 'default-user' });
    const before = await store.get(created.id);
    assert.ok(before?.doneAt, 'markDone must persist doneAt before reopen');
    assert.equal(await redis.hget(`backlog:item:${created.id}`, 'doneAt'), String(before?.doneAt));

    const correction = {
      userId: 'default-user',
      projectId: 'project-traqen',
      expectedStatus: 'done',
      reason: 'Correct cross-project import status collision',
    };
    const results = await Promise.allSettled([
      store.reopen(created.id, correction),
      store.reopen(created.id, correction),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);

    const reloaded = await store.get(created.id);
    assert.equal(reloaded?.status, 'open');
    assert.equal(reloaded?.doneAt, undefined);
    assert.equal(await redis.hget(`backlog:item:${created.id}`, 'doneAt'), null);
    assert.deepEqual(reloaded?.suggestion, before?.suggestion);
    assert.deepEqual(reloaded?.lease, before?.lease);
    assert.equal(reloaded?.dispatchedThreadId, before?.dispatchedThreadId);
    assert.equal(reloaded?.dispatchedThreadPhase, before?.dispatchedThreadPhase);
    assert.equal(reloaded?.dispatchAttemptId, before?.dispatchAttemptId);
    assert.equal(reloaded?.pendingThreadId, before?.pendingThreadId);
    assert.equal(reloaded?.kickoffMessageId, before?.kickoffMessageId);
    assert.deepEqual(reloaded?.audit.slice(0, -1), before?.audit);
    assert.equal(reloaded?.audit.at(-1)?.action, 'reopened');
    assert.equal(reloaded?.audit.filter((entry) => entry.action === 'reopened').length, 1);
  });

  it('concurrent acquire by different cats: only one succeeds', async () => {
    const itemId = await createDispatchedItem('acquire-race');

    const results = await Promise.allSettled([
      store.acquireLease(itemId, {
        catId: 'codex',
        ttlMs: 60_000,
        actorId: 'default-user',
      }),
      store.acquireLease(itemId, {
        catId: 'opus',
        ttlMs: 60_000,
        actorId: 'default-user',
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const latest = await store.get(itemId);
    assert.ok(latest?.lease);
    assert.equal(latest?.lease?.state, 'active');
    assert.ok(['codex', 'opus'].includes(latest?.lease?.ownerCatId ?? ''));
  });

  it('concurrent heartbeat vs reclaim at expiry boundary: exactly one transition wins', async () => {
    const itemId = await createDispatchedItem('heartbeat-reclaim-race');
    await store.acquireLease(itemId, {
      catId: 'codex',
      ttlMs: 2_000,
      actorId: 'default-user',
    });

    const seeded = await store.get(itemId);
    assert.ok(seeded?.lease);
    if (!seeded?.lease) return;

    const beforeExpiry = seeded.lease.expiresAt - 1;
    const afterExpiry = seeded.lease.expiresAt + 1;
    const timestamps = [beforeExpiry, afterExpiry];
    Date.now = () => timestamps.shift() ?? afterExpiry;

    const results = await Promise.allSettled([
      store.heartbeatLease(itemId, {
        catId: 'codex',
        ttlMs: 5_000,
        actorId: 'default-user',
      }),
      store.reclaimExpiredLease(itemId, {
        actorId: 'default-user',
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const latest = await store.get(itemId);
    assert.ok(latest?.lease);
    if (!latest?.lease) return;

    assert.ok(latest.lease.state === 'active' || latest.lease.state === 'reclaimed');
    const heartbeatCount = latest.audit.filter((entry) => entry.action === 'lease_heartbeat').length;
    const reclaimCount = latest.audit.filter((entry) => entry.action === 'lease_reclaimed').length;
    assert.equal(heartbeatCount + reclaimCount, 1);
  });
});
