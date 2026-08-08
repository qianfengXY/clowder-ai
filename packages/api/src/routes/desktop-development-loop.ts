import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DesktopDevelopmentLoopService } from '../domains/desktop-development-loop/desktop-development-loop-service.js';
import type { ProjectReviewHubService } from '../domains/projects/project-review-hub-service.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface DesktopDevelopmentLoopRoutesOptions {
  projectReviewHubService: ProjectReviewHubService;
  desktopDevelopmentLoopService?: DesktopDevelopmentLoopService;
  desktopDevelopmentToken?: string;
  desktopDevelopmentOwnerUserId?: string;
}

const idSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const fullShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);
const protocolSchema = z.coerce.number().int().positive();
const repositorySchema = z
  .object({
    host: z.literal('github.com'),
    owner: z.string().min(1).max(39),
    name: z.string().min(1).max(100),
    fullName: z.string().min(3).max(140),
  })
  .strict();
const workspaceSchema = z
  .object({
    repository: repositorySchema,
    branch: z.string().min(1).max(244),
    baseSha: fullShaSchema,
    currentSha: fullShaSchema,
    lastCommittedSha: fullShaSchema,
    worktreePresent: z.boolean(),
    worktreePath: z.string().min(1).max(4096),
    validatedAt: z.number().int().positive(),
  })
  .strict();
const commonMutationSchema = {
  protocolVersion: protocolSchema,
  projectId: idSchema,
  workId: idSchema,
  attemptId: idSchema,
  runtimeSessionId: idSchema,
};
const connectSchema = z
  .object({
    ...commonMutationSchema,
    chatRef: z.string().min(1).max(1000).optional(),
    expectedBindingEpoch: z.number().int().nonnegative(),
    expectedManagedWorkVersion: z.number().int().positive(),
    idempotencyKey: idSchema,
    leaseDurationMs: z.number().int().min(1_000).max(86_400_000),
    workspace: workspaceSchema,
  })
  .strict();
const heartbeatSchema = z
  .object({
    ...commonMutationSchema,
    bindingEpoch: z.number().int().positive(),
    expectedSessionVersion: z.number().int().positive(),
    idempotencyKey: idSchema,
    leaseDurationMs: z.number().int().min(1_000).max(86_400_000),
    workspace: workspaceSchema.optional(),
  })
  .strict();
const implementationSchema = z
  .object({
    ...commonMutationSchema,
    bindingEpoch: z.number().int().positive(),
    expectedManagedWorkVersion: z.number().int().positive(),
    exactSha: fullShaSchema,
    idempotencyKey: idSchema,
  })
  .strict();
const mergeConfirmationSchema = z
  .object({
    ...commonMutationSchema,
    bindingEpoch: z.number().int().positive(),
    expectedManagedWorkVersion: z.number().int().positive(),
    exactSha: fullShaSchema,
    idempotencyKey: idSchema,
  })
  .strict();
const mergeReportSchema = mergeConfirmationSchema
  .extend({
    mergeCommitSha: fullShaSchema,
  })
  .strict();
const acceptanceSchema = z
  .object({
    protocolVersion: protocolSchema,
    attemptId: idSchema,
    expectedManagedWorkVersion: z.number().int().positive(),
    exactSha: fullShaSchema,
    accepted: z.boolean(),
    idempotencyKey: idSchema,
  })
  .strict();

