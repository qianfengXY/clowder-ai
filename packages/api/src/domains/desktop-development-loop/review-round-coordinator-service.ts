import {
  buildProjectReviewHubId,
  buildReviewDesignDocumentRef,
  buildReviewDesignRef,
  type CatId,
  type ReviewRoundSafeView,
} from '@cat-cafe/shared';
import type { IManagedWorkConsumerPort } from '../cats/services/stores/ports/ManagedWorkConsumerPort.js';
import type {
  ConsensusFindingInput,
  IReviewRoundStore,
  ReviewDraftFindingInput,
} from '../review-coordination/ReviewRoundStore.js';
import { buildReviewCompletionObjective, type DesktopTaskActivator } from './codex-desktop-task-launcher.js';
import { preferChineseDesignDocuments } from './design-branch-resolver.js';
import type { DesktopSessionStore } from './desktop-session-store.js';
import { currentDeliveryCycleEvidence, deliveryCycleAttemptNumber } from './managed-work-delivery-cycle.js';
import { canContinueReviewLoop, deriveReviewLoopGate } from './review-loop-policy.js';
import type { IReviewRoundDisplayContextResolver } from './review-round-display-context.js';
import type { IReviewRoundStageDispatcher } from './review-round-stage-dispatcher.js';
import { WorkMutationCoordinator } from './work-mutation-coordinator.js';

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

export interface ReplayIndependentReviewInput {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly roundId: string;
}

