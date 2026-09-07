import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { BacklogStore } from '../dist/domains/cats/services/stores/ports/BacklogStore.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const input = (extra = {}) => ({
  userId: 'number-owner',
  projectId: 'number-project',
  title: 'Navigation design',
  summary: 'Keep this summary',
  priority: 'p0',
  tags: [],
  createdBy: 'user',
  ...extra,
});

function contracts(getStore) {
  test('allocates after the project catalog, not another project or the home backlog', async () => {
    const store = getStore();
    await store.create(input({ projectId: 'elsewhere', tags: ['feature:f999'] }));
    await store.create(input({ userId: 'another-owner', tags: ['feature:f999'] }));
    await store.create(input({ projectId: undefined, tags: ['feature:f998'] }));
    const item = await store.create(input({ projectFeatureNumbering: { reservedFeatureIds: ['F001', 'F006'] } }));
    assert.equal(item.title, '[F007] Navigation design');
    assert.deepEqual(item.tags, ['feature:f007']);
    assert.equal(item.importOrigin, undefined);
    assert.equal(item.audit[0].detail, item.title);
  });

  test('parallel creates are unique and both title and tag carry the committed ID', async () => {
    const store = getStore();
    const items = await Promise.all(
      Array.from({ length: 12 }, () =>
        store.create(
          input({
            projectId: 'parallel',
            projectFeatureNumbering: { reservedFeatureIds: ['F004'] },
          }),
        ),
      ),
    );
    assert.equal(new Set(items.map((i) => i.tags[0])).size, 12);
    for (const item of items) assert.ok(item.title.startsWith(`[${item.tags[0].slice(8).toUpperCase()}] `));
  });

  test('manual creates cannot claim catalog-reserved numbers, while catalog imports remain valid', async () => {
    const store = getStore();
    const projectId = 'catalog-reservation';
    const before = await store.listByUser('number-owner');
    for (const extra of [
      { title: '[F006] Manual task' },
      { tags: ['feature:f006'] },
      { title: '[f006] Manual task', tags: ['feature:F006'] },
    ]) {
      await assert.rejects(
        async () =>
          store.create(
            input({
              projectId,
              ...extra,
              projectFeatureNumbering: { reservedFeatureIds: ['f006'] },
            }),
          ),
        { name: 'ProjectFeatureNumberError' },
      );
      assert.deepEqual(await store.listByUser('number-owner'), before);
    }
    const imported = await store.create(
      input({
        projectId,
        title: '[F006] Canonical settings',
        tags: ['feature:f006'],
        importOrigin: {
          kind: 'external-project-catalog',
          projectId,
          featureId: 'F006',
          source: 'docs-backlog',
        },
      }),
    );
    assert.equal(imported.importOrigin.featureId, 'F006');
    const next = await store.create(
      input({
        projectId,
        projectFeatureNumbering: { reservedFeatureIds: ['F006'] },
      }),
    );
    assert.equal(next.tags[0], 'feature:f007');
  });

  test('assigns F005 to an existing unnumbered dispatched task without losing work', async () => {
    const store = getStore();
    const original = await store.create(input({ projectId: 'legacy' }));
    await store.suggestClaim(original.id, { catId: 'codex', why: 'why', plan: 'plan', requestedPhase: 'coding' });
    await store.decideClaim(original.id, { decision: 'approve', decidedBy: original.userId });
    await store.markDispatched(original.id, {
      threadId: 'keep-thread',
      threadPhase: 'brainstorm',
      dispatchedBy: original.userId,
    });
    const before = await store.get(original.id);
    const assigned = await store.assignProjectFeatureId(original.id, {
      userId: original.userId,
      projectId: 'legacy',
      expectedRevision: before.revision,
      featureId: 'F005',
      reservedFeatureIds: ['F001', 'F002', 'F003', 'F004', 'F006'],
      reason: 'operator assigned F005',
    });
    assert.equal(assigned.title, '[F005] Navigation design');
    assert.deepEqual(assigned.tags, ['feature:f005']);
    for (const key of [
      'id',
      'status',
      'summary',
      'priority',
      'suggestion',
      'dispatchedThreadId',
      'dispatchedThreadPhase',
    ]) {
      assert.deepEqual(assigned[key], before[key]);
    }
    assert.equal(assigned.revision, before.revision + 1);
    assert.equal(assigned.audit.at(-1).action, 'feature_id_assigned');
    const retry = await store.assignProjectFeatureId(original.id, {
      userId: original.userId,
      projectId: 'legacy',
      expectedRevision: assigned.revision,
      featureId: 'F005',
      reservedFeatureIds: ['F005'],
      reason: 'retry',
    });
    assert.equal(retry.revision, assigned.revision);
  });

  test('rejects conflicting assignment, stale revision and foreign scope without side effects', async () => {
    const store = getStore();
    const item = await store.create(input({ projectId: 'rejections' }));
    const base = {
      userId: item.userId,
      projectId: item.projectId,
      expectedRevision: item.revision,
      featureId: 'F005',
      reservedFeatureIds: [],
      reason: 'assignment',
    };
    for (const extra of [
      { userId: 'foreign' },
      { projectId: 'foreign' },
      { expectedRevision: 999 },
      { reservedFeatureIds: ['F005'] },
    ]) {
      await assert.rejects(async () => store.assignProjectFeatureId(item.id, { ...base, ...extra }));
      assert.deepEqual(await store.get(item.id), item);
    }
    await store.create(input({ projectId: item.projectId, title: '[F005] Already taken', tags: ['feature:f005'] }));
    await assert.rejects(async () => store.assignProjectFeatureId(item.id, base));
    assert.deepEqual(await store.get(item.id), item);
  });

  test('explicit numbers and imports cannot collide with existing project numbers', async () => {
    const store = getStore();
    const args = input({ projectId: 'collision', title: '[F012] Existing', tags: ['feature:f012'] });
    await store.create(args);
    await assert.rejects(async () =>
      store.create({
        ...args,
        importOrigin: {
          kind: 'external-project-catalog',
          projectId: 'collision',
          featureId: 'F012',
          source: 'docs-backlog',
        },
      }),
    );
    await assert.rejects(async () =>
      store.create(
        input({
          projectId: 'collision',
          title: '[F013] Mismatch',
          tags: ['feature:f014'],
          projectFeatureNumbering: { reservedFeatureIds: [] },
        }),
      ),
    );
  });

  test('automatic numbers are not reused after deletion; explicit free gaps remain assignable', async () => {
    const store = getStore();
    const args = input({ projectId: 'no-reuse', projectFeatureNumbering: { reservedFeatureIds: [] } });
    const first = await store.create(args);
    await store.delete(first.id, {
      userId: first.userId,
      projectId: first.projectId,
      expectedRevision: first.revision,
      expectedUpdatedAt: first.updatedAt,
    });
    assert.equal((await store.create(args)).tags[0], 'feature:f002');
    const legacy = await store.create(input({ projectId: first.projectId }));
    const assigned = await store.assignProjectFeatureId(legacy.id, {
      userId: legacy.userId,
      projectId: legacy.projectId,
      expectedRevision: legacy.revision,
      featureId: 'F001',
      reservedFeatureIds: [],
      reason: 'explicit reuse',
    });
    assert.equal(assigned.tags[0], 'feature:f001');
  });

  test('an assignment racing an explicit create cannot produce duplicate numbers', async () => {
    const store = getStore();
    const legacy = await store.create(input({ projectId: 'assignment-race' }));
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        store.assignProjectFeatureId(legacy.id, {
          userId: legacy.userId,
          projectId: legacy.projectId,
          expectedRevision: legacy.revision,
          featureId: 'F005',
          reservedFeatureIds: [],
          reason: 'assign race',
        }),
      ),
      Promise.resolve().then(() =>
        store.create(
          input({
            projectId: legacy.projectId,
            title: '[F005] Concurrent',
            tags: ['feature:f005'],
            projectFeatureNumbering: { reservedFeatureIds: [] },
          }),
        ),
      ),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const items = await store.listByUser(legacy.userId);
    assert.equal(items.filter((i) => i.projectId === legacy.projectId && i.tags.includes('feature:f005')).length, 1);
  });

  test('exhausted or malformed feature numbers fail without creating an unnumbered task', async () => {
    const store = getStore();
    const before = await store.listByUser('number-owner');
    for (const extra of [
      { projectFeatureNumbering: { reservedFeatureIds: ['F999'] } },
      { title: '[F1000] Invalid', projectFeatureNumbering: { reservedFeatureIds: [] } },
      { tags: ['feature:f005', 'feature:f006'], projectFeatureNumbering: { reservedFeatureIds: [] } },
    ]) {
      await assert.rejects(async () => store.create(input({ projectId: 'exhausted', ...extra })), {
        name: 'ProjectFeatureNumberError',
      });
    }
    assert.deepEqual(await store.listByUser('number-owner'), before);
  });
}

describe('project feature numbering: memory', () => {
  const store = new BacklogStore();
  contracts(() => store);
});

describe('project feature numbering: isolated Redis', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, () => {
  let redis;
  let store;
  before(async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'project feature numbering');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisBacklogStore } = await import('../dist/domains/cats/services/stores/redis/RedisBacklogStore.js');
    redis = createRedisClient({ url: process.env.REDIS_URL });
    await redis.ping();
    store = new RedisBacklogStore(redis);
  });
  after(async () => {
    await redis?.quit();
  });
  contracts(() => store);
  test('a fresh store instance continues the persistent sequence', async () => {
    const { RedisBacklogStore } = await import('../dist/domains/cats/services/stores/redis/RedisBacklogStore.js');
    const first = await store.create(
      input({ projectId: 'restart', projectFeatureNumbering: { reservedFeatureIds: ['F080'] } }),
    );
    const second = await new RedisBacklogStore(redis).create(
      input({ projectId: 'restart', projectFeatureNumbering: { reservedFeatureIds: [] } }),
    );
    assert.equal(first.tags[0], 'feature:f081');
    assert.equal(second.tags[0], 'feature:f082');
  });
});
