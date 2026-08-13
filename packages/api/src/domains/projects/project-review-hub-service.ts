import {
  buildFeatureWorkspaceThreadId,
  buildProjectReviewHubId,
  type FeatureWorkspaceThreadCandidatesView,
  type FeatureWorkspaceThreadKind,
  type FeatureWorkspaceThreadView,
  type ProjectReviewHubView,
} from '@cat-cafe/shared';
import type { IBacklogStore } from '../cats/services/stores/ports/BacklogStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { ExternalProjectStore } from './external-project-store.js';

export class ProjectReviewHubService {
  constructor(
    private readonly externalProjectStore: ExternalProjectStore,
    private readonly threadStore: IThreadStore,
    private readonly backlogStore?: Pick<IBacklogStore, 'listByUser'>,
    private readonly isReviewBindingLocked?: (input: {
      userId: string;
      projectId: string;
      backlogItemId: string;
    }) => Promise<boolean>,
  ) {}

  async ensureForFeature(
    projectId: string,
    backlogItemId: string,
    kind: FeatureWorkspaceThreadKind,
    userId: string,
    executionProjectPath?: string,
  ): Promise<FeatureWorkspaceThreadView> {
    const { project, item, featureId } = await this.requireFeature(projectId, backlogItemId, userId);
    const automaticThreadId = buildFeatureWorkspaceThreadId(project.id, item.id, kind);
    const slot = this.bindingSlot(item.id, kind);
    const bindings = await this.externalProjectStore.getFeatureWorkspaceBindings(project.id);
    let threadId = bindings[slot] ?? automaticThreadId;
    let binding: 'automatic' | 'manual' = bindings[slot] ? 'manual' : 'automatic';
    let existing = await this.threadStore.get(threadId);
    if (binding === 'manual' && !existing) {
      await this.externalProjectStore.setFeatureWorkspaceBinding(project.id, slot, null);
      threadId = automaticThreadId;
      binding = 'automatic';
      existing = await this.threadStore.get(threadId);
    }
    const wasDeleted = Boolean(existing?.deletedAt);
    const title = `${featureId} · ${kind === 'plan' ? '方案' : 'Review'} · ${project.name}`;
    if (binding === 'automatic') await this.threadStore.ensureThread(threadId, title);
    if (wasDeleted) await this.threadStore.restore(threadId);
    if (binding === 'automatic') {
      await Promise.all([
        this.threadStore.updateTitle(threadId, title),
        this.threadStore.updateProjectPath(threadId, executionProjectPath ?? project.sourcePath),
        this.threadStore.linkBacklogItem(threadId, item.id),
        this.threadStore.indexForUser(threadId, userId),
      ]);
    } else {
      await Promise.all([
        this.threadStore.indexForUser(threadId, userId),
        ...(executionProjectPath ? [this.threadStore.updateProjectPath(threadId, executionProjectPath)] : []),
      ]);
    }
    return {
      threadId,
      projectId: project.id,
      backlogItemId: item.id,
      featureId,
      kind,
      status: wasDeleted ? 'restored' : 'active',
      binding,
    };
  }

  async listFeatureThreadCandidates(
    projectId: string,
    backlogItemId: string,
    kind: FeatureWorkspaceThreadKind,
    userId: string,
  ): Promise<FeatureWorkspaceThreadCandidatesView> {
    const { project, item, featureId } = await this.requireFeature(projectId, backlogItemId, userId);
    const automaticThreadId = buildFeatureWorkspaceThreadId(project.id, item.id, kind);
    const slot = this.bindingSlot(item.id, kind);
    const bindings = await this.externalProjectStore.getFeatureWorkspaceBindings(project.id);
    const selectedThreadId = bindings[slot] ?? automaticThreadId;
    const manuallyBoundElsewhere = new Set(
      Object.entries(bindings)
        .filter(([key]) => key !== slot)
        .map(([, threadId]) => threadId),
    );
    const threads = await this.threadStore.listByProject(userId, project.sourcePath);
    const candidates = threads
      .filter(
        (thread) =>
          !thread.deletedAt &&
          !thread.systemKind &&
          !thread.threadKind &&
          !thread.externalRuntimeAnchorState &&
          !manuallyBoundElsewhere.has(thread.id) &&
          !/^project-feature-(?:plan|review):/.test(thread.id),
      )
      .map((thread) => ({
        threadId: thread.id,
        title: thread.title?.trim() || '未命名会话',
        lastActiveAt: thread.lastActiveAt,
        selected: thread.id === selectedThreadId,
      }))
      .sort((left, right) => Number(right.selected) - Number(left.selected) || right.lastActiveAt - left.lastActiveAt)
      .slice(0, 100);
    const locked = kind === 'review' ? await this.reviewBindingLocked(userId, project.id, item.id) : false;
    return {
      projectId: project.id,
      backlogItemId: item.id,
      featureId,
      kind,
      automaticThreadId,
      selectedThreadId,
      binding: bindings[slot] ? 'manual' : 'automatic',
      locked,
      candidates,
    };
  }

