import { z } from 'zod';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('desktop-development-loop-tools.ts', undefined, {
  resourceFamily: 'desktop-development-loop',
  authority: 'provider-runtime',
});

const idSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const fullShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);
const protocolVersionSchema = z.number().int().positive().describe('Protocol version returned by project discovery.');
const repositorySchema = z
  .object({
    host: z.literal('github.com').describe('Repository host; must be exactly "github.com".'),
    owner: z.string().min(1).max(39).describe('GitHub repository owner, for example "openai".'),
    name: z.string().min(1).max(100).describe('GitHub repository name without the owner, for example "codex".'),
    fullName: z.string().min(3).max(140).describe('Canonical GitHub owner/name, for example "openai/codex".'),
  })
  .strict()
  .describe('Repository identity read from the current committed workspace.');
const workspaceSchema = z
  .object({
    repository: repositorySchema,
    branch: z.string().min(1).max(244).describe('Current Git branch name, for example "feat/f289-loop".'),
    baseSha: fullShaSchema.describe('Full 40- or 64-hex SHA used as the implementation base.'),
    currentSha: fullShaSchema.describe('Full 40- or 64-hex SHA currently checked out.'),
    lastCommittedSha: fullShaSchema.describe('Full 40- or 64-hex SHA that can be recovered after worktree loss.'),
    worktreePresent: z.boolean().describe('Whether the permanent implementation worktree currently exists.'),
    worktreePath: z
      .string()
      .min(1)
      .max(4096)
      .describe('Absolute local path to the permanent implementation worktree; never returned by the server.'),
    validatedAt: z
      .number()
      .int()
      .positive()
      .describe('Unix epoch timestamp in milliseconds when Git state was validated.'),
  })
  .strict()
  .describe('Validated committed Git workspace state for the current Desktop implementation session.');

export const developmentProjectReadInputSchema = {
  protocolVersion: protocolVersionSchema,
  projectId: idSchema.optional().describe('Exact Clowder AI project id; provide this or repository, but not both.'),
  repository: z
    .string()
    .min(3)
    .max(300)
    .optional()
    .describe(
      'GitHub owner/name or clone URL used to find the bound project; provide this or projectId, but not both.',
    ),
};

export const developmentWorkReadInputSchema = {
  protocolVersion: protocolVersionSchema,
  projectId: idSchema.describe('Clowder AI project id bound to the managed work.'),
  workId: idSchema.describe('Canonical F275 managed-work id returned by Cat Café.'),
  attemptId: idSchema.describe('Current canonical F275 attempt id for this work.'),
};

export const developmentWorkConnectInputSchema = {
  ...developmentWorkReadInputSchema,
  runtimeSessionId: idSchema.describe('Stable ChatGPT Desktop runtime session id.'),
  chatRef: z.string().min(1).max(1000).optional().describe('Optional opaque ChatGPT chat reference for recovery.'),
  expectedBindingEpoch: z
    .number()
    .int()
    .nonnegative()
    .describe('Last observed Desktop binding epoch; use 0 for the first connection.'),
  expectedManagedWorkVersion: z.number().int().positive().describe('Last observed F275 managed-work version for CAS.'),
  idempotencyKey: idSchema.describe('Stable retry key unique to this connect or rebind operation.'),
  leaseDurationMs: z
    .number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .optional()
    .describe('Deprecated protocol-v1 compatibility field. Desktop bindings are permanent and this value is ignored.'),
  workspace: workspaceSchema,
};

export const developmentWorkHeartbeatInputSchema = {
  ...developmentWorkReadInputSchema,
  runtimeSessionId: idSchema.describe('Stable ChatGPT Desktop runtime session id that owns the current binding.'),
  bindingEpoch: z.number().int().positive().describe('Current fenced Desktop binding epoch from the Resume Packet.'),
  expectedSessionVersion: z.number().int().positive().describe('Last observed session binding version for CAS.'),
  idempotencyKey: idSchema.describe('Stable retry key unique to this heartbeat operation.'),
  leaseDurationMs: z
    .number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .optional()
    .describe('Deprecated protocol-v1 compatibility field. Desktop bindings are permanent and this value is ignored.'),
  workspace: workspaceSchema.optional().describe('Optional freshly validated committed workspace state.'),
};

