import { buildProjectReviewHubId, type CatId, type ReviewRoundSafeView } from '@cat-cafe/shared';
import type { IManagedWorkConsumerPort } from '../cats/services/stores/ports/ManagedWorkConsumerPort.js';
import type {
  ConsensusFindingInput,
  IReviewRoundStore,
  ReviewDraftFindingInput,
} from '../review-coordination/ReviewRoundStore.js';
import type { IReviewRoundStageDispatcher } from './review-round-stage-dispatcher.js';

const CONSUMER_ID = 'f289_desktop_development_loop' as const;

interface ReviewPrincipalInput {
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly reviewerCatId: CatId;
  readonly roundId: string;
}

export interface SubmitCoordinatedReviewDraftInput extends ReviewPrincipalInput {
  readonly expectedDraftVersion: number;
  readonly idempotencyKey: string;
  readonly verdict: 'approve' | 'findings';
  readonly findings: readonly ReviewDraftFindingInput[];
  readonly now?: number;
}

export interface FinishCoordinatedReviewStageInput extends ReviewPrincipalInput {
  readonly expectedRoundVersion: number;
  readonly idempotencyKey: string;
  readonly now?: number;
}

export interface PublishCoordinatedReviewConsensusInput extends FinishCoordinatedReviewStageInput {
  readonly expectedManagedWorkVersion: number;
  readonly verdict: 'changes_requested' | 'approved';
  readonly checksPassed: boolean;
  readonly findings: readonly ConsensusFindingInput[];
  readonly resolvedFindingIds: readonly string[];
}

export class ReviewRoundCoordinatorService {
  constructor(
    private readonly reviewRounds: IReviewRoundStore,
    private readonly managedWork: IManagedWorkConsumerPort,
    private readonly reviewDispatcher: IReviewRoundStageDispatcher,
  ) {}

  async readSafe(input: ReviewPrincipalInput): Promise<ReviewRoundSafeView> {
    const safe = await this.requireReviewerInHub(input);
    return safe;
  }

  async readPrivateDraft(input: ReviewPrincipalInput) {
    await this.requireReviewerInHub(input);
    return this.reviewRounds.readPrivateDraft({
      ownerUserId: input.ownerUserId,
      roundId: input.roundId,
      reviewerCatId: input.reviewerCatId,
      draftOwnerCatId: input.reviewerCatId,
    });
  }

  async readBarrierDrafts(input: ReviewPrincipalInput) {
    await this.requireReviewerInHub(input);
    return this.reviewRounds.readBarrierDrafts({
      ownerUserId: input.ownerUserId,
      roundId: input.roundId,
      reviewerCatId: input.reviewerCatId,
    });
  }

  async submitDraft(input: SubmitCoordinatedReviewDraftInput) {
    await this.requireReviewerInHub(input);
    return this.reviewRounds.submitIndependentDraft({
      ownerUserId: input.ownerUserId,
      roundId: input.roundId,
      reviewerCatId: input.reviewerCatId,
      expectedDraftVersion: input.expectedDraftVersion,
      idempotencyKey: input.idempotencyKey,
      verdict: input.verdict,
      findings: input.findings,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }

  async finishIndependent(input: FinishCoordinatedReviewStageInput) {
    await this.requireReviewerInHub(input);
    const round = await this.reviewRounds.finishIndependent({
      ownerUserId: input.ownerUserId,
      roundId: input.roundId,
      reviewerCatId: input.reviewerCatId,
      expectedRoundVersion: input.expectedRoundVersion,
      idempotencyKey: input.idempotencyKey,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    if (round.phase === 'cross_review') {
      await this.reviewDispatcher.dispatch({
        stage: 'cross_review',
        ownerUserId: round.ownerUserId,
        projectId: round.projectId,
        reviewHubThreadId: input.threadId,
        roundId: round.roundId,
        exactSha: round.exactSha,
        reviewerCatIds: round.reviewerCatIds,
        recorderCatId: round.recorderCatId,
      });
    }
    return round;
  }

  async finishCrossReview(input: FinishCoordinatedReviewStageInput) {
    await this.requireReviewerInHub(input);
    const round = await this.reviewRounds.finishCrossReview({
      ownerUserId: input.ownerUserId,
      roundId: input.roundId,
      reviewerCatId: input.reviewerCatId,
      expectedRoundVersion: input.expectedRoundVersion,
      idempotencyKey: input.idempotencyKey,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    if (round.phase === 'consensus_ready') {
      await this.reviewDispatcher.dispatch({
        stage: 'consensus',
        ownerUserId: round.ownerUserId,
        projectId: round.projectId,
        reviewHubThreadId: input.threadId,
        roundId: round.roundId,
        exactSha: round.exactSha,
        reviewerCatIds: round.reviewerCatIds,
        recorderCatId: round.recorderCatId,
      });
    }
    return round;
  }

  async publishConsensus(input: PublishCoordinatedReviewConsensusInput): Promise<ReviewRoundSafeView> {
    const before = await this.requireReviewerInHub(input);
    const completed = await this.reviewRounds.publishConsensus({
      ownerUserId: input.ownerUserId,
      roundId: input.roundId,
      recorderCatId: input.reviewerCatId,
      expectedRoundVersion: input.expectedRoundVersion,
      idempotencyKey: `${input.idempotencyKey}:consensus`,
      verdict: input.verdict,
      checksPassed: input.checksPassed,
      findings: input.findings,
      resolvedFindingIds: input.resolvedFindingIds,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    await this.managedWork.appendEvidence({
      consumerId: CONSUMER_ID,
      ownerUserId: input.ownerUserId,
      workId: before.round.workId,
      attemptId: before.round.attemptId,
      expectedVersion: input.expectedManagedWorkVersion,
      idempotencyKey: `${input.idempotencyKey}:managed-evidence`,
      evidence: {
        kind: 'review_completed',
        exactSha: before.round.exactSha,
        reviewRoundId: before.round.roundId,
        openFindingCount: completed.consensus?.openFindingCount ?? 0,
        checksPassed: completed.consensus?.checksPassed ?? false,
      },
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return completed;
  }

  private async requireReviewerInHub(input: ReviewPrincipalInput): Promise<ReviewRoundSafeView> {
    const safe = await this.reviewRounds.readSafe({ ownerUserId: input.ownerUserId, roundId: input.roundId });
    const legacyReviewHubId = buildProjectReviewHubId(safe.round.projectId);
    const authorizedThreadId = safe.round.reviewThreadId ?? legacyReviewHubId;
    if (input.threadId !== authorizedThreadId) {
      throw new Error('ReviewRound actions are restricted to the feature Review thread');
    }
    if (!safe.round.reviewerCatIds.includes(input.reviewerCatId)) {
      throw new Error('Authenticated cat is not a reviewer for this round');
    }
    return safe;
  }

}
