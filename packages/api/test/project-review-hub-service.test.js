// @ts-check

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

describe('EXT-001 ProjectReviewHubService', () => {
  let projectStore;
  let threadStore;
  let service;
  let project;

  beforeEach(async () => {
    const { ExternalProjectStore } = await import('../dist/domains/projects/external-project-store.js');
    const { ProjectReviewHubService } = await import('../dist/domains/projects/project-review-hub-service.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    projectStore = new ExternalProjectStore();
    threadStore = new ThreadStore({ maxThreads: 100 });
    service = new ProjectReviewHubService(projectStore, threadStore, {
      listByUser: async (userId) =>
        userId === 'user1'
          ? [
              {
                id: 'backlog-f006',
                userId,
                projectId: project.id,
                title: 'Workspace settings',
                tags: ['feature:f006'],
              },
            ]
          : [],
    });
    project = await projectStore.create('user1', {
      name: 'Loop Project',
      description: '',
      sourcePath: '/tmp/loop-project',
      desktopDevelopment: {
        repository: 'owner/repo',
        defaultBranch: 'main',
        defaultReviewers: ['cat-a', 'cat-b'],
      },
    });
  });

  test('concurrent ensure calls resolve one deterministic Review Hub', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => service.ensureForProject(project.id, 'user1')));
    const ids = new Set(results.map((item) => item.threadId));
    assert.deepEqual([...ids], [`project-review-hub:${project.id}`]);

    const thread = await threadStore.get(results[0].threadId);
    assert.equal(thread.projectPath, project.sourcePath);
    assert.equal(thread.title, 'Review Hub · Loop Project');
    assert.equal((await threadStore.list('user1')).filter((item) => item.id === results[0].threadId).length, 1);
  });

  test('soft deletion restores the same visible Hub and preserves thread identity', async () => {
    const first = await service.ensureForProject(project.id, 'user1');
    assert.equal(await threadStore.softDelete(first.threadId), true);
    assert.ok((await threadStore.get(first.threadId)).deletedAt);

    const restored = await service.ensureForProject(project.id, 'user1');
    assert.equal(restored.threadId, first.threadId);
    assert.equal(restored.status, 'restored');
    assert.equal((await threadStore.get(first.threadId)).deletedAt, null);
  });

  test('irrecoverably missing thread view is recreated at the same deterministic Hub id', async () => {
    const first = await service.ensureForProject(project.id, 'user1');
    assert.equal(await threadStore.delete(first.threadId), true);
    assert.equal(await threadStore.get(first.threadId), null);

    const recreated = await service.ensureForProject(project.id, 'user1');
    assert.equal(recreated.threadId, first.threadId);
    assert.equal(recreated.hubId, first.hubId);
    assert.equal(recreated.status, 'active');
    assert.equal((await threadStore.list('user1')).filter((item) => item.id === first.threadId).length, 1);
  });

  test('reuses one Hub across delivery cycles and rejects cross-user access', async () => {
    const first = await service.ensureForProject(project.id, 'user1');
    const nextCycle = await service.ensureForProject(project.id, 'user1');
    assert.equal(nextCycle.threadId, first.threadId);
    await assert.rejects(() => service.ensureForProject(project.id, 'user2'), /Project not found/i);
  });

  test('fails closed for projects without a Desktop development binding', async () => {
    const unbound = await projectStore.create('user1', {
      name: 'Unbound',
      description: '',
      sourcePath: '/tmp/unbound',
    });
    await assert.rejects(() => service.ensureForProject(unbound.id, 'user1'), /not configured/i);
  });

  test('creates deterministic plan and review threads for one feature', async () => {
    const plan = await service.ensureForFeature(project.id, 'backlog-f006', 'plan', 'user1');
    const review = await service.ensureForFeature(project.id, 'backlog-f006', 'review', 'user1');
    assert.equal(plan.threadId, `project-feature-plan:${project.id}:backlog-f006`);
    assert.equal(review.threadId, `project-feature-review:${project.id}:backlog-f006`);
    assert.equal((await threadStore.get(plan.threadId)).title, 'F006 · 方案 · Loop Project');
    assert.equal((await threadStore.get(review.threadId)).title, 'F006 · Review · Loop Project');
    assert.equal((await threadStore.get(plan.threadId)).backlogItemId, 'backlog-f006');
    assert.equal((await threadStore.get(review.threadId)).projectPath, project.sourcePath);
    assert.equal(plan.binding, 'automatic');
  });

  test('binds a feature workspace to an existing conversation in the same project', async () => {
    const existing = await threadStore.create('user1', 'Existing design conversation', project.sourcePath);
    const candidates = await service.listFeatureThreadCandidates(project.id, 'backlog-f006', 'plan', 'user1');
    assert.ok(candidates.candidates.some((candidate) => candidate.threadId === existing.id));

    const bound = await service.bindFeatureThread(project.id, 'backlog-f006', 'plan', existing.id, 'user1');
    assert.equal(bound.threadId, existing.id);
    assert.equal(bound.binding, 'manual');
    assert.equal((await threadStore.get(existing.id)).title, 'Existing design conversation');

    const reset = await service.bindFeatureThread(project.id, 'backlog-f006', 'plan', null, 'user1');
    assert.equal(reset.threadId, `project-feature-plan:${project.id}:backlog-f006`);
    assert.equal(reset.binding, 'automatic');
  });

  test('rejects conversations outside the project and restores a soft-deleted manual binding', async () => {
    const outside = await threadStore.create('user1', 'Other project', '/tmp/other-project');
    await assert.rejects(
      () => service.bindFeatureThread(project.id, 'backlog-f006', 'plan', outside.id, 'user1'),
      /not an available workspace candidate/i,
    );

    const existing = await threadStore.create('user1', 'Bound review', project.sourcePath);
    await service.bindFeatureThread(project.id, 'backlog-f006', 'review', existing.id, 'user1');
    assert.equal(await threadStore.softDelete(existing.id), true);
    const restored = await service.ensureForFeature(project.id, 'backlog-f006', 'review', 'user1');
    assert.equal(restored.threadId, existing.id);
    assert.equal(restored.status, 'restored');
  });

  test('locks Review rebinding while a review round is active', async () => {
    const { ProjectReviewHubService } = await import('../dist/domains/projects/project-review-hub-service.js');
    const lockedService = new ProjectReviewHubService(
      projectStore,
      threadStore,
      {
        listByUser: async () => [
          {
            id: 'backlog-f006',
            projectId: project.id,
            tags: ['feature:f006'],
          },
        ],
      },
      async () => true,
    );
    const existing = await threadStore.create('user1', 'Replacement review', project.sourcePath);
    const candidates = await lockedService.listFeatureThreadCandidates(project.id, 'backlog-f006', 'review', 'user1');
    assert.equal(candidates.locked, true);
    await assert.rejects(
      () => lockedService.bindFeatureThread(project.id, 'backlog-f006', 'review', existing.id, 'user1'),
      /locked while a review round is in progress/i,
    );
  });
});
