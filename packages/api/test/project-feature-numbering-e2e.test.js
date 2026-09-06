import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

test(
  'HTTP and persistent store: repair a legacy task, list it, then create the next numbered task',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'project numbering HTTP acceptance');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisBacklogStore } = await import('../dist/domains/cats/services/stores/redis/RedisBacklogStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ExternalProjectStore } = await import('../dist/domains/projects/external-project-store.js');
    const { NeedAuditFrameStore } = await import('../dist/domains/projects/need-audit-frame-store.js');
    const { externalProjectRoutes } = await import('../dist/routes/external-projects.js');
    const { backlogRoutes } = await import('../dist/routes/backlog.js');
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    const app = Fastify();
    const directory = await mkdtemp(join(tmpdir(), 'project-number-http-'));
    t.after(async () => {
      await app.close();
      await redis.quit();
      await rm(directory, { recursive: true, force: true });
    });
    const ids = ['F001', 'F002', 'F003', 'F004', 'F006'];
    await writeFile(
      join(directory, 'BACKLOG.md'),
      [
        '| ID | Feature | Status | Owner |',
        '|---|---|---|---|',
        ...ids.map((id) => `| ${id} | Canonical ${id} | spec | TBD |`),
      ].join('\n'),
    );
    const store = new RedisBacklogStore(redis);
    const projectStore = new ExternalProjectStore();
    await app.register(externalProjectRoutes, {
      externalProjectStore: projectStore,
      backlogStore: store,
      needAuditFrameStore: new NeedAuditFrameStore(),
    });
    await app.register(backlogRoutes, {
      externalProjectStore: projectStore,
      backlogStore: store,
      threadStore: new ThreadStore(),
      messageStore: new MessageStore(),
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const headers = { 'x-cat-cafe-user': 'http-number-owner', 'content-type': 'application/json' };
    async function request(method, path, body) {
      const response = await fetch(`${address}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
      return response.json();
    }
    const { project } = await request('POST', '/api/external-projects', {
      name: 'Traqen acceptance fixture',
      sourcePath: directory,
      backlogPath: 'BACKLOG.md',
    });
    await request('POST', `/api/external-projects/${project.id}/import-backlog`, {});
    const legacy = await store.create({
      userId: 'http-number-owner',
      projectId: project.id,
      title: 'Traqen整体布局及导航栏设计',
      summary: '负责Traqen页面整体布局',
      priority: 'p0',
      tags: [],
      createdBy: 'user',
    });
    await store.suggestClaim(legacy.id, {
      catId: 'codex',
      why: '保留原方案',
      plan: '保留导航设计计划',
      requestedPhase: 'coding',
    });
    await store.decideClaim(legacy.id, { decision: 'approve', decidedBy: legacy.userId });
    await store.markDispatched(legacy.id, {
      threadId: 'keep-history-thread',
      threadPhase: 'brainstorm',
      dispatchedBy: legacy.userId,
    });
    const before = await store.get(legacy.id);
    const { item } = await request(
      'PATCH',
      `/api/external-projects/${project.id}/backlog/items/${legacy.id}/feature-id`,
      {
        featureId: 'F005',
        expectedRevision: before.revision,
        reason: 'operator explicitly selected F005',
      },
    );
    assert.equal(item.title, '[F005] Traqen整体布局及导航栏设计');
    assert.deepEqual(item.suggestion, before.suggestion);
    assert.equal(item.dispatchedThreadId, before.dispatchedThreadId);
    const list = await request('GET', `/api/backlog/items?projectId=${project.id}`);
    assert.equal(list.items.length, 6);
    assert.equal(list.items.find((i) => i.id === legacy.id).title, item.title);
    const created = await request('POST', `/api/external-projects/${project.id}/backlog/items`, {
      title: '下一项工作',
      summary: '编号自动生成',
      priority: 'p2',
      tags: [],
    });
    assert.equal(created.title, '[F007] 下一项工作');
    assert.equal((await new RedisBacklogStore(redis).get(created.id)).tags[0], 'feature:f007');
    t.diagnostic(
      `worktree=${process.cwd()} HTTP=${address}; existing task=F005, six-item list verified; next create=F007; history retained`,
    );
  },
);