  async bindFeatureThread(
    projectId: string,
    backlogItemId: string,
    kind: FeatureWorkspaceThreadKind,
    threadId: string | null,
    userId: string,
  ): Promise<FeatureWorkspaceThreadView> {
    const { project, item } = await this.requireFeature(projectId, backlogItemId, userId);
    const slot = this.bindingSlot(item.id, kind);
    const current = (await this.externalProjectStore.getFeatureWorkspaceBindings(project.id))[slot] ?? null;
    if (current === threadId) return this.ensureForFeature(project.id, item.id, kind, userId);
    if (kind === 'review' && (await this.reviewBindingLocked(userId, project.id, item.id))) {
      throw new Error('Review conversation binding is locked while a review round is in progress');
    }
    if (threadId) {
      const candidates = await this.listFeatureThreadCandidates(project.id, item.id, kind, userId);
      if (!candidates.candidates.some((candidate) => candidate.threadId === threadId)) {
        throw new Error('Conversation is not an available workspace candidate for this project');
      }
    }
    await this.externalProjectStore.setFeatureWorkspaceBinding(project.id, slot, threadId);
    return this.ensureForFeature(project.id, item.id, kind, userId);
  }

  async ensureForProject(projectId: string, userId: string): Promise<ProjectReviewHubView> {
    const project = await this.requireConfiguredProject(projectId, userId);

    const hubId = buildProjectReviewHubId(project.id);
    const existing = await this.threadStore.get(hubId);
    const wasDeleted = Boolean(existing?.deletedAt);
    await this.threadStore.ensureThread(hubId, this.buildTitle(project.name));
    if (wasDeleted) {
      await this.threadStore.restore(hubId);
    }
    await Promise.all([
      this.threadStore.updateTitle(hubId, this.buildTitle(project.name)),
      this.threadStore.updateProjectPath(hubId, project.sourcePath),
      this.threadStore.indexForUser(hubId, userId),
    ]);

    return {
      hubId,
      threadId: hubId,
      projectId: project.id,
      status: wasDeleted ? 'restored' : 'active',
    };
  }

  private buildTitle(projectName: string): string {
    return `Review Hub · ${projectName}`;
  }

  private async requireConfiguredProject(projectId: string, userId: string) {
    const project = await this.externalProjectStore.getById(projectId);
    if (!project || project.userId !== userId) throw new Error('Project not found');
    if (!project.desktopDevelopment) throw new Error('Desktop development loop is not configured for this project');
    return project;
  }

  private async requireFeature(projectId: string, backlogItemId: string, userId: string) {
    const project = await this.requireConfiguredProject(projectId, userId);
    if (!this.backlogStore) throw new Error('Feature workspace capability is unavailable');
    const item = (await this.backlogStore.listByUser(userId)).find(
      (candidate) => candidate.id === backlogItemId && candidate.projectId === project.id,
    );
    if (!item) throw new Error('Project backlog item not found');
    const featureId = this.featureIdForItem(item.tags);
    if (!featureId) throw new Error('Project backlog item is missing a feature tag');
    return { project, item, featureId };
  }

  private bindingSlot(backlogItemId: string, kind: FeatureWorkspaceThreadKind): string {
    return `${backlogItemId}:${kind}`;
  }

  private async reviewBindingLocked(userId: string, projectId: string, backlogItemId: string): Promise<boolean> {
    return (await this.isReviewBindingLocked?.({ userId, projectId, backlogItemId })) ?? false;
  }

  private featureIdForItem(tags: readonly string[]): string | null {
    const value = tags
      .find((tag) => tag.toLowerCase().startsWith('feature:'))
      ?.slice('feature:'.length)
      .trim();
    return value ? value.toUpperCase() : null;
  }
}
