import {
  buildFeatureWorkspaceThreadId,
  buildProjectReviewHubId,
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
  ) {}

  async ensureForFeature(
    projectId: string,
    backlogItemId: string,
    kind: FeatureWorkspaceThreadKind,
    userId: string,
  ): Promise<FeatureWorkspaceThreadView> {
    const project = await this.requireConfiguredProject(projectId, userId);
    if (!this.backlogStore) throw new Error('Feature workspace capability is unavailable');
    const item = (await this.backlogStore.listByUser(userId)).find(
      (candidate) => candidate.id === backlogItemId && candidate.projectId === project.id,
    );
    if (!item) throw new Error('Project backlog item not found');
    const featureId = this.featureIdForItem(item.tags);
    if (!featureId) throw new Error('Project backlog item is missing a feature tag');

    const threadId = buildFeatureWorkspaceThreadId(project.id, item.id, kind);
    const existing = await this.threadStore.get(threadId);
    const wasDeleted = Boolean(existing?.deletedAt);
    const title = `${featureId} · ${kind === 'plan' ? '方案' : 'Review'} · ${project.name}`;
    await this.threadStore.ensureThread(threadId, title);
    if (wasDeleted) await this.threadStore.restore(threadId);
    await Promise.all([
      this.threadStore.updateTitle(threadId, title),
      this.threadStore.updateProjectPath(threadId, project.sourcePath),
      this.threadStore.linkBacklogItem(threadId, item.id),
      this.threadStore.indexForUser(threadId, userId),
    ]);
    return {
      threadId,
      projectId: project.id,
      backlogItemId: item.id,
      featureId,
      kind,
      status: wasDeleted ? 'restored' : 'active',
    };
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

  private featureIdForItem(tags: readonly string[]): string | null {
    const value = tags
      .find((tag) => tag.toLowerCase().startsWith('feature:'))
      ?.slice('feature:'.length)
      .trim();
    return value ? value.toUpperCase() : null;
  }
}
