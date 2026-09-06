import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

async function setup(t) {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'concurrent project import regression');
  const { createRedisClient } = await import('@cat-cafe/shared/utils');
  const { RedisBacklogStore } = await import('../dist/domains/cats/services/stores/redis/RedisBacklogStore.js');
  const { ExternalProjectStore } = await import('../dist/domains/projects/external-project-store.js');
  const { NeedAuditFrameStore } = await import('../dist/domains/projects/need-audit-frame-store.js');
  const { externalProjectRoutes } = await import('../dist/routes/external-projects.js');
  const redis = createRedisClient({ url: process.env.REDIS_URL });
  const store = new RedisBacklogStore(redis);
  const projects = new ExternalProjectStore();
  const app = Fastify();
  const directory = await mkdtemp(join(tmpdir(), 'project-import-race-'));
  t.after(async () => {
    await app.close();
    await redis.quit();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    join(directory, 'BACKLOG.md'),
    '| ID | Feature | Status | Owner |\n|---|---|---|---|\n| F001 | Imported feature | spec | TBD |',
  );
  const userId = directory;
  const project = await projects.create(userId, {
    name: 'Import race',
    sourcePath: directory,
    backlogPath: 'BACKLOG.md',
  });
  await app.register(externalProjectRoutes, {
    externalProjectStore: projects,
    backlogStore: store,
    needAuditFrameStore: new NeedAuditFrameStore(),
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  async function importBacklog() {
    const response = await fetch(`${address}/api/external-projects/${project.id}/import-backlog`, {
      method: 'POST',
      headers: { 'x-cat-cafe-user': userId },
    });
    return { status: response.status, body: await response.json() };
  }
  return { store, project, userId, importBacklog };
}

const options = { skip: redisIsolationSkipReason(process.env.REDIS_URL), timeout: 15000 };

for (const orphan of [false, true]) {
  test(`concurrent imports succeed with one persistent feature; orphan=${orphan}`, options, async (t) => {
    const { store, project, userId, importBacklog } = await setup(t);
    const historical = orphan
      ? await store.create({
          userId,
          title: '[F001] Historical task',
          summary: 'keep',
          priority: 'p2',
          tags: ['feature:f001'],
          createdBy: 'user',
        })
      : undefined;
    const create = store.create.bind(store);
    let arrivals = 0;
    let release;
    const bothReady = new Promise((resolve) => {
      release = resolve;
    });
    store.create = async (input) => {
      if (input.importOrigin) {
        if (++arrivals === 2) release();
        await bothReady;
      }
      return create(input);
    };
    const results = await Promise.all([importBacklog(), importBacklog()]);
    assert.deepEqual(
      results.map((result) => result.status),
      [200, 200],
      JSON.stringify(results),
    );
    assert.equal(
      results.reduce((sum, result) => sum + result.body.imported, 0),
      1,
    );
    assert.equal(
      results.reduce((sum, result) => sum + result.body.skipped, 0),
      1,
    );
    const items = (await store.listByUser(userId)).filter((item) => item.projectId === project.id);
    assert.equal(items.length, 1);
    assert.equal(items[0].importOrigin.featureId, 'F001');
    if (historical) assert.deepEqual(await store.get(historical.id), historical);
  });
}

test('a concurrent manual winner is preserved without adopting importer provenance', options, async (t) => {
  const { store, project, userId, importBacklog } = await setup(t);
  const create = store.create.bind(store);
  let manual;
  store.create = async (input) => {
    manual = await create({
      userId,
      projectId: project.id,
      title: '[F001] Manual winner',
      summary: 'keep this text',
      priority: 'p0',
      tags: [],
      createdBy: 'user',
    });
    return create(input);
  };
  const result = await importBacklog();
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.imported, 0);
  assert.equal(result.body.skipped, 1);
  assert.deepEqual(await store.get(manual.id), manual);
  assert.equal((await store.listByUser(userId)).filter((item) => item.projectId === project.id).length, 1);
});

test(
  'a numbering error without a same-project winner must not be reported as successful import',
  options,
  async (t) => {
    const { store, project, userId, importBacklog } = await setup(t);
    const { ProjectFeatureNumberError } = await import(
      '../dist/domains/cats/services/stores/shared/project-feature-numbering.js'
    );
    await store.create({
      userId,
      projectId: `${project.id}-other`,
      title: '[F001] Other project',
      summary: 'keep',
      priority: 'p2',
      tags: ['feature:f001'],
      createdBy: 'user',
    });
    store.create = async () => {
      throw new ProjectFeatureNumberError('No same-project winner');
    };
    const result = await importBacklog();
    assert.equal(result.status, 500);
    assert.equal((await store.listByUser(userId)).filter((item) => item.projectId === project.id).length, 0);
  },
);

test('unrelated storage errors remain failures even when a same-project winner exists', options, async (t) => {
  const { store, project, userId, importBacklog } = await setup(t);
  const create = store.create.bind(store);
  store.create = async () => {
    await create({
      userId,
      projectId: project.id,
      title: '[F001] Existing winner',
      summary: 'keep',
      priority: 'p2',
      tags: ['feature:f001'],
      createdBy: 'user',
    });
    throw new Error('Unrelated storage error');
  };
  assert.equal((await importBacklog()).status, 500);
});
