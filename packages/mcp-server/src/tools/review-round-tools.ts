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
    severity: z.enum(['P1', 'P2', 'P3']).describe('Finding severity: P1 blocking, P2 should fix, or P3 nice to have.'),
    title: z.string().min(1).max(500).describe('Concise finding title describing the concrete defect or risk.'),
    details: z
      .string()
      .min(1)
      .max(10_000)
      .describe('Actionable technical explanation including impact and required correction.'),
    evidence: z
      .array(z.string().min(1).max(2_000))
      .max(100)
      .optional()
      .describe('Optional exact file, line, test, command, or runtime evidence references.'),
    designRefs: z
      .array(z.string().min(1).max(2_000))
      .min(1)
      .max(100)
      .describe('Required references to the approved feature plan or acceptance criteria that authorize this finding.'),
    scope: z
      .enum(['plan_conformance', 'architecture_decision'])
      .describe(
        'Use plan_conformance normally. Use architecture_decision only for a serious P1 architecture conflict that needs user approval.',
      ),
  })
  .strict()
  .superRefine((finding, context) => {
    if (finding.scope === 'architecture_decision' && finding.severity !== 'P1') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Architecture decisions must use P1 severity' });
    }
  })
  .describe('One severity-ranked review finding for the immutable exact SHA.');

export const reviewRoundReadInputSchema = {
  roundId: idSchema.describe('ReviewRound id from the project Review Hub request.'),
};

export const reviewDraftSubmitInputSchema = {
  ...reviewRoundReadInputSchema,
  expectedDraftVersion: z
    .number()
    .int()
    .nonnegative()
    .describe('Last observed private draft version; use 0 for the first draft.'),
  idempotencyKey: idSchema.describe('Stable retry key unique to this private draft write.'),
  verdict: z.enum(['approve', 'findings']).describe('Independent verdict for the exact SHA: approve or findings.'),
  findings: z.array(findingSchema).max(200).describe('Independent findings; must be empty when verdict is approve.'),
};

export const reviewStageFinishInputSchema = {
  ...reviewRoundReadInputSchema,
  expectedRoundVersion: z.number().int().positive().describe('Last observed ReviewRound version for CAS.'),
  idempotencyKey: idSchema.describe('Stable retry key unique to this stage-finish operation.'),
};

export const reviewConsensusPublishInputSchema = {
  ...reviewStageFinishInputSchema,
  expectedManagedWorkVersion: z
    .number()
    .int()
    .positive()
    .describe('Last observed F275 managed-work version for evidence CAS.'),
  verdict: z
    .enum(['changes_requested', 'approved'])
    .describe('Final barrier-safe consensus verdict for the exact SHA.'),
  checksPassed: z.boolean().describe('Whether the recorder verified the required checks for the exact SHA.'),
  findings: z.array(findingSchema).max(200).describe('Canonical consensus findings for this round.'),
  resolvedFindingIds: z
    .array(idSchema)
    .max(200)
    .describe('Stable finding ids from earlier rounds proven closed by this exact SHA.'),
};

type FindingInput = {
  severity: 'P1' | 'P2' | 'P3';
  title: string;
  details: string;
  evidence?: string[];
  designRefs: string[];
  scope: 'plan_conformance' | 'architecture_decision';
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
      'Use when: a Review Hub turn needs the current phase, roster-safe state, or completed consensus. ' +
      'NOT for: reading private drafts before the barrier, changing the round, or supplying reviewer identity. ' +
      'Output: callback-scoped ReviewRound state and only barrier-safe findings.',
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
      "Read only the authenticated reviewer's private independent-review draft. " +
      'Use when: resuming or verifying your own draft before finishing the independent stage. ' +
      'NOT for: reading another reviewer, cross-review, or consensus publication. ' +
      'Output: your current private draft and version; other reviewers remain hidden.',
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
      "Create or replace the authenticated reviewer's versioned private exact-SHA draft. " +
      'Use when: independent review has produced a complete approve verdict or severity-ranked findings. ' +
      'NOT for: finishing the stage, reading peers, publishing consensus, or reviewing a different SHA. ' +
      'Output: the updated private draft and draft version; peers cannot read it before the barrier. ' +
      'After the stage is finished, the user-visible reply must follow the Review Hub shared two-table Markdown contract; do not replace it with prose.',
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
      "Fence the authenticated reviewer's current independent draft as finished. " +
      'Use when: your private draft is final and must count toward opening the independent-review barrier. ' +
      'NOT for: submitting a draft, skipping another reviewer, cross-review, or publishing consensus. ' +
      'Output: updated round phase/version; the barrier opens only after every assigned reviewer finishes. ' +
      'The user-visible reply must follow the Review Hub shared two-table Markdown contract and include only this reviewer before the barrier.',
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
      'Read all assigned reviewer drafts after the independent barrier opens. ' +
      'Use when: performing explicit cross-review, corroboration, and contradiction checks. ' +
      'NOT for: pre-barrier access, editing drafts, or publishing consensus. ' +
      'Output: the barrier-open set of immutable independent drafts.',
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
      'Record that the authenticated reviewer completed cross-review of the barrier-open drafts. ' +
      'Use when: you compared every independent draft and resolved corroborations or contradictions. ' +
      'NOT for: independent review, draft submission, or unilateral consensus. ' +
      'Output: updated round phase/version; consensus remains blocked until every reviewer finishes. ' +
      'The user-visible reply must follow the Review Hub shared two-table Markdown contract and keep one row per assessed finding.',
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
      'Use when: all reviewers finished cross-review and the server-designated recorder has the canonical verdict, checks, findings, and resolved ids. ' +
      'NOT for: non-recorders, pre-barrier publication, GitHub Issues, Git merge, push, deploy, or project-specific publication policy. ' +
      'Output: completed ReviewRound consensus, durable findings, and canonical F275 review evidence. ' +
      'The user-visible reply must follow the Review Hub shared two-table Markdown contract, including rejected or resolved rows.',
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