export const desktopDevelopmentLoopRoutes: FastifyPluginAsync<DesktopDevelopmentLoopRoutesOptions> = async (
  app,
  options,
) => {
  const {
    projectReviewHubService,
    desktopDevelopmentLoopService,
    desktopDevelopmentToken,
    desktopDevelopmentOwnerUserId,
  } = options;

  function requireUserId(request: FastifyRequest, reply: FastifyReply): string | null {
    const userId = resolveHeaderUserId(request) ?? undefined;
    if (!userId) {
      void reply.status(401).send({ error: 'Identity required' });
      return null;
    }
    return userId;
  }

  function requireDesktopPrincipal(request: FastifyRequest, reply: FastifyReply): string | null {
    if (!desktopDevelopmentLoopService || !desktopDevelopmentToken || !desktopDevelopmentOwnerUserId) {
      void reply.status(503).send({ error: 'Desktop development authentication is not configured' });
      return null;
    }
    const authorization = request.headers.authorization;
    const provided = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (!secretsEqual(desktopDevelopmentToken, provided)) {
      void reply.status(401).send({ error: 'Invalid or missing Desktop development token' });
      return null;
    }
    return desktopDevelopmentOwnerUserId;
  }

  function sendError(reply: FastifyReply, error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = /not found/i.test(message)
      ? 404
      : /protocol mismatch/i.test(message)
        ? 426
        : /conflict|belongs|binding|lease|configured|repository|current committed|requires/i.test(message)
          ? 409
          : 400;
    return reply.status(status).send({ error: message });
  }

  app.post('/api/external-projects/:id/development-loop/review-hub', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    try {
      const reviewHub = await projectReviewHubService.ensureForProject(id, userId);
      return reply.send({ reviewHub });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/desktop-development-loop/v1/projects/:projectId', async (request, reply) => {
    const ownerUserId = requireDesktopPrincipal(request, reply);
    if (!ownerUserId || !desktopDevelopmentLoopService) return;
    const params = z.object({ projectId: idSchema }).safeParse(request.params);
    const query = z.object({ protocolVersion: protocolSchema }).strict().safeParse(request.query);
    if (!params.success || !query.success) return reply.status(400).send({ error: 'Invalid request' });
    try {
      return reply.send(
        await desktopDevelopmentLoopService.readProject({ ...params.data, ...query.data, ownerUserId }),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/desktop-development-loop/v1/works/:workId', async (request, reply) => {
    const ownerUserId = requireDesktopPrincipal(request, reply);
    if (!ownerUserId || !desktopDevelopmentLoopService) return;
    const params = z.object({ workId: idSchema }).safeParse(request.params);
    const query = z
      .object({ protocolVersion: protocolSchema, projectId: idSchema, attemptId: idSchema })
      .strict()
      .safeParse(request.query);
    if (!params.success || !query.success) return reply.status(400).send({ error: 'Invalid request' });
    try {
      return reply.send(await desktopDevelopmentLoopService.readWork({ ...params.data, ...query.data, ownerUserId }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/desktop-development-loop/v1/connect', async (request, reply) => {
    const ownerUserId = requireDesktopPrincipal(request, reply);
    if (!ownerUserId || !desktopDevelopmentLoopService) return;
    const parsed = connectSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    try {
      return reply.send(await desktopDevelopmentLoopService.connect({ ...parsed.data, ownerUserId }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/desktop-development-loop/v1/heartbeat', async (request, reply) => {
    const ownerUserId = requireDesktopPrincipal(request, reply);
    if (!ownerUserId || !desktopDevelopmentLoopService) return;
    const parsed = heartbeatSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    try {
      return reply.send(await desktopDevelopmentLoopService.heartbeat({ ...parsed.data, ownerUserId }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/desktop-development-loop/v1/implementation', async (request, reply) => {
    const ownerUserId = requireDesktopPrincipal(request, reply);
    if (!ownerUserId || !desktopDevelopmentLoopService) return;
    const parsed = implementationSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    try {
      return reply.send(await desktopDevelopmentLoopService.reportImplementation({ ...parsed.data, ownerUserId }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/desktop-development-loop/v1/merge-confirmation', async (request, reply) => {
    const ownerUserId = requireDesktopPrincipal(request, reply);
    if (!ownerUserId || !desktopDevelopmentLoopService) return;
    const parsed = mergeConfirmationSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    try {
      return reply.send(await desktopDevelopmentLoopService.confirmMerge({ ...parsed.data, ownerUserId }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/desktop-development-loop/v1/merge-report', async (request, reply) => {
    const ownerUserId = requireDesktopPrincipal(request, reply);
    if (!ownerUserId || !desktopDevelopmentLoopService) return;
    const parsed = mergeReportSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    try {
      return reply.send(await desktopDevelopmentLoopService.reportMerged({ ...parsed.data, ownerUserId }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/external-projects/:projectId/development-loop/works/:workId/acceptance', async (request, reply) => {
    const ownerUserId = requireUserId(request, reply);
    if (!ownerUserId) return;
    if (!desktopDevelopmentLoopService) {
      return reply.status(503).send({ error: 'Desktop development loop is unavailable' });
    }
    const params = z.object({ projectId: idSchema, workId: idSchema }).strict().safeParse(request.params);
    const parsed = acceptanceSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.status(400).send({ error: 'Invalid request' });
    }
    try {
      return reply.send(
        await desktopDevelopmentLoopService.recordAcceptance({ ...params.data, ...parsed.data, ownerUserId }),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });
};

function secretsEqual(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}
