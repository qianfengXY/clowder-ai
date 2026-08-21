import {
  type BacklogItem,
  type BacklogStatus,
  buildProjectReviewHubId,
  buildReviewDesignDocumentRef,
  buildReviewDesignRef,
  type CatId,
  CHATGPT_DESKTOP_DEVELOPMENT_ACTOR,
  DESKTOP_DEVELOPMENT_PROTOCOL_VERSION,
  DESKTOP_DEVELOPMENT_REQUIRED_PILOTS,
  DESKTOP_DEVELOPMENT_REVIEW_ATTEMPT_LIMIT,
  type DesktopDevelopmentDeliveryCycleEntryMode,
  type DesktopDevelopmentPhase,
  type DesktopDevelopmentResumePacket,
  type DesktopDevelopmentWorkflowNode,
  type DesktopReviewConsensusAuthorization,
  type DesktopSessionBinding,
  type FeatureDesignDocumentsView,
  type ManagedWorkConsumerSnapshot,
  type ManagedWorkLifecycle,
  normalizeGitHubRepository,
  type ProjectDesignAuthorityView,
  type PublicDesktopDevelopmentProject,
  type ReviewRoundSafeView,
  toPublicDesktopDevelopmentProject,
  type WorkspaceBinding,
} from '@cat-cafe/shared';
import type { IBacklogStore } from '../cats/services/stores/ports/BacklogStore.js';
import type { IManagedWorkConsumerPort } from '../cats/services/stores/ports/ManagedWorkConsumerPort.js';
import type { IWorkflowSopStore } from '../cats/services/stores/ports/WorkflowSopStore.js';
import { VersionConflictError } from '../cats/services/stores/ports/WorkflowSopStore.js';
import type { ExternalProjectStore } from '../projects/external-project-store.js';
import type { ProjectReviewHubService } from '../projects/project-review-hub-service.js';
import type { IReviewRoundStore } from '../review-coordination/ReviewRoundStore.js';
import { buildReviewCompletionObjective, type DesktopTaskLauncher } from './codex-desktop-task-launcher.js';
import {
  type DesignBranchResolver,
  type DesignDocumentsResolver,
  normalizeDesignDocuments,
  preferChineseDesignDocuments,
  type ResolvedDesignAuthority,
  type ResolvedDesignBranch,
  resolveDesignBranch,
  resolveDesignDocuments,
} from './design-branch-resolver.js';
import type { DesktopSessionStore } from './desktop-session-store.js';
import {
  currentDeliveryCycleEvidence,
  currentDeliveryCycleReview,
  currentDeliveryCycleSnapshot,
  deliveryCycleAttemptNumber,
  deliveryCycleEntryMode,
  deliveryCycleNumber,
} from './managed-work-delivery-cycle.js';
import { canContinueReviewLoop, deriveReviewLoopGate } from './review-loop-policy.js';
import { featureTitleForReview } from './review-round-display-context.js';
import type { IReviewRoundStageDispatcher } from './review-round-stage-dispatcher.js';
import { verifyWorkspacePath, type WorkspacePathVerifier } from './workspace-path-verifier.js';

const CONSUMER_ID = 'f289_desktop_development_loop' as const;

export interface ConnectDesktopWorkInput {
  readonly protocolVersion: number;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly runtimeSessionId: string;
  readonly chatRef?: string;
  readonly expectedBindingEpoch: number;
  readonly expectedManagedWorkVersion: number;
  readonly idempotencyKey: string;
  readonly workspace: WorkspaceBinding;
  readonly now?: number;
}

export interface HeartbeatDesktopWorkInput {
  readonly protocolVersion: number;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly runtimeSessionId: string;
  readonly bindingEpoch: number;
  readonly expectedSessionVersion: number;
  readonly idempotencyKey: string;
  readonly workspace?: WorkspaceBinding;
  readonly now?: number;
}

export interface ReportDesktopImplementationInput {
  readonly protocolVersion: number;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly runtimeSessionId: string;
  readonly bindingEpoch: number;
  readonly expectedManagedWorkVersion: number;
  readonly exactSha: string;
  readonly idempotencyKey: string;
  readonly recorderCatId?: CatId;
  readonly now?: number;
}

export interface ConfirmDesktopMergeInput {
  readonly protocolVersion: number;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly runtimeSessionId: string;
  readonly bindingEpoch: number;
  readonly expectedManagedWorkVersion: number;
  readonly exactSha: string;
  readonly idempotencyKey: string;
  readonly now?: number;
}

export interface ReportDesktopMergedInput extends ConfirmDesktopMergeInput {
  readonly mergeCommitSha: string;
}

export interface RecordDesktopAcceptanceInput {
  readonly protocolVersion: number;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly expectedManagedWorkVersion: number;
  readonly exactSha: string;
  readonly accepted: boolean;
  readonly idempotencyKey: string;
  readonly now?: number;
}

export interface ApproveReviewContinuationInput {
  readonly protocolVersion: number;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly expectedManagedWorkVersion: number;
  readonly idempotencyKey: string;
  readonly now?: number;
}

export interface RecordArchitectureDecisionInput extends ApproveReviewContinuationInput {
  readonly findingId: string;
  readonly decision: 'keep_original_plan' | 'approve_plan_change';
}

export interface AuthorizeReviewConsensusInput extends ApproveReviewContinuationInput {
  readonly reviewRoundId: string;
  readonly instruction: string;
}

export interface RetryDesktopDevelopmentStageInput extends ApproveReviewContinuationInput {}

export interface RetryDesktopDevelopmentStageResult {
  readonly work: DesktopDevelopmentResumePacket;
  readonly action: 'wake_desktop' | 'replay_review_stage';
  readonly target: string;
}

export interface ReadDesktopWorkInput {
  readonly protocolVersion: number;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly now?: number;
}

export interface DesktopProjectReadResult {
  readonly project: PublicDesktopDevelopmentProject;
  readonly reviewHubId: string;
  readonly managedWorkDiscovery: {
    readonly status: 'available';
    readonly works: readonly DesktopManagedWorkCandidate[];
  };
}

export interface DesktopManagedWorkCandidate {
  readonly backlogItemId: string;
  readonly title: string;
  readonly backlogStatus: BacklogStatus;
  readonly workId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly lifecycle: ManagedWorkLifecycle;
  readonly managedWorkVersion: number;
  readonly connected: boolean;
  readonly sessionStatus: DesktopSessionBinding['status'] | 'stale_attempt' | null;
}

export type DesktopDevelopmentLaunchStatus =
  | 'available'
  | 'ready_for_desktop'
  | 'connected_to_desktop'
  | 'managed_by_catcafe'
  | 'rejected'
  | 'completed';

export interface DesktopDevelopmentLaunchState {
  readonly backlogItemId: string;
  readonly featureId: string;
  readonly title: string;
  readonly status: DesktopDevelopmentLaunchStatus;
  readonly managedWork?: {
    readonly workId: string;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly deliveryCycleNumber: number;
    readonly deliveryCycleEntryMode: DesktopDevelopmentDeliveryCycleEntryMode;
    readonly lifecycle: ManagedWorkLifecycle;
  };
  readonly deliveryCycleStarted?: boolean;
  readonly previousLifecycle?: 'accepted' | 'rejected';
  readonly desktopBinding?: {
    readonly chatRef?: string;
    readonly bindingEpoch: number;
    readonly status: DesktopSessionBinding['status'];
  };
  readonly desktopTask?:
    | { readonly status: 'created'; readonly threadId: string }
    | { readonly status: 'failed'; readonly error: string };
}

interface ProjectFeatureDesignAuthorityView {
  readonly branch: string | null;
  readonly exactSha: string | null;
  readonly documents: readonly string[];
  readonly status: 'missing' | 'ready';
  readonly error?: string;
}

function terminalLaunchStatus(lifecycle: ManagedWorkLifecycle): 'completed' | 'rejected' | null {
  if (lifecycle === 'accepted') return 'completed';
  if (lifecycle === 'rejected') return 'rejected';
  return null;
}

function featureIdForItem(item: BacklogItem): string | null {
  const featureId = item.tags
    .find((tag) => tag.toLowerCase().startsWith('feature:'))
    ?.slice('feature:'.length)
    .trim()
    .toUpperCase();
  return featureId || null;
}

export class DesktopDevelopmentLoopService {
  constructor(
    private readonly externalProjects: ExternalProjectStore,
    private readonly reviewHubs: ProjectReviewHubService,
    private readonly sessions: DesktopSessionStore,
    private readonly managedWork: IManagedWorkConsumerPort,
    private readonly reviewRounds: IReviewRoundStore,
    private readonly reviewDispatcher: IReviewRoundStageDispatcher,
    private readonly backlogStore: Pick<IBacklogStore, 'listByUser' | 'tryAcquireDispatchLock' | 'releaseDispatchLock'>,
    private readonly workflowSopStore: Pick<IWorkflowSopStore, 'get' | 'getManagedWorkAdmission' | 'upsert'>,
    private readonly desktopTaskLauncher?: DesktopTaskLauncher,
    private readonly workspacePathVerifier: WorkspacePathVerifier = verifyWorkspacePath,
    private readonly designBranchResolver: DesignBranchResolver = resolveDesignBranch,
    private readonly designDocumentsResolver: DesignDocumentsResolver = resolveDesignDocuments,
  ) {}

  async readProjectDesignAuthority(input: {
    protocolVersion: number;
    ownerUserId: string;
    projectId: string;
  }): Promise<{
    readonly authority: ProjectDesignAuthorityView;
    readonly features: readonly FeatureDesignDocumentsView[];
  }> {
    this.assertProtocol(input.protocolVersion);
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const items = (await this.backlogStore.listByUser(input.ownerUserId)).filter(
      (item) => item.projectId === input.projectId && featureIdForItem(item) !== null,
    );
    const [configuredBranch, documentsByFeature] = await Promise.all([
      this.externalProjects.getProjectDesignBranch(input.projectId),
      this.externalProjects.getFeatureDesignDocuments(input.projectId),
    ]);
    const authority = await this.projectDesignAuthorityView(project, configuredBranch);
    const features = await Promise.all(
      items.map((item) => this.featureDesignDocumentsView(project, item, documentsByFeature[item.id] ?? [], authority)),
    );
    return { authority, features };
  }

  async updateProjectDesignBranch(input: {
    protocolVersion: number;
    ownerUserId: string;
    projectId: string;
    branch: string;
  }): Promise<ProjectDesignAuthorityView> {
    this.assertProtocol(input.protocolVersion);
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const branch = input.branch.trim();
    const resolved = await this.designBranchResolver({
      sourcePath: project.sourcePath,
      repository: project.desktopDevelopment.repository,
      branch,
    });
    await this.externalProjects.setProjectDesignBranch(input.projectId, resolved.branch);
    return this.readyProjectDesignAuthorityView(input.projectId, resolved);
  }

