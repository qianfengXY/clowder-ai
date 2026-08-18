import type {
  ManagedWorkConsumerId,
  ManagedWorkConsumerSnapshot,
  ManagedWorkConsumerState,
  ManagedWorkEvidence,
  ManagedWorkEvidenceInput,
  ManagedWorkExecutorActor,
} from '@cat-cafe/shared';

export interface ManagedWorkIdentityInput {
  readonly consumerId: ManagedWorkConsumerId;
  readonly ownerUserId: string;
  readonly workId: string;
  readonly attemptId: string;
}

export interface ClaimManagedWorkAttemptInput extends ManagedWorkIdentityInput {
  readonly executor: ManagedWorkExecutorActor;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly now?: number;
}

export interface CreateNextManagedWorkAttemptInput {
  readonly consumerId: ManagedWorkConsumerId;
  readonly ownerUserId: string;
  readonly workId: string;
  readonly fromAttemptId: string;
  readonly executor: ManagedWorkExecutorActor;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly now?: number;
}

export interface StartNextManagedWorkDeliveryCycleInput {
  readonly consumerId: ManagedWorkConsumerId;
  readonly ownerUserId: string;
  readonly workId: string;
  readonly fromAttemptId: string;
  readonly executor: ManagedWorkExecutorActor;
  readonly expectedVersion: number;
  readonly terminalExactSha: string;
  readonly designBranch: string;
  readonly designExactSha: string;
  readonly designDocuments: readonly string[];
  readonly idempotencyKey: string;
  readonly now?: number;
}

export interface AppendManagedWorkEvidenceInput extends ManagedWorkIdentityInput {
  readonly evidence: ManagedWorkEvidenceInput;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly now?: number;
}

export interface TransitionManagedWorkInput extends ManagedWorkIdentityInput {
  readonly target: 'accepted' | 'rejected';
  readonly exactSha: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly now?: number;
}

export interface ManagedWorkEvidenceAppendResult {
  readonly evidence: ManagedWorkEvidence;
  readonly state: ManagedWorkConsumerState;
}

export interface IManagedWorkConsumerPort {
  read(input: ManagedWorkIdentityInput): Promise<ManagedWorkConsumerSnapshot>;
  claimAttempt(input: ClaimManagedWorkAttemptInput): Promise<ManagedWorkConsumerSnapshot>;
  createNextAttempt(input: CreateNextManagedWorkAttemptInput): Promise<ManagedWorkConsumerSnapshot>;
  startNextDeliveryCycle(input: StartNextManagedWorkDeliveryCycleInput): Promise<ManagedWorkConsumerSnapshot>;
  appendEvidence(input: AppendManagedWorkEvidenceInput): Promise<ManagedWorkEvidenceAppendResult>;
  transition(input: TransitionManagedWorkInput): Promise<ManagedWorkConsumerState>;
}
