/**
 * F076/F306: External Project registry and ownership-scoped BACKLOG routes
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CatId,
  CreateDesktopDevelopmentProjectBindingInput,
  DesktopDevelopmentPolicyUpdate,
  ExternalProject,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { IBacklogStore } from '../domains/cats/services/stores/ports/BacklogStore.js';
import type { IWorkflowSopStore } from '../domains/cats/services/stores/ports/WorkflowSopStore.js';
import type { ExternalProjectStore } from '../domains/projects/external-project-store.js';
import type { NeedAuditFrameStore } from '../domains/projects/need-audit-frame-store.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';
import {
  type BacklogFeatureRow,
  buildBacklogInputFromFeature,
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
  workflowSopStore?: Pick<IWorkflowSopStore, 'get' | 'upsert'>;
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
      });
      existingItems = [...migration.items];
    } catch (error) {
      return reply.status(500).send({
        error: `Cannot migrate legacy extension feature IDs: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    let created = 0;
    let skipped = 0;
    let orphans = 0;
    for (const row of rows) {
      const featureId = row.id.toLowerCase();

      const orphanItems = existingItems.filter((item) => getFeatureTagId(item.tags) === featureId && !item.projectId);
      if (orphanItems.length > 0) {
        orphans += orphanItems.length;
      }

      // 1. Current project already has this feature bound → skip
      const hasBoundItem = existingItems.some(
        (item) => item.projectId === project.id && getFeatureTagId(item.tags) === featureId,
      );
      if (hasBoundItem) {
        skipped++;
        continue;
      }

      // 2. Orphan items exist for this featureId but lack provenance evidence.
      //    Do NOT auto-backfill in the hot path — cross-project misattribution risk;
      //    create a project-bound replacement instead so imports repair visibility
      //    without mutating historical items that may belong to another project.
      if (orphanItems.length > 0) {
        const input = buildBacklogInputFromFeature(row, userId);
        await backlogStore.create({ ...input, projectId: project.id });
        created++;
        continue;
      }

      // 3. Create new item
      const input = buildBacklogInputFromFeature(row, userId);
      await backlogStore.create({ ...input, projectId: project.id });
      created++;
    }

    return reply.send({ imported: created, skipped, total: rows.length, orphans });
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