  async updateFeatureDesignDocuments(input: {
    protocolVersion: number;
    ownerUserId: string;
    projectId: string;
    backlogItemId: string;
    documents: readonly string[];
  }): Promise<FeatureDesignDocumentsView> {
    this.assertProtocol(input.protocolVersion);
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const item = (await this.backlogStore.listByUser(input.ownerUserId)).find(
      (candidate) => candidate.id === input.backlogItemId && candidate.projectId === input.projectId,
    );
    if (!item || !featureIdForItem(item)) throw new Error('Project feature not found');
    const branch = await this.externalProjects.getProjectDesignBranch(input.projectId);
    if (!branch) throw new Error('Project design branch is not configured');
    const resolved = await this.designBranchResolver({
      sourcePath: project.sourcePath,
      repository: project.desktopDevelopment.repository,
      branch,
    });
    const documents = await this.designDocumentsResolver(project.sourcePath, resolved.exactSha, input.documents);
    await this.externalProjects.setFeatureDesignDocuments(input.projectId, item.id, documents);
    return this.readyFeatureDesignDocumentsView(input.projectId, item, documents);
  }

  async listProjectLaunchStates(input: {
    protocolVersion: number;
    ownerUserId: string;
    projectId: string;
  }): Promise<readonly DesktopDevelopmentLaunchState[]> {
    this.assertProtocol(input.protocolVersion);
    await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const items = (await this.backlogStore.listByUser(input.ownerUserId)).filter(
      (item) => item.projectId === input.projectId && featureIdForItem(item) !== null,
    );
    return Promise.all(items.map((item) => this.classifyProjectLaunchState(input.ownerUserId, input.projectId, item)));
  }

  async startProjectWork(input: {
    protocolVersion: number;
    ownerUserId: string;
    projectId: string;
    backlogItemId: string;
  }): Promise<DesktopDevelopmentLaunchState> {
    this.assertProtocol(input.protocolVersion);
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const item = (await this.backlogStore.listByUser(input.ownerUserId)).find(
      (candidate) => candidate.id === input.backlogItemId && candidate.projectId === input.projectId,
    );
    if (!item) throw new Error('Project backlog item not found');

    const design = await this.requireFeatureDesignAuthority(project, item);

    await Promise.all([
      this.reviewHubs.ensureForFeature(input.projectId, item.id, 'plan', input.ownerUserId),
      this.reviewHubs.ensureForFeature(input.projectId, item.id, 'review', input.ownerUserId),
    ]);

    const lockToken = await this.backlogStore.tryAcquireDispatchLock?.(item.id);
    if (lockToken === false) throw new Error('Project backlog item launch is already in progress');
    try {
      const state = await this.startProjectWorkLocked(input.ownerUserId, input.projectId, item, design);
      if (state.status !== 'ready_for_desktop' || !this.desktopTaskLauncher) return state;
      try {
        const launchInput = {
          projectId: project.id,
          projectName: project.name,
          repository: project.desktopDevelopment.repository.fullName,
          sourcePath: project.sourcePath,
          backlogItemId: item.id,
          featureId: state.featureId,
          title: item.title,
          designBranch: design.branch,
          designExactSha: design.exactSha,
          designDocuments: design.documents,
        } as const;
        const desktopTask =
          state.deliveryCycleStarted &&
          state.previousLifecycle &&
          state.managedWork &&
          this.desktopTaskLauncher.resumeDeliveryCycle
            ? await this.desktopTaskLauncher.resumeDeliveryCycle({
                ...launchInput,
                workId: state.managedWork.workId,
                attemptId: state.managedWork.attemptId,
                attemptNumber: state.managedWork.attemptNumber,
                deliveryCycleNumber: state.managedWork.deliveryCycleNumber,
                previousLifecycle: state.previousLifecycle,
              })
            : await this.desktopTaskLauncher.launch(launchInput);
        return { ...state, desktopTask };
      } catch (error) {
        return {
          ...state,
          desktopTask: {
            status: 'failed',
            error: error instanceof Error ? error.message : 'Desktop task launch failed',
          },
        };
      }
    } finally {
      if (typeof lockToken === 'string') await this.backlogStore.releaseDispatchLock?.(item.id, lockToken);
    }
  }

  private async startProjectWorkLocked(
    ownerUserId: string,
    projectId: string,
    item: BacklogItem,
    design: ResolvedDesignAuthority,
  ): Promise<DesktopDevelopmentLaunchState> {
    const current = await this.classifyProjectLaunchState(ownerUserId, projectId, item);
    if (current.status === 'ready_for_desktop') {
      return this.reserveProjectWorkForDesktop(ownerUserId, projectId, item);
    }
    if (current.status === 'completed' || current.status === 'rejected') {
      if (!current.managedWork) throw new Error('Terminal managed work is unavailable');
      const previousLifecycle = current.managedWork.lifecycle as 'accepted' | 'rejected';
      let snapshot = await this.managedWork.read({
        consumerId: CONSUMER_ID,
        ownerUserId,
        workId: current.managedWork.workId,
        attemptId: current.managedWork.attemptId,
      });
      if (snapshot.state.currentAttemptId !== snapshot.attempt.attemptId) {
        snapshot = await this.managedWork.read({
          consumerId: CONSUMER_ID,
          ownerUserId,
          workId: snapshot.state.workId,
          attemptId: snapshot.state.currentAttemptId,
        });
      }
      if (!snapshot.state.terminalExactSha) throw new Error('Terminal managed work is missing its exact SHA');
      await this.managedWork.startNextDeliveryCycle({
        consumerId: CONSUMER_ID,
        ownerUserId,
        workId: snapshot.state.workId,
        fromAttemptId: snapshot.attempt.attemptId,
        executor: { kind: 'external_actor', actorId: CHATGPT_DESKTOP_DEVELOPMENT_ACTOR },
        expectedVersion: snapshot.state.version,
        terminalExactSha: snapshot.state.terminalExactSha,
        designBranch: design.branch,
        designExactSha: design.exactSha,
        designDocuments: design.documents,
        idempotencyKey: `desktop-delivery-cycle:${item.id}:${snapshot.state.version}`,
      });
      const reopened = await this.classifyProjectLaunchState(ownerUserId, projectId, item);
      return { ...reopened, deliveryCycleStarted: true, previousLifecycle };
    }
    if (current.status !== 'available') return current;

    try {
      await this.workflowSopStore.upsert(
        item.id,
        current.featureId,
        {
          sopDefinitionId: 'development',
          stage: 'kickoff',
          batonHolder: CHATGPT_DESKTOP_DEVELOPMENT_ACTOR,
          resumeCapsule: {
            goal: item.title,
            currentFocus: '等待 ChatGPT Desktop 连接并开始实现',
          },
          expectedVersion: 0,
        },
        ownerUserId,
        ownerUserId,
      );
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
    }

    return this.reserveProjectWorkForDesktop(ownerUserId, projectId, item);
  }

  private async reserveProjectWorkForDesktop(
    ownerUserId: string,
    projectId: string,
    item: BacklogItem,
  ): Promise<DesktopDevelopmentLaunchState> {
    const bundle = await this.workflowSopStore.getManagedWorkAdmission(ownerUserId, item.id);
    if (!bundle) return this.classifyProjectLaunchState(ownerUserId, projectId, item);
    const identity = {
      consumerId: CONSUMER_ID,
      ownerUserId,
      workId: bundle.admission.workId,
      attemptId: bundle.attempt.attemptId,
    } as const;
    const snapshot = await this.managedWork.read(identity);
    if (
      snapshot.state.lifecycle === 'active' &&
      snapshot.state.currentAttemptId === snapshot.attempt.attemptId &&
      !snapshot.attempt.executorActor &&
      !snapshot.attempt.executorCatId
    ) {
      try {
        await this.managedWork.claimAttempt({
          ...identity,
          executor: { kind: 'external_actor', actorId: CHATGPT_DESKTOP_DEVELOPMENT_ACTOR },
          expectedVersion: snapshot.state.version,
          idempotencyKey: `desktop-launch:${item.id}:claim`,
        });
      } catch (error) {
        const canonical = await this.classifyProjectLaunchState(ownerUserId, projectId, item);
        if (canonical.status === 'ready_for_desktop' || canonical.status === 'connected_to_desktop') return canonical;
        if (canonical.status === 'managed_by_catcafe') return canonical;
        throw error;
      }
    }
    return this.classifyProjectLaunchState(ownerUserId, projectId, item);
  }

  private async classifyProjectLaunchState(
    ownerUserId: string,
    projectId: string,
    item: BacklogItem,
  ): Promise<DesktopDevelopmentLaunchState> {
    const featureId = featureIdForItem(item);
    if (!featureId) throw new Error('Project backlog item is missing a feature tag');

    const base = { backlogItemId: item.id, featureId, title: item.title } as const;
    const sop = await this.workflowSopStore.get(item.id);
    // Imported Backlog/document status is historical planning metadata. A
    // Desktop feature has not started until it owns a Workflow SOP, and it is
    // not complete until its managed work reaches user-accepted lifecycle.
    if (!sop) {
      return {
        ...base,
        status: item.status === 'open' || item.status === 'done' ? 'available' : 'managed_by_catcafe',
      };
    }

    const bundle = await this.workflowSopStore.getManagedWorkAdmission(ownerUserId, item.id);
    if (!bundle) {
      return { ...base, status: 'managed_by_catcafe' };
    }
    let snapshot = await this.managedWork.read({
      consumerId: CONSUMER_ID,
      ownerUserId,
      workId: bundle.admission.workId,
      attemptId: bundle.attempt.attemptId,
    });
    if (snapshot.state.currentAttemptId !== snapshot.attempt.attemptId) {
      snapshot = await this.managedWork.read({
        consumerId: CONSUMER_ID,
        ownerUserId,
        workId: bundle.admission.workId,
        attemptId: snapshot.state.currentAttemptId,
      });
    }
    const session = await this.sessions.getCurrent(projectId, snapshot.admission.workId);
    const sessionMatchesAttempt = session?.attemptId === snapshot.attempt.attemptId;
    const deliveryCycleStart = currentDeliveryCycleEvidence(snapshot).find(
      (evidence) => evidence.kind === 'delivery_cycle_started' && evidence.newAttemptId === snapshot.attempt.attemptId,
    );
    const workContext = {
      managedWork: {
        workId: snapshot.state.workId,
        attemptId: snapshot.attempt.attemptId,
        attemptNumber: deliveryCycleAttemptNumber(snapshot),
        deliveryCycleNumber: deliveryCycleNumber(snapshot),
        deliveryCycleEntryMode: deliveryCycleEntryMode(snapshot),
        lifecycle: snapshot.state.lifecycle,
      },
      ...(snapshot.state.lifecycle === 'active' && deliveryCycleStart?.kind === 'delivery_cycle_started'
        ? {
            deliveryCycleStarted: true,
            previousLifecycle: deliveryCycleStart.previousLifecycle,
          }
        : {}),
      ...(sessionMatchesAttempt && session
        ? {
            desktopBinding: {
              ...(session.chatRef ? { chatRef: session.chatRef } : {}),
              bindingEpoch: session.bindingEpoch,
              status: session.status,
            },
          }
        : {}),
    } as const;
    const terminalStatus = terminalLaunchStatus(snapshot.state.lifecycle);
    if (terminalStatus) return { ...base, ...workContext, status: terminalStatus };

    const executor = snapshot.attempt.executorActor;
    if (executor?.kind === 'external_actor' && executor.actorId === CHATGPT_DESKTOP_DEVELOPMENT_ACTOR) {
      const desktopTask = await this.desktopTaskLauncher?.get(projectId, item.id);
      return {
        ...base,
        ...workContext,
        status: sessionMatchesAttempt && session.status === 'active' ? 'connected_to_desktop' : 'ready_for_desktop',
        ...(desktopTask ? { desktopTask } : {}),
      };
    }
    if (executor?.kind === 'cat' || snapshot.attempt.executorCatId) {
      return { ...base, ...workContext, status: 'managed_by_catcafe' };
    }
    return {
      ...base,
      ...workContext,
      status: sop.batonHolder === CHATGPT_DESKTOP_DEVELOPMENT_ACTOR ? 'ready_for_desktop' : 'managed_by_catcafe',
      ...(sop.batonHolder === CHATGPT_DESKTOP_DEVELOPMENT_ACTOR && this.desktopTaskLauncher
        ? { desktopTask: (await this.desktopTaskLauncher.get(projectId, item.id)) ?? undefined }
        : {}),
    };
  }

