import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ProjectReviewHubService } from '../domains/projects/project-review-hub-service.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface DesktopDevelopmentLoopRoutesOptions {
  projectReviewHubService: ProjectReviewHubService;
}

export const desktopDevelopmentLoopRoutes: FastifyPluginAsync<DesktopDevelopmentLoopRoutesOptions> = async (
  app,
  { projectReviewHubService },
) => {
  function requireUserId(request: FastifyRequest, reply: FastifyReply): string | null {
    const userId = resolveHeaderUserId(request) ?? undefined;
    if (!userId) {
      void reply.status(401).send({ error: 'Identity required' });
      return null;
    }
    return userId;
  }

  app.post('/api/external-projects/:id/development-loop/review-hub', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return;
    const { id } = request.params as { id: string };
    try {
      const reviewHub = await projectReviewHubService.ensureForProject(id, userId);
      return reply.send({ reviewHub });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const status = /Project not found/i.test(message) ? 404 : /not configured/i.test(message) ? 409 : 400;
      return reply.status(status).send({ error: message });
    }
  });
};
