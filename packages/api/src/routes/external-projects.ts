/**
 * F076/EXT-002: External Project registry and ownership-scoped BACKLOG routes
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BacklogImportOrigin,
  BacklogItem,
  CatId,
  CreateDesktopDevelopmentProjectBindingInput,
  DesktopDevelopmentPolicyUpdate,
  ExternalProject,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { IBacklogStore } from '../domains/cats/services/stores/ports/BacklogStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { IWorkflowSopStore } from '../domains/cats/services/stores/ports/WorkflowSopStore.js';
import type { IExternalProjectBacklogRetirementStore } from '../domains/projects/external-project-backlog-retirement-store.js';
import type { ExternalProjectStore } from '../domains/projects/external-project-store.js';
import type { NeedAuditFrameStore } from '../domains/projects/need-audit-frame-store.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';
import {
  type BacklogFeatureRow,
  buildBacklogInputFromFeature,
  featureStatusToBacklogStatus,
  getFeatureTagId,
  parseActiveFeaturesFromBacklog,
} from './backlog-doc-import.js';
import { createBacklogItemSchema } from './backlog-request-schemas.js';
import { DEFAULT_EXTENSION_CATALOG_RELATIVE_PATH, readExtensionFeatureRows } from './extension-feature-catalog.js';
import { migrateLegacyExtensionItems } from './extension-feature-migration.js';

export interface ExternalProjectRoutesOptions {
  externalProjectStore: ExternalProjectStore;
  needAuditFrameStore: NeedAuditFrameStore;
  backlogStore: IBacklogStore;
  threadStore?: Pick<IThreadStore, 'get' | 'list'>;
  backlogRetirementStore?: IExternalProjectBacklogRetirementStore;
  workflowSopStore?: Pick<IWorkflowSopStore, 'get' | 'upsert'>;
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((tag, index) => tag === rightSorted[index]);
}

function importOriginFor(row: BacklogFeatureRow, projectId: string): BacklogImportOrigin {
  return {
    kind: 'external-project-catalog',
    projectId,
    featureId: row.id.toUpperCase(),
    source: row.kind === 'extension' ? 'extension-catalog' : 'docs-backlog',
  };
}

function hasExactImportOrigin(item: BacklogItem, origin: BacklogImportOrigin): boolean {
  return (
    item.importOrigin?.kind === origin.kind &&
    item.importOrigin.projectId === origin.projectId &&
    item.importOrigin.featureId === origin.featureId &&
    item.importOrigin.source === origin.source
  );
}

function isManagedImportItem(item: BacklogItem, projectId: string, featureId: string): boolean {
  return (
    item.importOrigin?.kind === 'external-project-catalog' &&
    item.importOrigin.projectId === projectId &&
    item.importOrigin.featureId === featureId &&
    (item.importOrigin.source === 'docs-backlog' || item.importOrigin.source === 'extension-catalog')
  );
}

interface AdoptImportOriginRequest {
  readonly expectedFeatureId: string;
  readonly expectedUpdatedAt: number;
  readonly reason: string;
  readonly confirmation: string;
}

function parseAdoptImportOriginRequest(body: unknown): AdoptImportOriginRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const candidate = body as Record<string, unknown>;
  if (
    typeof candidate.expectedFeatureId !== 'string' ||
    !/^(?:F\d{3}|EXT-\d{3})$/i.test(candidate.expectedFeatureId.trim()) ||
    typeof candidate.expectedUpdatedAt !== 'number' ||
    !Number.isSafeInteger(candidate.expectedUpdatedAt) ||
    candidate.expectedUpdatedAt < 0 ||
    typeof candidate.reason !== 'string' ||
    candidate.reason.trim().length === 0 ||
    typeof candidate.confirmation !== 'string'
  ) {
    return null;
  }
  return {
    expectedFeatureId: candidate.expectedFeatureId.trim().toUpperCase(),
    expectedUpdatedAt: candidate.expectedUpdatedAt,
    reason: candidate.reason.trim(),
    confirmation: candidate.confirmation.trim(),
  };
}

interface RetireBacklogItemRequest {
  readonly expectedFeatureId: string;
  readonly expectedUpdatedAt: number;
  readonly reason: string;
  readonly mode: 'import-reconciliation' | 'operator-confirmed';
  readonly confirmation?: string;
}

function parseRetireBacklogItemRequest(body: unknown): RetireBacklogItemRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const candidate = body as Record<string, unknown>;
  if (
    typeof candidate.expectedFeatureId !== 'string' ||
    !/^(?:F\d{3}|EXT-\d{3})$/i.test(candidate.expectedFeatureId.trim()) ||
    typeof candidate.expectedUpdatedAt !== 'number' ||
    !Number.isSafeInteger(candidate.expectedUpdatedAt) ||
    candidate.expectedUpdatedAt < 0 ||
    typeof candidate.reason !== 'string' ||
    candidate.reason.trim().length === 0 ||
    (candidate.mode !== 'import-reconciliation' && candidate.mode !== 'operator-confirmed') ||
    (candidate.confirmation !== undefined && typeof candidate.confirmation !== 'string')
  ) {
    return null;
  }
  return {
    expectedFeatureId: candidate.expectedFeatureId.trim().toUpperCase(),
    expectedUpdatedAt: candidate.expectedUpdatedAt,
    reason: candidate.reason.trim(),
    mode: candidate.mode,
    ...(typeof candidate.confirmation === 'string' ? { confirmation: candidate.confirmation.trim() } : {}),
  };
}

export const externalProjectRoutes: FastifyPluginAsync<ExternalProjectRoutesOptions> = async (app, opts) => {
  const { externalProjectStore, needAuditFrameStore, backlogStore } = opts;

  /** Returns userId or sends 401 and returns null */
  function requireUserId(request: FastifyRequest, reply: FastifyReply): string | null {
    const userId = resolveHeaderUserId(request) ?? undefined;
    if (!userId) {
      void reply.status(401).send({ error: 'Identity required' });
      return null;
    }
    return userId;
  }

  /** Resolves project with ownership check. Returns project or sends 404 and returns null. */
  async function requireOwnedProject(id: string, userId: string, reply: FastifyReply): Promise<ExternalProject | null> {
    const project = await externalProjectStore.getById(id);
    if (!project || project.userId !== userId) {
      void reply.status(404).send({ error: 'Project not found' });
      return null;
    }
    return project;
  }

  // --- External Project CRUD ---

  app.post('/api/external-projects', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const body = request.body as {
      name?: string;
      description?: string;
      sourcePath?: string;
      backlogPath?: string;
      desktopDevelopment?: CreateDesktopDevelopmentProjectBindingInput;
    };
    if (!body.name || !body.sourcePath) {
      return reply.status(400).send({ error: 'name and sourcePath are required' });
    }
    try {
      const project = await externalProjectStore.create(userId, {
        name: body.name,
        description: body.description ?? '',
        sourcePath: body.sourcePath,
        ...(body.backlogPath ? { backlogPath: body.backlogPath } : {}),
        ...(body.desktopDevelopment ? { desktopDevelopment: body.desktopDevelopment } : {}),
      });
      return reply.status(201).send({ project });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(400).send({ error: message });
    }
  });

  app.get('/api/external-projects', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const projects = await externalProjectStore.listByUser(userId);
    return reply.send({ projects });
  });

  app.get('/api/external-projects/:id', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    const project = await requireOwnedProject(id, userId, reply);
    if (!project) return;
    return reply.send({ project });
  });

  app.patch('/api/external-projects/:id/development-loop', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    if (!(await requireOwnedProject(id, userId, reply))) return;
    const body = request.body as Partial<DesktopDevelopmentPolicyUpdate>;
    if (!isValidDesktopDevelopmentVersion(body.expectedVersion)) {
      return reply.status(400).send({ error: 'expectedVersion is required' });
    }
    try {
      const project = await externalProjectStore.updateDesktopDevelopment(id, body as DesktopDevelopmentPolicyUpdate);
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      return reply.send({ project });
    } catch (error) {
      const { message, status } = describeDesktopDevelopmentUpdateError(error);
      return reply.status(status).send({ error: message });
    }
  });

  app.delete('/api/external-projects/:id', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    const project = await requireOwnedProject(id, userId, reply);
    if (!project) return;
    await externalProjectStore.delete(id);
    return reply.status(204).send();
  });

  app.post('/api/external-projects/:id/backlog/items', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    const project = await requireOwnedProject(id, userId, reply);
    if (!project) return;

    const parsed = createBacklogItemSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const item = await backlogStore.create({
      userId,
      projectId: project.id,
      title: parsed.data.title,
      summary: parsed.data.summary,
      priority: parsed.data.priority,
      tags: parsed.data.tags,
      createdBy: parsed.data.createdBy as CatId | 'user',
    });
    return reply.status(201).send(item);
  });

  app.post('/api/external-projects/:id/backlog/items/:backlogItemId/adopt-import-origin', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id: projectId, backlogItemId } = request.params as { id: string; backlogItemId: string };
    const project = await requireOwnedProject(projectId, userId, reply);
    if (!project) return;
    const adoption = parseAdoptImportOriginRequest(request.body);
    if (!adoption) {
      return reply.status(400).send({
        error: 'expectedFeatureId, expectedUpdatedAt, reason, and confirmation are required to adopt legacy data',
      });
    }
    if (adoption.confirmation !== `ADOPT LEGACY IMPORT ${adoption.expectedFeatureId} ${backlogItemId}`) {
      return reply.status(400).send({ error: 'Exact operator confirmation is required for legacy adoption' });
    }

    const item = await backlogStore.get(backlogItemId, userId);
    if (!item || item.projectId !== project.id) return reply.status(404).send({ error: 'Backlog item not found' });
    const itemFeatureId = getFeatureTagId(item.tags)?.toUpperCase();
    if (itemFeatureId !== adoption.expectedFeatureId) {
      return reply.status(409).send({ error: 'Backlog item feature identity changed before adoption' });
    }

    let rows: BacklogFeatureRow[];
    try {
      const markdown = await readFile(join(project.sourcePath, project.backlogPath), 'utf-8');
      const extensionRows = await readExtensionFeatureRows(
        join(project.sourcePath, DEFAULT_EXTENSION_CATALOG_RELATIVE_PATH),
      );
      rows = [...parseActiveFeaturesFromBacklog(markdown), ...extensionRows];
    } catch (error) {
      return reply.status(400).send({
        error: `Cannot verify the active project catalog: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const row = rows.find((candidate) => candidate.id.toUpperCase() === adoption.expectedFeatureId);
    if (!row)
      return reply.status(409).send({ error: `${adoption.expectedFeatureId} is not an active catalog feature` });
    const origin = importOriginFor(row, project.id);
    if (!item.tags.includes(`source:${origin.source}`)) {
      return reply.status(409).send({ error: 'Legacy backlog item source tag does not match the active catalog' });
    }
    if (item.importOrigin) {
      if (hasExactImportOrigin(item, origin)) return reply.send({ item, adopted: false });
      return reply.status(409).send({ error: 'Backlog item already has different immutable importer provenance' });
    }

    const adopted = await backlogStore.adoptImportOrigin(item.id, {
      userId,
      projectId: project.id,
      expectedUpdatedAt: adoption.expectedUpdatedAt,
      importOrigin: origin,
      adoptedBy: userId,
      reason: adoption.reason,
    });
    if (!adopted) return reply.status(409).send({ error: 'Backlog item changed before import origin adoption' });
    return reply.send({ item: adopted, adopted: true });
  });

  // --- BACKLOG import ---

  app.post('/api/external-projects/:id/import-backlog', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    const project = await requireOwnedProject(id, userId, reply);
    if (!project) return;

    const backlogFullPath = join(project.sourcePath, project.backlogPath);
    let markdown: string;
    try {
      markdown = await readFile(backlogFullPath, 'utf-8');
    } catch {
      return reply.status(400).send({ error: `Cannot read ${backlogFullPath}` });
    }

    let rows: BacklogFeatureRow[];
    try {
      const extensionRows = await readExtensionFeatureRows(
        join(project.sourcePath, DEFAULT_EXTENSION_CATALOG_RELATIVE_PATH),
      );
      rows = [...parseActiveFeaturesFromBacklog(markdown), ...extensionRows];
    } catch (error) {
      return reply.status(400).send({
        error: `Cannot read project feature catalog: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    let existingItems = await backlogStore.listByUser(userId);
    try {
      const migration = await migrateLegacyExtensionItems({
        items: existingItems,
        extensionRows: rows.filter((row) => row.kind === 'extension'),
        backlogStore,
        ...(opts.workflowSopStore ? { workflowSopStore: opts.workflowSopStore } : {}),
        userId,
        requiredImportProjectId: project.id,
      });
      existingItems = [...migration.items];
    } catch (error) {
      return reply.status(500).send({
        error: `Cannot migrate legacy extension feature IDs: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    let created = 0;
    const refreshedItemIds: string[] = [];
    let skipped = 0;
    let orphans = 0;
    const existingByFeatureId = new Map<string, BacklogItem>();
    for (const item of existingItems) {
      if (item.projectId !== project.id || item.importOrigin?.projectId !== project.id) continue;
      const featureId = item.importOrigin.featureId.toLowerCase();
      if (!existingByFeatureId.has(featureId)) {
        existingByFeatureId.set(featureId, item);
      }
    }
    for (const row of rows) {
      const featureId = row.id.toLowerCase();
      const expectedOrigin = importOriginFor(row, project.id);

      const orphanItems = existingItems.filter((item) => getFeatureTagId(item.tags) === featureId && !item.projectId);
      if (orphanItems.length > 0) {
        orphans += orphanItems.length;
      }

      // 1. Refresh importer-managed items from the current source row. Import never
      // treats an absent row as deletion evidence: source documents can be partial.
      const managedCandidate = existingByFeatureId.get(featureId);
      const existing =
        managedCandidate && hasExactImportOrigin(managedCandidate, expectedOrigin) ? managedCandidate : undefined;
      if (existing) {
        const importInput = buildBacklogInputFromFeature(row, userId);
        const mappedStatus = featureStatusToBacklogStatus(row.status);
        const needsStatusUpgrade = existing.status === 'open' && mappedStatus !== 'open';
        const shouldRefresh =
          existing.title !== importInput.title ||
          existing.summary !== importInput.summary ||
          existing.priority !== importInput.priority ||
          !sameTags(existing.tags, importInput.tags) ||
          needsStatusUpgrade;
        if (!shouldRefresh) {
          skipped++;
          continue;
        }

        const refreshed = await backlogStore.refreshMetadata(existing.id, {
          title: importInput.title,
          summary: importInput.summary,
          priority: importInput.priority,
          tags: importInput.tags,
          ...(existing.dependencies ? { dependencies: existing.dependencies } : {}),
          ...(needsStatusUpgrade ? { importStatus: mappedStatus } : {}),
          refreshedBy: userId,
        });
        if (!refreshed) {
          skipped++;
          continue;
        }
        existingByFeatureId.set(featureId, refreshed);
        refreshedItemIds.push(refreshed.id);
        continue;
      }

      // 2. A locally created item may use this feature tag. Preserve it rather
      // than replace it with an importer-owned duplicate.
      const hasBoundItem = existingItems.some(
        (item) => item.projectId === project.id && getFeatureTagId(item.tags) === featureId,
      );
      if (hasBoundItem) {
        skipped++;
        continue;
      }

      // 3. Orphan items exist for this featureId but lack provenance evidence.
      //    Do NOT auto-backfill in the hot path — cross-project misattribution risk;
      //    create a project-bound replacement instead so imports repair visibility
      //    without mutating historical items that may belong to another project.
      if (orphanItems.length > 0) {
        const input = buildBacklogInputFromFeature(row, userId);
        const imported = await backlogStore.create({
          ...input,
          projectId: project.id,
          importOrigin: importOriginFor(row, project.id),
        });
        existingByFeatureId.set(featureId, imported);
        created++;
        continue;
      }

      // 4. Create new item
      const input = buildBacklogInputFromFeature(row, userId);
      const imported = await backlogStore.create({
        ...input,
        projectId: project.id,
        importOrigin: importOriginFor(row, project.id),
      });
      existingByFeatureId.set(featureId, imported);
      created++;
    }

    return reply.send({
      imported: created,
      refreshed: refreshedItemIds.length,
      skipped,
      total: rows.length,
      orphans,
      refreshedItemIds,
    });
  });

  app.delete('/api/external-projects/:id/backlog/items/:backlogItemId', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id: projectId, backlogItemId } = request.params as { id: string; backlogItemId: string };
    const project = await requireOwnedProject(projectId, userId, reply);
    if (!project) return;

    const retireRequest = parseRetireBacklogItemRequest(request.body);
    if (!retireRequest) {
      return reply.status(400).send({
        error:
          'expectedFeatureId, expectedUpdatedAt, reason, and mode are required to permanently remove a backlog item',
      });
    }

    const item = await backlogStore.get(backlogItemId, userId);
    if (!item || item.projectId !== project.id) {
      return reply.status(404).send({ error: 'Backlog item not found' });
    }
    const itemFeatureId = getFeatureTagId(item.tags)?.toUpperCase();
    if (!itemFeatureId || itemFeatureId !== retireRequest.expectedFeatureId) {
      return reply.status(409).send({ error: 'Backlog item feature identity changed before it could be removed' });
    }
    const importReconciliation = retireRequest.mode === 'import-reconciliation';
    if (importReconciliation && !isManagedImportItem(item, project.id, retireRequest.expectedFeatureId)) {
      return reply.status(409).send({ error: 'Backlog item has no immutable importer provenance' });
    }
    if (
      !importReconciliation &&
      retireRequest.confirmation !== `PERMANENTLY DELETE ${retireRequest.expectedFeatureId} ${item.id}`
    ) {
      return reply.status(400).send({ error: 'Exact operator confirmation is required for a manual retirement' });
    }

    // Importer tags are editable backlog data, not deletion authority. The current
    // project catalogs are the source of truth for whether a feature is retired.
    let activeRows: BacklogFeatureRow[];
    try {
      const markdown = await readFile(join(project.sourcePath, project.backlogPath), 'utf-8');
      const extensionRows = await readExtensionFeatureRows(
        join(project.sourcePath, DEFAULT_EXTENSION_CATALOG_RELATIVE_PATH),
      );
      activeRows = [...parseActiveFeaturesFromBacklog(markdown), ...extensionRows];
    } catch (error) {
      return reply.status(400).send({
        error: `Cannot verify the active project catalog: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (activeRows.some((row) => row.id.toUpperCase() === retireRequest.expectedFeatureId)) {
      return reply
        .status(409)
        .send({ error: `${retireRequest.expectedFeatureId} is still present in the active project catalog` });
    }

    if (!opts.threadStore || !opts.backlogRetirementStore || !opts.workflowSopStore) {
      return reply.status(503).send({ error: 'Required stores unavailable; cannot safely remove backlog item' });
    }
    // RedisThreadStore.list() also repairs a missing user-thread index. Feed the
    // repaired snapshot into the atomic transaction while the Lua script scans
    // the live index again, closing both historical-index and concurrent-link gaps.
    const ownerThreads = await opts.threadStore.list(userId);
    const ownerThreadIds = new Set(ownerThreads.map((thread) => thread.id));
    const primaryThreadIds = [...new Set([item.pendingThreadId, item.dispatchedThreadId].filter(Boolean))] as string[];
    for (const threadId of primaryThreadIds) {
      const thread = await opts.threadStore.get(threadId);
      if (thread?.backlogItemId === item.id && !ownerThreadIds.has(threadId)) {
        return reply.status(409).send({ error: 'Backlog item is linked to a thread outside the current user scope' });
      }
    }
    const candidateThreadIds = [
      ...new Set([
        ...ownerThreads.filter((thread) => thread.backlogItemId === item.id).map((thread) => thread.id),
        ...primaryThreadIds,
      ]),
    ];
    const workflowSop = await opts.workflowSopStore.get(item.id);
    const retirement = await opts.backlogRetirementStore.retire({
      itemId: item.id,
      userId,
      projectId: project.id,
      expectedUpdatedAt: retireRequest.expectedUpdatedAt,
      ...(importReconciliation && item.importOrigin ? { requiredImportOrigin: item.importOrigin } : {}),
      expectedWorkflowSop: workflowSop,
      candidateThreadIds,
    });
    if (retirement !== 'deleted') {
      return reply.status(retirement === 'missing' ? 404 : 409).send({
        error: `Backlog retirement rejected: ${retirement}`,
      });
    }

    app.log.info(
      {
        projectId: project.id,
        backlogItemId: item.id,
        featureId: retireRequest.expectedFeatureId,
        mode: retireRequest.mode,
        reason: retireRequest.reason,
      },
      'Permanently removed retired project backlog item',
    );
    return reply.status(204).send();
  });

  // --- Need Audit Frame routes ---

  app.post('/api/external-projects/:projectId/frame', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!(await requireOwnedProject(projectId, userId, reply))) return;

    const body = request.body as Record<string, unknown>;
    try {
      const frame = needAuditFrameStore.upsert(projectId, {
        sponsor: (body.sponsor as string) ?? '',
        motivation: (body.motivation as string) ?? '',
        successMetric: (body.successMetric as string) ?? '',
        constraints: (body.constraints as string) ?? '',
        currentWorkflow: (body.currentWorkflow as string) ?? '',
        provenanceMap: (body.provenanceMap as string) ?? '',
      });
      return reply.send({ frame });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(400).send({ error: message });
    }
  });

  app.get('/api/external-projects/:projectId/frame', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { projectId } = request.params as { projectId: string };
    if (!(await requireOwnedProject(projectId, userId, reply))) return;
    const frame = needAuditFrameStore.getByProject(projectId);
    if (!frame) return reply.status(404).send({ error: 'Audit frame not found' });
    return reply.send({ frame });
  });
};

function isValidDesktopDevelopmentVersion(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function describeDesktopDevelopmentUpdateError(error: unknown): { message: string; status: 400 | 409 } {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return { message, status: /version conflict/i.test(message) ? 409 : 400 };
}
