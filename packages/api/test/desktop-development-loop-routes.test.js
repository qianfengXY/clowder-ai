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
      projectReviewHubService: new ProjectReviewHubService(externalProjectStore, threadStore, {
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
      }),
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

  test('POST feature thread creates separate plan and Review conversations', async () => {
    for (const kind of ['plan', 'review']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/external-projects/${project.id}/development-loop/features/backlog-f006/threads/${kind}`,
        headers: { 'x-cat-cafe-user': 'user1' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().thread.threadId, `project-feature-${kind}:${project.id}:backlog-f006`);
    }
  });

  test('lists same-project candidates and binds an existing conversation', async () => {
    const existing = await threadStore.create('user1', 'Existing plan', project.sourcePath);
    const candidates = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${project.id}/development-loop/features/backlog-f006/threads/plan/candidates`,
      headers: { 'x-cat-cafe-user': 'user1' },
    });
    assert.equal(candidates.statusCode, 200);
    assert.ok(candidates.json().binding.candidates.some((candidate) => candidate.threadId === existing.id));

    const bound = await app.inject({
      method: 'PUT',
      url: `/api/external-projects/${project.id}/development-loop/features/backlog-f006/threads/plan/binding`,
      headers: { 'x-cat-cafe-user': 'user1' },
      payload: { threadId: existing.id },
    });
    assert.equal(bound.statusCode, 200);
    assert.equal(bound.json().thread.threadId, existing.id);
    assert.equal(bound.json().thread.binding, 'manual');
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
      readProjectByRepository: async (input) => {
        calls.push(['readProjectByRepository', input]);
        return {
          project: { projectId: 'project-from-repo', localCheckoutBound: true, binding: null },
          reviewHubId: 'hub',
        };
      },
      listProjectWorks: async (input) => {
        calls.push(['listProjectWorks', input]);
        return [packet];
      },
      listProjectLaunchStates: async (input) => {
        calls.push(['listProjectLaunchStates', input]);
        return [
          {
            backlogItemId: 'backlog-1',
            featureId: 'F006',
            title: 'Workspace capability settings',
            status: 'available',
          },
        ];
      },
      startProjectWork: async (input) => {
        calls.push(['startProjectWork', input]);
        return {
          backlogItemId: input.backlogItemId,
          featureId: 'F006',
          title: 'Workspace capability settings',
          status: 'ready_for_desktop',
        };
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
    assert.deepEqual(response.json(), {
      error: 'Desktop development authentication is not configured',
      code: 'desktop_development_auth_unavailable',
      action: 'Configure the scoped Desktop development credential before retrying.',
    });
    assert.deepEqual(unavailable.calls, []);

    const capabilityUnavailable = await createApp({ desktopDevelopmentLoopService: undefined });
    response = await capabilityUnavailable.app.inject({
      method: 'GET',
      url: '/api/desktop-development-loop/v1/projects/project-1?protocolVersion=1',
      headers: { authorization: 'Bearer desktop-secret' },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      error: 'Desktop managed-work capability is unavailable',
      code: 'managed_work_capability_unavailable',
      action: 'Upgrade or enable the F275 managed-work consumer capability before retrying.',
    });
    assert.deepEqual(capabilityUnavailable.calls, []);

    const invalid = await createApp();
    response = await invalid.app.inject({
      method: 'GET',
      url: '/api/desktop-development-loop/v1/projects/project-1?protocolVersion=1',
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(invalid.calls, []);
  });

  test('returns a structured safe-upgrade response for protocol mismatch', async () => {
    const { app, calls } = await createApp({
      desktopDevelopmentLoopService: {
        readProject: async () => {
          throw new Error('Desktop development protocol mismatch: received 2, supported 1');
        },
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/desktop-development-loop/v1/projects/project-1?protocolVersion=2',
      headers: { authorization: 'Bearer desktop-secret' },
    });
    assert.equal(response.statusCode, 426);
    assert.deepEqual(response.json(), {
      error: 'Desktop development protocol mismatch: received 2, supported 1',
      code: 'desktop_development_protocol_mismatch',
      supportedProtocolVersion: 1,
      action: 'Upgrade or reconfigure the Desktop client to protocol version 1 before any write.',
    });
    assert.deepEqual(calls, []);
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

  test('resolves the project from an exact repository without exposing owner identity', async () => {
    const { app, calls } = await createApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/desktop-development-loop/v1/projects/resolve?protocolVersion=1&repository=owner%2Frepo',
      headers: { authorization: 'Bearer desktop-secret', 'x-cat-cafe-user': 'spoofed-owner' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().project.projectId, 'project-from-repo');
    assert.deepEqual(calls, [
      ['readProjectByRepository', { protocolVersion: 1, ownerUserId: 'server-owner', repository: 'owner/repo' }],
    ]);
  });

  test('lists project work for the authenticated Cat Cafe acceptance surface', async () => {
    const { app, calls } = await createApp();
    let response = await app.inject({
      method: 'GET',
      url: '/api/external-projects/project-1/development-loop/works?protocolVersion=1',
    });
    assert.equal(response.statusCode, 401);

    response = await app.inject({
      method: 'GET',
      url: '/api/external-projects/project-1/development-loop/works?protocolVersion=1',
      headers: { 'x-cat-cafe-user': 'operator-1' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().works[0].workId, 'work-1');
    assert.deepEqual(calls, [
      ['listProjectWorks', { protocolVersion: 1, ownerUserId: 'operator-1', projectId: 'project-1' }],
    ]);
  });

  test('lists and starts project-scoped Desktop launch states with strict mutation identity', async () => {
    const { app, calls } = await createApp();
    let response = await app.inject({
      method: 'GET',
      url: '/api/external-projects/project-1/development-loop/launch-states?protocolVersion=1',
      headers: { 'x-cat-cafe-user': 'operator-1' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().states[0].status, 'available');

    response = await app.inject({
      method: 'POST',
      url: '/api/external-projects/project-1/development-loop/features/backlog-1/start',
      headers: { 'content-type': 'application/json' },
      payload: { protocolVersion: 1 },
    });
    assert.equal(response.statusCode, 401);

    response = await app.inject({
      method: 'POST',
      url: '/api/external-projects/project-1/development-loop/features/backlog-1/start',
      headers: { 'x-cat-cafe-user': 'operator-1', 'content-type': 'application/json' },
      payload: { protocolVersion: 1 },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().state.status, 'ready_for_desktop');
    assert.deepEqual(calls, [
      ['listProjectLaunchStates', { protocolVersion: 1, ownerUserId: 'operator-1', projectId: 'project-1' }],
      [
        'startProjectWork',
        {
          protocolVersion: 1,
          ownerUserId: 'operator-1',
          projectId: 'project-1',
          backlogItemId: 'backlog-1',
        },
      ],
    ]);
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