export class ReviewRoundCoordinatorService {
  constructor(
    private readonly reviewRounds: IReviewRoundStore,
    private readonly managedWork: IManagedWorkConsumerPort,
    private readonly reviewDispatcher: IReviewRoundStageDispatcher,
    private readonly reviewDisplayContexts?: IReviewRoundDisplayContextResolver,
    private readonly desktopSessions?: Pick<DesktopSessionStore, 'getCurrent'>,
    private readonly desktopTasks?: DesktopTaskActivator,
    private readonly workMutations: WorkMutationCoordinator = new WorkMutationCoordinator(),
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
    const safe = await this.requireReviewerInHub(input);
    const displayContext = this.reviewDisplayContexts ? await this.resolveDisplayContext(safe.round) : undefined;
    assertFindingDesignRefs(safe, input.findings, displayContext);
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
    return this.withRoundWorkMutation(input, async () => {
      const before = await this.requireReviewerInHub(input);
      const displayContext = await this.resolveDisplayContext(before.round);
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
          allReviewerCatIds: round.reviewerCatIds,
          completedReviewerCatIds: [],
          recorderCatId: round.recorderCatId,
          displayContext,
        });
      }
      return round;
    });
  }

  async finishCrossReview(input: FinishCoordinatedReviewStageInput) {
    return this.withRoundWorkMutation(input, async () => {
      const before = await this.requireReviewerInHub(input);
      const displayContext = await this.resolveDisplayContext(before.round);
      const round = await this.reviewRounds.finishCrossReview({
        ownerUserId: input.ownerUserId,
        roundId: input.roundId,
        reviewerCatId: input.reviewerCatId,
        expectedRoundVersion: input.expectedRoundVersion,
        idempotencyKey: input.idempotencyKey,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      if (round.phase === 'consensus_ready') {
        const managed = await this.managedWork.read({
          consumerId: CONSUMER_ID,
          ownerUserId: round.ownerUserId,
          workId: round.workId,
          attemptId: round.attemptId,
        });
        await this.reviewDispatcher.dispatch({
          stage: 'consensus',
          ownerUserId: round.ownerUserId,
          projectId: round.projectId,
          reviewHubThreadId: input.threadId,
          roundId: round.roundId,
          exactSha: round.exactSha,
          reviewerCatIds: round.reviewerCatIds,
          allReviewerCatIds: round.reviewerCatIds,
          completedReviewerCatIds: round.reviewerCatIds,
          recorderCatId: round.recorderCatId,
          displayContext,
          managedWorkVersion: managed.state.version,
        });
      }
      return round;
    });
  }

  async publishConsensus(input: PublishCoordinatedReviewConsensusInput): Promise<ReviewRoundSafeView> {
    return this.withRoundWorkMutation(input, async () => {
      const before = await this.requireReviewerInHub(input);
      const displayContext = this.reviewDisplayContexts ? await this.resolveDisplayContext(before.round) : undefined;
      assertFindingDesignRefs(before, input.findings, displayContext);
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
      const managed = await this.managedWork.read({
        consumerId: CONSUMER_ID,
        ownerUserId: input.ownerUserId,
        workId: before.round.workId,
        attemptId: before.round.attemptId,
      });
      const gate = deriveReviewLoopGate({
        attemptNumber: deliveryCycleAttemptNumber(managed),
        exactSha: completed.round.exactSha,
        findings: completed.findings,
        evidence: currentDeliveryCycleEvidence(managed),
      });
      if (completed.consensus?.verdict === 'approved' || canContinueReviewLoop(gate)) {
        await this.wakeBoundDesktopTask({
          ownerUserId: input.ownerUserId,
          projectId: before.round.projectId,
          workId: before.round.workId,
          attemptId: before.round.attemptId,
          reviewRoundId: before.round.roundId,
          exactSha: before.round.exactSha,
          ...(before.round.designBranch && before.round.designExactSha
            ? {
                designBranch: before.round.designBranch,
                designExactSha: before.round.designExactSha,
                designDocuments: before.round.designDocuments ?? [],
              }
            : {}),
        });
      }
      return completed;
    });
  }

  async replayIndependent(input: ReplayIndependentReviewInput): Promise<ReviewRoundSafeView> {
    return this.withRoundWorkMutation(input, async () => {
      const safe = await this.reviewRounds.readSafe({ ownerUserId: input.ownerUserId, roundId: input.roundId });
      const { round } = safe;
      if (round.projectId !== input.projectId) throw new Error('Review round does not belong to this project');
      if (!safe.currentForWork) throw new Error('Only the current Review round can be replayed');
      if (round.phase !== 'independent') throw new Error('Only the independent Review stage can be replayed');
      const pendingReviewerCatIds = round.reviewerCatIds.filter(
        (reviewerCatId) => !round.independentFinishedCatIds.includes(reviewerCatId),
      );
      if (pendingReviewerCatIds.length === 0) throw new Error('Independent Review replay has no pending reviewer');
      const drafts = await Promise.all(
        pendingReviewerCatIds.map((reviewerCatId) =>
          this.reviewRounds.readPrivateDraft({
            ownerUserId: input.ownerUserId,
            roundId: input.roundId,
            reviewerCatId,
            draftOwnerCatId: reviewerCatId,
          }),
        ),
      );
      if (drafts.some(Boolean)) throw new Error('Independent Review replay requires no submitted draft');

      const displayContext = await this.resolveDisplayContext(round);
      await this.reviewDispatcher.dispatch({
        stage: 'independent',
        ownerUserId: round.ownerUserId,
        projectId: round.projectId,
        reviewHubThreadId: round.reviewThreadId ?? buildProjectReviewHubId(round.projectId),
        roundId: round.roundId,
        exactSha: round.exactSha,
        reviewerCatIds: pendingReviewerCatIds,
        allReviewerCatIds: round.reviewerCatIds,
        completedReviewerCatIds: round.independentFinishedCatIds,
        recorderCatId: round.recorderCatId,
        displayContext,
        deliveryKey: `replay:${round.version}`,
      });
      return safe;
    });
  }

  private async withRoundWorkMutation<T>(
    input: { readonly ownerUserId: string; readonly roundId: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    const safe = await this.reviewRounds.readSafe({ ownerUserId: input.ownerUserId, roundId: input.roundId });
    return this.workMutations.run({ projectId: safe.round.projectId, workId: safe.round.workId }, operation);
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

  private async resolveDisplayContext(round: {
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly workId: string;
    readonly attemptId: string;
    readonly designBranch?: string;
    readonly designExactSha?: string;
    readonly designDocuments?: readonly string[];
  }) {
    if (!this.reviewDisplayContexts) {
      throw new Error('Review display context resolver is unavailable');
    }
    return this.reviewDisplayContexts.resolve({
      ownerUserId: round.ownerUserId,
      projectId: round.projectId,
      workId: round.workId,
      attemptId: round.attemptId,
      ...(round.designBranch && round.designExactSha
        ? {
            designBranch: round.designBranch,
            designExactSha: round.designExactSha,
            designDocuments: round.designDocuments ?? [],
          }
        : {}),
    });
  }

  private async wakeBoundDesktopTask(input: {
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly workId: string;
    readonly attemptId: string;
    readonly reviewRoundId: string;
    readonly exactSha: string;
    readonly designBranch?: string;
    readonly designExactSha?: string;
    readonly designDocuments?: readonly string[];
  }): Promise<void> {
    if (!this.desktopSessions || !this.desktopTasks) return;
    const binding = await this.desktopSessions.getCurrent(input.projectId, input.workId);
    if (!binding?.chatRef || binding.attemptId !== input.attemptId) return;
    const displayContext = await this.resolveDisplayContext(input);
    await this.desktopTasks
      .activate({
        threadId: binding.chatRef,
        sourcePath: binding.workspace.worktreePath,
        objective: buildReviewCompletionObjective({
          ...input,
          ...displayContext,
          runtimeSessionId: binding.runtimeSessionId,
        }),
      })
      .catch(() => undefined);
  }
}

function assertFindingDesignRefs(
  review: ReviewRoundSafeView,
  findings: readonly { readonly designRefs: readonly string[] }[],
  displayContext?: {
    readonly designBranch: string;
    readonly designExactSha: string;
    readonly designDocuments: readonly string[];
  },
): void {
  const designBranch = displayContext?.designBranch ?? review.round.designBranch;
  const designExactSha = displayContext?.designExactSha ?? review.round.designExactSha;
  if (!designBranch || !designExactSha) return;
  const requiredRef = buildReviewDesignRef(designBranch, designExactSha);
  if (findings.some((finding) => !finding.designRefs.includes(requiredRef))) {
    throw new Error(`Every Review finding must reference the authoritative design commit: ${requiredRef}`);
  }
  const requiredDocumentRefs = preferChineseDesignDocuments(
    displayContext?.designDocuments ?? review.round.designDocuments ?? [],
  ).map((documentPath) => buildReviewDesignDocumentRef(designBranch, designExactSha, documentPath));
  if (
    requiredDocumentRefs.length > 0 &&
    findings.some((finding) => !finding.designRefs.some((value) => requiredDocumentRefs.includes(value)))
  ) {
    throw new Error('Every Review finding must reference at least one configured design document');
  }
  const designDocumentPrefix = `${requiredRef}:`;
  if (
    findings.some((finding) =>
      finding.designRefs.some(
        (value) =>
          value.startsWith(designDocumentPrefix) &&
          !requiredDocumentRefs.some(
            (configuredRef) => value === configuredRef || value.startsWith(`${configuredRef}#`),
          ),
      ),
    )
  ) {
    throw new Error('Review findings may reference only the design documents configured for this feature');
  }
}
