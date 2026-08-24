import type { FeatureDocDetail } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import {
  parseFeatureDocDependencies,
  parseFeatureDocOwner,
  parseFeatureDocPhases,
  parseFeatureDocRisks,
  parseFeatureDocStatus,
} from './backlog-doc-import.js';
import { EXTENSION_FEATURE_ID_PATTERN, readExtensionFeatureDocContent } from './extension-feature-catalog.js';
import { gitListFeatureDocs, readFeatureDocContent } from './git-doc-reader.js';

export const featureDocDetailRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { featureId: string } }>(
    '/api/backlog/feature-doc-detail',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['featureId'],
          properties: { featureId: { type: 'string', pattern: '^(?:F\\d{3}|EXT-\\d{3})$' } },
        },
      },
    },
    async (request, reply) => {
      const { featureId } = request.query;
      const normalizedId = featureId.toUpperCase();

      let docFile = normalizedId;
      let content: string | null;
      if (EXTENSION_FEATURE_ID_PATTERN.test(normalizedId)) {
        content = await readExtensionFeatureDocContent(normalizedId);
      } else {
        const docs = await gitListFeatureDocs();
        const canonicalDocFile = docs.find((f) => f.toUpperCase().startsWith(normalizedId));
        if (!canonicalDocFile) {
          reply.status(404);
          return { error: `Feature doc not found for ${featureId}` };
        }
        docFile = canonicalDocFile;
        content = await readFeatureDocContent(canonicalDocFile);
      }
      if (!content) {
        reply.status(404);
        return { error: `Could not read feature doc ${docFile}` };
      }

      const detail: FeatureDocDetail = {
        featureId: normalizedId,
        status: parseFeatureDocStatus(content),
        owner: parseFeatureDocOwner(content),
        phases: parseFeatureDocPhases(content),
        risks: parseFeatureDocRisks(content),
        dependencies: parseFeatureDocDependencies(content),
      };

      return detail;
    },
  );
};
