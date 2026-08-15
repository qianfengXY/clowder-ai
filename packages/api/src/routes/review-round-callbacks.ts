import type { CatId } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ReviewRoundCoordinatorService } from '../domains/desktop-development-loop/review-round-coordinator-service.js';
import {
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackAuth,
} from './callback-auth-prehandler.js';

export interface ReviewRoundCallbackRoutesOptions {
  registry: CallbackAuthRegistry;
  coordinator?: ReviewRoundCoordinatorService;
}

const idSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const paramsSchema = z.object({ roundId: idSchema }).strict();
const findingSchema = z
  .object({
    severity: z.enum(['P1', 'P2', 'P3']),
    title: z.string().min(1).max(500),
    details: z.string().min(1).max(10_000),
    evidence: z.array(z.string().min(1).max(2_000)).max(100).optional(),
    designRefs: z.array(z.string().min(1).max(2_000)).min(1).max(100),
    scope: z.enum(['plan_conformance', 'architecture_decision']),
  })
  .strict()
  .superRefine((finding, context) => {
    if (finding.scope === 'architecture_decision' && finding.severity !== 'P1') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Architecture decisions must use P1 severity' });
    }
  });
const draftSchema = z
  .object({
    expectedDraftVersion: z.number().int().nonnegative(),
    idempotencyKey: idSchema,
    verdict: z.enum(['approve', 'findings']),
    findings: z.array(findingSchema).max(200),
  })
  .strict();
const finishSchema = z
  .object({
    expectedRoundVersion: z.number().int().positive(),
    idempotencyKey: idSchema,
  })
  .strict();
const consensusSchema = finishSchema
  .extend({
    expectedManagedWorkVersion: z.number().int().positive(),
    verdict: z.enum(['changes_requested', 'approved']),
    checksPassed: z.boolean(),
    findings: z.array(findingSchema).max(200),
    resolvedFindingIds: z.array(idSchema).max(200),
  })
  .strict();

export const reviewRoundCallbackRoutes: FastifyPluginAsync<ReviewRoundCallbackRoutesOptions> = async (app, options) => {
  registerCallbackAuthHook(app, options.registry);

  function requirePrincipal(request: FastifyRequest, reply: FastifyReply) {
    const record = requireCallbackAuth(request, reply);
    if (!record) return null;
    if (!options.coordinator) {
      void reply.status(503).send({ error: 'Review coordination is unavailable' });
      return null;
    }
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      void reply.status(400).send({ error: 'Invalid ReviewRound identifier', details: params.error.issues });
      return null;
    }
    return {
      coordinator: options.coordinator,
      principal: {
        ownerUserId: record.userId,
        threadId: record.threadId,
        reviewerCatId: record.catId as CatId,
        roundId: params.data.roundId,
      },
    };
  }

  function sendError(reply: FastifyReply, error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = /not found/i.test(message)
      ? 404
      : /restricted|not a reviewer/i.test(message)
        ? 403
        : /version|phase|barrier|consensus|recorder|conflict|already/i.test(message)
          ? 409
          : 400;
    return reply.status(status).send({ error: message });
  }

  app.get('/api/callbacks/review-rounds/:roundId', async (request, reply) => {
    const auth = requirePrincipal(request, reply);
    if (!auth) return;
    try {
      return reply.send(await auth.coordinator.readSafe(auth.principal));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/callbacks/review-rounds/:roundId/private-draft', async (request, reply) => {
    const auth = requirePrincipal(request, reply);
    if (!auth) return;
    try {
      return reply.send(await auth.coordinator.readPrivateDraft(auth.principal));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/api/callbacks/review-rounds/:roundId/barrier-drafts', async (request, reply) => {
    const auth = requirePrincipal(request, reply);
    if (!auth) return;
    try {
      return reply.send(await auth.coordinator.readBarrierDrafts(auth.principal));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/callbacks/review-rounds/:roundId/draft', async (request, reply) => {
    const auth = requirePrincipal(request, reply);
    if (!auth) return;
    const body = draftSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'Invalid request body', details: body.error.issues });
    try {
      return reply.send(await auth.coordinator.submitDraft({ ...auth.principal, ...body.data }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/callbacks/review-rounds/:roundId/finish-independent', async (request, reply) => {
    const auth = requirePrincipal(request, reply);
    if (!auth) return;
    const body = finishSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'Invalid request body', details: body.error.issues });
    try {
      return reply.send(await auth.coordinator.finishIndependent({ ...auth.principal, ...body.data }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/callbacks/review-rounds/:roundId/finish-cross-review', async (request, reply) => {
    const auth = requirePrincipal(request, reply);
    if (!auth) return;
    const body = finishSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'Invalid request body', details: body.error.issues });
    try {
      return reply.send(await auth.coordinator.finishCrossReview({ ...auth.principal, ...body.data }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/api/callbacks/review-rounds/:roundId/consensus', async (request, reply) => {
    const auth = requirePrincipal(request, reply);
    if (!auth) return;
    const body = consensusSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'Invalid request body', details: body.error.issues });
    try {
      return reply.send(await auth.coordinator.publishConsensus({ ...auth.principal, ...body.data }));
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
