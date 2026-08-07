// @ts-check

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F289 desktop development loop routes', () => {
  let app;
  let project;
  let threadStore;

  beforeEach(async () => {
    const { ExternalProjectStore } = await import('../dist/domains/projects/external-project-store.js');
    const { ProjectReviewHubService } = await import('../dist/domains/projects/project-review-hub-service.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { desktopDevelopmentLoopRoutes } = await import('../dist/routes/desktop-development-loop.js');
    const externalProjectStore = new ExternalProjectStore();
    threadStore = new ThreadStore();
    project = await externalProjectStore.create('user1', {
      name: 'Route Project',
      description: '',
      sourcePath: '/tmp/route-project',
      desktopDevelopment: {
        repository: 'owner/repo',
        defaultBranch: 'main',
        defaultReviewers: ['cat-a', 'cat-b'],
      },
    });
    app = Fastify();
    await app.register(desktopDevelopmentLoopRoutes, {
      projectReviewHubService: new ProjectReviewHubService(externalProjectStore, threadStore),
    });
  });

  test('POST review-hub ensures and restores the same thread', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${project.id}/development-loop/review-hub`,
      headers: { 'x-cat-cafe-user': 'user1' },
    });
    assert.equal(first.statusCode, 200);
    const firstHub = first.json().reviewHub;
    assert.equal(firstHub.threadId, `project-review-hub:${project.id}`);

    await threadStore.softDelete(firstHub.threadId);
    const restored = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${project.id}/development-loop/review-hub`,
      headers: { 'x-cat-cafe-user': 'user1' },
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().reviewHub.threadId, firstHub.threadId);
    assert.equal(restored.json().reviewHub.status, 'restored');
  });

  test('requires identity and project ownership', async () => {
    const missingIdentity = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${project.id}/development-loop/review-hub`,
    });
    assert.equal(missingIdentity.statusCode, 401);

    const otherUser = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${project.id}/development-loop/review-hub`,
      headers: { 'x-cat-cafe-user': 'user2' },
    });
    assert.equal(otherUser.statusCode, 404);
  });
});
