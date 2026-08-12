import { buildProjectReviewHubId, type ProjectReviewHubView } from '@cat-cafe/shared';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { ExternalProjectStore } from './external-project-store.js';

export class ProjectReviewHubService {
  constructor(
    private readonly externalProjectStore: ExternalProjectStore,
    private readonly threadStore: IThreadStore,
  ) {}

  async ensureForProject(projectId: string, userId: string): Promise<ProjectReviewHubView> {
    const project = await this.externalProjectStore.getById(projectId);
    if (!project || project.userId !== userId) {
      throw new Error('Project not found');
    }
    if (!project.desktopDevelopment) {
      throw new Error('Desktop development loop is not configured for this project');
    }

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
}
