import assert from 'node:assert/strict';
import { test } from 'node:test';

const SHA = 'a'.repeat(40);

function finding(overrides = {}) {
  return {
    findingId: 'finding-1',
    projectId: 'project-1',
    workId: 'work-1',
    introducedByRoundId: 'round-1',
    introducedExactSha: SHA,
    severity: 'P2',
    title: 'Plan mismatch',
    details: 'The implementation does not satisfy the approved acceptance condition.',
    evidence: ['src/example.ts:1'],
    designRefs: ['project-feature-plan:project-1:backlog-1#acceptance-1'],
    scope: 'plan_conformance',
    status: 'open',
    createdAt: 1,
    ...overrides,
  };
}

test('review loop pauses after attempt 15 until the user approves the next bounded block', async () => {
  const { deriveReviewLoopGate } = await import('../dist/domains/desktop-development-loop/review-loop-policy.js');
  const atFourteen = deriveReviewLoopGate({ attemptNumber: 14, exactSha: SHA, findings: [finding()], evidence: [] });
  assert.equal(atFourteen.continuationPending, false);
  assert.equal(atFourteen.approvedThroughAttempt, 15);

  const atFifteen = deriveReviewLoopGate({ attemptNumber: 15, exactSha: SHA, findings: [finding()], evidence: [] });
  assert.equal(atFifteen.continuationPending, true);

  const approved = deriveReviewLoopGate({
    attemptNumber: 15,
    exactSha: SHA,
    findings: [finding()],
    evidence: [
      {
        kind: 'review_continuation_approved',
        exactSha: SHA,
        approvedThroughAttemptNumber: 30,
        approvedByUserId: 'owner-1',
        evidenceId: 'evidence-1',
        workId: 'work-1',
        attemptId: 'attempt-15',
        consumerId: 'f289_desktop_development_loop',
        recordedAt: 2,
      },
    ],
  });
  assert.equal(approved.continuationPending, false);
  assert.equal(approved.approvedThroughAttempt, 30);
});

test('serious architecture findings pause until each finding has a user decision', async () => {
  const { deriveReviewLoopGate } = await import('../dist/domains/desktop-development-loop/review-loop-policy.js');
  const architectureFinding = finding({
    findingId: 'architecture-1',
    severity: 'P1',
    scope: 'architecture_decision',
  });
  const pending = deriveReviewLoopGate({
    attemptNumber: 4,
    exactSha: SHA,
    findings: [architectureFinding],
    evidence: [],
  });
  assert.equal(pending.architectureDecisionPending, true);
  assert.deepEqual(pending.architectureDecisionFindingIds, ['architecture-1']);

  const decided = deriveReviewLoopGate({
    attemptNumber: 4,
    exactSha: SHA,
    findings: [architectureFinding],
    evidence: [
      {
        kind: 'architecture_decision_recorded',
        exactSha: SHA,
        findingId: 'architecture-1',
        decision: 'keep_original_plan',
        decidedByUserId: 'owner-1',
        evidenceId: 'evidence-2',
        workId: 'work-1',
        attemptId: 'attempt-4',
        consumerId: 'f289_desktop_development_loop',
        recordedAt: 2,
      },
    ],
  });
  assert.equal(decided.architectureDecisionPending, false);

  const staleDecision = deriveReviewLoopGate({
    attemptNumber: 4,
    exactSha: 'b'.repeat(40),
    findings: [architectureFinding],
    evidence: decided.architectureDecisionPending
      ? []
      : [
          {
            kind: 'architecture_decision_recorded',
            exactSha: SHA,
            findingId: 'architecture-1',
            decision: 'keep_original_plan',
            decidedByUserId: 'owner-1',
            evidenceId: 'evidence-2',
            workId: 'work-1',
            attemptId: 'attempt-4',
            consumerId: 'f289_desktop_development_loop',
            recordedAt: 2,
          },
        ],
  });
  assert.equal(staleDecision.architectureDecisionPending, true);
});
