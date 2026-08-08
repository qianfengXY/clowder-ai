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

export const developmentProjectReadInputSchema = {
  protocolVersion: protocolVersionSchema,
  projectId: idSchema.describe('Clowder AI project id already bound to this repository.'),
};

export const developmentWorkReadInputSchema = {
  protocolVersion: protocolVersionSchema,
  projectId: idSchema,
  workId: idSchema,
  attemptId: idSchema,
};

export const developmentWorkConnectInputSchema = {
  ...developmentWorkReadInputSchema,
  runtimeSessionId: idSchema.describe('Stable ChatGPT Desktop runtime session id.'),
  chatRef: z.string().min(1).max(1000).optional().describe('Optional opaque ChatGPT chat reference for recovery.'),
  expectedBindingEpoch: z.number().int().nonnegative(),
  expectedManagedWorkVersion: z.number().int().positive(),
  idempotencyKey: idSchema,
  leaseDurationMs: z.number().int().min(1_000).max(86_400_000),
  workspace: workspaceSchema,
};

export const developmentWorkHeartbeatInputSchema = {
  ...developmentWorkReadInputSchema,
  runtimeSessionId: idSchema,
  bindingEpoch: z.number().int().positive(),
  expectedSessionVersion: z.number().int().positive(),
  idempotencyKey: idSchema,
  leaseDurationMs: z.number().int().min(1_000).max(86_400_000),
  workspace: workspaceSchema.optional(),
};

export const developmentImplementationReportInputSchema = {
  ...developmentWorkReadInputSchema,
  runtimeSessionId: idSchema,
  bindingEpoch: z.number().int().positive(),
  expectedManagedWorkVersion: z.number().int().positive(),
  exactSha: fullShaSchema.describe('Full committed SHA currently checked out in the bound workspace.'),
  idempotencyKey: idSchema,
};

export const developmentMergeConfirmationInputSchema = {
  ...developmentWorkReadInputSchema,
  runtimeSessionId: idSchema,
  bindingEpoch: z.number().int().positive(),
  expectedManagedWorkVersion: z.number().int().positive(),
  exactSha: fullShaSchema,
  idempotencyKey: idSchema,
};

export const developmentMergeReportInputSchema = {
  ...developmentMergeConfirmationInputSchema,
  mergeCommitSha: fullShaSchema.describe('Full merge commit SHA produced by ChatGPT Desktop native Git tools.'),
};

type ProjectReadInput = {
  protocolVersion: number;
  projectId: string;
};

type WorkReadInput = ProjectReadInput & {
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
  leaseDurationMs: number;
  workspace: WorkspaceInput;
};

type WorkHeartbeatInput = WorkReadInput & {
  runtimeSessionId: string;
  bindingEpoch: number;
  expectedSessionVersion: number;
  idempotencyKey: string;
  leaseDurationMs: number;
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
  const query = new URLSearchParams({ protocolVersion: String(input.protocolVersion) });
  return requestDesktopLoop(
    `/api/desktop-development-loop/v1/projects/${encodeURIComponent(input.projectId)}?${query}`,
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
      'This never returns a local checkout path or credential.',
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
      'Resume one managed implementation attempt and read only its current lifecycle, fenced session epoch, exact SHA, barrier-safe consensus findings, and next legal actions.',
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
      'A rebind advances the session epoch so a deleted or replaced chat cannot mutate the work.',
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
      'Renew the current fenced ChatGPT Desktop session lease and optionally refresh committed workspace metadata. ' +
      'A stale session or epoch is rejected.',
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
      'This opens or reuses one exact-SHA multi-cat review round in the project Review Hub; it does not merge, push, deploy, or publish findings externally.',
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
      'Record the operators explicit merge confirmation from the current ChatGPT Desktop chat after the exact SHA has a green, zero-finding consensus. ' +
      'This is lifecycle evidence only: it does not execute Git, merge, push, deploy, or grant repository authority; a superseded chat epoch cannot reuse it.',
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
      'The server validates current-chat confirmation during manual pilots and records only the receipt; it never executes Git, merge, push, or deploy.',
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
