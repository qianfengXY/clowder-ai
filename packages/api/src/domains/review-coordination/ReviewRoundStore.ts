import type {
  CatId,
  ManagedWorkExecutorActor,
  ReviewConsensusFinding,
  ReviewConsensusVerdict,
  ReviewDraftVerdict,
  ReviewFindingScope,
  ReviewPrivateDraft,
  ReviewRound,
  ReviewRoundSafeView,
  ReviewSeverity,
} from '@cat-cafe/shared';

export interface CreateReviewRoundInput {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly exactSha: string;
  readonly designBranch?: string;
  readonly designExactSha?: string;
  readonly designDocuments?: readonly string[];
  readonly author: ManagedWorkExecutorActor;
  readonly reviewerCatIds: readonly CatId[];
  readonly recorderCatId: CatId;
  readonly reviewThreadId?: string;
  readonly idempotencyKey: string;
  readonly now?: number;
}

export interface ReviewRoundIdentityInput {
  readonly ownerUserId: string;
  readonly roundId: string;
}

export interface ReviewWorkIdentityInput {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly workId: string;
}

export interface ReadPrivateReviewDraftInput extends ReviewRoundIdentityInput {
  readonly reviewerCatId: CatId;
  readonly draftOwnerCatId: CatId;
}

export interface ReadBarrierDraftsInput extends ReviewRoundIdentityInput {
  readonly reviewerCatId: CatId;
}

export interface ReviewDraftFindingInput {
  readonly severity: ReviewSeverity;
  readonly title: string;
  readonly details: string;
  readonly evidence?: readonly string[];
  readonly designRefs: readonly string[];
  readonly scope: ReviewFindingScope;
}

export interface SubmitIndependentDraftInput extends ReviewRoundIdentityInput {
  readonly reviewerCatId: CatId;
  readonly expectedDraftVersion: number;
  readonly idempotencyKey: string;
  readonly verdict: ReviewDraftVerdict;
  readonly findings: readonly ReviewDraftFindingInput[];
  readonly now?: number;
}

export interface FinishReviewStageInput extends ReviewRoundIdentityInput {
  readonly reviewerCatId: CatId;
  readonly expectedRoundVersion: number;
  readonly idempotencyKey: string;
  readonly now?: number;
}

export interface ConsensusFindingInput {
  readonly severity: ReviewSeverity;
  readonly title: string;
  readonly details: string;
  readonly evidence?: readonly string[];
  readonly designRefs: readonly string[];
  readonly scope: ReviewFindingScope;
}

export interface PublishReviewConsensusInput extends ReviewRoundIdentityInput {
  readonly recorderCatId: CatId;
  readonly expectedRoundVersion: number;
  readonly idempotencyKey: string;
  readonly verdict: ReviewConsensusVerdict;
  readonly checksPassed: boolean;
  readonly findings: readonly ConsensusFindingInput[];
  readonly resolvedFindingIds: readonly string[];
  readonly now?: number;
}

export interface IReviewRoundStore {
  createRound(input: CreateReviewRoundInput): Promise<ReviewRound>;
  readSafe(input: ReviewRoundIdentityInput): Promise<ReviewRoundSafeView>;
  readCurrentSafe(input: ReviewWorkIdentityInput): Promise<ReviewRoundSafeView | null>;
  readPrivateDraft(input: ReadPrivateReviewDraftInput): Promise<ReviewPrivateDraft | null>;
  readBarrierDrafts(input: ReadBarrierDraftsInput): Promise<readonly ReviewPrivateDraft[]>;
  submitIndependentDraft(input: SubmitIndependentDraftInput): Promise<ReviewPrivateDraft>;
  finishIndependent(input: FinishReviewStageInput): Promise<ReviewRound>;
  finishCrossReview(input: FinishReviewStageInput): Promise<ReviewRound>;
  publishConsensus(input: PublishReviewConsensusInput): Promise<ReviewRoundSafeView>;
}

export type { ReviewConsensusFinding };
