import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const H = { 'x-cat-cafe-user': 'owner-redis' };

async function createFixture(retirementStoreWrapper) {
  const [
    { createRedisClient },
    { ExternalProjectStore },
    { NeedAuditFrameStore },
    { RedisBacklogStore },
    { RedisThreadStore },
    { RedisWorkflowSopStore },
    { RedisExternalProjectBacklogRetirementStore },
    { externalProjectRoutes },
  ] = await Promise.all([
    import('@cat-cafe/shared/utils'),
    import('../dist/domains/projects/external-project-store.js'),
    import('../dist/domains/projects/need-audit-frame-store.js'),
    import('../dist/domains/cats/services/stores/redis/RedisBacklogStore.js'),
    import('../dist/domains/cats/services/stores/redis/RedisThreadStore.js'),
    import('../dist/domains/cats/services/stores/redis/RedisWorkflowSopStore.js'),
    import('../dist/domains/projects/external-project-backlog-retirement-store.js'),
    import('../dist/routes/external-projects.js'),
  ]);
  const keyPrefix = `cat-cafe-test:external-retirement:${process.pid}:${Date.now()}:${Math.random()}:`;
  const redis = createRedisClient({ url: REDIS_URL, keyPrefix });
  await redis.ping();
  const backlogStore = new RedisBacklogStore(redis);
  const threadStore = new RedisThreadStore(redis);
  const workflowSopStore = new RedisWorkflowSopStore(redis);
  const atomicRetirementStore = new RedisExternalProjectBacklogRetirementStore(redis);
  const backlogRetirementStore = retirementStoreWrapper
    ? retirementStoreWrapper(atomicRetirementStore)
    : atomicRetirementStore;
  const app = Fastify();
  await app.register(externalProjectRoutes, {
    externalProjectStore: new ExternalProjectStore(),
    needAuditFrameStore: new NeedAuditFrameStore(),
    backlogStore,
    threadStore,
    workflowSopStore,
    backlogRetirementStore,
  });

  const sourcePath = await mkdtemp(join(tmpdir(), 'external-retirement-redis-'));
  await mkdir(join(sourcePath, 'docs'), { recursive: true });
  await writeFile(
    join(sourcePath, 'docs', 'ROADMAP.md'),
    ['| ID | Feature | Status | Owner | Link |', '|---|---|---|---|---|'].join('\n'),
  );
  const projectResponse = await app.inject({
    method: 'POST',
    url: '/api/external-projects',
    headers: H,
    payload: { name: 'Traqen', sourcePath, backlogPath: 'docs/ROADMAP.md' },
  });
  const projectId = projectResponse.json().project.id;
  const item = await backlogStore.create({
    userId: 'owner-redis',
    projectId,
    title: '[F007] stale imported row',
    summary: 'retired feature',
    priority: 'p2',
    tags: ['source:docs-backlog', 'feature:f007'],
    createdBy: 'user',
    importOrigin: {
      kind: 'external-project-catalog',
      projectId,
      featureId: 'F007',
      source: 'docs-backlog',
    },
  });
  const primaryThread = await threadStore.create('owner-redis', 'historical F007 thread');
  const secondaryThread = await threadStore.create('owner-redis', 'secondary F007 thread');
  await threadStore.linkBacklogItem(primaryThread.id, item.id);
  await threadStore.linkBacklogItem(secondaryThread.id, item.id);
  await workflowSopStore.upsert(
    item.id,
    'F007',
    {
      stage: 'discussion',
      resumeCapsule: { goal: 'retire safely', currentFocus: 'retirement' },
    },
    'cat-idwxwjba',
    'owner-redis',
  );

  return { app, redis, backlogStore, threadStore, workflowSopStore, projectId, item, primaryThread, secondaryThread };
}