  async readProject(input: {
    protocolVersion: number;
    ownerUserId: string;
    projectId: string;
    now?: number;
  }): Promise<DesktopProjectReadResult> {
    this.assertProtocol(input.protocolVersion);
    const project = await this.requireProject(input.projectId, input.ownerUserId);
    const managedWorks = await this.discoverManagedWorks(input.ownerUserId, project.id, input.now ?? Date.now());
    return {
      project: toPublicDesktopDevelopmentProject({
        projectId: project.id,
        sourcePath: project.sourcePath,
        binding: project.desktopDevelopment ?? null,
      }),
      reviewHubId: buildProjectReviewHubId(project.id),
      managedWorkDiscovery: { status: 'available', works: managedWorks },
    };
  }

  async readProjectByRepository(input: {
    protocolVersion: number;
    ownerUserId: string;
    repository: string;
    now?: number;
  }): Promise<DesktopProjectReadResult> {
    this.assertProtocol(input.protocolVersion);
    const repository = normalizeGitHubRepository(input.repository).fullName.toLowerCase();
    const matches = (await this.externalProjects.listByUser(input.ownerUserId)).filter(
      (project) => project.desktopDevelopment?.repository.fullName.toLowerCase() === repository,
    );
    if (matches.length === 0) throw new Error('Project not found');
    if (matches.length > 1) {
      throw new Error('Repository is bound to multiple Cat Cafe projects; use the exact projectId');
    }
    const project = matches[0];
    if (!project) throw new Error('Project not found');
    return this.readProject({ ...input, projectId: project.id });
  }

  private async discoverManagedWorks(
    ownerUserId: string,
    projectId: string,
    now = Date.now(),
  ): Promise<readonly DesktopManagedWorkCandidate[]> {
    const [items, sessions] = await Promise.all([
      this.backlogStore.listByUser(ownerUserId),
      this.sessions.listCurrentByProject(projectId, now),
    ]);
    const sessionsByWorkId = new Map(sessions.map((session) => [session.workId, session]));
    const candidates = await Promise.all(
      items
        .filter((item) => item.projectId === projectId)
        .map(async (item): Promise<DesktopManagedWorkCandidate | null> => {
          const bundle = await this.workflowSopStore.getManagedWorkAdmission(ownerUserId, item.id);
          if (!bundle) return null;
          let snapshot = await this.managedWork.read({
            consumerId: CONSUMER_ID,
            ownerUserId,
            workId: bundle.admission.workId,
            attemptId: bundle.attempt.attemptId,
          });
          if (snapshot.state.currentAttemptId !== snapshot.attempt.attemptId) {
            snapshot = await this.managedWork.read({
              consumerId: CONSUMER_ID,
              ownerUserId,
              workId: bundle.admission.workId,
              attemptId: snapshot.state.currentAttemptId,
            });
          }
          const session = sessionsByWorkId.get(bundle.admission.workId);
          const sessionMatchesAttempt = session?.attemptId === snapshot.attempt.attemptId;
          return {
            backlogItemId: item.id,
            title: item.title,
            backlogStatus: item.status,
            workId: bundle.admission.workId,
            attemptId: snapshot.attempt.attemptId,
            attemptNumber: deliveryCycleAttemptNumber(snapshot),
            lifecycle: snapshot.state.lifecycle,
            managedWorkVersion: snapshot.state.version,
            connected: sessionMatchesAttempt,
            sessionStatus: session ? (sessionMatchesAttempt ? session.status : 'stale_attempt') : null,
          };
        }),
    );
    return candidates
      .filter((candidate): candidate is DesktopManagedWorkCandidate => candidate !== null)
      .sort((left, right) => left.backlogItemId.localeCompare(right.backlogItemId));
  }

