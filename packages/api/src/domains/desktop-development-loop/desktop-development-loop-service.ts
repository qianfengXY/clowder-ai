import {
  type BacklogItem,
  type BacklogStatus,
  buildProjectReviewHubId,
  type CatId,
  CHATGPT_DESKTOP_DEVELOPMENT_ACTOR,
  DESKTOP_DEVELOPMENT_PROTOCOL_VERSION,
  DESKTOP_DEVELOPMENT_REQUIRED_PILOTS,
  type DesktopDevelopmentPhase,
  type DesktopDevelopmentResumePacket,
  type DesktopSessionBinding,
  type ManagedWorkConsumerSnapshot,
  type ManagedWorkLifecycle,
  normalizeGitHubRepository,
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
import type { DesktopTaskLauncher } from './codex-desktop-task-launcher.js';
import type { DesktopSessionStore } from './desktop-session-store.js';
import type { IReviewRoundStageDispatcher } from './review-round-stage-dispatcher.js';

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
  readonly leaseDurationMs: number;
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
  readonly leaseDurationMs: number;
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
  readonly desktopTask?:
    | { readonly status: 'created'; readonly threadId: string }
    | { readonly status: 'failed'; readonly error: string };
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

function launchStatusWithoutSop(status: BacklogStatus): DesktopDevelopmentLaunchStatus {
  if (status === 'done') return 'completed';
  if (status === 'open') return 'available';
  return 'managed_by_catcafe';
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
  ) {}

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
    await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const item = (await this.backlogStore.listByUser(input.ownerUserId)).find(
      (candidate) => candidate.id === input.backlogItemId && candidate.projectId === input.projectId,
    );
    if (!item) throw new Error('Project backlog item not found');

    await Promise.all([
      this.reviewHubs.ensureForFeature(input.projectId, item.id, 'plan', input.ownerUserId),
      this.reviewHubs.ensureForFeature(input.projectId, item.id, 'review', input.ownerUserId),
    ]);

    const lockToken = await this.backlogStore.tryAcquireDispatchLock?.(item.id);
    if (lockToken === false) throw new Error('Project backlog item launch is already in progress');
    try {
      const state = await this.startProjectWorkLocked(input.ownerUserId, input.projectId, item);
      if (state.status !== 'ready_for_desktop' || !this.desktopTaskLauncher) return state;
      const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
      try {
        const desktopTask = await this.desktopTaskLauncher.launch({
          projectId: project.id,
          projectName: project.name,
          repository: project.desktopDevelopment.repository.fullName,
          sourcePath: project.sourcePath,
          backlogItemId: item.id,
          featureId: state.featureId,
          title: item.title,
        });
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
  ): Promise<DesktopDevelopmentLaunchState> {
    const current = await this.classifyProjectLaunchState(ownerUserId, projectId, item);
    if (current.status === 'ready_for_desktop') {
      return this.reserveProjectWorkForDesktop(ownerUserId, projectId, item);
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
    if (!sop) return { ...base, status: launchStatusWithoutSop(item.status) };

    const bundle = await this.workflowSopStore.getManagedWorkAdmission(ownerUserId, item.id);
    if (!bundle) {
      return {
        ...base,
        status: item.status === 'done' || sop.stage === 'completion' ? 'completed' : 'managed_by_catcafe',
      };
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
    const terminalStatus = terminalLaunchStatus(snapshot.state.lifecycle);
    if (terminalStatus) return { ...base, status: terminalStatus };

    const executor = snapshot.attempt.executorActor;
    if (executor?.kind === 'external_actor' && executor.actorId === CHATGPT_DESKTOP_DEVELOPMENT_ACTOR) {
      const session = await this.sessions.getCurrent(projectId, snapshot.admission.workId);
      const desktopTask = await this.desktopTaskLauncher?.get(projectId, item.id);
      return {
        ...base,
        status:
          session?.attemptId === snapshot.attempt.attemptId && session.status === 'active'
            ? 'connected_to_desktop'
            : 'ready_for_desktop',
        ...(desktopTask ? { desktopTask } : {}),
      };
    }
    if (executor?.kind === 'cat' || snapshot.attempt.executorCatId) {
      return { ...base, status: 'managed_by_catcafe' };
    }
    return {
      ...base,
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
            attemptNumber: snapshot.attempt.attemptNumber,
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
    this.assertWorkspaceRepository(project.desktopDevelopment.repository.fullName, input.workspace);

    const identity = this.managedIdentity(input);
    let snapshot = await this.managedWork.read(identity);
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
      leaseDurationMs: input.leaseDurationMs,
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
    if (input.workspace)
      this.assertWorkspaceRepository(project.desktopDevelopment.repository.fullName, input.workspace);
    await this.assertCurrentSession(input, input.now ?? Date.now(), false);
    await this.sessions.heartbeat({
      projectId: input.projectId,
      workId: input.workId,
      bindingEpoch: input.bindingEpoch,
      runtimeSessionId: input.runtimeSessionId,
      expectedVersion: input.expectedSessionVersion,
      idempotencyKey: input.idempotencyKey,
      leaseDurationMs: input.leaseDurationMs,
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
    if (!session.workspace.worktreePresent) {
      throw new Error('Permanent worktree is missing; rebuild it from the last committed SHA before reporting');
    }
    const exactSha = input.exactSha.toLowerCase();
    if (session.workspace.currentSha !== exactSha || session.workspace.lastCommittedSha !== exactSha) {
      throw new Error('Implementation SHA must equal the current committed workspace SHA');
    }

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
    const reviewHub = await this.reviewHubs.ensureForFeature(
      input.projectId,
      managed.admission.producerRef,
      'review',
      input.ownerUserId,
    );
    const round = await this.reviewRounds.createRound({
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      workId: input.workId,
      attemptId: input.attemptId,
      exactSha,
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
      recorderCatId: round.recorderCatId,
    });

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
    await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const session = await this.assertCurrentSession(input, now, true);
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
    const existing = managed.evidence.find(
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

    const existing = managed.evidence.find((evidence) => evidence.kind === 'merged' && evidence.exactSha === exactSha);
    if (existing?.kind === 'merged') {
      if (existing.mergeCommitSha !== mergeCommitSha) {
        throw new Error('Merge receipt conflicts with the existing merge commit SHA');
      }
      return this.readWork(input, managed.state.version);
    }

    if (project.desktopDevelopment.mergeMode !== 'automatic') {
      const currentConfirmation = managed.evidence.some(
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
    if (!managed.evidence.some((evidence) => evidence.kind === 'merged' && evidence.exactSha === exactSha)) {
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

  async readWork(input: ReadDesktopWorkInput, knownManagedVersion?: number): Promise<DesktopDevelopmentResumePacket> {
    this.assertProtocol(input.protocolVersion);
    const now = input.now ?? Date.now();
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    const identity = this.managedIdentity(input);
    const [managed, session, review] = await Promise.all([
      this.managedWork.read(identity),
      this.sessions.getCurrent(input.projectId, input.workId, now),
      this.reviewRounds.readCurrentSafe({
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        workId: input.workId,
      }),
    ]);
    if (!session || session.attemptId !== input.attemptId) {
      throw new Error('Desktop session binding not found for this work attempt');
    }
    const openFindings = (review?.findings ?? [])
      .filter((finding) => finding.status === 'open')
      .map((finding) => ({
        findingId: finding.findingId,
        severity: finding.severity,
        summary: finding.title,
        evidenceRefs: finding.evidence,
        status: 'open' as const,
      }));
    const exactSha = session.workspace.currentSha;
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
    });
    return {
      protocolVersion: DESKTOP_DEVELOPMENT_PROTOCOL_VERSION,
      projectId: project.id,
      repository: project.desktopDevelopment.repository,
      defaultBranch: project.desktopDevelopment.defaultBranch,
      workId: managed.state.workId,
      attemptId: managed.attempt.attemptId,
      attemptNumber: managed.attempt.attemptNumber,
      phase: derived.phase,
      workLifecycle: managed.state.lifecycle,
      managedWorkVersion: knownManagedVersion ?? managed.state.version,
      bindingEpoch: session.bindingEpoch,
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
      openFindings,
      nextLegalActions: derived.nextLegalActions,
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
    requireActiveLease: boolean,
  ): Promise<DesktopSessionBinding> {
    const session = await this.sessions.getCurrent(input.projectId, input.workId, now);
    if (!session || session.attemptId !== input.attemptId) throw new Error('Desktop session binding not found');
    if (session.bindingEpoch !== input.bindingEpoch || session.runtimeSessionId !== input.runtimeSessionId) {
      throw new Error('Desktop session does not own the current binding epoch');
    }
    if (requireActiveLease && session.status !== 'active') throw new Error('Desktop session lease is not active');
    return session;
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
    const canonicalEvidence = managed.evidence.some(
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

interface DesktopDevelopmentStateInput {
  managedLifecycle: 'active' | 'accepted' | 'rejected';
  session: DesktopSessionBinding;
  review: ReviewRoundSafeView | null;
  managed: ManagedWorkConsumerSnapshot;
  mergeMode: 'manual_confirm_in_chatgpt' | 'automatic';
}

interface DesktopDevelopmentDerivedState {
  readonly phase: DesktopDevelopmentPhase;
  readonly nextLegalActions: readonly string[];
}

function deriveDesktopDevelopmentState(input: DesktopDevelopmentStateInput): DesktopDevelopmentDerivedState {
  if (input.managedLifecycle === 'accepted') return { phase: 'accepted', nextLegalActions: [] };
  if (input.managedLifecycle === 'rejected') return { phase: 'rejected', nextLegalActions: [] };
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
      return { phase: 'cross_review', nextLegalActions: ['wait_for_consensus'] };
  }
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