test(
  'retirement atomically removes backlog, workflow SOP, and every owner thread backlink',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'external project retirement');
    const fixture = await createFixture();
    const { app, redis, backlogStore, threadStore, workflowSopStore, projectId, item, primaryThread, secondaryThread } =
      fixture;

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/external-projects/${projectId}/backlog/items/${item.id}`,
        headers: H,
        payload: {
          expectedFeatureId: 'F007',
          expectedUpdatedAt: item.updatedAt,
          expectedRevision: item.revision,
          reason: 'retired from the authoritative project roadmap',
          mode: 'import-reconciliation',
        },
      });

      assert.equal(response.statusCode, 204, response.body);
      assert.equal(await backlogStore.get(item.id, 'owner-redis'), null);
      assert.equal(await workflowSopStore.get(item.id), null);
      assert.equal((await threadStore.get(primaryThread.id))?.backlogItemId, undefined);
      assert.equal((await threadStore.get(secondaryThread.id))?.backlogItemId, undefined);
      await assert.rejects(
        threadStore.linkBacklogItem(primaryThread.id, item.id),
        /backlog.*not found/,
        'a delayed dispatch reverse-link write cannot recreate a retired relationship',
      );
      assert.equal((await threadStore.get(primaryThread.id))?.backlogItemId, undefined);
    } finally {
      await app.close();
      await redis.quit();
    }
  },
);

test(
  'an in-flight dispatch lock rejects retirement without mutating related state',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'external project retirement dispatch exclusion');
    const fixture = await createFixture();
    const { app, redis, backlogStore, threadStore, workflowSopStore, projectId, item, primaryThread } = fixture;

    try {
      const lock = await backlogStore.tryAcquireDispatchLock(item.id);
      assert.equal(typeof lock, 'string');
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/external-projects/${projectId}/backlog/items/${item.id}`,
        headers: H,
        payload: {
          expectedFeatureId: 'F007',
          expectedUpdatedAt: item.updatedAt,
          expectedRevision: item.revision,
          reason: 'exercise dispatch exclusion',
          mode: 'import-reconciliation',
        },
      });

      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.json().error, /dispatch_in_progress/);
      assert.ok(await backlogStore.get(item.id, 'owner-redis'));
      assert.ok(await workflowSopStore.get(item.id));
      assert.equal((await threadStore.get(primaryThread.id))?.backlogItemId, item.id);
      await backlogStore.releaseDispatchLock(item.id, lock);
    } finally {
      await app.close();
      await redis.quit();
    }
  },
);