  async connect(input: ConnectDesktopWorkInput): Promise<DesktopDevelopmentResumePacket> {
    this.assertProtocol(input.protocolVersion);
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    await this.assertWorkspaceBinding(project, input.workspace);

    const identity = this.managedIdentity(input);
    let snapshot = currentDeliveryCycleSnapshot(await this.managedWork.read(identity));
    const review = await this.reviewRounds.readCurrentSafe({
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      workId: input.workId,
    });
    const startsFixAttempt =
      review?.round.phase === 'complete' &&
      review.round.attemptId === input.attemptId &&
      review.currentForWork &&
      review.consensus?.verdict === 'changes_requested';
    if (startsFixAttempt) {
      const gate = deriveReviewLoopGate({
        attemptNumber: deliveryCycleAttemptNumber(snapshot),
        exactSha: review.round.exactSha,
        findings: review.findings,
        evidence: currentDeliveryCycleEvidence(snapshot),
      });
      if (!canContinueReviewLoop(gate)) {
        throw new Error(
          gate.architectureDecisionPending
            ? 'Review is awaiting a user architecture decision in Cat Cafe'
            : 'Review reached its 15-attempt limit and is awaiting user continuation approval in Cat Cafe',
        );
      }
      snapshot = await this.managedWork.createNextAttempt({
        consumerId: CONSUMER_ID,
        ownerUserId: input.ownerUserId,
        workId: input.workId,
        fromAttemptId: input.attemptId,
        executor: { kind: 'external_actor', actorId: CHATGPT_DESKTOP_DEVELOPMENT_ACTOR },
        expectedVersion: input.expectedManagedWorkVersion,
        idempotencyKey: `${input.idempotencyKey}:next-attempt`,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    } else if (snapshot.state.currentAttemptId !== snapshot.attempt.attemptId) {
      throw new Error(`Managed-work stale attempt: current ${snapshot.state.currentAttemptId}`);
    } else if (!snapshot.attempt.executorActor && !snapshot.attempt.executorCatId) {
      snapshot = await this.managedWork.claimAttempt({
        ...identity,
        executor: { kind: 'external_actor', actorId: CHATGPT_DESKTOP_DEVELOPMENT_ACTOR },
        expectedVersion: input.expectedManagedWorkVersion,
        idempotencyKey: `${input.idempotencyKey}:claim`,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    } else if (
      snapshot.attempt.executorActor?.kind !== 'external_actor' ||
      snapshot.attempt.executorActor.actorId !== CHATGPT_DESKTOP_DEVELOPMENT_ACTOR
    ) {
      throw new Error('Managed-work attempt belongs to another executor');
    }

    await this.sessions.bind({
      projectId: input.projectId,
      workId: input.workId,
      attemptId: snapshot.attempt.attemptId,
      runtimeSessionId: input.runtimeSessionId,
      ...(input.chatRef ? { chatRef: input.chatRef } : {}),
      expectedEpoch: input.expectedBindingEpoch,
      idempotencyKey: `${input.idempotencyKey}:session`,
      workspace: input.workspace,
      ...(input.now === undefined ? {} : { now: input.now }),
    });

    return this.readWork({
      protocolVersion: input.protocolVersion,
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      workId: input.workId,
      attemptId: snapshot.attempt.attemptId,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }

  async listProjectWorks(input: {
    protocolVersion: number;
    ownerUserId: string;
    projectId: string;
    now?: number;
  }): Promise<readonly DesktopDevelopmentResumePacket[]> {
    this.assertProtocol(input.protocolVersion);
    await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const now = input.now ?? Date.now();
    const sessions = await this.sessions.listCurrentByProject(input.projectId, now);
    return Promise.all(
      sessions.map((session) =>
        this.readWork({
          protocolVersion: input.protocolVersion,
          ownerUserId: input.ownerUserId,
          projectId: input.projectId,
          workId: session.workId,
          attemptId: session.attemptId,
          now,
        }),
      ),
    );
  }

  async heartbeat(input: HeartbeatDesktopWorkInput): Promise<DesktopDevelopmentResumePacket> {
    this.assertProtocol(input.protocolVersion);
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    if (input.workspace) await this.assertWorkspaceBinding(project, input.workspace);
    const session = await this.assertCurrentSession(input, input.now ?? Date.now(), false);
    await this.assertWorkspaceBinding(project, session.workspace);
    await this.sessions.heartbeat({
      projectId: input.projectId,
      workId: input.workId,
      bindingEpoch: input.bindingEpoch,
      runtimeSessionId: input.runtimeSessionId,
      expectedVersion: input.expectedSessionVersion,
      idempotencyKey: input.idempotencyKey,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return this.readWork(input);
  }

  async reportImplementation(input: ReportDesktopImplementationInput): Promise<DesktopDevelopmentResumePacket> {
    this.assertProtocol(input.protocolVersion);
    const now = input.now ?? Date.now();
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const session = await this.assertCurrentSession(input, now, true);
    await this.assertWorkspaceBinding(project, session.workspace);
    if (!session.workspace.worktreePresent) {
      throw new Error('Permanent worktree is missing; rebuild it from the last committed SHA before reporting');
    }
    const exactSha = input.exactSha.toLowerCase();
    if (session.workspace.currentSha !== exactSha || session.workspace.lastCommittedSha !== exactSha) {
      throw new Error('Implementation SHA must equal the current committed workspace SHA');
    }

    const managedBeforeReport = await this.managedWork.read(this.managedIdentity(input));
    const backlogItem = (await this.backlogStore.listByUser(input.ownerUserId)).find(
      (candidate) =>
        candidate.id === managedBeforeReport.admission.producerRef && candidate.projectId === input.projectId,
    );
    if (!backlogItem) throw new Error('Review display context backlog item is unavailable');
    const featureId = featureIdForItem(backlogItem);
    if (!featureId) throw new Error('Review display context feature id is unavailable');
    const design = await this.requireFeatureDesignAuthority(project, backlogItem);

    const evidence = await this.managedWork.appendEvidence({
      ...this.managedIdentity(input),
      expectedVersion: input.expectedManagedWorkVersion,
      idempotencyKey: `${input.idempotencyKey}:implementation`,
      evidence: { kind: 'implementation_committed', exactSha },
      now,
    });
    const recorderCatId =
      input.recorderCatId ??
      project.desktopDevelopment.defaultReviewRecorder ??
      project.desktopDevelopment.defaultReviewers[0];
    if (!recorderCatId) throw new Error('Review recorder is unavailable');
    const managed = await this.managedWork.read(this.managedIdentity(input));
    const [, reviewHub] = await Promise.all([
      this.reviewHubs.ensureForFeature(input.projectId, managed.admission.producerRef, 'plan', input.ownerUserId),
      this.reviewHubs.ensureForFeature(input.projectId, managed.admission.producerRef, 'review', input.ownerUserId),
    ]);
    const round = await this.reviewRounds.createRound({
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      workId: input.workId,
      attemptId: input.attemptId,
      exactSha,
      designBranch: design.branch,
      designExactSha: design.exactSha,
      designDocuments: design.documents,
      author: { kind: 'external_actor', actorId: CHATGPT_DESKTOP_DEVELOPMENT_ACTOR },
      reviewerCatIds: project.desktopDevelopment.defaultReviewers,
      recorderCatId,
      reviewThreadId: reviewHub.threadId,
      idempotencyKey: `${input.idempotencyKey}:round`,
      now,
    });
    await this.reviewDispatcher.dispatch({
      stage: 'independent',
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      reviewHubThreadId: reviewHub.threadId,
      roundId: round.roundId,
      exactSha: round.exactSha,
      reviewerCatIds: round.reviewerCatIds,
      allReviewerCatIds: round.reviewerCatIds,
      completedReviewerCatIds: [],
      recorderCatId: round.recorderCatId,
      displayContext: {
        projectName: project.name,
        repository: project.desktopDevelopment.repository.fullName,
        backlogItemId: backlogItem.id,
        featureId,
        featureTitle: featureTitleForReview(featureId, backlogItem.title),
        attemptNumber: deliveryCycleAttemptNumber(managed),
        designBranch: design.branch,
        designExactSha: design.exactSha,
        designDocuments: design.documents,
      },
    });

    if (session.chatRef) {
      await this.desktopTaskLauncher?.pause({
        threadId: session.chatRef,
        sourcePath: session.workspace.worktreePath,
      });
    }

    return this.readWork(
      {
        protocolVersion: input.protocolVersion,
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        workId: input.workId,
        attemptId: input.attemptId,
        now,
      },
      evidence.state.version,
    );
  }

  async confirmMerge(input: ConfirmDesktopMergeInput): Promise<DesktopDevelopmentResumePacket> {
    this.assertProtocol(input.protocolVersion);
    const now = input.now ?? Date.now();
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const session = await this.assertCurrentSession(input, now, true);
    await this.assertWorkspaceBinding(project, session.workspace);
    const exactSha = input.exactSha.toLowerCase();
    this.assertSessionImplementationSha(session, exactSha);
    const identity = this.managedIdentity(input);
    const [managed, review] = await Promise.all([
      this.managedWork.read(identity),
      this.reviewRounds.readCurrentSafe({
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        workId: input.workId,
      }),
    ]);
    this.assertApprovedGreenReview(exactSha, managed, review);
    const existing = currentDeliveryCycleEvidence(managed).find(
      (evidence) =>
        evidence.kind === 'merge_confirmed' &&
        evidence.exactSha === exactSha &&
        evidence.bindingEpoch === session.bindingEpoch,
    );
    if (existing) return this.readWork(input, managed.state.version);

    const appended = await this.managedWork.appendEvidence({
      ...identity,
      expectedVersion: input.expectedManagedWorkVersion,
      idempotencyKey: `${input.idempotencyKey}:merge-confirmation`,
      evidence: {
        kind: 'merge_confirmed',
        exactSha,
        bindingEpoch: session.bindingEpoch,
        confirmedByUserId: input.ownerUserId,
      },
      now,
    });
    return this.readWork(input, appended.state.version);
  }

  async reportMerged(input: ReportDesktopMergedInput): Promise<DesktopDevelopmentResumePacket> {
    this.assertProtocol(input.protocolVersion);
    const now = input.now ?? Date.now();
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const session = await this.assertCurrentSession(input, now, true);
    await this.assertWorkspaceBinding(project, session.workspace);
    const exactSha = input.exactSha.toLowerCase();
    const mergeCommitSha = input.mergeCommitSha.toLowerCase();
    this.assertSessionImplementationSha(session, exactSha);
    const identity = this.managedIdentity(input);
    const [managed, review] = await Promise.all([
      this.managedWork.read(identity),
      this.reviewRounds.readCurrentSafe({
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        workId: input.workId,
      }),
    ]);
    this.assertApprovedGreenReview(exactSha, managed, review);

    const existing = currentDeliveryCycleEvidence(managed).find(
      (evidence) => evidence.kind === 'merged' && evidence.exactSha === exactSha,
    );
    if (existing?.kind === 'merged') {
      if (existing.mergeCommitSha !== mergeCommitSha) {
        throw new Error('Merge receipt conflicts with the existing merge commit SHA');
      }
      return this.readWork(input, managed.state.version);
    }

    if (project.desktopDevelopment.mergeMode !== 'automatic') {
      const currentConfirmation = currentDeliveryCycleEvidence(managed).some(
        (evidence) =>
          evidence.kind === 'merge_confirmed' &&
          evidence.exactSha === exactSha &&
          evidence.bindingEpoch === session.bindingEpoch &&
          evidence.confirmedByUserId === input.ownerUserId,
      );
      if (!currentConfirmation) {
        throw new Error('Manual merge requires confirmation from the current ChatGPT binding');
      }
    }

    const appended = await this.managedWork.appendEvidence({
      ...identity,
      expectedVersion: input.expectedManagedWorkVersion,
      idempotencyKey: `${input.idempotencyKey}:merged`,
      evidence: { kind: 'merged', exactSha, mergeCommitSha },
      now,
    });
    return this.readWork(input, appended.state.version);
  }

  async recordAcceptance(input: RecordDesktopAcceptanceInput): Promise<DesktopDevelopmentResumePacket> {
    this.assertProtocol(input.protocolVersion);
    const now = input.now ?? Date.now();
    await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const exactSha = input.exactSha.toLowerCase();
    const identity = this.managedIdentity(input);
    const managed = await this.managedWork.read(identity);
    const review = await this.reviewRounds.readCurrentSafe({
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      workId: input.workId,
    });
    this.assertApprovedGreenReview(exactSha, managed, review);
    if (
      !currentDeliveryCycleEvidence(managed).some(
        (evidence) => evidence.kind === 'merged' && evidence.exactSha === exactSha,
      )
    ) {
      throw new Error('Final acceptance requires a matching merge receipt');
    }

    if (managed.state.lifecycle !== 'active') {
      const expectedLifecycle = input.accepted ? 'accepted' : 'rejected';
      if (managed.state.lifecycle !== expectedLifecycle || managed.state.terminalExactSha !== exactSha) {
        throw new Error('Final acceptance conflicts with the terminal managed-work state');
      }
      if (input.accepted) await this.externalProjects.recordAcceptedManualPilot(input.projectId, input.workId);
      return this.readWork(input, managed.state.version);
    }

    const acceptance = await this.managedWork.appendEvidence({
      ...identity,
      expectedVersion: input.expectedManagedWorkVersion,
      idempotencyKey: `${input.idempotencyKey}:acceptance`,
      evidence: { kind: 'acceptance_recorded', exactSha, accepted: input.accepted },
      now,
    });
    const terminal = await this.managedWork.transition({
      ...identity,
      target: input.accepted ? 'accepted' : 'rejected',
      exactSha,
      expectedVersion: acceptance.state.version,
      idempotencyKey: `${input.idempotencyKey}:terminal`,
      now,
    });
    if (input.accepted) await this.externalProjects.recordAcceptedManualPilot(input.projectId, input.workId);
    return this.readWork(input, terminal.version);
  }

  async approveReviewContinuation(input: ApproveReviewContinuationInput): Promise<DesktopDevelopmentResumePacket> {
    this.assertProtocol(input.protocolVersion);
    await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const identity = this.managedIdentity(input);
    const [managed, review] = await Promise.all([
      this.managedWork.read(identity),
      this.reviewRounds.readCurrentSafe({
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        workId: input.workId,
      }),
    ]);
    this.assertReviewDecisionTarget(input.attemptId, managed, review);
    const gate = deriveReviewLoopGate({
      attemptNumber: deliveryCycleAttemptNumber(managed),
      exactSha: review.round.exactSha,
      findings: review.findings,
      evidence: currentDeliveryCycleEvidence(managed),
    });
    if (!gate.continuationPending) {
      return this.readWork(input, managed.state.version);
    }
    const approvedThroughAttemptNumber = deliveryCycleAttemptNumber(managed) + DESKTOP_DEVELOPMENT_REVIEW_ATTEMPT_LIMIT;
    const appended = await this.managedWork.appendEvidence({
      ...identity,
      expectedVersion: input.expectedManagedWorkVersion,
      idempotencyKey: `${input.idempotencyKey}:review-continuation`,
      evidence: {
        kind: 'review_continuation_approved',
        exactSha: review.round.exactSha,
        approvedThroughAttemptNumber,
        approvedByUserId: input.ownerUserId,
      },
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    const updated = await this.managedWork.read(identity);
    await this.activateReviewCompletionIfReady(input, updated, review);
    return this.readWork(input, appended.state.version);
  }

  async recordArchitectureDecision(input: RecordArchitectureDecisionInput): Promise<DesktopDevelopmentResumePacket> {
    this.assertProtocol(input.protocolVersion);
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const identity = this.managedIdentity(input);
    const [managed, review] = await Promise.all([
      this.managedWork.read(identity),
      this.reviewRounds.readCurrentSafe({
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        workId: input.workId,
      }),
    ]);
    this.assertReviewDecisionTarget(input.attemptId, managed, review);
    const item = (await this.backlogStore.listByUser(input.ownerUserId)).find(
      (candidate) => candidate.id === managed.admission.producerRef && candidate.projectId === input.projectId,
    );
    if (!item) throw new Error('Development-loop backlog item is unavailable');
    const finding = review.findings.find(
      (candidate) =>
        candidate.findingId === input.findingId &&
        candidate.status === 'open' &&
        candidate.scope === 'architecture_decision',
    );
    if (!finding) throw new Error('Open architecture decision finding not found');
    const existing = currentDeliveryCycleEvidence(managed).find(
      (evidence) =>
        evidence.kind === 'architecture_decision_recorded' &&
        evidence.findingId === input.findingId &&
        evidence.exactSha === review.round.exactSha,
    );
    if (existing?.kind === 'architecture_decision_recorded') {
      if (existing.decision !== input.decision)
        throw new Error('Architecture decision conflicts with the recorded choice');
      return this.readWork(input, managed.state.version);
    }
    const design = await this.requireFeatureDesignAuthority(project, item);
    if (
      input.decision === 'approve_plan_change' &&
      review.round.designExactSha &&
      design.exactSha === review.round.designExactSha
    ) {
      throw new Error('Design branch has not advanced; commit the revised plan before continuing');
    }
    if (
      input.decision === 'keep_original_plan' &&
      review.round.designExactSha &&
      design.exactSha !== review.round.designExactSha
    ) {
      throw new Error(
        'Design branch changed after Review; restore the reviewed plan or choose the updated-plan decision',
      );
    }
    const appended = await this.managedWork.appendEvidence({
      ...identity,
      expectedVersion: input.expectedManagedWorkVersion,
      idempotencyKey: `${input.idempotencyKey}:architecture-decision`,
      evidence: {
        kind: 'architecture_decision_recorded',
        exactSha: review.round.exactSha,
        findingId: input.findingId,
        decision: input.decision,
        decidedByUserId: input.ownerUserId,
        designBranch: design.branch,
        designExactSha: design.exactSha,
      },
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    const updated = await this.managedWork.read(identity);
    await this.activateReviewCompletionIfReady(input, updated, review);
    return this.readWork(input, appended.state.version);
  }

  async authorizeReviewConsensus(input: AuthorizeReviewConsensusInput): Promise<DesktopDevelopmentResumePacket> {
    this.assertProtocol(input.protocolVersion);
    await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const identity = this.managedIdentity(input);
    const now = input.now ?? Date.now();
    const instruction = input.instruction.trim();
    if (!instruction) throw new Error('Review consensus authorization instruction is required');
    const [rawManaged, session, rawReview] = await Promise.all([
      this.managedWork.read(identity),
      this.sessions.getCurrent(input.projectId, input.workId, now),
      this.reviewRounds.readCurrentSafe({
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        workId: input.workId,
      }),
    ]);
    const managed = currentDeliveryCycleSnapshot(rawManaged);
    const review = currentDeliveryCycleReview(managed, rawReview);
    if (managed.state.version !== input.expectedManagedWorkVersion) {
      throw new Error(
        `Managed-work version conflict: expected ${input.expectedManagedWorkVersion}, actual ${managed.state.version}`,
      );
    }
    if (
      managed.state.lifecycle !== 'active' ||
      managed.attempt.attemptId !== input.attemptId ||
      managed.state.currentAttemptId !== input.attemptId ||
      !session ||
      session.attemptId !== input.attemptId ||
      !review ||
      !review.currentForWork ||
      review.round.attemptId !== input.attemptId ||
      review.round.roundId !== input.reviewRoundId ||
      review.round.phase !== 'consensus_ready' ||
      review.round.exactSha !== session.workspace.currentSha
    ) {
      throw new Error('User consensus authorization requires the current consensus-ready Review round and SHA');
    }
    const existing = consensusAuthorizationForReview(managed, review);
    if (existing) {
      if (existing.instruction !== instruction) {
        throw new Error('Review consensus already has a different user authorization');
      }
      return this.readWork(input, managed.state.version);
    }
    const appended = await this.managedWork.appendEvidence({
      ...identity,
      expectedVersion: input.expectedManagedWorkVersion,
      idempotencyKey: `${input.idempotencyKey}:consensus-authorization`,
      evidence: {
        kind: 'review_consensus_authorized',
        exactSha: review.round.exactSha,
        reviewRoundId: review.round.roundId,
        instruction,
        authorizedByUserId: input.ownerUserId,
      },
      now,
    });
    const context = await this.resolveWorkflowDisplayContext(input.ownerUserId, input.projectId, managed);
    await this.reviewDispatcher.dispatch({
      stage: 'consensus',
      ownerUserId: review.round.ownerUserId,
      projectId: review.round.projectId,
      reviewHubThreadId: review.round.reviewThreadId ?? buildProjectReviewHubId(review.round.projectId),
      roundId: review.round.roundId,
      exactSha: review.round.exactSha,
      reviewerCatIds: [review.round.recorderCatId],
      allReviewerCatIds: review.round.reviewerCatIds,
      completedReviewerCatIds: review.round.reviewerCatIds,
      recorderCatId: review.round.recorderCatId,
      displayContext: context,
      managedWorkVersion: appended.state.version,
      consensusAuthorization: {
        instruction,
        authorizedByUserId: input.ownerUserId,
        authorizedAt: now,
      },
      deliveryKey: `user-consensus:${input.idempotencyKey}`,
    });
    return this.readWork(input, appended.state.version);
  }

  async retryCurrentStage(input: RetryDesktopDevelopmentStageInput): Promise<RetryDesktopDevelopmentStageResult> {
    this.assertProtocol(input.protocolVersion);
    const work = await this.readWork(input);
    if (work.attemptId !== input.attemptId) {
      throw new Error(`Managed-work stale attempt: current ${work.attemptId}`);
    }
    if (work.managedWorkVersion !== input.expectedManagedWorkVersion) {
      throw new Error(
        `Managed-work version conflict: expected ${input.expectedManagedWorkVersion}, actual ${work.managedWorkVersion}`,
      );
    }

    if (work.phase === 'independent_review' || work.phase === 'cross_review') {
      const target = await this.replayCurrentReviewStage(input);
      return { work: await this.readWork(input), action: 'replay_review_stage', target };
    }

    if (
      work.phase === 'ready_for_desktop' ||
      work.phase === 'implementing' ||
      work.phase === 'implementation_ready' ||
      work.phase === 'fix_required' ||
      work.phase === 'approved_for_merge' ||
      work.phase === 'awaiting_manual_merge_confirmation' ||
      work.phase === 'auto_merge_ready'
    ) {
      await this.wakeDesktopForCurrentStage(input, work);
      return { work: await this.readWork(input), action: 'wake_desktop', target: 'ChatGPT Desktop 原绑定窗口' };
    }

    if (work.phase === 'awaiting_design_branch') {
      throw new Error('Current stage requires a committed feature design branch; configure it before retrying');
    }
    if (work.phase === 'awaiting_architecture_decision') {
      throw new Error(
        'Current stage requires a design disagreement decision; choose a decision instead of retrying it',
      );
    }
    if (work.phase === 'awaiting_review_continuation') {
      throw new Error('Current stage requires Review continuation approval; approve it instead of retrying it');
    }
    if (work.phase === 'acceptance_pending') {
      throw new Error('Current stage requires final acceptance; record the acceptance decision instead of retrying it');
    }
    throw new Error('Completed or rejected work has no stage to retry');
  }

  async readWork(input: ReadDesktopWorkInput, knownManagedVersion?: number): Promise<DesktopDevelopmentResumePacket> {
    this.assertProtocol(input.protocolVersion);
    const now = input.now ?? Date.now();
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const identity = this.managedIdentity(input);
    const [rawManaged, session, rawReview] = await Promise.all([
      this.managedWork.read(identity),
      this.sessions.getCurrent(input.projectId, input.workId, now),
      this.reviewRounds.readCurrentSafe({
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        workId: input.workId,
      }),
    ]);
    const managed = currentDeliveryCycleSnapshot(rawManaged);
    const review = currentDeliveryCycleReview(managed, rawReview);
    if (!session || session.attemptId !== input.attemptId) {
      throw new Error('Desktop session binding not found for this work attempt');
    }
    const featureItem = (await this.backlogStore.listByUser(input.ownerUserId)).find(
      (candidate) => candidate.id === managed.admission.producerRef && candidate.projectId === input.projectId,
    );
    if (!featureItem) throw new Error('Development-loop backlog item is unavailable');
    const design = await this.projectFeatureDesignAuthorityView(project, featureItem);
    const architectureDecisionIds = new Set(
      managed.evidence.flatMap((evidence) =>
        evidence.kind === 'architecture_decision_recorded' && evidence.exactSha === review?.round.exactSha
          ? [evidence.findingId]
          : [],
      ),
    );
    const designRefs =
      review?.round.designBranch && review.round.designExactSha
        ? buildDesignAuthorityRefs(
            review.round.designBranch,
            review.round.designExactSha,
            preferChineseDesignDocuments(review.round.designDocuments ?? []),
          )
        : design.status === 'ready' && design.branch && design.exactSha
          ? buildDesignAuthorityRefs(design.branch, design.exactSha, design.documents)
          : [];
    const openFindings = (review?.findings ?? [])
      .filter((finding) => finding.status === 'open')
      .map((finding) => ({
        findingId: finding.findingId,
        severity: finding.severity,
        summary: finding.title,
        evidenceRefs: finding.evidence,
        // Historical findings may predate exact design references. Once the
        // feature has a validated design branch, anchor them to its commit;
        // discussion threads are never promoted into implementation authority.
        designRefs: resumeDesignRefs(finding.designRefs, designRefs),
        scope: finding.scope,
        architectureDecisionRecorded: architectureDecisionIds.has(finding.findingId),
        status: 'open' as const,
      }));
    const exactSha = session.workspace.currentSha;
    const reviewGate = deriveReviewLoopGate({
      attemptNumber: deliveryCycleAttemptNumber(managed),
      exactSha: review?.round.exactSha ?? exactSha,
      findings: review?.findings ?? [],
      evidence: managed.evidence,
    });
    const mergeConfirmed = managed.evidence.some(
      (evidence) =>
        evidence.kind === 'merge_confirmed' &&
        evidence.exactSha === exactSha &&
        evidence.bindingEpoch === session.bindingEpoch,
    );
    const merged = managed.evidence.some((evidence) => evidence.kind === 'merged' && evidence.exactSha === exactSha);
    const derived = deriveDesktopDevelopmentState({
      managedLifecycle: managed.state.lifecycle,
      session,
      review,
      managed,
      mergeMode: project.desktopDevelopment.mergeMode,
      designBranchReady: design.status === 'ready',
    });
    const consensusAuthorization = review ? consensusAuthorizationForReview(managed, review) : undefined;
    return {
      protocolVersion: DESKTOP_DEVELOPMENT_PROTOCOL_VERSION,
      projectId: project.id,
      repository: project.desktopDevelopment.repository,
      defaultBranch: project.desktopDevelopment.defaultBranch,
      designBranch: design.branch,
      designExactSha: design.exactSha,
      designDocuments: design.documents,
      reviewDesignExactSha: review?.round.designExactSha ?? null,
      reviewDesignDocuments: preferChineseDesignDocuments(review?.round.designDocuments ?? []),
      workId: managed.state.workId,
      attemptId: managed.attempt.attemptId,
      attemptNumber: deliveryCycleAttemptNumber(managed),
      deliveryCycleNumber: deliveryCycleNumber(managed),
      deliveryCycleEntryMode: deliveryCycleEntryMode(managed),
      phase: derived.phase,
      workLifecycle: managed.state.lifecycle,
      managedWorkVersion: knownManagedVersion ?? managed.state.version,
      bindingEpoch: session.bindingEpoch,
      ...(session.chatRef ? { chatRef: session.chatRef } : {}),
      sessionStatus: session.status,
      sessionVersion: session.version,
      branch: session.workspace.branch,
      currentSha: session.workspace.currentSha,
      lastCommittedSha: session.workspace.lastCommittedSha,
      worktreePresent: session.workspace.worktreePresent,
      mergeMode: project.desktopDevelopment.mergeMode,
      successfulManualPilotCount: project.desktopDevelopment.successfulManualPilotCount,
      autoMergeAvailable: project.desktopDevelopment.successfulManualPilotCount >= DESKTOP_DEVELOPMENT_REQUIRED_PILOTS,
      mergeConfirmed,
      merged,
      acceptancePending: managed.state.lifecycle === 'active' && merged,
      reviewRoundId: review?.round.roundId ?? null,
      reviewPhase: review?.round.phase ?? null,
      reviewRoundVersion: review?.round.version ?? null,
      reviewCurrentForWork: review?.currentForWork ?? false,
      ...(consensusAuthorization ? { consensusAuthorization } : {}),
      openFindings,
      reviewAttemptLimit: DESKTOP_DEVELOPMENT_REVIEW_ATTEMPT_LIMIT,
      reviewContinuationApprovedThroughAttempt: reviewGate.approvedThroughAttempt,
      reviewContinuationPending: derived.phase === 'awaiting_review_continuation',
      architectureDecisionPending: derived.phase === 'awaiting_architecture_decision',
      nextLegalActions: derived.nextLegalActions,
      workflowNodes: deriveWorkflowNodes({ managed, session, review, derived, design }),
    };
  }

  private async replayCurrentReviewStage(input: RetryDesktopDevelopmentStageInput): Promise<string> {
    const [managed, review] = await Promise.all([
      this.managedWork.read(this.managedIdentity(input)),
      this.reviewRounds.readCurrentSafe({
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        workId: input.workId,
      }),
    ]);
    if (!review || !review.currentForWork || review.round.attemptId !== input.attemptId) {
      throw new Error('Current Review round is unavailable for replay');
    }
    if (review.round.phase === 'complete') throw new Error('Completed Review cannot be replayed as an active stage');

    const context = await this.resolveWorkflowDisplayContext(input.ownerUserId, input.projectId, managed);
    const consensusAuthorization = consensusAuthorizationForReview(managed, review);
    const stage = review.round.phase === 'consensus_ready' ? 'consensus' : review.round.phase;
    const completedReviewerCatIds =
      stage === 'independent'
        ? review.round.independentFinishedCatIds
        : stage === 'cross_review'
          ? review.round.crossReviewFinishedCatIds
          : review.round.reviewerCatIds;
    const pendingReviewerCatIds =
      stage === 'consensus'
        ? [review.round.recorderCatId]
        : review.round.reviewerCatIds.filter((catId) => !completedReviewerCatIds.includes(catId));
    if (pendingReviewerCatIds.length === 0)
      throw new Error('Current Review stage has no pending participant to replay');

    await this.reviewDispatcher.dispatch({
      stage,
      ownerUserId: review.round.ownerUserId,
      projectId: review.round.projectId,
      reviewHubThreadId: review.round.reviewThreadId ?? buildProjectReviewHubId(review.round.projectId),
      roundId: review.round.roundId,
      exactSha: review.round.exactSha,
      reviewerCatIds: pendingReviewerCatIds,
      allReviewerCatIds: review.round.reviewerCatIds,
      completedReviewerCatIds,
      recorderCatId: review.round.recorderCatId,
      displayContext: context,
      managedWorkVersion: managed.state.version,
      ...(consensusAuthorization
        ? {
            consensusAuthorization: {
              instruction: consensusAuthorization.instruction,
              authorizedByUserId: consensusAuthorization.authorizedByUserId,
              authorizedAt: consensusAuthorization.authorizedAt,
            },
          }
        : {}),
      deliveryKey: `manual:${input.idempotencyKey}`,
    });
    return stage === 'consensus'
      ? `共识记录者 ${review.round.recorderCatId}`
      : `${pendingReviewerCatIds.length} 位待处理 reviewer`;
  }

  private async wakeDesktopForCurrentStage(
    input: RetryDesktopDevelopmentStageInput,
    work: DesktopDevelopmentResumePacket,
  ): Promise<void> {
    if (!this.desktopTaskLauncher) throw new Error('ChatGPT Desktop task launcher is unavailable');
    const [managed, session, review] = await Promise.all([
      this.managedWork.read(this.managedIdentity(input)),
      this.sessions.getCurrent(input.projectId, input.workId),
      this.reviewRounds.readCurrentSafe({
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        workId: input.workId,
      }),
    ]);
    if (!session?.chatRef || session.attemptId !== input.attemptId) {
      throw new Error('Current work attempt has no bound ChatGPT Desktop window');
    }
    const context = await this.resolveWorkflowDisplayContext(input.ownerUserId, input.projectId, managed);
    const objective =
      work.phase === 'fix_required' && review?.round.phase === 'complete' && review.round.attemptId === input.attemptId
        ? buildReviewCompletionObjective({
            ...context,
            projectId: input.projectId,
            workId: input.workId,
            attemptId: input.attemptId,
            reviewRoundId: review.round.roundId,
            exactSha: review.round.exactSha,
            runtimeSessionId: session.runtimeSessionId,
            operatorDecisions: reviewOperatorDecisions(managed, review),
          })
        : buildManualWorkflowResumeObjective({
            ...context,
            projectId: input.projectId,
            workId: input.workId,
            attemptId: input.attemptId,
            phase: work.phase,
            runtimeSessionId: session.runtimeSessionId,
          });
    await this.desktopTaskLauncher.activate({
      threadId: session.chatRef,
      sourcePath: session.workspace.worktreePath,
      objective,
    });
  }

  private async resolveWorkflowDisplayContext(
    ownerUserId: string,
    projectId: string,
    managed: ManagedWorkConsumerSnapshot,
  ) {
    const project = await this.requireConfiguredProject(projectId, ownerUserId);
    const item = (await this.backlogStore.listByUser(ownerUserId)).find(
      (candidate) => candidate.id === managed.admission.producerRef && candidate.projectId === projectId,
    );
    if (!item) throw new Error('Development-loop backlog item is unavailable');
    const featureId = featureIdForItem(item);
    if (!featureId) throw new Error('Development-loop feature id is unavailable');
    const design = await this.requireFeatureDesignAuthority(project, item);
    return {
      projectName: project.name,
      repository: project.desktopDevelopment.repository.fullName,
      backlogItemId: item.id,
      featureId,
      featureTitle: featureTitleForReview(featureId, item.title),
      attemptNumber: deliveryCycleAttemptNumber(managed),
      designBranch: design.branch,
      designExactSha: design.exactSha,
      designDocuments: design.documents,
    };
  }

  private async assertCurrentSession(
    input: {
      projectId: string;
      workId: string;
      attemptId: string;
      runtimeSessionId: string;
      bindingEpoch: number;
    },
    now: number,
    requireActiveBinding: boolean,
  ): Promise<DesktopSessionBinding> {
    const session = await this.sessions.getCurrent(input.projectId, input.workId, now);
    if (!session || session.attemptId !== input.attemptId) throw new Error('Desktop session binding not found');
    if (session.bindingEpoch !== input.bindingEpoch || session.runtimeSessionId !== input.runtimeSessionId) {
      throw new Error('Desktop session does not own the current binding epoch');
    }
    if (requireActiveBinding && session.status !== 'active') throw new Error('Desktop session binding is not active');
    return session;
  }

  private assertReviewDecisionTarget(
    attemptId: string,
    managed: ManagedWorkConsumerSnapshot,
    review: ReviewRoundSafeView | null,
  ): asserts review is ReviewRoundSafeView {
    if (
      managed.state.lifecycle !== 'active' ||
      managed.attempt.attemptId !== attemptId ||
      managed.state.currentAttemptId !== attemptId ||
      !review ||
      !review.currentForWork ||
      review.round.attemptId !== attemptId ||
      review.round.phase !== 'complete' ||
      review.consensus?.verdict !== 'changes_requested'
    ) {
      throw new Error('Review decision requires the current completed changes-requested round');
    }
  }

  private async activateReviewCompletionIfReady(
    input: Pick<ApproveReviewContinuationInput, 'ownerUserId' | 'projectId' | 'workId' | 'attemptId'>,
    managed: ManagedWorkConsumerSnapshot,
    review: ReviewRoundSafeView,
  ): Promise<void> {
    const gate = deriveReviewLoopGate({
      attemptNumber: deliveryCycleAttemptNumber(managed),
      exactSha: review.round.exactSha,
      findings: review.findings,
      evidence: currentDeliveryCycleEvidence(managed),
    });
    if (!canContinueReviewLoop(gate) || !this.desktopTaskLauncher) return;
    const session = await this.sessions.getCurrent(input.projectId, input.workId);
    if (!session?.chatRef || session.attemptId !== input.attemptId) return;
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const item = (await this.backlogStore.listByUser(input.ownerUserId)).find(
      (candidate) => candidate.id === managed.admission.producerRef && candidate.projectId === input.projectId,
    );
    if (!item) throw new Error('Review display context backlog item is unavailable');
    const featureId = featureIdForItem(item);
    if (!featureId) throw new Error('Review display context feature id is unavailable');
    const design = await this.requireFeatureDesignAuthority(project, item);
    const operatorDecisions = currentDeliveryCycleEvidence(managed)
      .filter(
        (evidence) =>
          evidence.kind === 'architecture_decision_recorded' &&
          evidence.exactSha === review.round.exactSha &&
          review.findings.some((finding) => finding.findingId === evidence.findingId),
      )
      .map((evidence) =>
        evidence.kind === 'architecture_decision_recorded' ? `${evidence.findingId}: ${evidence.decision}` : '',
      )
      .filter(Boolean);
    await this.desktopTaskLauncher.activate({
      threadId: session.chatRef,
      sourcePath: session.workspace.worktreePath,
      objective: buildReviewCompletionObjective({
        projectName: project.name,
        featureId,
        featureTitle: featureTitleForReview(featureId, item.title),
        attemptNumber: deliveryCycleAttemptNumber(managed),
        projectId: input.projectId,
        workId: input.workId,
        attemptId: input.attemptId,
        reviewRoundId: review.round.roundId,
        exactSha: review.round.exactSha,
        designBranch: design.branch,
        designExactSha: design.exactSha,
        designDocuments: design.documents,
        runtimeSessionId: session.runtimeSessionId,
        operatorDecisions,
      }),
    });
  }

  private managedIdentity(input: { ownerUserId: string; workId: string; attemptId: string }): {
    consumerId: typeof CONSUMER_ID;
    ownerUserId: string;
    workId: string;
    attemptId: string;
  } {
    return {
      consumerId: CONSUMER_ID,
      ownerUserId: input.ownerUserId,
      workId: input.workId,
      attemptId: input.attemptId,
    };
  }

  private async projectFeatureDesignAuthorityView(
    project: Awaited<ReturnType<DesktopDevelopmentLoopService['requireConfiguredProject']>>,
    item: BacklogItem,
  ): Promise<ProjectFeatureDesignAuthorityView> {
    const [configuredBranch, documentsByFeature] = await Promise.all([
      this.externalProjects.getProjectDesignBranch(project.id),
      this.externalProjects.getFeatureDesignDocuments(project.id),
    ]);
    const authority = await this.projectDesignAuthorityView(project, configuredBranch);
    const feature = await this.featureDesignDocumentsView(project, item, documentsByFeature[item.id] ?? [], authority);
    return {
      branch: authority.branch,
      exactSha: authority.exactSha,
      documents: feature.documents,
      status: authority.status === 'ready' && feature.status === 'ready' ? 'ready' : 'missing',
      error: authority.error ?? feature.error,
    };
  }

  private async projectDesignAuthorityView(
    project: Awaited<ReturnType<DesktopDevelopmentLoopService['requireConfiguredProject']>>,
    configuredBranch: string | null,
  ): Promise<ProjectDesignAuthorityView> {
    if (!configuredBranch) {
      return {
        projectId: project.id,
        branch: null,
        exactSha: null,
        status: 'missing',
      };
    }
    try {
      const resolved = await this.designBranchResolver({
        sourcePath: project.sourcePath,
        repository: project.desktopDevelopment.repository,
        branch: configuredBranch,
      });
      return this.readyProjectDesignAuthorityView(project.id, resolved);
    } catch (error) {
      return {
        projectId: project.id,
        branch: configuredBranch,
        exactSha: null,
        status: 'unavailable',
        error: error instanceof Error ? error.message : 'Design branch is unavailable',
      };
    }
  }

  private readyProjectDesignAuthorityView(
    projectId: string,
    resolved: ResolvedDesignBranch,
  ): ProjectDesignAuthorityView {
    return {
      projectId,
      branch: resolved.branch,
      exactSha: resolved.exactSha,
      status: 'ready',
    };
  }

  private async featureDesignDocumentsView(
    project: Awaited<ReturnType<DesktopDevelopmentLoopService['requireConfiguredProject']>>,
    item: BacklogItem,
    configuredDocuments: readonly string[],
    authority: ProjectDesignAuthorityView,
  ): Promise<FeatureDesignDocumentsView> {
    const featureId = featureIdForItem(item);
    if (!featureId) throw new Error('Project feature id is unavailable');
    if (configuredDocuments.length === 0) {
      return { projectId: project.id, backlogItemId: item.id, featureId, documents: [], status: 'missing' };
    }
    if (authority.status !== 'ready' || !authority.exactSha) {
      return {
        projectId: project.id,
        backlogItemId: item.id,
        featureId,
        documents: normalizeDesignDocuments(configuredDocuments),
        status: 'unavailable',
        error: authority.error ?? 'Project design branch is unavailable',
      };
    }
    try {
      const documents = await this.designDocumentsResolver(project.sourcePath, authority.exactSha, configuredDocuments);
      return this.readyFeatureDesignDocumentsView(project.id, item, documents);
    } catch (error) {
      return {
        projectId: project.id,
        backlogItemId: item.id,
        featureId,
        documents: normalizeDesignDocuments(configuredDocuments),
        status: 'unavailable',
        error: error instanceof Error ? error.message : 'Design documents are unavailable',
      };
    }
  }

  private readyFeatureDesignDocumentsView(
    projectId: string,
    item: BacklogItem,
    documents: readonly string[],
  ): FeatureDesignDocumentsView {
    const featureId = featureIdForItem(item);
    if (!featureId) throw new Error('Project feature id is unavailable');
    return { projectId, backlogItemId: item.id, featureId, documents, status: 'ready' };
  }

  private async requireFeatureDesignAuthority(
    project: Awaited<ReturnType<DesktopDevelopmentLoopService['requireConfiguredProject']>>,
    item: BacklogItem,
  ): Promise<ResolvedDesignAuthority> {
    const [configuredBranch, documentsByFeature] = await Promise.all([
      this.externalProjects.getProjectDesignBranch(project.id),
      this.externalProjects.getFeatureDesignDocuments(project.id),
    ]);
    if (!configuredBranch) {
      throw new Error('Project design branch is not configured; bind the shared committed branch before continuing');
    }
    const configuredDocuments = documentsByFeature[item.id] ?? [];
    if (configuredDocuments.length === 0) {
      throw new Error('Feature design documents are not configured; select design documents before continuing');
    }
    const resolved = await this.designBranchResolver({
      sourcePath: project.sourcePath,
      repository: project.desktopDevelopment.repository,
      branch: configuredBranch,
    });
    const documents = await this.designDocumentsResolver(project.sourcePath, resolved.exactSha, configuredDocuments);
    return { ...resolved, documents };
  }

  private async requireProject(projectId: string, ownerUserId: string) {
    const project = await this.externalProjects.getById(projectId);
    if (!project || project.userId !== ownerUserId) throw new Error('Project not found');
    return project;
  }

  private async requireConfiguredProject(projectId: string, ownerUserId: string) {
    const project = await this.requireProject(projectId, ownerUserId);
    if (!project.desktopDevelopment) throw new Error('Desktop development loop is not configured for this project');
    return project as typeof project & { desktopDevelopment: NonNullable<typeof project.desktopDevelopment> };
  }

  private assertWorkspaceRepository(expectedFullName: string, workspace: WorkspaceBinding): void {
    if (workspace.repository.fullName.toLowerCase() !== expectedFullName.toLowerCase()) {
      throw new Error('Workspace repository does not match the project binding');
    }
  }

  private async assertWorkspaceBinding(
    project: Awaited<ReturnType<DesktopDevelopmentLoopService['requireConfiguredProject']>>,
    workspace: WorkspaceBinding,
  ): Promise<void> {
    this.assertWorkspaceRepository(project.desktopDevelopment.repository.fullName, workspace);
    await this.workspacePathVerifier(project.sourcePath, workspace.worktreePath);
  }

  private assertSessionImplementationSha(session: DesktopSessionBinding, exactSha: string): void {
    if (session.workspace.currentSha !== exactSha || session.workspace.lastCommittedSha !== exactSha) {
      throw new Error('Merge SHA must equal the current committed workspace SHA');
    }
  }

  private assertApprovedGreenReview(
    exactSha: string,
    managed: ManagedWorkConsumerSnapshot,
    review: ReviewRoundSafeView | null,
  ): asserts review is ReviewRoundSafeView {
    const validReview =
      review?.round.phase === 'complete' &&
      review.currentForWork &&
      review.round.exactSha === exactSha &&
      review.consensus?.verdict === 'approved' &&
      review.consensus.checksPassed &&
      review.consensus.openFindingCount === 0 &&
      !review.findings.some((finding) => finding.status === 'open');
    const canonicalEvidence = currentDeliveryCycleEvidence(managed).some(
      (evidence) =>
        evidence.kind === 'review_completed' &&
        evidence.exactSha === exactSha &&
        evidence.reviewRoundId === review?.round.roundId &&
        evidence.openFindingCount === 0 &&
        evidence.checksPassed,
    );
    if (!validReview || !canonicalEvidence) {
      throw new Error('Merge requires the current exact SHA to have an approved, green review with zero findings');
    }
  }

  private assertProtocol(protocolVersion: number): void {
    if (protocolVersion !== DESKTOP_DEVELOPMENT_PROTOCOL_VERSION) {
      throw new Error(
        `Desktop development protocol mismatch: received ${protocolVersion}, supported ${DESKTOP_DEVELOPMENT_PROTOCOL_VERSION}`,
      );
    }
  }
}

function buildManualWorkflowResumeObjective(input: {
  readonly projectName: string;
  readonly featureId: string;
  readonly featureTitle: string;
  readonly attemptNumber: number;
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly phase: DesktopDevelopmentPhase;
  readonly runtimeSessionId: string;
  readonly designBranch: string;
  readonly designExactSha: string;
  readonly designDocuments: readonly string[];
}): string {
  return [
    `[开发闭环系统消息] ${input.projectName} · ${input.featureId} · ${input.featureTitle}`,
    '',
    '用户在 CatCafe 的完整流程链路中手动触发了当前停滞节点。',
    `当前阶段：${input.phase}`,
    `当前实现轮次：Attempt #${input.attemptNumber}`,
    `projectId：${input.projectId}`,
    `workId：${input.workId}`,
    `attemptId：${input.attemptId}`,
    `runtimeSessionId：${input.runtimeSessionId}`,
    `方案分支：${input.designBranch}`,
    `方案提交：${input.designExactSha}`,
    `设计文档：${input.designDocuments.join('、')}`,
    '',
    '请在原绑定任务中读取最新 Resume Packet，只执行服务端返回的 nextLegalActions。',
    '实现必须以该方案提交为准；方案讨论会话只用于讨论，不是实现依据。',
    '完成一次合法动作后结束本次 turn；不要轮询等待 CatCafe，也不要创建新的 ChatGPT 任务。',
  ].join('\n');
}

function deriveWorkflowNodes(input: {
  readonly managed: ManagedWorkConsumerSnapshot;
  readonly session: DesktopSessionBinding;
  readonly review: ReviewRoundSafeView | null;
  readonly derived: DesktopDevelopmentDerivedState;
  readonly design: ProjectFeatureDesignAuthorityView;
}): readonly DesktopDevelopmentWorkflowNode[] {
  const context = buildWorkflowProjectionContext(input);
  return [
    designWorkflowNode(context),
    implementationWorkflowNode(context),
    independentReviewWorkflowNode(context),
    crossReviewWorkflowNode(context),
    consensusWorkflowNode(context),
    handoffWorkflowNode(context),
    mergeWorkflowNode(context),
    acceptanceWorkflowNode(context),
  ];
}

interface WorkflowProjectionContext {
  readonly managed: ManagedWorkConsumerSnapshot;
  readonly session: DesktopSessionBinding;
  readonly review: ReviewRoundSafeView | null;
  readonly phase: DesktopDevelopmentPhase;
  readonly implementationAt: number | null;
  readonly mergedAt: number | null;
  readonly acceptanceAt: number | null;
  readonly consensusApproved: boolean;
  readonly design: ProjectFeatureDesignAuthorityView;
}

function buildWorkflowProjectionContext(input: {
  readonly managed: ManagedWorkConsumerSnapshot;
  readonly session: DesktopSessionBinding;
  readonly review: ReviewRoundSafeView | null;
  readonly derived: DesktopDevelopmentDerivedState;
  readonly design: ProjectFeatureDesignAuthorityView;
}): WorkflowProjectionContext {
  const attemptId = input.managed.attempt.attemptId;
  const review = input.review?.round.attemptId === attemptId && input.review.currentForWork ? input.review : null;
  return {
    managed: input.managed,
    session: input.session,
    review,
    phase: input.derived.phase,
    implementationAt: latestEvidenceAt(input.managed, 'implementation_committed', attemptId),
    mergedAt: latestEvidenceAt(input.managed, 'merged', attemptId),
    acceptanceAt: latestEvidenceAt(input.managed, 'acceptance_recorded', attemptId),
    consensusApproved: review?.round.phase === 'complete' && review.consensus?.verdict === 'approved',
    design: input.design,
  };
}

function designWorkflowNode(context: WorkflowProjectionContext): DesktopDevelopmentWorkflowNode {
  const ready = context.design.status === 'ready';
  return {
    id: 'design',
    status: ready ? 'completed' : 'blocked',
    actor: 'user',
    startedAt: null,
    completedAt: null,
    manualAction: ready ? null : 'configure_design_branch',
  };
}

function implementationWorkflowNode(context: WorkflowProjectionContext): DesktopDevelopmentWorkflowNode {
  const completed = Boolean(context.implementationAt || context.review);
  const unavailable =
    context.phase === 'awaiting_design_branch' ||
    context.phase === 'ready_for_desktop' ||
    !context.session.workspace.worktreePresent ||
    context.session.status !== 'active';
  let status: DesktopDevelopmentWorkflowNode['status'] = 'active';
  if (completed) status = 'completed';
  else if (unavailable) status = 'blocked';
  return {
    id: 'implementation',
    status,
    actor: 'chatgpt_desktop',
    startedAt: context.managed.attempt.createdAt,
    completedAt: context.implementationAt,
    manualAction: completed ? null : 'wake_desktop',
  };
}

function independentReviewWorkflowNode(context: WorkflowProjectionContext): DesktopDevelopmentWorkflowNode {
  const active = context.review?.round.phase === 'independent';
  let status: DesktopDevelopmentWorkflowNode['status'] = 'pending';
  if (active) status = 'active';
  else if (context.review) status = 'completed';
  return {
    id: 'independent_review',
    status,
    actor: 'reviewers',
    startedAt: context.review?.round.createdAt ?? null,
    completedAt: context.review?.round.barrierOpenedAt ?? null,
    completedCount: context.review?.progress.independentFinished ?? 0,
    requiredCount: context.review?.round.reviewerCatIds.length ?? 0,
    manualAction: active ? 'replay_review_stage' : null,
  };
}

function crossReviewWorkflowNode(context: WorkflowProjectionContext): DesktopDevelopmentWorkflowNode {
  const phase = context.review?.round.phase;
  const active = phase === 'cross_review';
  let status: DesktopDevelopmentWorkflowNode['status'] = 'pending';
  if (active) status = 'active';
  else if (phase === 'consensus_ready' || phase === 'complete') status = 'completed';
  return {
    id: 'cross_review',
    status,
    actor: 'reviewers',
    startedAt: context.review?.round.barrierOpenedAt ?? null,
    completedAt: null,
    completedCount: context.review?.progress.crossReviewFinished ?? 0,
    requiredCount: context.review?.round.reviewerCatIds.length ?? 0,
    manualAction: active ? 'replay_review_stage' : null,
  };
}

function consensusWorkflowNode(context: WorkflowProjectionContext): DesktopDevelopmentWorkflowNode {
  const phase = context.review?.round.phase;
  const active = phase === 'consensus_ready';
  let status: DesktopDevelopmentWorkflowNode['status'] = 'pending';
  if (active) status = 'active';
  else if (phase === 'complete') status = 'completed';
  return {
    id: 'consensus',
    status,
    actor: 'review_recorder',
    startedAt: active || phase === 'complete' ? (context.review?.round.barrierOpenedAt ?? null) : null,
    completedAt: context.review?.consensus?.publishedAt ?? context.review?.round.completedAt ?? null,
    manualAction: active ? 'replay_review_stage' : null,
  };
}

function handoffWorkflowNode(context: WorkflowProjectionContext): DesktopDevelopmentWorkflowNode {
  const reviewComplete = context.review?.round.phase === 'complete';
  const architectureGate = context.phase === 'awaiting_architecture_decision';
  const continuationGate = context.phase === 'awaiting_review_continuation';
  const blocked = architectureGate || continuationGate;
  const active = context.phase === 'fix_required';
  let status: DesktopDevelopmentWorkflowNode['status'] = 'pending';
  if (blocked) status = 'blocked';
  else if (active) status = 'active';
  else if (reviewComplete) status = 'completed';
  return {
    id: 'handoff',
    status,
    actor: blocked ? 'user' : context.consensusApproved ? 'catcafe' : 'chatgpt_desktop',
    startedAt: context.review?.round.completedAt ?? null,
    completedAt: context.consensusApproved ? (context.review?.round.completedAt ?? null) : null,
    manualAction: handoffManualAction(context.phase),
  };
}

function handoffManualAction(phase: DesktopDevelopmentPhase): DesktopDevelopmentWorkflowNode['manualAction'] {
  if (phase === 'awaiting_architecture_decision') return 'record_architecture_decision';
  if (phase === 'awaiting_review_continuation') return 'approve_review_continuation';
  if (phase === 'fix_required') return 'wake_desktop';
  return null;
}

function mergeWorkflowNode(context: WorkflowProjectionContext): DesktopDevelopmentWorkflowNode {
  let status: DesktopDevelopmentWorkflowNode['status'] = 'pending';
  if (context.mergedAt) status = 'completed';
  else if (context.consensusApproved) status = 'active';
  return {
    id: 'merge',
    status,
    actor: 'chatgpt_desktop',
    startedAt: context.consensusApproved ? (context.review?.round.completedAt ?? null) : null,
    completedAt: context.mergedAt,
    manualAction: context.consensusApproved && !context.mergedAt ? 'wake_desktop' : null,
  };
}

function acceptanceWorkflowNode(context: WorkflowProjectionContext): DesktopDevelopmentWorkflowNode {
  const terminal = context.managed.state.lifecycle !== 'active';
  let status: DesktopDevelopmentWorkflowNode['status'] = 'pending';
  if (context.mergedAt && terminal) status = 'completed';
  else if (context.mergedAt) status = 'active';
  return {
    id: 'acceptance',
    status,
    actor: 'user',
    startedAt: context.mergedAt,
    completedAt: context.acceptanceAt,
    manualAction: context.mergedAt && !terminal ? 'record_acceptance' : null,
  };
}

function reviewOperatorDecisions(managed: ManagedWorkConsumerSnapshot, review: ReviewRoundSafeView): readonly string[] {
  const findingIds = new Set(review.findings.map((finding) => finding.findingId));
  return managed.evidence.flatMap((evidence) => {
    if (
      evidence.kind !== 'architecture_decision_recorded' ||
      evidence.exactSha !== review.round.exactSha ||
      !findingIds.has(evidence.findingId)
    ) {
      return [];
    }
    return [`${evidence.findingId}: ${evidence.decision}`];
  });
}

function latestEvidenceAt(
  managed: ManagedWorkConsumerSnapshot,
  kind: 'implementation_committed' | 'merged' | 'acceptance_recorded',
  attemptId: string,
): number | null {
  let latest: number | null = null;
  for (const evidence of managed.evidence) {
    if (evidence.kind !== kind || evidence.attemptId !== attemptId) continue;
    latest = latest === null ? evidence.recordedAt : Math.max(latest, evidence.recordedAt);
  }
  return latest;
}

function buildDesignAuthorityRefs(
  designBranch: string,
  designExactSha: string,
  designDocuments: readonly string[],
): readonly string[] {
  return [
    buildReviewDesignRef(designBranch, designExactSha),
    ...designDocuments.map((documentPath) => buildReviewDesignDocumentRef(designBranch, designExactSha, documentPath)),
  ];
}

function resumeDesignRefs(designRefs: readonly string[], fallbackRefs: readonly string[]): readonly string[] {
  if (designRefs.length > 0) return designRefs;
  return fallbackRefs;
}

interface DesktopDevelopmentStateInput {
  managedLifecycle: 'active' | 'accepted' | 'rejected';
  session: DesktopSessionBinding;
  review: ReviewRoundSafeView | null;
  managed: ManagedWorkConsumerSnapshot;
  mergeMode: 'manual_confirm_in_chatgpt' | 'automatic';
  designBranchReady: boolean;
}

interface DesktopDevelopmentDerivedState {
  readonly phase: DesktopDevelopmentPhase;
  readonly nextLegalActions: readonly string[];
}

function deriveDesktopDevelopmentState(input: DesktopDevelopmentStateInput): DesktopDevelopmentDerivedState {
  if (input.managedLifecycle === 'accepted') return { phase: 'accepted', nextLegalActions: [] };
  if (input.managedLifecycle === 'rejected') return { phase: 'rejected', nextLegalActions: [] };
  if (!input.designBranchReady) {
    return { phase: 'awaiting_design_branch', nextLegalActions: ['configure_design_branch'] };
  }
  if (input.session.status !== 'active') {
    return { phase: 'ready_for_desktop', nextLegalActions: ['rebind_session'] };
  }
  if (!input.session.workspace.worktreePresent) {
    return { phase: 'ready_for_desktop', nextLegalActions: ['rebuild_worktree_from_last_committed_sha'] };
  }
  if (!input.review) {
    return { phase: 'implementing', nextLegalActions: ['implement_and_report_committed_sha'] };
  }
  if (input.review.round.attemptId !== input.session.attemptId) {
    if (input.review.round.exactSha === input.session.workspace.currentSha) {
      return { phase: 'implementing', nextLegalActions: ['fix_open_findings'] };
    }
    return workspaceImplementationState(input.session.workspace);
  }
  if (input.review.round.exactSha !== input.session.workspace.currentSha) {
    return workspaceImplementationState(input.session.workspace);
  }
  if (input.review.round.phase === 'complete') return deriveCompletedReviewState(input);
  switch (input.review.round.phase) {
    case 'independent':
      return { phase: 'independent_review', nextLegalActions: ['wait_for_independent_review'] };
    case 'cross_review':
      return { phase: 'cross_review', nextLegalActions: ['wait_for_cross_review'] };
    case 'consensus_ready':
      return consensusAuthorizationForReview(input.managed, input.review)
        ? { phase: 'cross_review', nextLegalActions: ['wait_for_authorized_consensus'] }
        : { phase: 'cross_review', nextLegalActions: ['wait_for_consensus', 'authorize_review_consensus'] };
  }
}

function consensusAuthorizationForReview(
  managed: ManagedWorkConsumerSnapshot,
  review: ReviewRoundSafeView,
): DesktopReviewConsensusAuthorization | undefined {
  const matching = managed.evidence.filter(
    (evidence) =>
      evidence.kind === 'review_consensus_authorized' &&
      evidence.reviewRoundId === review.round.roundId &&
      evidence.exactSha === review.round.exactSha,
  );
  const latest = matching.at(-1);
  if (!latest || latest.kind !== 'review_consensus_authorized') return undefined;
  return {
    reviewRoundId: latest.reviewRoundId,
    exactSha: latest.exactSha,
    instruction: latest.instruction,
    authorizedByUserId: latest.authorizedByUserId,
    authorizedAt: latest.recordedAt,
  };
}

function workspaceImplementationState(workspace: WorkspaceBinding): DesktopDevelopmentDerivedState {
  if (workspace.currentSha === workspace.lastCommittedSha) {
    return { phase: 'implementation_ready', nextLegalActions: ['report_new_committed_sha'] };
  }
  return { phase: 'implementing', nextLegalActions: ['commit_changes_before_report'] };
}

function deriveCompletedReviewState(input: DesktopDevelopmentStateInput): DesktopDevelopmentDerivedState {
  const review = input.review;
  if (!review || review.round.phase !== 'complete') return workspaceImplementationState(input.session.workspace);
  if (review.consensus?.verdict === 'changes_requested') {
    const gate = deriveReviewLoopGate({
      attemptNumber: deliveryCycleAttemptNumber(input.managed),
      exactSha: review.round.exactSha,
      findings: review.findings,
      evidence: input.managed.evidence,
    });
    if (gate.architectureDecisionPending) {
      return { phase: 'awaiting_architecture_decision', nextLegalActions: ['request_user_architecture_decision'] };
    }
    if (gate.continuationPending) {
      return { phase: 'awaiting_review_continuation', nextLegalActions: ['request_review_continuation_approval'] };
    }
    return { phase: 'fix_required', nextLegalActions: ['start_fix_attempt'] };
  }
  if (review.consensus?.verdict !== 'approved' || !review.currentForWork) {
    return workspaceImplementationState(input.session.workspace);
  }
  const exactSha = review.round.exactSha;
  const reviewCompleted = input.managed.evidence.some(
    (evidence) =>
      evidence.kind === 'review_completed' &&
      evidence.exactSha === exactSha &&
      evidence.reviewRoundId === review.round.roundId &&
      evidence.openFindingCount === 0 &&
      evidence.checksPassed,
  );
  if (!reviewCompleted) {
    return { phase: 'approved_for_merge', nextLegalActions: ['wait_for_review_evidence'] };
  }
  const merged = input.managed.evidence.some(
    (evidence) => evidence.kind === 'merged' && evidence.exactSha === exactSha,
  );
  if (merged) return { phase: 'acceptance_pending', nextLegalActions: ['wait_for_final_acceptance'] };
  const currentConfirmation = input.managed.evidence.some(
    (evidence) =>
      evidence.kind === 'merge_confirmed' &&
      evidence.exactSha === exactSha &&
      evidence.bindingEpoch === input.session.bindingEpoch,
  );
  if (input.mergeMode === 'automatic' || currentConfirmation) {
    return { phase: 'auto_merge_ready', nextLegalActions: ['merge_with_native_git'] };
  }
  return {
    phase: 'awaiting_manual_merge_confirmation',
    nextLegalActions: ['request_merge_confirmation'],
  };
}
