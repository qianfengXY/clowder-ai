import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Review coordinator requires every new finding to cite only the configured round design documents', async () => {
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
      designBranch: 'design/f001-legacy-system-understanding',
      designExactSha: designSha,
      designDocuments: ['docs/design/f006.md', 'docs/design/f006.zh-CN.md'],
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
    {
      resolve: async () => ({
        designBranch: 'design/shared-specs',
        designExactSha: designSha,
        designDocuments: ['docs/design/f006.zh-CN.md'],
      }),
    },
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
    new RegExp(`git:refs/heads/design/shared-specs@${designSha}`),
  );
  assert.equal(submitted, 0);

  await assert.rejects(
    () =>
      service.submitDraft({
        ...base,
        findings: [
          {
            ...finding,
            designRefs: [
              `git:refs/heads/design/shared-specs@${designSha}`,
              `git:refs/heads/design/shared-specs@${designSha}:docs/design/f006.zh-CN.md`,
              `git:refs/heads/design/shared-specs@${designSha}:docs/design/f006.md`,
            ],
          },
        ],
      }),
    /only the design documents configured for this feature/,
  );
  assert.equal(submitted, 0);

  await service.submitDraft({
    ...base,
    findings: [
      {
        ...finding,
        designRefs: [
          `git:refs/heads/design/shared-specs@${designSha}`,
          `git:refs/heads/design/shared-specs@${designSha}:docs/design/f006.zh-CN.md`,
          `git:refs/heads/design/shared-specs@${designSha}:docs/design/f006.zh-CN.md#验收条件`,
        ],
      },
    ],
  });
  assert.equal(submitted, 1);
});