test(
  'a same-millisecond backlog mutation advances the server revision and rejects stale retirement',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'external project retirement monotonic revision');
    const fixture = await createFixture();
    const { app, redis, backlogStore, projectId, item } = fixture;
    const originalDateNow = Date.now;

    try {
      Date.now = () => item.updatedAt;
      await backlogStore.suggestClaim(item.id, {
        catId: 'cat-idwxwjba',
        why: 'same-millisecond mutation regression',
        plan: 'prove the server revision is the destructive CAS',
        requestedPhase: 'coding',
      });
      const changed = await backlogStore.get(item.id, 'owner-redis');
      assert.equal(changed.updatedAt, item.updatedAt, 'wall-clock timestamp intentionally collides');
      assert.equal(changed.revision, item.revision + 1);

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/external-projects/${projectId}/backlog/items/${item.id}`,
        headers: H,
        payload: {
          expectedFeatureId: 'F007',
          expectedUpdatedAt: item.updatedAt,
          expectedRevision: item.revision,
          reason: 'stale same-millisecond snapshot must fail closed',
          mode: 'import-reconciliation',
        },
      });

      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.json().error, /backlog_conflict/);
      assert.equal((await backlogStore.get(item.id, 'owner-redis'))?.status, 'suggested');
    } finally {
      Date.now = originalDateNow;
      await app.close();
      await redis.quit();
    }
  },
);

test(
  'a delayed stale writer advances the server revision and cannot reuse an inspected retirement snapshot',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'external project retirement concurrent revision');
    const fixture = await createFixture();
    const { app, redis, backlogStore, projectId, item } = fixture;
    const originalDateNow = Date.now;
    const originalWriteItem = backlogStore.writeItem.bind(backlogStore);
    let staleWriteReached;
    let releaseStaleWrite;
    const reached = new Promise((resolve) => {
      staleWriteReached = resolve;
    });
    const release = new Promise((resolve) => {
      releaseStaleWrite = resolve;
    });

    try {
      Date.now = () => item.updatedAt;
      await backlogStore.suggestClaim(item.id, {
        catId: 'cat-idwxwjba',
        why: 'prepare approved item for a concurrent dispatch-progress mutation',
        plan: 'prove every completed mutation advances an atomic server revision',
        requestedPhase: 'coding',
      });
      await backlogStore.decideClaim(item.id, { decision: 'approve', decidedBy: 'owner-redis' });

      backlogStore.writeItem = async (nextItem) => {
        staleWriteReached();
        await release;
        return originalWriteItem(nextItem);
      };
      const staleMutation = backlogStore.updateDispatchProgress(item.id, {
        updatedBy: 'owner-redis',
        dispatchAttemptId: 'stale-attempt',
      });
      await reached;

      const concurrentStore = new backlogStore.constructor(redis);
      await concurrentStore.updateDispatchProgress(item.id, {
        updatedBy: 'owner-redis',
        pendingThreadId: 'newer-thread',
      });
      const inspected = await concurrentStore.get(item.id, 'owner-redis');
      const inspectedRevision = inspected.revision ?? inspected.audit.length;

      releaseStaleWrite();
      await staleMutation;
      const current = await concurrentStore.get(item.id, 'owner-redis');
      assert.equal(current.updatedAt, inspected.updatedAt, 'wall-clock timestamp intentionally collides');
      assert.equal(
        current.audit.length,
        inspected.audit.length,
        'stale writers can replace an equal-length audit tail',
      );
      assert.equal(current.dispatchAttemptId, 'stale-attempt');
      assert.equal(current.pendingThreadId, 'newer-thread');
      assert.equal(current.revision, inspectedRevision + 1, 'the server revision must still advance atomically');

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/external-projects/${projectId}/backlog/items/${item.id}`,
        headers: H,
        payload: {
          expectedFeatureId: 'F007',
          expectedUpdatedAt: inspected.updatedAt,
          expectedRevision: inspectedRevision,
          reason: 'a mutation completed after operator inspection',
          mode: 'import-reconciliation',
        },
      });

      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.json().error, /backlog_conflict/);
      assert.ok(await concurrentStore.get(item.id, 'owner-redis'));
    } finally {
      backlogStore.writeItem = originalWriteItem;
      releaseStaleWrite?.();
      Date.now = originalDateNow;
      await app.close();
      await redis.quit();
    }
  },
);

test(
  'a concurrent Workflow SOP update rejects retirement without mutating any related state',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'external project retirement concurrency');
    let retirementReached;
    let releaseRetirement;
    const reached = new Promise((resolve) => {
      retirementReached = resolve;
    });
    const release = new Promise((resolve) => {
      releaseRetirement = resolve;
    });
    const fixture = await createFixture((atomicStore) => ({
      async retire(input) {
        retirementReached();
        await release;
        return atomicStore.retire(input);
      },
    }));
    const { app, redis, backlogStore, threadStore, workflowSopStore, projectId, item, primaryThread, secondaryThread } =
      fixture;

    try {
      const originalSop = await workflowSopStore.get(item.id);
      assert.ok(originalSop);
      const responsePromise = app.inject({
        method: 'DELETE',
        url: `/api/external-projects/${projectId}/backlog/items/${item.id}`,
        headers: H,
        payload: {
          expectedFeatureId: 'F007',
          expectedUpdatedAt: item.updatedAt,
          expectedRevision: item.revision,
          reason: 'exercise concurrent SOP guard',
          mode: 'import-reconciliation',
        },
      });
      await reached;
      const newerSop = await workflowSopStore.upsert(
        item.id,
        'F007',
        { stage: 'coding', expectedVersion: originalSop.version },
        'cat-idwxwjba',
        'owner-redis',
      );
      releaseRetirement();
      const response = await responsePromise;

      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.json().error, /workflow_conflict/);
      assert.ok(await backlogStore.get(item.id, 'owner-redis'));
      assert.deepEqual(await workflowSopStore.get(item.id), newerSop);
      assert.equal((await threadStore.get(primaryThread.id))?.backlogItemId, item.id);
      assert.equal((await threadStore.get(secondaryThread.id))?.backlogItemId, item.id);
    } finally {
      releaseRetirement?.();
      await app.close();
      await redis.quit();
    }
  },
);
