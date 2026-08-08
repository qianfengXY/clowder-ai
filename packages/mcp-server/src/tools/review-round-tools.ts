import { z } from 'zod';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';
import { callbackGet, callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('review-round-tools.ts', undefined, {
  resourceFamily: 'review-round',
  authority: 'callback-thread',
});

const idSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const findingSchema = z
  .object({
    severity: z.enum(['P1', 'P2', 'P3']),
    title: z.string().min(1).max(500),
    details: z.string().min(1).max(10_000),
    evidence: z.array(z.string().min(1).max(2_000)).max(100).optional(),
  })
  .strict();

export const reviewRoundReadInputSchema = {
  roundId: idSchema.describe('ReviewRound id from the project Review Hub request.'),
};

export const reviewDraftSubmitInputSchema = {
  ...reviewRoundReadInputSchema,
  expectedDraftVersion: z.number().int().nonnegative(),
  idempotencyKey: idSchema,
  verdict: z.enum(['approve', 'findings']),
  findings: z.array(findingSchema).max(200),
};

export const reviewStageFinishInputSchema = {
  ...reviewRoundReadInputSchema,
  expectedRoundVersion: z.number().int().positive(),
  idempotencyKey: idSchema,
};

export const reviewConsensusPublishInputSchema = {
  ...reviewStageFinishInputSchema,
  expectedManagedWorkVersion: z.number().int().positive(),
  verdict: z.enum(['changes_requested', 'approved']),
  checksPassed: z.boolean(),
  findings: z.array(findingSchema).max(200),
  resolvedFindingIds: z.array(idSchema).max(200),
};

type FindingInput = {
  severity: 'P1' | 'P2' | 'P3';
  title: string;
  details: string;
  evidence?: string[];
};

type ReviewRoundReadInput = { roundId: string };
type ReviewDraftSubmitInput = ReviewRoundReadInput & {
  expectedDraftVersion: number;
  idempotencyKey: string;
  verdict: 'approve' | 'findings';
  findings: FindingInput[];
};
type ReviewStageFinishInput = ReviewRoundReadInput & {
  expectedRoundVersion: number;
  idempotencyKey: string;
};
type ReviewConsensusPublishInput = ReviewStageFinishInput & {
  expectedManagedWorkVersion: number;
  verdict: 'changes_requested' | 'approved';
  checksPassed: boolean;
  findings: FindingInput[];
  resolvedFindingIds: string[];
};

function roundPath(roundId: string, suffix = ''): string {
  return `/api/callbacks/review-rounds/${encodeURIComponent(roundId)}${suffix}`;
}

export async function handleReviewRoundRead(input: ReviewRoundReadInput): Promise<ToolResult> {
  return callbackGet(roundPath(input.roundId));
}

export async function handleReviewPrivateDraftRead(input: ReviewRoundReadInput): Promise<ToolResult> {
  return callbackGet(roundPath(input.roundId, '/private-draft'));
}

export async function handleReviewBarrierDraftsRead(input: ReviewRoundReadInput): Promise<ToolResult> {
  return callbackGet(roundPath(input.roundId, '/barrier-drafts'));
}

export async function handleReviewDraftSubmit(input: ReviewDraftSubmitInput): Promise<ToolResult> {
  const { roundId, ...body } = input;
  return callbackPost(roundPath(roundId, '/draft'), body);
}

export async function handleReviewIndependentFinish(input: ReviewStageFinishInput): Promise<ToolResult> {
  const { roundId, ...body } = input;
  return callbackPost(roundPath(roundId, '/finish-independent'), body);
}

export async function handleReviewCrossFinish(input: ReviewStageFinishInput): Promise<ToolResult> {
  const { roundId, ...body } = input;
  return callbackPost(roundPath(roundId, '/finish-cross-review'), body);
}

export async function handleReviewConsensusPublish(input: ReviewConsensusPublishInput): Promise<ToolResult> {
  const { roundId, ...body } = input;
  return callbackPost(roundPath(roundId, '/consensus'), body);
}

const runtimeProfiles = ['full'] as const;

export const reviewRoundTools = [
  defineTool({
    name: 'cat_cafe_review_round_read',
    description:
      'Read the barrier-safe state and consensus findings for one exact-SHA ReviewRound. ' +
      'The server derives reviewer, owner, and project Review Hub from callback authentication.',
    inputSchema: reviewRoundReadInputSchema,
    handler: handleReviewRoundRead,
    governance: {
      implementationExport: 'handleReviewRoundRead',
      action: 'read-round',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles,
    },
  }),
  defineTool({
    name: 'cat_cafe_review_private_draft_read',
    description:
      'Read only your own private independent-review draft before the barrier opens. Other reviewers drafts remain hidden.',
    inputSchema: reviewRoundReadInputSchema,
    handler: handleReviewPrivateDraftRead,
    governance: {
      implementationExport: 'handleReviewPrivateDraftRead',
      action: 'read-private-draft',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles,
    },
  }),
  defineTool({
    name: 'cat_cafe_review_draft_submit',
    description:
      'Create or replace your versioned private exact-SHA review draft. No other reviewer can read it before every reviewer finishes independently.',
    inputSchema: reviewDraftSubmitInputSchema,
    handler: handleReviewDraftSubmit,
    governance: {
      implementationExport: 'handleReviewDraftSubmit',
      action: 'submit-draft',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles,
    },
  }),
  defineTool({
    name: 'cat_cafe_review_independent_finish',
    description:
      'Fence your current independent draft as finished. The draft barrier opens only after every assigned reviewer finishes independently.',
    inputSchema: reviewStageFinishInputSchema,
    handler: handleReviewIndependentFinish,
    governance: {
      implementationExport: 'handleReviewIndependentFinish',
      action: 'finish-independent',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles,
    },
  }),
  defineTool({
    name: 'cat_cafe_review_barrier_drafts_read',
    description:
      'Read all assigned reviewers drafts after the independent-review barrier has opened, for explicit cross-review and corroboration.',
    inputSchema: reviewRoundReadInputSchema,
    handler: handleReviewBarrierDraftsRead,
    governance: {
      implementationExport: 'handleReviewBarrierDraftsRead',
      action: 'read-barrier-drafts',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles,
    },
  }),
  defineTool({
    name: 'cat_cafe_review_cross_finish',
    description:
      'Record that you completed cross-review against the barrier-open reviewer drafts. Consensus remains blocked until every reviewer finishes.',
    inputSchema: reviewStageFinishInputSchema,
    handler: handleReviewCrossFinish,
    governance: {
      implementationExport: 'handleReviewCrossFinish',
      action: 'finish-cross-review',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles,
    },
  }),
  defineTool({
    name: 'cat_cafe_review_consensus_publish',
    description:
      'Publish the final barrier-safe consensus for an exact-SHA round and append its canonical managed-work review evidence. ' +
      'Only the server-designated recorder in the project Review Hub can succeed; this never posts an Issue, merges, pushes, or deploys.',
    inputSchema: reviewConsensusPublishInputSchema,
    handler: handleReviewConsensusPublish,
    governance: {
      implementationExport: 'handleReviewConsensusPublish',
      action: 'publish-consensus',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles,
    },
  }),
] as const;
