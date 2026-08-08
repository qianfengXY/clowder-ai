import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { assertRedisIsolationOrThrow, cleanupPrefixedRedisKeys } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const REDIS_ISOLATED = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';
const SHA_A = 'a'.repeat(40);

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
      };
      service = new DesktopDevelopmentLoopService(externalProjects, reviewHubs, sessions, managedWork, reviewRounds);
      reviewCoordinator = new ReviewRoundCoordinatorService(reviewRounds, managedWork);
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
      assert.doesNotMatch(JSON.stringify(result), /Volumes\/WorkSSD/);
      await assert.rejects(
        () => service.readProject({ protocolVersion: 2, ownerUserId: 'owner-1', projectId: project.id }),
        /protocol mismatch/i,
      );
      await assert.rejects(
        () => service.readProject({ protocolVersion: 1, ownerUserId: 'owner-2', projectId: project.id }),
        /project not found/i,
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
      assert.equal(first.managedWorkVersion, 2);
      assert.equal(first.reviewRoundId, null);
      assert.deepEqual(first.nextLegalActions, ['implement_and_report_committed_sha']);
      assert.doesNotMatch(JSON.stringify(first), /example-worktree/);

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
      assert.equal(reported.currentSha, SHA_A);
      assert.deepEqual(reported.nextLegalActions, ['wait_for_independent_review']);
      assert.equal(reviewHubEnsureCount, 1);

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
      assert.deepEqual(packet.nextLegalActions, ['fix_open_findings']);
    });

    test('derives reviewer identity from the Review Hub and writes one canonical review-completed evidence row', async () => {
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
      const hubThreadId = `project-review-hub:${project.id}`;

      await assert.rejects(
        () =>
          reviewCoordinator.readSafe({
            ownerUserId: 'owner-1',
            threadId: 'ordinary-thread',
            reviewerCatId: 'cat-codex',
            roundId,
          }),
        /project Review Hub/i,
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
      const completed = await reviewCoordinator.publishConsensus({
        ownerUserId: 'owner-1',
        threadId: hubThreadId,
        reviewerCatId: 'cat-codex',
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
    });
  },
);