export const developmentImplementationReportInputSchema = {
  ...developmentWorkReadInputSchema,
  runtimeSessionId: idSchema.describe('Stable ChatGPT Desktop runtime session id that owns the current binding.'),
  bindingEpoch: z.number().int().positive().describe('Current fenced Desktop binding epoch from the Resume Packet.'),
  expectedManagedWorkVersion: z.number().int().positive().describe('Last observed F275 managed-work version for CAS.'),
  exactSha: fullShaSchema.describe('Full committed SHA currently checked out in the bound workspace.'),
  idempotencyKey: idSchema.describe('Stable retry key unique to this implementation report.'),
};

export const developmentMergeConfirmationInputSchema = {
  ...developmentWorkReadInputSchema,
  runtimeSessionId: idSchema.describe('Stable ChatGPT Desktop runtime session id that owns the current binding.'),
  bindingEpoch: z.number().int().positive().describe('Current fenced Desktop binding epoch from the Resume Packet.'),
  expectedManagedWorkVersion: z.number().int().positive().describe('Last observed F275 managed-work version for CAS.'),
  exactSha: fullShaSchema.describe('Full approved implementation SHA to which the confirmation applies.'),
  idempotencyKey: idSchema.describe('Stable retry key unique to this merge confirmation.'),
};

export const developmentMergeReportInputSchema = {
  ...developmentMergeConfirmationInputSchema,
  mergeCommitSha: fullShaSchema.describe('Full merge commit SHA produced by ChatGPT Desktop native Git tools.'),
};

type ProjectReadInput = {
  protocolVersion: number;
  projectId?: string;
  repository?: string;
};

type WorkReadInput = {
  protocolVersion: number;
  projectId: string;
  workId: string;
  attemptId: string;
};

type WorkspaceInput = {
  repository: { host: 'github.com'; owner: string; name: string; fullName: string };
  branch: string;
  baseSha: string;
  currentSha: string;
  lastCommittedSha: string;
  worktreePresent: boolean;
  worktreePath: string;
  validatedAt: number;
};

type WorkConnectInput = WorkReadInput & {
  runtimeSessionId: string;
  chatRef?: string;
  expectedBindingEpoch: number;
  expectedManagedWorkVersion: number;
  idempotencyKey: string;
  leaseDurationMs?: number;
  workspace: WorkspaceInput;
};

type WorkHeartbeatInput = WorkReadInput & {
  runtimeSessionId: string;
  bindingEpoch: number;
  expectedSessionVersion: number;
  idempotencyKey: string;
  leaseDurationMs?: number;
  workspace?: WorkspaceInput;
};

type ImplementationReportInput = WorkReadInput & {
  runtimeSessionId: string;
  bindingEpoch: number;
  expectedManagedWorkVersion: number;
  exactSha: string;
  idempotencyKey: string;
};

type MergeConfirmationInput = ImplementationReportInput;
type MergeReportInput = MergeConfirmationInput & { mergeCommitSha: string };

export async function handleDevelopmentProjectRead(input: ProjectReadInput): Promise<ToolResult> {
  const hasProjectId = Boolean(input.projectId);
  const hasRepository = Boolean(input.repository);
  if (hasProjectId === hasRepository) {
    return errorResult(
      'Invalid project selector. Expected exactly one of projectId or repository. Example: repository="owner/repo"',
    );
  }
  const query = new URLSearchParams({ protocolVersion: String(input.protocolVersion) });
  if (input.repository) {
    query.set('repository', input.repository);
    return requestDesktopLoop(`/api/desktop-development-loop/v1/projects/resolve?${query}`);
  }
  return requestDesktopLoop(
    `/api/desktop-development-loop/v1/projects/${encodeURIComponent(input.projectId ?? '')}?${query}`,
  );
}

