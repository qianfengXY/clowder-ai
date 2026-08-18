// @ts-check

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

describe('F289 project-scoped Desktop launch', () => {
  let service;
  let sops;
  let admissions;
  let snapshots;
  let sessions;
  let upsertCalls;
  let designBranches;
  let VersionConflictError;

  const project = {
    id: 'project-1',
    userId: 'owner-1',
    name: 'Example',
    sourcePath: '/work/example',
    desktopDevelopment: { repository: { fullName: 'owner/repo' } },
  };
  const projectItem = {
    id: 'backlog-1',
    userId: 'owner-1',
    projectId: 'project-1',
    title: '[F006] Workspace capability settings',
    tags: ['source:docs-backlog', 'feature:f006'],
    status: 'open',
  };
  const otherProjectItem = { ...projectItem, id: 'backlog-other', projectId: 'project-2' };
  const malformedProjectItem = {
    ...projectItem,
    id: 'backlog-malformed',
    title: 'Imported row without feature tag',
    tags: ['source:docs-backlog'],
  };

  function admission(backlogItemId) {
    return {
      admission: {
        workId: `work-${backlogItemId}`,
        ownerUserId: 'owner-1',
        producerKind: 'workflow_sop_v1',
        producerRef: backlogItemId,
        initialAttemptId: `attempt-${backlogItemId}`,
        admittedAt: 1,
      },
      attempt: {
        attemptId: `attempt-${backlogItemId}`,
        workId: `work-${backlogItemId}`,
        attemptNumber: 1,
        executorCatId: null,
        createdAt: 1,
        executorBoundAt: null,
      },
    };
  }

  function snapshot(bundle, executorActor) {
    return {
      ...bundle,
      attempt: { ...bundle.attempt, ...(executorActor ? { executorActor } : {}) },
      state: {
        consumerId: 'f289_desktop_development_loop',
        workId: bundle.admission.workId,
        currentAttemptId: bundle.attempt.attemptId,
        currentAttemptNumber: 1,
        lifecycle: 'active',
        version: 1,
      },
      evidence: [],
    };
  }

  beforeEach(async () => {
    const serviceModule = await import('../dist/domains/desktop-development-loop/desktop-development-loop-service.js');
    ({ VersionConflictError } = await import('../dist/domains/cats/services/stores/ports/WorkflowSopStore.js'));
    sops = new Map();
    admissions = new Map();
    snapshots = new Map();
    sessions = new Map();
    upsertCalls = [];
    designBranches = { 'backlog-1': 'design/f006-workspace-capability' };
    const workflowSopStore = {
      get: async (itemId) => sops.get(itemId) ?? null,
      getManagedWorkAdmission: async (_ownerUserId, itemId) => admissions.get(itemId) ?? null,
      upsert: async (itemId, featureId, input, updatedBy, ownerUserId) => {
        upsertCalls.push({ itemId, featureId, input, updatedBy, ownerUserId });
        const sop = {
          featureId,
          backlogItemId: itemId,
          sopDefinitionId: 'development',
          stage: input.stage ?? 'kickoff',
          batonHolder: input.batonHolder ?? updatedBy,
          nextSkill: null,
          resumeCapsule: { goal: '', done: [], currentFocus: '', ...input.resumeCapsule },
          checks: {
            remoteMainSynced: 'unknown',
            qualityGatePassed: 'unknown',
            reviewApproved: 'unknown',
            visionGuardDone: 'unknown',
          },
          version: 1,
          updatedAt: 1,
          updatedBy,
        };
        const bundle = admission(itemId);
        sops.set(itemId, sop);
        admissions.set(itemId, bundle);
        snapshots.set(bundle.admission.workId, snapshot(bundle));
        return sop;
      },
    };
    service = new serviceModule.DesktopDevelopmentLoopService(
      {
        getById: async (id) => (id === project.id ? project : null),
        getFeatureDesignBranches: async () => ({ ...designBranches }),
        setFeatureDesignBranch: async (_projectId, backlogItemId, branch) => {
          if (branch) designBranches[backlogItemId] = branch;
          else delete designBranches[backlogItemId];
        },
      },
      {
        ensureForFeature: async (projectId, backlogItemId, kind) => ({
          threadId: `project-feature-${kind}:${projectId}:${backlogItemId}`,
          projectId,
          backlogItemId,
          featureId: 'F006',
          kind,
          status: 'active',
        }),
      },
      { getCurrent: async (_projectId, workId) => sessions.get(workId) ?? null },
      {
        read: async ({ workId }) => snapshots.get(workId),
        claimAttempt: async ({ workId, executor, expectedVersion }) => {
          const current = snapshots.get(workId);
          assert.equal(current.state.version, expectedVersion);
          current.attempt.executorActor = executor;
          current.attempt.executorBoundAt = 2;
          current.state.version += 1;
          return current;
        },
      },
      {},
      {},
      { listByUser: async () => [projectItem, malformedProjectItem, otherProjectItem] },
      workflowSopStore,
    );
    service.designBranchResolver = async ({ branch }) => ({ branch, exactSha: 'd'.repeat(40) });
  });

  test('lists only the selected project and starts with create-only SOP semantics', async () => {
    assert.deepEqual(
      await service.listProjectLaunchStates({ protocolVersion: 1, ownerUserId: 'owner-1', projectId: 'project-1' }),
      [
        {
          backlogItemId: 'backlog-1',
          featureId: 'F006',
          title: '[F006] Workspace capability settings',
          status: 'available',
        },
      ],
    );

    const started = await service.startProjectWork({
      protocolVersion: 1,
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      backlogItemId: 'backlog-1',
    });
    assert.equal(started.status, 'ready_for_desktop');
    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].input.expectedVersion, 0);
    assert.equal(upsertCalls[0].input.batonHolder, 'chatgpt-desktop-dev');
    assert.deepEqual(snapshots.get('work-backlog-1').attempt.executorActor, {
      kind: 'external_actor',
      actorId: 'chatgpt-desktop-dev',
    });
  });

  test('does not treat imported done metadata as Desktop completion before the feature starts', async () => {
    projectItem.status = 'done';
    try {
      const [state] = await service.listProjectLaunchStates({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: 'project-1',
      });
      assert.equal(state.status, 'available');
      assert.equal(state.managedWork, undefined);
      assert.equal(state.desktopBinding, undefined);
    } finally {
      projectItem.status = 'open';
    }
  });

  test('returns the native Desktop task created for the exact feature', async () => {
    let launchInput;
    service.desktopTaskLauncher = {
      get: async () => null,
      launch: async (input) => {
        launchInput = input;
        return { status: 'created', threadId: 'codex-thread-f006' };
      },
    };
    const started = await service.startProjectWork({
      protocolVersion: 1,
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      backlogItemId: 'backlog-1',
    });
    assert.deepEqual(started.desktopTask, { status: 'created', threadId: 'codex-thread-f006' });
    assert.deepEqual(launchInput, {
      projectId: 'project-1',
      projectName: 'Example',
      repository: 'owner/repo',
      sourcePath: '/work/example',
      backlogItemId: 'backlog-1',
      featureId: 'F006',
      title: '[F006] Workspace capability settings',
      designBranch: 'design/f006-workspace-capability',
      designExactSha: 'd'.repeat(40),
    });
  });

  test('refuses to start before a committed feature design branch is configured', async () => {
    designBranches = {};
    await assert.rejects(
      () =>
        service.startProjectWork({
          protocolVersion: 1,
          ownerUserId: 'owner-1',
          projectId: 'project-1',
          backlogItemId: 'backlog-1',
        }),
      /design branch is not configured/i,
    );
    assert.equal(upsertCalls.length, 0);
  });

  test('does not overwrite an existing cat-owned workflow', async () => {
    const bundle = admission('backlog-1');
    sops.set('backlog-1', {
      featureId: 'F006',
      stage: 'impl',
      batonHolder: 'cat-owner',
    });
    admissions.set('backlog-1', bundle);
    snapshots.set(bundle.admission.workId, snapshot(bundle, { kind: 'cat', catId: 'cat-owner' }));

    const result = await service.startProjectWork({
      protocolVersion: 1,
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      backlogItemId: 'backlog-1',
    });
    assert.equal(result.status, 'managed_by_catcafe');
    assert.equal(upsertCalls.length, 0);
  });

  test('does not start a second flow for a backlog item already dispatched to cats', async () => {
    projectItem.status = 'dispatched';
    try {
      const result = await service.startProjectWork({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: 'project-1',
        backlogItemId: 'backlog-1',
      });
      assert.equal(result.status, 'managed_by_catcafe');
      assert.equal(upsertCalls.length, 0);
    } finally {
      projectItem.status = 'open';
    }
  });

  test('re-reads canonical ownership when create loses a race', async () => {
    const originalUpsert = service.workflowSopStore.upsert;
    service.workflowSopStore.upsert = async () => {
      const bundle = admission('backlog-1');
      sops.set('backlog-1', { featureId: 'F006', stage: 'impl', batonHolder: 'cat-race' });
      admissions.set('backlog-1', bundle);
      snapshots.set(bundle.admission.workId, snapshot(bundle, { kind: 'cat', catId: 'cat-race' }));
      throw new VersionConflictError({ version: 1 });
    };

    const result = await service.startProjectWork({
      protocolVersion: 1,
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      backlogItemId: 'backlog-1',
    });
    assert.equal(result.status, 'managed_by_catcafe');
    service.workflowSopStore.upsert = originalUpsert;
  });

  test('reclassifies a racing legacy SOP that has no managed-work admission', async () => {
    const originalUpsert = service.workflowSopStore.upsert;
    service.workflowSopStore.upsert = async () => {
      sops.set('backlog-1', { featureId: 'F006', stage: 'impl', batonHolder: 'legacy-owner' });
      throw new VersionConflictError({ version: 1 });
    };

    const result = await service.startProjectWork({
      protocolVersion: 1,
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      backlogItemId: 'backlog-1',
    });
    assert.equal(result.status, 'managed_by_catcafe');
    service.workflowSopStore.upsert = originalUpsert;
  });

  test('distinguishes active, detached, and rejected Desktop work', async () => {
    const bundle = admission('backlog-1');
    sops.set('backlog-1', {
      featureId: 'F006',
      stage: 'impl',
      batonHolder: 'chatgpt-desktop-dev',
    });
    admissions.set('backlog-1', bundle);
    snapshots.set(
      bundle.admission.workId,
      snapshot(bundle, { kind: 'external_actor', actorId: 'chatgpt-desktop-dev' }),
    );
    sessions.set(bundle.admission.workId, {
      attemptId: bundle.attempt.attemptId,
      status: 'active',
      chatRef: 'chat-f006',
      bindingEpoch: 3,
    });

    let [state] = await service.listProjectLaunchStates({
      protocolVersion: 1,
      ownerUserId: 'owner-1',
      projectId: 'project-1',
    });
    assert.equal(state.status, 'connected_to_desktop');
    assert.deepEqual(state.desktopBinding, {
      chatRef: 'chat-f006',
      bindingEpoch: 3,
      status: 'active',
    });
    assert.deepEqual(state.managedWork, {
      workId: 'work-backlog-1',
      attemptId: 'attempt-backlog-1',
      attemptNumber: 1,
      lifecycle: 'active',
    });

    sessions.set(bundle.admission.workId, {
      attemptId: bundle.attempt.attemptId,
      status: 'detached',
      chatRef: 'chat-f006',
      bindingEpoch: 3,
    });
    [state] = await service.listProjectLaunchStates({
      protocolVersion: 1,
      ownerUserId: 'owner-1',
      projectId: 'project-1',
    });
    assert.equal(state.status, 'ready_for_desktop');

    snapshots.get(bundle.admission.workId).state.lifecycle = 'rejected';
    sops.get('backlog-1').stage = 'completion';
    [state] = await service.listProjectLaunchStates({
      protocolVersion: 1,
      ownerUserId: 'owner-1',
      projectId: 'project-1',
    });
    assert.equal(state.status, 'rejected');
  });

  test('does not call admitted active work completed from SOP or backlog projections', async () => {
    const bundle = admission('backlog-1');
    projectItem.status = 'done';
    sops.set('backlog-1', {
      featureId: 'F006',
      stage: 'completion',
      batonHolder: 'chatgpt-desktop-dev',
    });
    admissions.set('backlog-1', bundle);
    snapshots.set(
      bundle.admission.workId,
      snapshot(bundle, { kind: 'external_actor', actorId: 'chatgpt-desktop-dev' }),
    );
    try {
      const [state] = await service.listProjectLaunchStates({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: 'project-1',
      });
      assert.equal(state.status, 'ready_for_desktop');
    } finally {
      projectItem.status = 'open';
    }
  });
});
