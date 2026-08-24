import type { CatId } from './ids.js';

export type WorkAdmissionProducerKind = 'workflow_sop_v1';

/** Canonical identity minted when an eligible managed workflow is first admitted. */
export interface WorkAdmission {
  readonly workId: string;
  readonly ownerUserId: string;
  readonly producerKind: WorkAdmissionProducerKind;
  readonly producerRef: string;
  readonly initialAttemptId: string;
  readonly admittedAt: number;
}

/** Phase B only creates attempt #1; later attempt allocation remains deferred. */
export interface WorkAttempt {
  readonly attemptId: string;
  readonly workId: string;
  readonly attemptNumber: number;
  readonly executorCatId: CatId | null;
  /** Phase-C executor identity. Legacy Phase-B records hydrate from executorCatId. */
  readonly executorActor?: ManagedWorkExecutorActor;
  readonly createdAt: number;
  readonly executorBoundAt: number | null;
}

export interface WorkflowSopAdmissionBundle {
  readonly admission: WorkAdmission;
  readonly attempt: WorkAttempt;
}

/** Internal identity carried by an authenticated invocation after executor bind. */
export interface ManagedWorkBinding {
  readonly workId: string;
  readonly attemptId: string;
}

// Persisted compatibility key from EXT-001's former F289 allocation. Renaming
// it would orphan existing managed-work state, so it is intentionally stable.
export const MANAGED_WORK_CONSUMER_IDS = ['f289_desktop_development_loop'] as const;
export type ManagedWorkConsumerId = (typeof MANAGED_WORK_CONSUMER_IDS)[number];

export type ManagedWorkExecutorActor =
  | { readonly kind: 'cat'; readonly catId: CatId }
  | { readonly kind: 'external_actor'; readonly actorId: 'chatgpt-desktop-dev' };

export type ManagedWorkLifecycle = 'active' | 'accepted' | 'rejected';

export interface ManagedWorkConsumerState {
  readonly consumerId: ManagedWorkConsumerId;
  readonly workId: string;
  readonly currentAttemptId: string;
  readonly currentAttemptNumber: number;
  /** Monotonic user-visible delivery cycle. Legacy records default to cycle 1. */
  readonly currentDeliveryCycleNumber?: number;
  /** Review/fix attempt number within the current delivery cycle. Legacy records default to currentAttemptNumber. */
  readonly currentDeliveryCycleAttemptNumber?: number;
  readonly lifecycle: ManagedWorkLifecycle;
  readonly terminalExactSha?: string;
  readonly terminalAt?: number;
  readonly version: number;
}

export type ManagedWorkEvidenceInput =
  | { readonly kind: 'implementation_committed'; readonly exactSha: string }
  | {
      readonly kind: 'review_completed';
      readonly exactSha: string;
      readonly reviewRoundId: string;
      readonly openFindingCount: number;
      readonly checksPassed: boolean;
    }
  | {
      readonly kind: 'merge_confirmed';
      readonly exactSha: string;
      readonly bindingEpoch: number;
      readonly confirmedByUserId: string;
    }
  | {
      readonly kind: 'review_continuation_approved';
      readonly exactSha: string;
      readonly approvedThroughAttemptNumber: number;
      readonly approvedByUserId: string;
    }
  | {
      readonly kind: 'architecture_decision_recorded';
      readonly exactSha: string;
      readonly findingId: string;
      readonly decision: 'keep_original_plan' | 'approve_plan_change';
      readonly decidedByUserId: string;
      readonly designBranch?: string;
      readonly designExactSha?: string;
    }
  | {
      readonly kind: 'review_consensus_authorized';
      readonly exactSha: string;
      readonly reviewRoundId: string;
      readonly instruction: string;
      readonly authorizedByUserId: string;
    }
  | { readonly kind: 'merged'; readonly exactSha: string; readonly mergeCommitSha: string }
  | { readonly kind: 'acceptance_recorded'; readonly exactSha: string; readonly accepted: boolean }
  | { readonly kind: 'work_rejected'; readonly exactSha: string; readonly reason: string };

export interface ManagedWorkDeliveryCycleStartedEvidenceInput {
  /** Explicit audit boundary when a user reopens terminal work for repair or later supplementary implementation. */
  readonly kind: 'delivery_cycle_started';
  readonly exactSha: string;
  readonly deliveryCycleNumber: number;
  readonly previousLifecycle: 'accepted' | 'rejected';
  readonly designBranch: string;
  readonly designExactSha: string;
  readonly designDocuments: readonly string[];
  readonly startedByUserId: string;
  readonly newAttemptId: string;
}

export type ManagedWorkEvidence = (ManagedWorkEvidenceInput | ManagedWorkDeliveryCycleStartedEvidenceInput) & {
  readonly evidenceId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly consumerId: ManagedWorkConsumerId;
  readonly recordedAt: number;
};

export interface ManagedWorkConsumerSnapshot {
  readonly admission: WorkAdmission;
  readonly attempt: WorkAttempt;
  readonly state: ManagedWorkConsumerState;
  readonly evidence: readonly ManagedWorkEvidence[];
}