export async function handleDevelopmentWorkRead(input: WorkReadInput): Promise<ToolResult> {
  const query = new URLSearchParams({
    protocolVersion: String(input.protocolVersion),
    projectId: input.projectId,
    attemptId: input.attemptId,
  });
  return requestDesktopLoop(`/api/desktop-development-loop/v1/works/${encodeURIComponent(input.workId)}?${query}`);
}

export async function handleDevelopmentWorkConnect(input: WorkConnectInput): Promise<ToolResult> {
  return requestDesktopLoop('/api/desktop-development-loop/v1/connect', input);
}

export async function handleDevelopmentWorkHeartbeat(input: WorkHeartbeatInput): Promise<ToolResult> {
  return requestDesktopLoop('/api/desktop-development-loop/v1/heartbeat', input);
}

export async function handleDevelopmentImplementationReport(input: ImplementationReportInput): Promise<ToolResult> {
  return requestDesktopLoop('/api/desktop-development-loop/v1/implementation', input);
}

export async function handleDevelopmentMergeConfirmationRecord(input: MergeConfirmationInput): Promise<ToolResult> {
  return requestDesktopLoop('/api/desktop-development-loop/v1/merge-confirmation', input);
}

export async function handleDevelopmentMergeReport(input: MergeReportInput): Promise<ToolResult> {
  return requestDesktopLoop('/api/desktop-development-loop/v1/merge-report', input);
}

