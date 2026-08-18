import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Review coordinator requires every new finding to cite the round design commit', async () => {
  const { ReviewRoundCoordinatorService } = await import(
    '../dist/domains/desktop-development-loop/review-round-coordinator-service.js'
  );
  const designSha = 'd'.repeat(40);
  const safe = {
    round: {
      roundId: 'round-1',
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      workId: 'work-1',
      attemptId: 'attempt-1',
      exactSha: 'a'.repeat(40),
      designBranch: 'design/f006-workspace',
      designExactSha: designSha,
      reviewerCatIds: ['cat-gpt', 'cat-kimi'],
      recorderCatId: 'cat-gpt',
      reviewThreadId: 'project-feature-review:project-1:backlog-1',
    },
  };
  let submitted = 0;
  const service = new ReviewRoundCoordinatorService(
    {
      readSafe: async () => safe,
      submitIndependentDraft: async (input) => {
        submitted += 1;
        return input;
      },
    },
    {},
    {},
  );
  const base = {
    ownerUserId: 'owner-1',
    threadId: 'project-feature-review:project-1:backlog-1',
    reviewerCatId: 'cat-gpt',
    roundId: 'round-1',
    expectedDraftVersion: 0,
    idempotencyKey: 'draft-1',
    verdict: 'findings',
  };
  const finding = {
    severity: 'P2',
    title: 'Mismatch',
    details: 'Implementation does not match the plan.',
    evidence: ['src/index.ts:10'],
    scope: 'plan_conformance',
  };

  await assert.rejects(
    () => service.submitDraft({ ...base, findings: [{ ...finding, designRefs: ['docs/plan.md'] }] }),
    new RegExp(`git:refs/heads/design/f006-workspace@${designSha}`),
  );
  assert.equal(submitted, 0);

  await service.submitDraft({
    ...base,
    findings: [{ ...finding, designRefs: [`git:refs/heads/design/f006-workspace@${designSha}`] }],
  });
  assert.equal(submitted, 1);
});
