import type {
  DesktopDevelopmentDeliveryCycleEntryMode,
  ManagedWorkConsumerSnapshot,
  ManagedWorkEvidence,
  ReviewRoundSafeView,
} from '@cat-cafe/shared';

export function deliveryCycleNumber(managed: ManagedWorkConsumerSnapshot): number {
  return managed.state.currentDeliveryCycleNumber ?? 1;
}

export function deliveryCycleAttemptNumber(managed: ManagedWorkConsumerSnapshot): number {
  return managed.state.currentDeliveryCycleAttemptNumber ?? managed.attempt.attemptNumber;
}

export function deliveryCycleEntryMode(managed: ManagedWorkConsumerSnapshot): DesktopDevelopmentDeliveryCycleEntryMode {
  const boundary = currentDeliveryCycleEvidence(managed).find((evidence) => evidence.kind === 'delivery_cycle_started');
  return boundary?.kind === 'delivery_cycle_started' && boundary.previousLifecycle === 'rejected'
    ? 'acceptance_rework'
    : 'design_change';
}

/** Evidence at or after the latest explicit delivery-cycle boundary. */
export function currentDeliveryCycleEvidence(managed: ManagedWorkConsumerSnapshot): readonly ManagedWorkEvidence[] {
  const cycle = deliveryCycleNumber(managed);
  let boundaryIndex = -1;
  for (let index = managed.evidence.length - 1; index >= 0; index -= 1) {
    const evidence = managed.evidence[index];
    if (evidence?.kind === 'delivery_cycle_started' && evidence.deliveryCycleNumber === cycle) {
      boundaryIndex = index;
      break;
    }
  }
  return boundaryIndex < 0 ? managed.evidence : managed.evidence.slice(boundaryIndex);
}

export function currentDeliveryCycleSnapshot(managed: ManagedWorkConsumerSnapshot): ManagedWorkConsumerSnapshot {
  return { ...managed, evidence: currentDeliveryCycleEvidence(managed) };
}

/**
 * Immediately after reopening terminal work, the Review store still points to
 * the preceding delivery cycle. It becomes relevant again only after the new
 * cycle reports an implementation (or after a later fix attempt in this cycle).
 */
export function currentDeliveryCycleReview(
  managed: ManagedWorkConsumerSnapshot,
  review: ReviewRoundSafeView | null,
): ReviewRoundSafeView | null {
  if (!review) return null;
  const boundary = currentDeliveryCycleEvidence(managed).find((evidence) => evidence.kind === 'delivery_cycle_started');
  if (
    boundary?.kind === 'delivery_cycle_started' &&
    boundary.newAttemptId === managed.attempt.attemptId &&
    review.round.attemptId !== managed.attempt.attemptId
  ) {
    return null;
  }
  return review;
}
