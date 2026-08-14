import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const ROUND = {
  roundId: 'round-1',
  ownerUserId: 'owner-1',
  projectId: 'project-1',
  workId: 'work-1',
  attemptId: 'attempt-1',
  exactSha: 'a'.repeat(40),
  author: { kind: 'external_actor', actorId: 'chatgpt-desktop-dev' },
  reviewerCatIds: ['cat-codex', 'cat-kimi'],
  recorderCatId: 'cat-codex',
  reviewThreadId: 'project-feature-review:project-1:backlog-1',
  phase: 'independent',
  independentFinishedCatIds: [],
  crossReviewFinishedCatIds: [],
  version: 1,
  createdAt: 1,
};

const DISPLAY_CONTEXT = {
  projectName: 'Traqen',
  repository: 'qianfengXY/Traqen',
  backlogItemId: 'backlog-1',
  featureId: 'F006',
  featureTitle: 'Workspace capability settings',
  attemptNumber: 3,
};

function fixture(overrides = {}, drafts = {}) {
  const dispatches = [];
  const round = { ...ROUND, ...overrides };
  const safe = {
    round,
    currentForWork: overrides.currentForWork ?? true,
    progress: { independentFinished: 0, required: 2, crossReviewFinished: 0 },
    consensus: null,
    findings: [],
  };
  const reviewRounds = {
    readSafe: async () => safe,
    readPrivateDraft: async ({ draftOwnerCatId }) => drafts[draftOwnerCatId] ?? null,
  };
  const managedWork = {};
  const dispatcher = { dispatch: async (input) => dispatches.push(input) };
  const displayContexts = { resolve: async () => DISPLAY_CONTEXT };
  return { reviewRounds, managedWork, dispatcher, dispatches, safe, displayContexts };
}

describe('ReviewRoundCoordinatorService replay', () => {
  test('replays an untouched current independent stage with a version-stable delivery key', async () => {
    const { ReviewRoundCoordinatorService } = await import(
      '../dist/domains/desktop-development-loop/review-round-coordinator-service.js'
    );
    const f = fixture();
    const coordinator = new ReviewRoundCoordinatorService(
      f.reviewRounds,
      f.managedWork,
      f.dispatcher,
      f.displayContexts,
    );
    const result = await coordinator.replayIndependent({
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      roundId: 'round-1',
    });
    assert.equal(result, f.safe);
    assert.deepEqual(f.dispatches, [
      {
        stage: 'independent',
        ownerUserId: 'owner-1',
        projectId: 'project-1',
        reviewHubThreadId: 'project-feature-review:project-1:backlog-1',
        roundId: 'round-1',
        exactSha: 'a'.repeat(40),
        reviewerCatIds: ['cat-codex', 'cat-kimi'],
        allReviewerCatIds: ['cat-codex', 'cat-kimi'],
        completedReviewerCatIds: [],
        recorderCatId: 'cat-codex',
        displayContext: DISPLAY_CONTEXT,
        deliveryKey: 'replay:1',
      },
    ]);
  });

  test('refuses replay after any draft, completion, phase advance, or supersession', async () => {
    const { ReviewRoundCoordinatorService } = await import(
      '../dist/domains/desktop-development-loop/review-round-coordinator-service.js'
    );
    const cases = [
      fixture({}, { 'cat-kimi': { version: 1 } }),
      fixture({ independentFinishedCatIds: ['cat-codex', 'cat-kimi'] }),
      fixture({ phase: 'cross_review' }),
      fixture({ currentForWork: false }),
    ];
    for (const f of cases) {
      const coordinator = new ReviewRoundCoordinatorService(
        f.reviewRounds,
        f.managedWork,
        f.dispatcher,
        f.displayContexts,
      );
      await assert.rejects(
        () =>
          coordinator.replayIndependent({
            ownerUserId: 'owner-1',
            projectId: 'project-1',
            roundId: 'round-1',
          }),
        /replay/i,
      );
      assert.deepEqual(f.dispatches, []);
    }
  });

  test('replays only unfinished reviewers after partial independent progress', async () => {
    const { ReviewRoundCoordinatorService } = await import(
      '../dist/domains/desktop-development-loop/review-round-coordinator-service.js'
    );
    const f = fixture({ independentFinishedCatIds: ['cat-codex'], version: 2 });
    const coordinator = new ReviewRoundCoordinatorService(
      f.reviewRounds,
      f.managedWork,
      f.dispatcher,
      f.displayContexts,
    );
    await coordinator.replayIndependent({
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      roundId: 'round-1',
    });
    assert.deepEqual(f.dispatches[0].reviewerCatIds, ['cat-kimi']);
    assert.deepEqual(f.dispatches[0].completedReviewerCatIds, ['cat-codex']);
    assert.deepEqual(f.dispatches[0].displayContext, DISPLAY_CONTEXT);
    assert.equal(f.dispatches[0].deliveryKey, 'replay:2');
  });
});
