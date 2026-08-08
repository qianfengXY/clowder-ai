import {
  buildProjectReviewHubId,
  type CatId,
  CHATGPT_DESKTOP_DEVELOPMENT_ACTOR,
  DESKTOP_DEVELOPMENT_PROTOCOL_VERSION,
  type DesktopDevelopmentResumePacket,
  type DesktopSessionBinding,
  type PublicDesktopDevelopmentProject,
  type ReviewRoundSafeView,
  toPublicDesktopDevelopmentProject,
  type WorkspaceBinding,
} from '@cat-cafe/shared';
import type { IManagedWorkConsumerPort } from '../cats/services/stores/ports/ManagedWorkConsumerPort.js';
import type { ExternalProjectStore } from '../projects/external-project-store.js';
import type { ProjectReviewHubService } from '../projects/project-review-hub-service.js';
import type { IReviewRoundStore } from '../review-coordination/ReviewRoundStore.js';
import type { DesktopSessionStore } from './desktop-session-store.js';

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
}

export class DesktopDevelopmentLoopService {
  constructor(
    private readonly externalProjects: ExternalProjectStore,
    private readonly reviewHubs: ProjectReviewHubService,
    private readonly sessions: DesktopSessionStore,
    private readonly managedWork: IManagedWorkConsumerPort,
    private readonly reviewRounds: IReviewRoundStore,
  ) {}

  async readProject(input: {
    protocolVersion: number;
    ownerUserId: string;
    projectId: string;
  }): Promise<DesktopProjectReadResult> {
    this.assertProtocol(input.protocolVersion);
    const project = await this.requireProject(input.projectId, input.ownerUserId);
    return {
      project: toPublicDesktopDevelopmentProject({
        projectId: project.id,
        sourcePath: project.sourcePath,
        binding: project.desktopDevelopment ?? null,
      }),
      reviewHubId: buildProjectReviewHubId(project.id),
    };
  }

  async connect(input: ConnectDesktopWorkInput): Promise<DesktopDevelopmentResumePacket> {
    this.assertProtocol(input.protocolVersion);
    const project = await this.requireConfiguredProject(input.projectId, input.ownerUserId);
    this.assertWorkspaceRepository(project.desktopDevelopment.repository.fullName, input.workspace);

    const identity = this.managedIdentity(input);
    let snapshot = await this.managedWork.read(identity);
    if (!snapshot.attempt.executorActor && !snapshot.attempt.executorCatId) {
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
      attemptId: input.attemptId,
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
      attemptId: input.attemptId,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
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
    const recorderCatId = input.recorderCatId ?? project.desktopDevelopment.defaultReviewers[0];
    if (!recorderCatId) throw new Error('Review recorder is unavailable');
    await this.reviewRounds.createRound({
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      workId: input.workId,
      attemptId: input.attemptId,
      exactSha,
      author: { kind: 'external_actor', actorId: CHATGPT_DESKTOP_DEVELOPMENT_ACTOR },
      reviewerCatIds: project.desktopDevelopment.defaultReviewers,
      recorderCatId,
      idempotencyKey: `${input.idempotencyKey}:round`,
      now,
    });
    await this.reviewHubs.ensureForProject(input.projectId, input.ownerUserId);

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
    return {
      protocolVersion: DESKTOP_DEVELOPMENT_PROTOCOL_VERSION,
      projectId: project.id,
      repository: project.desktopDevelopment.repository,
      defaultBranch: project.desktopDevelopment.defaultBranch,
      workId: managed.state.workId,
      attemptId: managed.attempt.attemptId,
      workLifecycle: managed.state.lifecycle,
      managedWorkVersion: knownManagedVersion ?? managed.state.version,
      bindingEpoch: session.bindingEpoch,
      sessionStatus: session.status,
      sessionVersion: session.version,
      branch: session.workspace.branch,
      currentSha: session.workspace.currentSha,
      lastCommittedSha: session.workspace.lastCommittedSha,
      worktreePresent: session.workspace.worktreePresent,
      reviewRoundId: review?.round.roundId ?? null,
      reviewPhase: review?.round.phase ?? null,
      reviewRoundVersion: review?.round.version ?? null,
      reviewCurrentForWork: review?.currentForWork ?? false,
      openFindings,
      nextLegalActions: deriveNextLegalActions({ managedLifecycle: managed.state.lifecycle, session, review }),
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

  private assertProtocol(protocolVersion: number): void {
    if (protocolVersion !== DESKTOP_DEVELOPMENT_PROTOCOL_VERSION) {
      throw new Error(
        `Desktop development protocol mismatch: received ${protocolVersion}, supported ${DESKTOP_DEVELOPMENT_PROTOCOL_VERSION}`,
      );
    }
  }
}

function deriveNextLegalActions(input: {
  managedLifecycle: 'active' | 'accepted' | 'rejected';
  session: DesktopSessionBinding;
  review: ReviewRoundSafeView | null;
}): readonly string[] {
  if (input.managedLifecycle !== 'active') return [];
  if (input.session.status !== 'active') return ['rebind_session'];
  if (!input.review) return ['implement_and_report_committed_sha'];
  if (input.review.round.exactSha !== input.session.workspace.currentSha) return ['report_new_committed_sha'];
  switch (input.review.round.phase) {
    case 'independent':
      return ['wait_for_independent_review'];
    case 'cross_review':
      return ['wait_for_cross_review'];
    case 'consensus_ready':
      return ['wait_for_consensus'];
    case 'complete':
      if (input.review.consensus?.verdict === 'changes_requested') return ['fix_open_findings'];
      if (input.review.consensus?.verdict === 'approved' && input.review.currentForWork) {
        return ['request_merge_confirmation'];
      }
      return ['report_new_committed_sha'];
  }
}
