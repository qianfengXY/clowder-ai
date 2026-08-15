import {
  DESKTOP_DEVELOPMENT_REVIEW_ATTEMPT_LIMIT,
  type ManagedWorkEvidence,
  type ReviewConsensusFinding,
} from '@cat-cafe/shared';

export interface ReviewLoopGate {
  readonly approvedThroughAttempt: number;
  readonly continuationPending: boolean;
  readonly architectureDecisionFindingIds: readonly string[];
  readonly architectureDecisionPending: boolean;
}

export function deriveReviewLoopGate(input: {
  readonly attemptNumber: number;
  readonly exactSha: string;
  readonly findings: readonly ReviewConsensusFinding[];
  readonly evidence: readonly ManagedWorkEvidence[];
}): ReviewLoopGate {
  const approvedThroughAttempt = input.evidence.reduce<number>(
    (maximum, evidence) =>
      evidence.kind === 'review_continuation_approved'
        ? Math.max(maximum, evidence.approvedThroughAttemptNumber)
        : maximum,
    DESKTOP_DEVELOPMENT_REVIEW_ATTEMPT_LIMIT,
  );
  const decidedFindingIds = new Set(
    input.evidence.flatMap((evidence) =>
      evidence.kind === 'architecture_decision_recorded' && evidence.exactSha === input.exactSha.toLowerCase()
        ? [evidence.findingId]
        : [],
    ),
  );
  const architectureDecisionFindingIds = input.findings
    .filter(
      (finding) =>
        finding.status === 'open' &&
        finding.scope === 'architecture_decision' &&
        !decidedFindingIds.has(finding.findingId),
    )
    .map((finding) => finding.findingId);
  return {
    approvedThroughAttempt,
    continuationPending: input.attemptNumber >= approvedThroughAttempt,
    architectureDecisionFindingIds,
    architectureDecisionPending: architectureDecisionFindingIds.length > 0,
  };
}

export function canContinueReviewLoop(gate: ReviewLoopGate): boolean {
  return !gate.continuationPending && !gate.architectureDecisionPending;
}
