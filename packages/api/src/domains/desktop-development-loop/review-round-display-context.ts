import type { IBacklogStore } from '../cats/services/stores/ports/BacklogStore.js';
import type { IManagedWorkConsumerPort } from '../cats/services/stores/ports/ManagedWorkConsumerPort.js';
import type { ExternalProjectStore } from '../projects/external-project-store.js';
import type { ProjectReviewHubService } from '../projects/project-review-hub-service.js';
import {
  type DesignBranchResolver,
  type DesignDocumentsResolver,
  normalizeDesignDocuments,
  resolveDesignBranch,
  resolveDesignDocuments,
} from './design-branch-resolver.js';
import { deliveryCycleAttemptNumber } from './managed-work-delivery-cycle.js';

const CONSUMER_ID = 'f289_desktop_development_loop' as const;

export interface ReviewRoundDisplayContext {
  readonly projectName: string;
  readonly repository: string;
  readonly backlogItemId: string;
  readonly featureId: string;
  readonly featureTitle: string;
  readonly attemptNumber: number;
  readonly designBranch: string;
  readonly designExactSha: string;
  readonly designDocuments: readonly string[];
}

export interface ResolveReviewRoundDisplayContextInput {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly designBranch?: string;
  readonly designExactSha?: string;
  readonly designDocuments?: readonly string[];
}

export interface IReviewRoundDisplayContextResolver {
  resolve(input: ResolveReviewRoundDisplayContextInput): Promise<ReviewRoundDisplayContext>;
}

export class ReviewRoundDisplayContextResolver implements IReviewRoundDisplayContextResolver {
  constructor(
    private readonly externalProjects: Pick<
      ExternalProjectStore,
      'getById' | 'getProjectDesignBranch' | 'getFeatureDesignDocuments'
    >,
    private readonly backlogStore: Pick<IBacklogStore, 'listByUser'>,
    private readonly managedWork: Pick<IManagedWorkConsumerPort, 'read'>,
    _reviewHubs?: Pick<ProjectReviewHubService, 'ensureForFeature'>,
    private readonly designBranchResolver: DesignBranchResolver = resolveDesignBranch,
    private readonly designDocumentsResolver: DesignDocumentsResolver = resolveDesignDocuments,
  ) {}

  async resolve(input: ResolveReviewRoundDisplayContextInput): Promise<ReviewRoundDisplayContext> {
    const [project, managed, backlogItems] = await Promise.all([
      this.externalProjects.getById(input.projectId),
      this.managedWork.read({
        consumerId: CONSUMER_ID,
        ownerUserId: input.ownerUserId,
        workId: input.workId,
        attemptId: input.attemptId,
      }),
      this.backlogStore.listByUser(input.ownerUserId),
    ]);
    if (!project || project.userId !== input.ownerUserId || !project.desktopDevelopment) {
      throw new Error('Review display context project is unavailable');
    }
    const backlogItemId = managed.admission.producerRef;
    const item = backlogItems.find(
      (candidate) => candidate.id === backlogItemId && candidate.projectId === input.projectId,
    );
    if (!item) throw new Error('Review display context backlog item is unavailable');
    const featureId = featureIdForReview(item.tags, item.title);
    if (!featureId) throw new Error('Review display context feature id is unavailable');
    const recordedDesign =
      input.designBranch && input.designExactSha
        ? { branch: input.designBranch, exactSha: input.designExactSha }
        : null;
    const projectDesignBranch = await this.externalProjects.getProjectDesignBranch(input.projectId);
    const configuredBranch = recordedDesign?.branch ?? projectDesignBranch;
    if (!configuredBranch) throw new Error('Review display context design branch is unavailable');
    let design =
      recordedDesign ??
      (await this.designBranchResolver({
        sourcePath: project.sourcePath,
        repository: project.desktopDevelopment.repository,
        branch: configuredBranch,
      }));
    if (recordedDesign && projectDesignBranch && projectDesignBranch !== recordedDesign.branch) {
      try {
        const renamedDesign = await this.designBranchResolver({
          sourcePath: project.sourcePath,
          repository: project.desktopDevelopment.repository,
          branch: projectDesignBranch,
        });
        if (renamedDesign.exactSha === recordedDesign.exactSha) design = renamedDesign;
      } catch {
        // A recorded exact SHA remains valid when the currently configured alias is unavailable.
      }
    }
    const configuredDocuments =
      input.designDocuments ?? (await this.externalProjects.getFeatureDesignDocuments(input.projectId))[backlogItemId];
    if (!configuredDocuments?.length && !recordedDesign) {
      throw new Error('Review display context design documents are unavailable');
    }
    const designDocuments = !configuredDocuments?.length
      ? []
      : recordedDesign
        ? normalizeDesignDocuments(configuredDocuments)
        : await this.designDocumentsResolver(project.sourcePath, design.exactSha, configuredDocuments);
    return {
      projectName: project.name,
      repository: project.desktopDevelopment.repository.fullName,
      backlogItemId,
      featureId,
      featureTitle: featureTitleForReview(featureId, item.title),
      attemptNumber: deliveryCycleAttemptNumber(managed),
      designBranch: design.branch,
      designExactSha: design.exactSha,
      designDocuments,
    };
  }
}

export function featureIdForReview(tags: readonly string[], title: string): string | null {
  const tagged = tags
    .find((tag) => tag.toLowerCase().startsWith('feature:'))
    ?.slice('feature:'.length)
    .trim()
    .toUpperCase();
  if (tagged) return tagged;
  return title.match(/(?:^|\[|\s)(F\d{3})(?:\]|\s|[-—:：·]|$)/i)?.[1]?.toUpperCase() ?? null;
}

export function featureTitleForReview(featureId: string, title: string): string {
  const escaped = featureId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    title
      .trim()
      .replace(new RegExp(`^\\[${escaped}\\]\\s*`, 'i'), '')
      .replace(new RegExp(`^${escaped}\\s*[-—:：·]?\\s*`, 'i'), '')
      .trim() || featureId
  );
}
