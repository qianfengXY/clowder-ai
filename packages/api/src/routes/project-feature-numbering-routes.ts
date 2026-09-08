import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CatId, ExternalProject } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IBacklogStore } from '../domains/cats/services/stores/ports/BacklogStore.js';
import { ProjectFeatureNumberError } from '../domains/cats/services/stores/shared/project-feature-numbering.js';
import { parseActiveFeaturesFromBacklog } from './backlog-doc-import.js';
import { createBacklogItemSchema } from './backlog-request-schemas.js';

const assignmentSchema = z
  .object({
    featureId: z
      .string()
      .regex(/^F\d{3}$/i)
      .transform((id) => id.toUpperCase()),
    expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

async function reservedFeatureIds(project: ExternalProject): Promise<string[]> {
  let markdown: string;
  try {
    markdown = await readFile(join(project.sourcePath, project.backlogPath), 'utf8');
  } catch (error) {
    // A newly registered project need not have a catalog yet. Other read failures are not an empty catalog.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return parseActiveFeaturesFromBacklog(markdown).map((row) => row.id);
}

interface Options {
  backlogStore: IBacklogStore;
  requireUserId: (request: FastifyRequest, reply: FastifyReply) => string | null;
  requireOwnedProject: (id: string, userId: string, reply: FastifyReply) => Promise<ExternalProject | null>;
}

export function registerProjectFeatureNumberingRoutes(app: FastifyInstance, options: Options): void {
  const { backlogStore, requireUserId, requireOwnedProject } = options;
  app.post('/api/external-projects/:id/backlog/items', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    const project = await requireOwnedProject(id, userId, reply);
    if (!project) return;
    const parsed = createBacklogItemSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    try {
      const item = await backlogStore.create({
        userId,
        projectId: project.id,
        title: parsed.data.title,
        summary: parsed.data.summary,
        priority: parsed.data.priority,
        tags: parsed.data.tags,
        createdBy: parsed.data.createdBy as CatId | 'user',
        projectFeatureNumbering: { reservedFeatureIds: await reservedFeatureIds(project) },
      });
      return reply.status(201).send(item);
    } catch (error) {
      if (error instanceof ProjectFeatureNumberError) {
        return reply.status(409).send({ error: error.message, code: 'project_feature_number_conflict' });
      }
      throw error;
    }
  });

  app.patch('/api/external-projects/:id/backlog/items/:backlogItemId/feature-id', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id, backlogItemId } = request.params as { id: string; backlogItemId: string };
    const project = await requireOwnedProject(id, userId, reply);
    if (!project) return;
    const parsed = assignmentSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    const existing = await backlogStore.get(backlogItemId, userId);
    if (!existing || existing.projectId !== project.id)
      return reply.status(404).send({ error: 'Backlog item not found' });
    try {
      const item = await backlogStore.assignProjectFeatureId(backlogItemId, {
        ...parsed.data,
        userId,
        projectId: project.id,
        reservedFeatureIds: await reservedFeatureIds(project),
      });
      return reply.send({ item });
    } catch (error) {
      if (error instanceof ProjectFeatureNumberError) {
        return reply.status(409).send({ error: error.message, code: 'project_feature_number_conflict' });
      }
      throw error;
    }
  });
}
