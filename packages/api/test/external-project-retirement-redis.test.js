import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

test(
  'stale retirement restores the exact Redis Workflow SOP snapshot',
  { skip: redisIsolationSkipReason(REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'external project retirement');
    const [
      { createRedisClient },
      { ExternalProjectStore },
      { NeedAuditFrameStore },
      { RedisBacklogStore },
      { RedisThreadStore },
      { RedisWorkflowSopStore },
      { externalProjectRoutes },
    ] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/projects/external-project-store.js'),
      import('../dist/domains/projects/need-audit-frame-store.js'),
      import('../dist/domains/cats/services/stores/redis/RedisBacklogStore.js'),
      import('../dist/domains/cats/services/stores/redis/RedisThreadStore.js'),
      import('../dist/domains/cats/services/stores/redis/RedisWorkflowSopStore.js'),
      import('../dist/routes/external-projects.js'),
    ]);
    const keyPrefix = `cat-cafe-test:external-retirement:${process.pid}:${Date.now()}:`;
    const redis = createRedisClient({ url: REDIS_URL, keyPrefix });
    await redis.ping();
    const backlogStore = new RedisBacklogStore(redis);
    const threadStore = new RedisThreadStore(redis);
    const workflowSopStore = new RedisWorkflowSopStore(redis);
    const app = Fastify();

    try {
      await app.register(externalProjectRoutes, {
        externalProjectStore: new ExternalProjectStore(),
        needAuditFrameStore: new NeedAuditFrameStore(),
        backlogStore,
        threadStore,
        workflowSopStore,
      });

      const sourcePath = await mkdtemp(join(tmpdir(), 'external-retirement-redis-'));
      await mkdir(join(sourcePath, 'docs'), { recursive: true });
      await writeFile(
        join(sourcePath, 'docs', 'ROADMAP.md'),
        ['| ID | 名称 | Status | Owner | Link |', '|---|---|---|---|---|'].join('\n'),
      );
      const projectResponse = await app.inject({
        method: 'POST',
        url: '/api/external-projects',
        headers: { 'x-cat-cafe-user': 'owner-redis' },
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
      });
      const thread = await threadStore.create('owner-redis', 'historical F007 thread');
      await threadStore.linkBacklogItem(thread.id, item.id);
      await workflowSopStore.upsert(
        item.id,
        'F007',
        {
          stage: 'discussion',
          resumeCapsule: { goal: 'preserve exact rollback state', currentFocus: 'retirement' },
        },
        'cat-idwxwjba',
        'owner-redis',
      );
      const originalWorkflowSop = await workflowSopStore.get(item.id);
      assert.ok(originalWorkflowSop);

      const response = await app.inject({
        method: 'DELETE',
        url: `/api/external-projects/${projectId}/backlog/items/${item.id}`,
        headers: { 'x-cat-cafe-user': 'owner-redis' },
        payload: {
          expectedFeatureId: 'F007',
          expectedUpdatedAt: item.updatedAt - 1,
          reason: 'exercise stale compare-and-delete rollback',
        },
      });

      assert.equal(response.statusCode, 409);
      assert.ok(await backlogStore.get(item.id, 'owner-redis'));
      assert.equal((await threadStore.get(thread.id))?.backlogItemId, item.id);
      assert.deepEqual(await workflowSopStore.get(item.id), originalWorkflowSop);
    } finally {
      await app.close();
      await redis.quit();
    }
  },
);
