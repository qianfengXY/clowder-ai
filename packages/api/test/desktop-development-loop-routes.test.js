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

describe('F289 ChatGPT Desktop service-principal routes', () => {
  const packet = {
    protocolVersion: 1,
    projectId: 'project-1',
    repository: { host: 'github.com', owner: 'owner', name: 'repo', fullName: 'owner/repo' },
    defaultBranch: 'main',
    workId: 'work-1',
    attemptId: 'attempt-1',
    workLifecycle: 'active',
    managedWorkVersion: 2,
    bindingEpoch: 1,
    sessionStatus: 'active',
    sessionVersion: 1,
    branch: 'feat/example',
    currentSha: 'a'.repeat(40),
    lastCommittedSha: 'a'.repeat(40),
    worktreePresent: true,
    mergeMode: 'manual_confirm_in_chatgpt',
    successfulManualPilotCount: 0,
    autoMergeAvailable: false,
    mergeConfirmed: false,
    merged: false,
    acceptancePending: false,
    reviewRoundId: null,
    reviewPhase: null,
    reviewRoundVersion: null,
    reviewCurrentForWork: false,
    openFindings: [],
    nextLegalActions: ['implement_and_report_committed_sha'],
  };

  async function createApp(options = {}) {
    const { desktopDevelopmentLoopRoutes } = await import('../dist/routes/desktop-development-loop.js');
    const calls = [];
    const service = {
      readProject: async (input) => {
        calls.push(['readProject', input]);
        return { project: { projectId: input.projectId, localCheckoutBound: true, binding: null }, reviewHubId: 'hub' };
      },
      readWork: async (input) => {
        calls.push(['readWork', input]);
        return packet;
      },
      connect: async (input) => {
        calls.push(['connect', input]);
        return packet;
      },
      heartbeat: async (input) => {
        calls.push(['heartbeat', input]);
        return packet;
      },
      reportImplementation: async (input) => {
        calls.push(['reportImplementation', input]);
        return { ...packet, reviewRoundId: 'round-1', reviewPhase: 'independent' };
      },
      confirmMerge: async (input) => {
        calls.push(['confirmMerge', input]);
        return { ...packet, mergeConfirmed: true, nextLegalActions: ['merge_with_native_git'] };
      },
      reportMerged: async (input) => {
        calls.push(['reportMerged', input]);
        return { ...packet, merged: true, acceptancePending: true, nextLegalActions: ['wait_for_final_acceptance'] };
      },
      recordAcceptance: async (input) => {
        calls.push(['recordAcceptance', input]);
        return { ...packet, workLifecycle: input.accepted ? 'accepted' : 'rejected', nextLegalActions: [] };
      },
    };
    const app = Fastify();
    await app.register(desktopDevelopmentLoopRoutes, {
      projectReviewHubService: { ensureForProject: async () => ({}) },
      desktopDevelopmentLoopService: service,
      desktopDevelopmentToken: 'desktop-secret',
      desktopDevelopmentOwnerUserId: 'server-owner',
      ...options,
    });
    return { app, calls };
  }

  test('fails closed when provider authentication is unavailable or invalid', async () => {
    const unavailable = await createApp({ desktopDevelopmentToken: '' });
    let response = await unavailable.app.inject({
      method: 'GET',
      url: '/api/desktop-development-loop/v1/projects/project-1?protocolVersion=1',
      headers: { authorization: 'Bearer desktop-secret' },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(unavailable.calls, []);

    const invalid = await createApp();
    response = await invalid.app.inject({
      method: 'GET',
      url: '/api/desktop-development-loop/v1/projects/project-1?protocolVersion=1',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(invalid.calls, []);
  });

  test('derives owner identity server-side and rejects caller-supplied identity fields', async () => {
    const { app, calls } = await createApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/desktop-development-loop/v1/projects/project-1?protocolVersion=1',
      headers: {
        authorization: 'Bearer desktop-secret',
        'x-cat-cafe-user': 'spoofed-owner',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [
      ['readProject', { protocolVersion: 1, ownerUserId: 'server-owner', projectId: 'project-1' }],
    ]);

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/desktop-development-loop/v1/connect',
      headers: { authorization: 'Bearer desktop-secret' },
      payload: {
        protocolVersion: 1,
        ownerUserId: 'spoofed-owner',
        projectId: 'project-1',
        workId: 'work-1',
        attemptId: 'attempt-1',
        runtimeSessionId: 'runtime-1',
        expectedBindingEpoch: 0,
        expectedManagedWorkVersion: 1,
        idempotencyKey: 'connect-1',
        leaseDurationMs: 60_000,
        workspace: {
          repository: { host: 'github.com', owner: 'owner', name: 'repo', fullName: 'owner/repo' },
          branch: 'feat/example',
          baseSha: '0'.repeat(40),
          currentSha: 'a'.repeat(40),
          lastCommittedSha: 'a'.repeat(40),
          worktreePresent: true,
          worktreePath: '/private/worktree',
          validatedAt: 1_000,
        },
      },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(calls.length, 1);
  });

  test('exposes only the bounded project, work, connect, heartbeat, and implementation surface', async () => {
    const { app, calls } = await createApp();
    const headers = { authorization: 'Bearer desktop-secret' };
    const common = {
      protocolVersion: 1,
      projectId: 'project-1',
      workId: 'work-1',
      attemptId: 'attempt-1',
    };
    const workspace = {
      repository: { host: 'github.com', owner: 'owner', name: 'repo', fullName: 'owner/repo' },
      branch: 'feat/example',
      baseSha: '0'.repeat(40),
      currentSha: 'a'.repeat(40),
      lastCommittedSha: 'a'.repeat(40),
      worktreePresent: true,
      worktreePath: '/private/worktree',
      validatedAt: 1_000,
    };

    let response = await app.inject({
      method: 'GET',
      url: '/api/desktop-development-loop/v1/works/work-1?protocolVersion=1&projectId=project-1&attemptId=attempt-1',
      headers,
    });
    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.body, /private\/worktree/);

    response = await app.inject({
      method: 'POST',
      url: '/api/desktop-development-loop/v1/connect',
      headers,
      payload: {
        ...common,
        runtimeSessionId: 'runtime-1',
        expectedBindingEpoch: 0,
        expectedManagedWorkVersion: 1,
        idempotencyKey: 'connect-1',
        leaseDurationMs: 60_000,
        workspace,
      },
    });
    assert.equal(response.statusCode, 200);

    response = await app.inject({
      method: 'POST',
      url: '/api/desktop-development-loop/v1/heartbeat',
      headers,
      payload: {
        ...common,
        runtimeSessionId: 'runtime-1',
        bindingEpoch: 1,
        expectedSessionVersion: 1,
        idempotencyKey: 'heartbeat-1',
        leaseDurationMs: 60_000,
      },
    });
    assert.equal(response.statusCode, 200);

    response = await app.inject({
      method: 'POST',
      url: '/api/desktop-development-loop/v1/implementation',
      headers,
      payload: {
        ...common,
        runtimeSessionId: 'runtime-1',
        bindingEpoch: 1,
        expectedManagedWorkVersion: 2,
        exactSha: 'a'.repeat(40),
        idempotencyKey: 'implementation-1',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reviewRoundId, 'round-1');
    assert.deepEqual(
      calls.map(([name]) => name),
      ['readWork', 'connect', 'heartbeat', 'reportImplementation'],
    );

    response = await app.inject({
      method: 'POST',
      url: '/api/desktop-development-loop/v1/merge',
      headers,
      payload: common,
    });
    assert.equal(response.statusCode, 404);
  });

  test('records current-chat confirmation and merge receipt without exposing a merge primitive', async () => {
    const { app, calls } = await createApp();
    const headers = { authorization: 'Bearer desktop-secret' };
    const common = {
      protocolVersion: 1,
      projectId: 'project-1',
      workId: 'work-1',
      attemptId: 'attempt-1',
      runtimeSessionId: 'runtime-1',
      bindingEpoch: 2,
      expectedManagedWorkVersion: 7,
      exactSha: 'a'.repeat(40),
      idempotencyKey: 'merge-flow-1',
    };
    let response = await app.inject({
      method: 'POST',
      url: '/api/desktop-development-loop/v1/merge-confirmation',
      headers,
      payload: common,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().mergeConfirmed, true);

    response = await app.inject({
      method: 'POST',
      url: '/api/desktop-development-loop/v1/merge-report',
      headers,
      payload: { ...common, idempotencyKey: 'merge-flow-2', mergeCommitSha: 'b'.repeat(40) },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().acceptancePending, true);
    assert.deepEqual(
      calls.map(([name]) => name),
      ['confirmMerge', 'reportMerged'],
    );
    assert.equal(
      calls.every(([, input]) => input.ownerUserId === 'server-owner'),
      true,
    );
  });

  test('keeps final acceptance on the authenticated Cat Cafe user surface', async () => {
    const { app, calls } = await createApp();
    const payload = {
      protocolVersion: 1,
      attemptId: 'attempt-1',
      expectedManagedWorkVersion: 9,
      exactSha: 'a'.repeat(40),
      accepted: true,
      idempotencyKey: 'acceptance-1',
    };
    let response = await app.inject({
      method: 'POST',
      url: '/api/external-projects/project-1/development-loop/works/work-1/acceptance',
      payload,
    });
    assert.equal(response.statusCode, 401);

    response = await app.inject({
      method: 'POST',
      url: '/api/external-projects/project-1/development-loop/works/work-1/acceptance',
      headers: { 'x-cat-cafe-user': 'operator-1' },
      payload,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().workLifecycle, 'accepted');
    assert.deepEqual(calls, [
      [
        'recordAcceptance',
        {
          ...payload,
          projectId: 'project-1',
          workId: 'work-1',
          ownerUserId: 'operator-1',
        },
      ],
    ]);
  });
});
