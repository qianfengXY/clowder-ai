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
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 1);
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
      importOrigin: {
        kind: 'external-project-catalog',
        projectId: 'project-traqen',
        featureId: 'F006',
        source: 'docs-backlog',
      },
      dependencies: { blockedBy: ['F007'] },
    });

    assert.equal(created.projectId, 'project-traqen');
    assert.equal(created.revision, 1);
    assert.equal((await store.get(created.id))?.projectId, 'project-traqen');
    assert.deepEqual((await store.get(created.id))?.importOrigin, created.importOrigin);
    assert.deepEqual((await store.get(created.id))?.dependencies, { blockedBy: ['F007'] });
    assert.equal((await store.listByUser('default-user'))[0]?.projectId, 'project-traqen');
  });

  it('adoptImportOrigin installs immutable provenance under exact owner/project/update CAS', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const created = await store.create({
      userId: 'default-user',
      title: '[F004] legacy imported title',
      summary: 'legacy source snapshot',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f004'],
      createdBy: 'user',
      projectId: 'project-traqen',
    });
    const input = {
      userId: 'default-user',
      projectId: 'project-traqen',
      expectedUpdatedAt: created.updatedAt,
      expectedRevision: created.revision,
      importOrigin: {
        kind: 'external-project-catalog',
        projectId: 'project-traqen',
        featureId: 'F004',
        source: 'docs-backlog',
      },
      adoptedBy: 'default-user',
      reason: 'operator verified the legacy row',
    };

    const adopted = await store.adoptImportOrigin(created.id, input);
    assert.deepEqual(adopted?.importOrigin, input.importOrigin);
    assert.ok(adopted.updatedAt > created.updatedAt);
    assert.equal(adopted.revision, created.revision + 1);
    assert.equal(adopted.audit.at(-1).action, 'import_origin_adopted');
    assert.equal(
      await store.adoptImportOrigin(created.id, input),
      null,
      'stale or repeated adoption cannot overwrite origin',
    );
    assert.deepEqual((await store.get(created.id))?.importOrigin, input.importOrigin);
  });

  it('hydrates a legacy record revision and atomically advances it on the next mutation', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const created = await store.create({
      userId: 'default-user',
      title: '[F002] legacy revision',
      summary: 'created before the explicit revision field existed',
      priority: 'p1',
      tags: ['source:docs-backlog', 'feature:f002'],
      createdBy: 'user',
      projectId: 'project-traqen',
    });
    await redis.hdel(`backlog:item:${created.id}`, 'revision');

    const legacy = await store.get(created.id);
    assert.equal(legacy.revision, legacy.audit.length);
    const refreshed = await store.refreshMetadata(created.id, {
      title: '[F002] Deterministic Evidence',
      summary: legacy.summary,
      priority: legacy.priority,
      tags: legacy.tags,
      refreshedBy: 'default-user',
    });

    assert.equal(refreshed.revision, legacy.revision + 1);
    assert.equal(await redis.hget(`backlog:item:${created.id}`, 'revision'), String(refreshed.revision));
  });

  it('refreshMetadata cannot overwrite a concurrent lifecycle transition', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const created = await store.create({
      userId: 'default-user',
      title: '[F003] stale title',
      summary: 'stale summary',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f003'],
      createdBy: 'user',
      projectId: 'project-traqen',
      importOrigin: {
        kind: 'external-project-catalog',
        projectId: 'project-traqen',
        featureId: 'F003',
        source: 'docs-backlog',
      },
    });

    let refreshEvalSeen = false;
    let releaseSnapshot;
    let snapshotTaken;
    const release = new Promise((resolve) => {
      releaseSnapshot = resolve;
    });
    const staleRead = new Promise((resolve) => {
      snapshotTaken = resolve;
    });
    const redisProxy = new Proxy(redis, {
      get(target, property) {
        if (property === 'eval') {
          return async (...args) => {
            if (String(args[0]).includes('REFRESH_METADATA_ATOMIC')) refreshEvalSeen = true;
            return target.eval(...args);
          };
        }
        if (property === 'hgetall') {
          return async (...args) => {
            const snapshot = await target.hgetall(...args);
            if (!refreshEvalSeen && String(args[0]).endsWith(created.id)) {
              snapshotTaken();
              await release;
            }
            return snapshot;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const refreshStore = new RedisBacklogStore(redisProxy, { ttlSeconds: 120 });
    const refreshPromise = refreshStore.refreshMetadata(created.id, {
      title: '[F003] Agent Candidates & Reviewed Business Function Tree',
      summary: 'canonical source summary',
      priority: 'p1',
      tags: ['source:docs-backlog', 'feature:f003', 'status:spec'],
      refreshedBy: 'default-user',
    });

    const firstBoundary = await Promise.race([
      refreshPromise.then(() => 'atomic-refresh'),
      staleRead.then(() => 'stale-read'),
    ]);
    await store.suggestClaim(created.id, {
      catId: 'codex',
      why: 'preserve current work',
      plan: 'continue lifecycle',
      requestedPhase: 'coding',
    });
    await store.decideClaim(created.id, { decision: 'approve', decidedBy: 'default-user' });
    await store.markDispatched(created.id, {
      threadId: 'thread-f003',
      threadPhase: 'coding',
      dispatchedBy: 'default-user',
    });
    releaseSnapshot();
    await refreshPromise;

    assert.equal(firstBoundary, 'atomic-refresh');
    const finalItem = await store.get(created.id);
    assert.equal(finalItem?.title, '[F003] Agent Candidates & Reviewed Business Function Tree');
    assert.equal(finalItem?.priority, 'p1');
    assert.equal(finalItem?.status, 'dispatched');
    assert.equal(finalItem?.dispatchedThreadId, 'thread-f003');
    assert.deepEqual(finalItem?.importOrigin, created.importOrigin);
    assert.deepEqual(
      finalItem?.audit.map((entry) => entry.action),
      ['created', 'refreshed', 'suggested', 'approved', 'dispatched'],
    );
    assert.equal(finalItem?.revision, created.revision + 4);
  });

  it('delete removes only the exact owner/project item and clears its list and dispatch lock', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const created = await store.create({
      userId: 'default-user',
      title: '[F007] Retired feature',
      summary: 'must be reusable after explicit removal',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f007'],
      createdBy: 'user',
      projectId: 'project-traqen',
    });
    await redis.set(`backlog:dispatch-lock:${created.id}`, 'test-lock');

    assert.equal(
      await store.delete(created.id, {
        userId: 'default-user',
        projectId: 'another-project',
        expectedUpdatedAt: created.updatedAt,
        expectedRevision: created.revision,
      }),
      null,
      'a project mismatch must leave the record intact',
    );
    assert.ok(await store.get(created.id));

    assert.equal(
      await store.delete(created.id, {
        userId: 'default-user',
        projectId: 'project-traqen',
        expectedUpdatedAt: created.updatedAt - 1,
        expectedRevision: created.revision,
      }),
      null,
      'a stale snapshot must leave the record intact',
    );
    assert.ok(await store.get(created.id));

    const removed = await store.delete(created.id, {
      userId: 'default-user',
      projectId: 'project-traqen',
      expectedUpdatedAt: created.updatedAt,
      expectedRevision: created.revision,
    });
    assert.equal(removed?.id, created.id);
    assert.equal(await store.get(created.id), null);
    assert.equal(await redis.zscore('backlog:items:user:default-user', created.id), null);
    assert.equal(await redis.get(`backlog:dispatch-lock:${created.id}`), null);
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