async function requestDesktopLoop(path: string, body?: object): Promise<ToolResult> {
  const token = process.env.CAT_CAFE_DESKTOP_DEVELOPMENT_TOKEN?.trim();
  if (!token) return errorResult('ChatGPT Desktop development-loop credential is not configured.');
  const apiUrl = (process.env.CAT_CAFE_API_URL ?? 'http://localhost:3004').replace(/\/$/, '');
  try {
    const response = await fetch(`${apiUrl}${path}`, {
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const text = await response.text();
    if (!response.ok) return errorResult(`Desktop development-loop request failed (${response.status}): ${text}`);
    const value = text ? JSON.parse(text) : null;
    return successResult(JSON.stringify(value, null, 2));
  } catch (error) {
    return errorResult(
      `Desktop development-loop request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const runtimeProfiles = ['full', 'desktop:development-loop'] as const;

export const desktopDevelopmentLoopTools = [
  defineTool({
    name: 'cat_cafe_development_project_read',
    description:
      'Read the server-owned public project/repository binding before starting or resuming implementation. ' +
      'Use when: ChatGPT Desktop knows either the Cat Café project id or its exact GitHub owner/name and needs repository, reviewer, pilot, or Review Hub policy. ' +
      'NOT for: fuzzy project search, reading a work attempt, or obtaining a local path or credential. ' +
      'Output: a read-only public project binding and deterministic Review Hub id.',
    inputSchema: developmentProjectReadInputSchema,
    handler: handleDevelopmentProjectRead,
    governance: {
      implementationExport: 'handleDevelopmentProjectRead',
      action: 'read-project',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles,
      targetExposure: 'profile-gated',
    },
  }),
  defineTool({
    name: 'cat_cafe_development_work_read',
    description:
      'Read one managed implementation attempt as a server-derived Resume Packet. ' +
      'Use when: starting a turn, resuming after restart, or checking review, merge, or acceptance progress. ' +
      'NOT for: claiming a work attempt, mutating Git, or reading private reviewer drafts. ' +
      'Output: current lifecycle, fenced session epoch, exact SHA, barrier-safe findings, and next legal actions.',
    inputSchema: developmentWorkReadInputSchema,
    handler: handleDevelopmentWorkRead,
    governance: {
      implementationExport: 'handleDevelopmentWorkRead',
      action: 'read-work',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles,
      targetExposure: 'profile-gated',
    },
  }),
  defineTool({
    name: 'cat_cafe_development_work_connect',
    description:
      'Claim or rebind one managed work attempt to the current ChatGPT Desktop session. ' +
      'Use when: the first Desktop chat starts the attempt or a replacement chat takes ownership. ' +
      'NOT for: creating managed work, reviewing code, committing, pushing, merging, or deploying. ' +
      'Output: a Resume Packet with the newly active fenced epoch and next legal actions. ' +
      'GOTCHA: a successful rebind advances the epoch, so the previous chat immediately loses write authority.',
    inputSchema: developmentWorkConnectInputSchema,
    handler: handleDevelopmentWorkConnect,
    governance: {
      implementationExport: 'handleDevelopmentWorkConnect',
      action: 'connect-work',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles,
      targetExposure: 'profile-gated',
    },
  }),
  defineTool({
    name: 'cat_cafe_development_work_heartbeat',
    description:
      'Refresh committed workspace metadata for the current permanent fenced ChatGPT Desktop binding. ' +
      'Use when: the committed workspace SHA or worktree state changed. ' +
      'NOT for: reconnecting a deleted chat, reporting finished implementation, mutating Git, or keeping uncommitted work recoverable. ' +
      'Output: an updated Resume Packet and session version. GOTCHA: stale sessions or epochs are rejected.',
    inputSchema: developmentWorkHeartbeatInputSchema,
    handler: handleDevelopmentWorkHeartbeat,
    governance: {
      implementationExport: 'handleDevelopmentWorkHeartbeat',
      action: 'heartbeat-work',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles,
      targetExposure: 'profile-gated',
    },
  }),
  defineTool({
    name: 'cat_cafe_development_implementation_report',
    description:
      'Report the full committed implementation SHA owned by the current fenced Desktop session. ' +
      'Use when: implementation and checks are committed and the exact checked-out SHA is ready for multi-cat review. ' +
      'NOT for: uncommitted work, a missing worktree, Git push, merge, deploy, or external finding publication. ' +
      'Output: an updated Resume Packet and one opened or reused exact-SHA ReviewRound in the project Review Hub.',
    inputSchema: developmentImplementationReportInputSchema,
    handler: handleDevelopmentImplementationReport,
    governance: {
      implementationExport: 'handleDevelopmentImplementationReport',
      action: 'report-implementation',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles,
      targetExposure: 'profile-gated',
    },
  }),
  defineTool({
    name: 'cat_cafe_development_merge_confirmation_record',
    description:
      "Record the operator's explicit merge confirmation from the current ChatGPT Desktop chat. " +
      'Use when: a manual pilot has a current exact-SHA approved review with green checks and zero findings, and the operator confirms merge in this chat. ' +
      'NOT for: executing Git, granting repository authority, auto-merge, push, deploy, or confirmations from superseded chats. ' +
      'Output: scoped merge-confirmation lifecycle evidence and an updated Resume Packet.',
    inputSchema: developmentMergeConfirmationInputSchema,
    handler: handleDevelopmentMergeConfirmationRecord,
    governance: {
      implementationExport: 'handleDevelopmentMergeConfirmationRecord',
      action: 'record-merge-confirmation',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles,
      targetExposure: 'profile-gated',
    },
  }),
  defineTool({
    name: 'cat_cafe_development_merge_report',
    description:
      'Report the merge commit SHA after ChatGPT Desktop has completed the merge with its native Git tools. ' +
      'Use when: native Git has already merged the current approved exact SHA and the receipt must enter lifecycle truth. ' +
      'NOT for: asking Cat Café to execute Git, merge, push, deploy, or bypass manual-pilot confirmation. ' +
      'Output: a validated merge receipt, acceptance-pending state, and updated Resume Packet.',
    inputSchema: developmentMergeReportInputSchema,
    handler: handleDevelopmentMergeReport,
    governance: {
      implementationExport: 'handleDevelopmentMergeReport',
      action: 'report-merge',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles,
      targetExposure: 'profile-gated',
    },
  }),
] as const;
