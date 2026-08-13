import type { CatId } from './ids.js';
import type { ManagedWorkExecutorActor } from './managed-work.js';

export type ReviewSeverity = 'P1' | 'P2' | 'P3';
export type ReviewRoundPhase = 'independent' | 'cross_review' | 'consensus_ready' | 'complete';
export type ReviewDraftVerdict = 'approve' | 'findings';
export type ReviewConsensusVerdict = 'changes_requested' | 'approved';

export interface ReviewRound {
  readonly roundId: string;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly exactSha: string;
  readonly author: ManagedWorkExecutorActor;
  readonly reviewerCatIds: readonly CatId[];
  readonly recorderCatId: CatId;
  /** Visible thread selected when the round was created. Absent only on legacy project-Hub rounds. */
  readonly reviewThreadId?: string;
  readonly phase: ReviewRoundPhase;
  readonly independentFinishedCatIds: readonly CatId[];
  readonly crossReviewFinishedCatIds: readonly CatId[];
  readonly version: number;
  readonly createdAt: number;
  readonly barrierOpenedAt?: number;
  readonly completedAt?: number;
}

export interface ReviewDraftFinding {
  readonly draftFindingId: string;
  readonly severity: ReviewSeverity;
  readonly title: string;
  readonly details: string;
  readonly evidence: readonly string[];
}

export interface ReviewPrivateDraft {
  readonly roundId: string;
  readonly reviewerCatId: CatId;
  readonly verdict: ReviewDraftVerdict;
  readonly findings: readonly ReviewDraftFinding[];
  readonly version: number;
  readonly updatedAt: number;
}

export type ReviewFindingStatus = 'open' | 'resolved';

export interface ReviewConsensusFinding {
  readonly findingId: string;
  readonly projectId: string;
  readonly workId: string;
  readonly introducedByRoundId: string;
  readonly introducedExactSha: string;
  readonly severity: ReviewSeverity;
  readonly title: string;
  readonly details: string;
  readonly evidence: readonly string[];
  readonly status: ReviewFindingStatus;
  readonly createdAt: number;
  readonly resolvedAt?: number;
  readonly resolvedByRoundId?: string;
  readonly resolvedExactSha?: string;
}

export interface ReviewConsensus {
  readonly roundId: string;
  readonly recorderCatId: CatId;
  readonly verdict: ReviewConsensusVerdict;
  readonly checksPassed: boolean;
  readonly openFindingCount: number;
  readonly publishedAt: number;
}

export interface ReviewRoundSafeView {
  readonly round: ReviewRound;
  /** False once a newer exact-SHA round exists for the same project/work. */
  readonly currentForWork: boolean;
  readonly progress: {
    readonly independentFinished: number;
    readonly required: number;
    readonly crossReviewFinished: number;
  };
  readonly consensus: ReviewConsensus | null;
  /** Empty until this round reaches a barrier-safe completed consensus. */
  readonly findings: readonly ReviewConsensusFinding[];
}
