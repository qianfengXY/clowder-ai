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
  return { reviewRounds, managedWork, dispatcher, dispatches, safe };
}

describe('ReviewRoundCoordinatorService replay', () => {
  test('replays an untouched current independent stage with a version-stable delivery key', async () => {
    const { ReviewRoundCoordinatorService } = await import(
      '../dist/domains/desktop-development-loop/review-round-coordinator-service.js'
    );
    const f = fixture();
    const coordinator = new ReviewRoundCoordinatorService(f.reviewRounds, f.managedWork, f.dispatcher);
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
        recorderCatId: 'cat-codex',
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
      fixture({ independentFinishedCatIds: ['cat-codex'] }),
      fixture({ phase: 'cross_review' }),
      fixture({ currentForWork: false }),
    ];
    for (const f of cases) {
      const coordinator = new ReviewRoundCoordinatorService(f.reviewRounds, f.managedWork, f.dispatcher);
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
});
