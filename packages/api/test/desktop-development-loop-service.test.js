import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { assertRedisIsolationOrThrow, cleanupPrefixedRedisKeys } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const REDIS_ISOLATED = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe(
  'F289 DesktopDevelopmentLoopService',
  { skip: !REDIS_URL ? 'REDIS_URL not set' : !REDIS_ISOLATED ? 'Redis isolation flag not set' : false },
  () => {
    let redis;
    let externalProjects;
    let workflowStore;
    let managedWork;
    let reviewRounds;
    let sessions;
    let service;
    let reviewCoordinator;
    let reviewHubEnsureCount;
    let reviewDispatches;
    let desktopWakes;
    let backlogItems;
    let connected = false;

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'desktop-development-loop-service');
      const { createRedisClient } = await import('@cat-cafe/shared/utils');
      const { ExternalProjectStore } = await import('../dist/domains/projects/external-project-store.js');
      const { RedisWorkflowSopStore } = await import(
        '../dist/domains/cats/services/stores/redis/RedisWorkflowSopStore.js'
      );
      const { RedisManagedWorkConsumerPort } = await import(
        '../dist/domains/cats/services/stores/redis/RedisManagedWorkConsumerPort.js'
      );
      const { RedisReviewRoundStore } = await import('../dist/domains/review-coordination/RedisReviewRoundStore.js');
      const { DesktopSessionStore } = await import('../dist/domains/desktop-development-loop/desktop-session-store.js');
      const { DesktopDevelopmentLoopService } = await import(
        '../dist/domains/desktop-development-loop/desktop-development-loop-service.js'
      );
      const { ReviewRoundCoordinatorService } = await import(
        '../dist/domains/desktop-development-loop/review-round-coordinator-service.js'
      );

      redis = createRedisClient({ url: REDIS_URL });
      try {
        await redis.ping();
        connected = true;
      } catch {
        await redis.quit().catch(() => {});
        return;
      }
      externalProjects = new ExternalProjectStore(redis);
      workflowStore = new RedisWorkflowSopStore(redis);
      managedWork = new RedisManagedWorkConsumerPort(redis);
      reviewRounds = new RedisReviewRoundStore(redis);
      sessions = new DesktopSessionStore(redis);
      const reviewHubs = {
        ensureForProject: async (projectId) => {
          reviewHubEnsureCount += 1;
          return {
            hubId: `project-review-hub:${projectId}`,
            threadId: `project-review-hub:${projectId}`,
            projectId,
            status: 'active',
          };
        },
        ensureForFeature: async (projectId, backlogItemId, kind) => {
          reviewHubEnsureCount += 1;
          return {
            threadId: `project-feature-${kind}:${projectId}:${backlogItemId}`,
            projectId,
            backlogItemId,
            featureId: 'F006',
            kind,
            status: 'active',
          };
        },
      };
      const reviewDispatcher = {
        dispatch: async (input) => {
          reviewDispatches.push(input);
        },
      };
      const backlogStore = {
        listByUser: async (userId) => backlogItems.filter((item) => item.userId === userId),
      };
      service = new DesktopDevelopmentLoopService(
        externalProjects,
        reviewHubs,
        sessions,
        managedWork,
        reviewRounds,
        reviewDispatcher,
        backlogStore,
        workflowStore,
        undefined,
        async () => {},
      );
      reviewCoordinator = new ReviewRoundCoordinatorService(
        reviewRounds,
        managedWork,
        reviewDispatcher,
        {
          resolve: async () => ({
            projectName: 'Example',
            repository: 'owner/repo',
            backlogItemId: 'backlog-1',
            featureId: 'F289',
            featureTitle: 'Implement the Desktop loop',
            attemptNumber: 1,
          }),
        },
        sessions,
        { activate: async (input) => desktopWakes.push(input) },
      );
    });

    after(async () => {
      if (!connected) return;
      await cleanupPrefixedRedisKeys(redis, [
        'external-project:*',
        'workflow:sop:*',
        'managed-work:*',
        'desktop-development:*',
        'review-round:*',
      ]);
      await redis.quit();
    });

    beforeEach(async (t) => {
      if (!connected) return t.skip('Redis not connected');
      reviewHubEnsureCount = 0;
      reviewDispatches = [];
      desktopWakes = [];
      backlogItems = [];
      await cleanupPrefixedRedisKeys(redis, [
        'external-project:*',
        'workflow:sop:*',
        'managed-work:*',
        'desktop-development:*',
        'review-round:*',
      ]);
    });

    async function arrange() {
      const project = await externalProjects.create('owner-1', {
        name: 'Example',
        description: 'Example project',
        sourcePath: '/Volumes/WorkSSD/example',
        desktopDevelopment: {
          repository: 'owner/repo',
          defaultBranch: 'main',
          defaultReviewers: ['cat-codex', 'cat-kimi'],
          allowPush: true,
          allowPullRequest: true,
        },
      });
      await workflowStore.upsert('backlog-1', 'F289', {}, 'cat-codex', 'owner-1');
      const bundle = await workflowStore.getManagedWorkAdmission('owner-1', 'backlog-1');
      backlogItems.push({
        id: 'backlog-1',
        userId: 'owner-1',
        projectId: project.id,
        title: 'Implement the Desktop loop',
        tags: ['feature:F289'],
        status: 'approved',
      });
      return { project, bundle };
    }

    function workspace(currentSha = SHA_A) {
      return {
        repository: { host: 'github.com', owner: 'owner', name: 'repo', fullName: 'owner/repo' },
        branch: 'feat/example',
        baseSha: '0'.repeat(40),
        currentSha,
        lastCommittedSha: currentSha,
        worktreePresent: true,
        worktreePath: '/Volumes/WorkSSD/example-worktree',
        validatedAt: 1_000,
      };
    }

    test('reads only the public project projection and rejects protocol or owner mismatch', async () => {
      const { project } = await arrange();
      const result = await service.readProject({ protocolVersion: 1, ownerUserId: 'owner-1', projectId: project.id });
      assert.equal(result.project.projectId, project.id);
      assert.equal(result.project.localCheckoutBound, true);
      assert.equal(result.reviewHubId, `project-review-hub:${project.id}`);
      assert.deepEqual(result.managedWorkDiscovery, {
        status: 'available',
        works: [
          {
            backlogItemId: 'backlog-1',
            title: 'Implement the Desktop loop',
            backlogStatus: 'approved',
            workId: result.managedWorkDiscovery.works[0].workId,
            attemptId: result.managedWorkDiscovery.works[0].attemptId,
            attemptNumber: 1,
            lifecycle: 'active',
            managedWorkVersion: 1,
            connected: false,
            sessionStatus: null,
          },
        ],
      });
      assert.doesNotMatch(JSON.stringify(result), /Volumes\/WorkSSD/);
      await assert.rejects(
        () => service.readProject({ protocolVersion: 2, ownerUserId: 'owner-1', projectId: project.id }),
        /protocol mismatch/i,
      );
      await assert.rejects(
        () => service.readProject({ protocolVersion: 1, ownerUserId: 'owner-2', projectId: project.id }),
        /project not found/i,
      );

      const resolved = await service.readProjectByRepository({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        repository: 'https://github.com/owner/repo.git',
      });
      assert.equal(resolved.project.projectId, project.id);
      await assert.rejects(
        () =>
          service.readProjectByRepository({
            protocolVersion: 1,
            ownerUserId: 'owner-2',
            repository: 'owner/repo',
          }),
        /project not found/i,
      );
      assert.deepEqual(
        await service.listProjectWorks({ protocolVersion: 1, ownerUserId: 'owner-1', projectId: project.id }),
        [],
      );
    });

    test('claims the work for Desktop, fences a replaced chat, and creates one exact-SHA review round', async () => {
      const { project, bundle } = await arrange();
      const first = await service.connect({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-1',
        chatRef: 'chat-1',
        expectedBindingEpoch: 0,
        expectedManagedWorkVersion: 1,
        idempotencyKey: 'connect-1',
        leaseDurationMs: 60_000,
        workspace: workspace(),
        now: 2_000,
      });
      assert.equal(first.bindingEpoch, 1);
      assert.equal(first.chatRef, 'chat-1');
      assert.equal(first.attemptNumber, 1);
      assert.equal(first.phase, 'implementing');
      assert.equal(first.managedWorkVersion, 2);
      assert.equal(first.reviewRoundId, null);
      assert.deepEqual(first.nextLegalActions, ['implement_and_report_committed_sha']);
      assert.doesNotMatch(JSON.stringify(first), /example-worktree/);

      const connectedProject = await service.readProject({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        now: 2_500,
      });
      assert.equal(connectedProject.managedWorkDiscovery.works[0].connected, true);
      assert.equal(connectedProject.managedWorkDiscovery.works[0].sessionStatus, 'active');
      assert.equal(connectedProject.managedWorkDiscovery.works[0].managedWorkVersion, 2);

      const connectedProjectMuchLater = await service.readProject({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        now: 2_500 + 365 * 24 * 60 * 60 * 1_000,
      });
      assert.equal(connectedProjectMuchLater.managedWorkDiscovery.works[0].sessionStatus, 'active');

      const second = await service.connect({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-2',
        chatRef: 'chat-2',
        expectedBindingEpoch: 1,
        expectedManagedWorkVersion: first.managedWorkVersion,
        idempotencyKey: 'connect-2',
        leaseDurationMs: 60_000,
        workspace: workspace(),
        now: 3_000,
      });
      assert.equal(second.bindingEpoch, 2);
      assert.equal(second.chatRef, 'chat-2');

      await assert.rejects(
        () =>
          service.reportImplementation({
            protocolVersion: 1,
            ownerUserId: 'owner-1',
            projectId: project.id,
            workId: bundle.admission.workId,
            attemptId: bundle.attempt.attemptId,
            runtimeSessionId: 'runtime-1',
            bindingEpoch: 1,
            expectedManagedWorkVersion: second.managedWorkVersion,
            exactSha: SHA_A,
            idempotencyKey: 'stale-report',
            now: 4_000,
          }),
        /does not own the current binding epoch/i,
      );

      const reported = await service.reportImplementation({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-2',
        bindingEpoch: 2,
        expectedManagedWorkVersion: second.managedWorkVersion,
        exactSha: SHA_A,
        idempotencyKey: 'report-a',
        now: 4_000,
      });
      assert.equal(reported.reviewPhase, 'independent');
      assert.equal(reported.phase, 'independent_review');
      assert.equal(reported.currentSha, SHA_A);
      assert.deepEqual(reported.nextLegalActions, ['wait_for_independent_review']);
      assert.equal(reviewHubEnsureCount, 1);
      assert.deepEqual(reviewDispatches, [
        {
          stage: 'independent',
          ownerUserId: 'owner-1',
          projectId: project.id,
          reviewHubThreadId: `project-feature-review:${project.id}:backlog-1`,
          roundId: reported.reviewRoundId,
          exactSha: SHA_A,
          reviewerCatIds: ['cat-codex', 'cat-kimi'],
          allReviewerCatIds: ['cat-codex', 'cat-kimi'],
          completedReviewerCatIds: [],
          recorderCatId: 'cat-codex',
          displayContext: {
            projectName: 'Example',
            repository: 'owner/repo',
            backlogItemId: 'backlog-1',
            featureId: 'F289',
            featureTitle: 'Implement the Desktop loop',
            attemptNumber: 1,
          },
        },
      ]);

      const round = await reviewRounds.readCurrentSafe({
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
      });
      assert.equal(round.round.exactSha, SHA_A);
      assert.deepEqual(round.round.reviewerCatIds, ['cat-codex', 'cat-kimi']);
      assert.equal(round.round.author.actorId, 'chatgpt-desktop-dev');

      const replayed = await service.reportImplementation({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-2',
        bindingEpoch: 2,
        expectedManagedWorkVersion: second.managedWorkVersion,
        exactSha: SHA_A,
        idempotencyKey: 'report-a',
        now: 9_000,
      });
      assert.equal(replayed.reviewRoundId, reported.reviewRoundId);
      assert.equal(replayed.managedWorkVersion, reported.managedWorkVersion);
      assert.equal(reviewDispatches.length, 2, 'the dispatcher receives a retry and deduplicates at message ingress');
    });

    test('returns only barrier-safe consensus findings in the Resume Packet', async () => {
      const { project, bundle } = await arrange();
      let packet = await service.connect({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-1',
        expectedBindingEpoch: 0,
        expectedManagedWorkVersion: 1,
        idempotencyKey: 'connect',
        leaseDurationMs: 60_000,
        workspace: workspace(),
        now: 2_000,
      });
      packet = await service.reportImplementation({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-1',
        bindingEpoch: packet.bindingEpoch,
        expectedManagedWorkVersion: packet.managedWorkVersion,
        exactSha: SHA_A,
        idempotencyKey: 'report',
        now: 3_000,
      });
      const roundId = packet.reviewRoundId;
      await reviewRounds.submitIndependentDraft({
        ownerUserId: 'owner-1',
        roundId,
        reviewerCatId: 'cat-codex',
        expectedDraftVersion: 0,
        idempotencyKey: 'draft-codex',
        verdict: 'findings',
        findings: [{ severity: 'P1', title: 'Private P1', details: 'Must not leak before barrier.' }],
        now: 4_000,
      });
      packet = await service.readWork({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        now: 4_100,
      });
      assert.deepEqual(packet.openFindings, []);

      await reviewRounds.submitIndependentDraft({
        ownerUserId: 'owner-1',
        roundId,
        reviewerCatId: 'cat-kimi',
        expectedDraftVersion: 0,
        idempotencyKey: 'draft-kimi',
        verdict: 'approve',
        findings: [],
        now: 4_000,
      });
      let round = (await reviewRounds.readSafe({ ownerUserId: 'owner-1', roundId })).round;
      round = await reviewRounds.finishIndependent({
        ownerUserId: 'owner-1',
        roundId,
        reviewerCatId: 'cat-codex',
        expectedRoundVersion: round.version,
        idempotencyKey: 'finish-codex',
        now: 5_000,
      });
      round = await reviewRounds.finishIndependent({
        ownerUserId: 'owner-1',
        roundId,
        reviewerCatId: 'cat-kimi',
        expectedRoundVersion: round.version,
        idempotencyKey: 'finish-kimi',
        now: 5_000,
      });
      round = await reviewRounds.finishCrossReview({
        ownerUserId: 'owner-1',
        roundId,
        reviewerCatId: 'cat-codex',
        expectedRoundVersion: round.version,
        idempotencyKey: 'cross-codex',
        now: 6_000,
      });
      round = await reviewRounds.finishCrossReview({
        ownerUserId: 'owner-1',
        roundId,
        reviewerCatId: 'cat-kimi',
        expectedRoundVersion: round.version,
        idempotencyKey: 'cross-kimi',
        now: 6_000,
      });
      await reviewRounds.publishConsensus({
        ownerUserId: 'owner-1',
        roundId,
        recorderCatId: 'cat-codex',
        expectedRoundVersion: round.version,
        idempotencyKey: 'consensus',
        verdict: 'changes_requested',
        checksPassed: false,
        findings: [{ severity: 'P1', title: 'Consensus P1', details: 'This is safe.', evidence: ['src/a.ts:1'] }],
        resolvedFindingIds: [],
        now: 7_000,
      });

      packet = await service.readWork({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        now: 7_100,
      });
      assert.deepEqual(
        packet.openFindings.map((finding) => finding.summary),
        ['Consensus P1'],
      );
      assert.doesNotMatch(JSON.stringify(packet), /Private P1|Must not leak/);
      assert.deepEqual(packet.nextLegalActions, ['start_fix_attempt']);
      assert.equal(packet.phase, 'fix_required');

      const fixAttempt = await service.connect({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-1',
        chatRef: 'chat-1',
        expectedBindingEpoch: packet.bindingEpoch,
        expectedManagedWorkVersion: packet.managedWorkVersion,
        idempotencyKey: 'connect-fix-attempt',
        leaseDurationMs: 60_000,
        workspace: workspace(),
        now: 8_000,
      });
      assert.notEqual(fixAttempt.attemptId, bundle.attempt.attemptId);
      assert.equal(fixAttempt.attemptNumber, 2);
      assert.equal(fixAttempt.bindingEpoch, packet.bindingEpoch + 1);
      assert.equal(fixAttempt.phase, 'implementing');
      assert.deepEqual(fixAttempt.nextLegalActions, ['fix_open_findings']);

      const replayedFixAttempt = await service.connect({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-1',
        chatRef: 'chat-1',
        expectedBindingEpoch: packet.bindingEpoch,
        expectedManagedWorkVersion: packet.managedWorkVersion,
        idempotencyKey: 'connect-fix-attempt',
        leaseDurationMs: 60_000,
        workspace: workspace(),
        now: 8_500,
      });
      assert.equal(replayedFixAttempt.attemptId, fixAttempt.attemptId);
      assert.equal(replayedFixAttempt.bindingEpoch, fixAttempt.bindingEpoch);
      assert.equal(replayedFixAttempt.managedWorkVersion, fixAttempt.managedWorkVersion);

      const fixedWorkspace = workspace(SHA_B);
      const fixed = await service.heartbeat({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: fixAttempt.attemptId,
        runtimeSessionId: 'runtime-1',
        bindingEpoch: fixAttempt.bindingEpoch,
        expectedSessionVersion: fixAttempt.sessionVersion,
        idempotencyKey: 'heartbeat-fixed-sha',
        leaseDurationMs: 60_000,
        workspace: fixedWorkspace,
        now: 9_000,
      });
      assert.equal(fixed.phase, 'implementation_ready');
      assert.deepEqual(fixed.nextLegalActions, ['report_new_committed_sha']);

      const rereview = await service.reportImplementation({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: fixAttempt.attemptId,
        runtimeSessionId: 'runtime-1',
        bindingEpoch: fixAttempt.bindingEpoch,
        expectedManagedWorkVersion: fixed.managedWorkVersion,
        exactSha: SHA_B,
        idempotencyKey: 'report-fixed-sha',
        now: 10_000,
      });
      assert.equal(rereview.attemptId, fixAttempt.attemptId);
      assert.equal(rereview.attemptNumber, 2);
      assert.equal(rereview.currentSha, SHA_B);
      assert.equal(rereview.phase, 'independent_review');
      assert.notEqual(rereview.reviewRoundId, roundId);
    });

    test('returns an explicit committed-SHA recovery action when the permanent worktree is missing', async () => {
      const { project, bundle } = await arrange();
      const missingWorktree = workspace();
      missingWorktree.worktreePresent = false;
      const packet = await service.connect({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-missing-worktree',
        expectedBindingEpoch: 0,
        expectedManagedWorkVersion: 1,
        idempotencyKey: 'connect-missing-worktree',
        leaseDurationMs: 60_000,
        workspace: missingWorktree,
        now: 2_000,
      });

      assert.equal(packet.worktreePresent, false);
      assert.equal(packet.lastCommittedSha, SHA_A);
      assert.deepEqual(packet.nextLegalActions, ['rebuild_worktree_from_last_committed_sha']);
      await assert.rejects(
        () =>
          service.reportImplementation({
            protocolVersion: 1,
            ownerUserId: 'owner-1',
            projectId: project.id,
            workId: bundle.admission.workId,
            attemptId: bundle.attempt.attemptId,
            runtimeSessionId: 'runtime-missing-worktree',
            bindingEpoch: packet.bindingEpoch,
            expectedManagedWorkVersion: packet.managedWorkVersion,
            exactSha: SHA_A,
            idempotencyKey: 'report-missing-worktree',
            now: 3_000,
          }),
        /worktree is missing/i,
      );
    });

    test('derives reviewer identity from the Review Hub and writes one canonical review-completed evidence row', async () => {
      const { project, bundle } = await arrange();
      await externalProjects.updateDesktopDevelopment(project.id, {
        expectedVersion: project.desktopDevelopment.version,
        defaultReviewRecorder: 'cat-kimi',
      });
      let packet = await service.connect({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-1',
        chatRef: 'chatgpt-thread-f006',
        expectedBindingEpoch: 0,
        expectedManagedWorkVersion: 1,
        idempotencyKey: 'connect-reviewer-flow',
        leaseDurationMs: 60_000,
        workspace: workspace(),
        now: 2_000,
      });
      packet = await service.reportImplementation({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-1',
        bindingEpoch: packet.bindingEpoch,
        expectedManagedWorkVersion: packet.managedWorkVersion,
        exactSha: SHA_A,
        idempotencyKey: 'report-reviewer-flow',
        now: 3_000,
      });
      const roundId = packet.reviewRoundId;
      const hubThreadId = `project-feature-review:${project.id}:backlog-1`;

      await assert.rejects(
        () =>
          reviewCoordinator.readSafe({
            ownerUserId: 'owner-1',
            threadId: 'ordinary-thread',
            reviewerCatId: 'cat-codex',
            roundId,
          }),
        /feature Review thread/i,
      );
      await assert.rejects(
        () =>
          reviewCoordinator.readSafe({
            ownerUserId: 'owner-1',
            threadId: `project-review-hub:${project.id}`,
            reviewerCatId: 'cat-codex',
            roundId,
          }),
        /feature Review thread/i,
      );

      await reviewCoordinator.submitDraft({
        ownerUserId: 'owner-1',
        threadId: hubThreadId,
        reviewerCatId: 'cat-codex',
        roundId,
        expectedDraftVersion: 0,
        idempotencyKey: 'draft-codex-flow',
        verdict: 'approve',
        findings: [],
        now: 4_000,
      });
      await reviewCoordinator.submitDraft({
        ownerUserId: 'owner-1',
        threadId: hubThreadId,
        reviewerCatId: 'cat-kimi',
        roundId,
        expectedDraftVersion: 0,
        idempotencyKey: 'draft-kimi-flow',
        verdict: 'approve',
        findings: [],
        now: 4_000,
      });
      let round = (
        await reviewCoordinator.readSafe({
          ownerUserId: 'owner-1',
          threadId: hubThreadId,
          reviewerCatId: 'cat-codex',
          roundId,
        })
      ).round;
      round = await reviewCoordinator.finishIndependent({
        ownerUserId: 'owner-1',
        threadId: hubThreadId,
        reviewerCatId: 'cat-codex',
        roundId,
        expectedRoundVersion: round.version,
        idempotencyKey: 'finish-independent-codex-flow',
        now: 5_000,
      });
      round = await reviewCoordinator.finishIndependent({
        ownerUserId: 'owner-1',
        threadId: hubThreadId,
        reviewerCatId: 'cat-kimi',
        roundId,
        expectedRoundVersion: round.version,
        idempotencyKey: 'finish-independent-kimi-flow',
        now: 5_000,
      });
      assert.equal(reviewDispatches.at(-1).stage, 'cross_review');
      assert.equal(reviewDispatches.at(-1).roundId, roundId);
      assert.equal(
        (
          await reviewCoordinator.readBarrierDrafts({
            ownerUserId: 'owner-1',
            threadId: hubThreadId,
            reviewerCatId: 'cat-codex',
            roundId,
          })
        ).length,
        2,
      );
      round = await reviewCoordinator.finishCrossReview({
        ownerUserId: 'owner-1',
        threadId: hubThreadId,
        reviewerCatId: 'cat-codex',
        roundId,
        expectedRoundVersion: round.version,
        idempotencyKey: 'finish-cross-codex-flow',
        now: 6_000,
      });
      round = await reviewCoordinator.finishCrossReview({
        ownerUserId: 'owner-1',
        threadId: hubThreadId,
        reviewerCatId: 'cat-kimi',
        roundId,
        expectedRoundVersion: round.version,
        idempotencyKey: 'finish-cross-kimi-flow',
        now: 6_000,
      });
      assert.equal(reviewDispatches.at(-1).stage, 'consensus');
      assert.deepEqual(reviewDispatches.at(-1).reviewerCatIds, ['cat-codex', 'cat-kimi']);
      assert.equal(reviewDispatches.at(-1).recorderCatId, 'cat-kimi');
      const completed = await reviewCoordinator.publishConsensus({
        ownerUserId: 'owner-1',
        threadId: hubThreadId,
        reviewerCatId: 'cat-kimi',
        roundId,
        expectedRoundVersion: round.version,
        expectedManagedWorkVersion: packet.managedWorkVersion,
        idempotencyKey: 'publish-consensus-flow',
        verdict: 'approved',
        checksPassed: true,
        findings: [],
        resolvedFindingIds: [],
        now: 7_000,
      });
      assert.equal(completed.consensus.openFindingCount, 0);

      const managed = await managedWork.read({
        consumerId: 'f289_desktop_development_loop',
        ownerUserId: 'owner-1',
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
      });
      const reviewEvidence = managed.evidence.filter((evidence) => evidence.kind === 'review_completed');
      assert.equal(reviewEvidence.length, 1);
      assert.equal(reviewEvidence[0].reviewRoundId, roundId);
      assert.equal(reviewEvidence[0].checksPassed, true);
      assert.equal(desktopWakes.length, 1);
      assert.equal(desktopWakes[0].threadId, 'chatgpt-thread-f006');
      assert.equal(desktopWakes[0].sourcePath, '/Volumes/WorkSSD/example-worktree');
      assert.match(desktopWakes[0].objective, /\[Review 系统消息\] Example · F289 · Implement the Desktop loop/);
      assert.match(desktopWakes[0].objective, new RegExp(roundId));
    });

    test('requires current-chat merge confirmation, records merge, and counts acceptance once', async () => {
      const { project, bundle } = await arrange();
      let packet = await service.connect({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-1',
        expectedBindingEpoch: 0,
        expectedManagedWorkVersion: 1,
        idempotencyKey: 'connect-merge-flow',
        leaseDurationMs: 60_000,
        workspace: workspace(),
        now: 2_000,
      });
      packet = await service.reportImplementation({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-1',
        bindingEpoch: packet.bindingEpoch,
        expectedManagedWorkVersion: packet.managedWorkVersion,
        exactSha: SHA_A,
        idempotencyKey: 'report-merge-flow',
        now: 3_000,
      });
      await assert.rejects(
        () =>
          service.confirmMerge({
            protocolVersion: 1,
            ownerUserId: 'owner-1',
            projectId: project.id,
            workId: bundle.admission.workId,
            attemptId: bundle.attempt.attemptId,
            runtimeSessionId: 'runtime-1',
            bindingEpoch: packet.bindingEpoch,
            expectedManagedWorkVersion: packet.managedWorkVersion,
            exactSha: SHA_A,
            idempotencyKey: 'confirm-too-early',
            now: 3_500,
          }),
        /approved.*green review/i,
      );

      const roundId = packet.reviewRoundId;
      const hubThreadId = `project-feature-review:${project.id}:backlog-1`;
      for (const reviewerCatId of ['cat-codex', 'cat-kimi']) {
        await reviewCoordinator.submitDraft({
          ownerUserId: 'owner-1',
          threadId: hubThreadId,
          reviewerCatId,
          roundId,
          expectedDraftVersion: 0,
          idempotencyKey: `draft-${reviewerCatId}-merge-flow`,
          verdict: 'approve',
          findings: [],
          now: 4_000,
        });
      }
      let round = (await reviewRounds.readSafe({ ownerUserId: 'owner-1', roundId })).round;
      for (const reviewerCatId of ['cat-codex', 'cat-kimi']) {
        round = await reviewCoordinator.finishIndependent({
          ownerUserId: 'owner-1',
          threadId: hubThreadId,
          reviewerCatId,
          roundId,
          expectedRoundVersion: round.version,
          idempotencyKey: `independent-${reviewerCatId}-merge-flow`,
          now: 5_000,
        });
      }
      for (const reviewerCatId of ['cat-codex', 'cat-kimi']) {
        round = await reviewCoordinator.finishCrossReview({
          ownerUserId: 'owner-1',
          threadId: hubThreadId,
          reviewerCatId,
          roundId,
          expectedRoundVersion: round.version,
          idempotencyKey: `cross-${reviewerCatId}-merge-flow`,
          now: 6_000,
        });
      }
      await reviewCoordinator.publishConsensus({
        ownerUserId: 'owner-1',
        threadId: hubThreadId,
        reviewerCatId: 'cat-codex',
        roundId,
        expectedRoundVersion: round.version,
        expectedManagedWorkVersion: packet.managedWorkVersion,
        idempotencyKey: 'consensus-merge-flow',
        verdict: 'approved',
        checksPassed: true,
        findings: [],
        resolvedFindingIds: [],
        now: 7_000,
      });
      packet = await service.readWork({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        now: 7_100,
      });
      assert.equal(packet.phase, 'awaiting_manual_merge_confirmation');
      assert.deepEqual(packet.nextLegalActions, ['request_merge_confirmation']);

      packet = await service.confirmMerge({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-1',
        bindingEpoch: packet.bindingEpoch,
        expectedManagedWorkVersion: packet.managedWorkVersion,
        exactSha: SHA_A,
        idempotencyKey: 'confirm-merge-flow',
        now: 8_000,
      });
      assert.equal(packet.mergeConfirmed, true);
      assert.equal(packet.phase, 'auto_merge_ready');
      assert.deepEqual(packet.nextLegalActions, ['merge_with_native_git']);

      packet = await service.connect({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-2',
        expectedBindingEpoch: packet.bindingEpoch,
        expectedManagedWorkVersion: packet.managedWorkVersion,
        idempotencyKey: 'rebind-before-merge',
        leaseDurationMs: 60_000,
        workspace: workspace(),
        now: 9_000,
      });
      assert.equal(packet.mergeConfirmed, false);
      assert.equal(packet.phase, 'awaiting_manual_merge_confirmation');
      await assert.rejects(
        () =>
          service.reportMerged({
            protocolVersion: 1,
            ownerUserId: 'owner-1',
            projectId: project.id,
            workId: bundle.admission.workId,
            attemptId: bundle.attempt.attemptId,
            runtimeSessionId: 'runtime-2',
            bindingEpoch: packet.bindingEpoch,
            expectedManagedWorkVersion: packet.managedWorkVersion,
            exactSha: SHA_A,
            mergeCommitSha: 'b'.repeat(40),
            idempotencyKey: 'merge-with-stale-confirmation',
            now: 9_500,
          }),
        /current ChatGPT binding/i,
      );

      packet = await service.confirmMerge({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-2',
        bindingEpoch: packet.bindingEpoch,
        expectedManagedWorkVersion: packet.managedWorkVersion,
        exactSha: SHA_A,
        idempotencyKey: 'reconfirm-merge-flow',
        now: 10_000,
      });
      packet = await service.reportMerged({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        runtimeSessionId: 'runtime-2',
        bindingEpoch: packet.bindingEpoch,
        expectedManagedWorkVersion: packet.managedWorkVersion,
        exactSha: SHA_A,
        mergeCommitSha: 'b'.repeat(40),
        idempotencyKey: 'report-merged-flow',
        now: 11_000,
      });
      assert.equal(packet.acceptancePending, true);
      assert.equal(packet.phase, 'acceptance_pending');
      assert.deepEqual(packet.nextLegalActions, ['wait_for_final_acceptance']);

      packet = await service.recordAcceptance({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        expectedManagedWorkVersion: packet.managedWorkVersion,
        exactSha: SHA_A,
        accepted: true,
        idempotencyKey: 'accept-merge-flow',
        now: 12_000,
      });
      assert.equal(packet.workLifecycle, 'accepted');
      assert.equal(packet.phase, 'accepted');
      assert.deepEqual(packet.nextLegalActions, []);
      assert.equal((await externalProjects.getById(project.id)).desktopDevelopment.successfulManualPilotCount, 1);

      await service.recordAcceptance({
        protocolVersion: 1,
        ownerUserId: 'owner-1',
        projectId: project.id,
        workId: bundle.admission.workId,
        attemptId: bundle.attempt.attemptId,
        expectedManagedWorkVersion: packet.managedWorkVersion,
        exactSha: SHA_A,
        accepted: true,
        idempotencyKey: 'accept-merge-flow',
        now: 13_000,
      });
      assert.equal((await externalProjects.getById(project.id)).desktopDevelopment.successfulManualPilotCount, 1);
    });
  },
);
