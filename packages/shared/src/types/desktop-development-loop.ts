import type { CatId } from './ids.js';

export const DESKTOP_DEVELOPMENT_PROTOCOL_VERSION = 1 as const;
export const CHATGPT_DESKTOP_DEVELOPMENT_ACTOR = 'chatgpt-desktop-dev' as const;
export const DESKTOP_DEVELOPMENT_REQUIRED_PILOTS = 2 as const;

export type DesktopDevelopmentProtocolVersion = typeof DESKTOP_DEVELOPMENT_PROTOCOL_VERSION;
export type DesktopDevelopmentActor = typeof CHATGPT_DESKTOP_DEVELOPMENT_ACTOR;
export type DesktopDevelopmentMergeMode = 'manual_confirm_in_chatgpt' | 'automatic';

export interface GitHubRepositoryIdentity {
  readonly host: 'github.com';
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
}

export interface DesktopDevelopmentProjectBinding {
  readonly protocolVersion: DesktopDevelopmentProtocolVersion;
  readonly repository: GitHubRepositoryIdentity;
  readonly defaultBranch: string;
  readonly developmentActor: DesktopDevelopmentActor;
  readonly defaultReviewers: readonly CatId[];
  readonly mergeMode: DesktopDevelopmentMergeMode;
  readonly successfulManualPilotCount: 0 | 1 | 2;
  /** Work ids that already contributed to the capped pilot count. */
  readonly successfulManualPilotWorkIds: readonly string[];
  readonly allowPush: boolean;
  readonly allowPullRequest: boolean;
  readonly requireFinalAcceptance: true;
  readonly version: number;
}

export interface CreateDesktopDevelopmentProjectBindingInput {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly defaultReviewers: readonly string[];
  readonly allowPush?: boolean;
  readonly allowPullRequest?: boolean;
}

export interface DesktopDevelopmentPolicyUpdate {
  readonly expectedVersion: number;
  readonly defaultBranch?: string;
  readonly defaultReviewers?: readonly string[];
  readonly mergeMode?: DesktopDevelopmentMergeMode;
  readonly allowPush?: boolean;
  readonly allowPullRequest?: boolean;
}

export interface ProjectReviewHubView {
  readonly hubId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly status: 'active' | 'restored';
}

export interface WorkspaceBinding {
  readonly repository: GitHubRepositoryIdentity;
  readonly branch: string;
  readonly baseSha: string;
  readonly currentSha: string;
  readonly lastCommittedSha: string;
  readonly worktreePresent: boolean;
  /** Private runtime-only path. Never include this field in a public projection. */
  readonly worktreePath: string;
  readonly validatedAt: number;
}

export type DesktopSessionBindingStatus = 'active' | 'detached' | 'superseded';

export interface DesktopSessionBinding {
  readonly projectId: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly runtimeSessionId: string;
  readonly chatRef?: string;
  readonly bindingEpoch: number;
  readonly leaseExpiresAt: number;
  readonly status: DesktopSessionBindingStatus;
  readonly workspace: WorkspaceBinding;
  readonly version: number;
}

export interface BarrierSafeReviewFinding {
  readonly findingId: string;
  readonly severity: 'P1' | 'P2' | 'P3';
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly status: 'open' | 'closed';
}

export interface DesktopDevelopmentResumePacket {
  readonly protocolVersion: DesktopDevelopmentProtocolVersion;
  readonly projectId: string;
  readonly repository: GitHubRepositoryIdentity;
  readonly defaultBranch: string;
  readonly workId: string;
  readonly attemptId: string;
  readonly workLifecycle: 'active' | 'accepted' | 'rejected';
  readonly managedWorkVersion: number;
  readonly bindingEpoch: number;
  readonly sessionStatus: DesktopSessionBindingStatus;
  readonly sessionVersion: number;
  readonly branch: string;
  readonly currentSha: string;
  readonly lastCommittedSha: string;
  readonly worktreePresent: boolean;
  readonly reviewRoundId: string | null;
  readonly reviewPhase: 'independent' | 'cross_review' | 'consensus_ready' | 'complete' | null;
  readonly reviewRoundVersion: number | null;
  readonly reviewCurrentForWork: boolean;
  readonly openFindings: readonly BarrierSafeReviewFinding[];
  readonly nextLegalActions: readonly string[];
}

export interface PublicDesktopDevelopmentProject {
  readonly projectId: string;
  readonly localCheckoutBound: boolean;
  readonly binding: DesktopDevelopmentProjectBinding | null;
}

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function normalizeGitHubRepository(value: string): GitHubRepositoryIdentity {
  const trimmed = value.trim();
  let path = trimmed;

  const httpsMatch = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/i.exec(trimmed);
  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+?)$/i.exec(trimmed);
  if (httpsMatch) {
    path = `${httpsMatch[1]}/${httpsMatch[2]}`;
  } else if (sshMatch) {
    path = `${sshMatch[1]}/${sshMatch[2]}`;
  } else if (trimmed.includes('://') || trimmed.includes('@') || trimmed.startsWith('.')) {
    throw new Error('GitHub repository must be owner/name or a github.com clone URL');
  }

  const segments = path.split('/');
  if (segments.length !== 2) {
    throw new Error('GitHub repository must contain exactly owner/name');
  }
  const [owner = '', rawName = ''] = segments;
  const name = rawName.replace(/\.git$/i, '');
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPOSITORY_PATTERN.test(name) || name === '.' || name === '..') {
    throw new Error('GitHub repository contains an invalid owner or repository name');
  }
  return { host: 'github.com', owner, name, fullName: `${owner}/${name}` };
}

export function assertValidDesktopDefaultBranch(value: string): void {
  const branch = value.trim();
  const invalid =
    branch.length === 0 ||
    branch.length > 244 ||
    branch.startsWith('-') ||
    branch.startsWith('.') ||
    branch.startsWith('heads/') ||
    branch.endsWith('.') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.includes('//') ||
    /[\s~^:?*[\\]/.test(branch) ||
    branch.split('/').some((segment) => segment.length === 0 || segment.startsWith('.'));
  if (invalid) {
    throw new Error('Invalid default branch name');
  }
}

function normalizeReviewers(values: readonly string[]): readonly CatId[] {
  const reviewers = values.map((value) => value.trim()).filter(Boolean);
  if (reviewers.includes(CHATGPT_DESKTOP_DEVELOPMENT_ACTOR)) {
    throw new Error('Desktop author cannot review its own implementation');
  }
  const unique = [...new Set(reviewers)];
  if (unique.length < 2) {
    throw new Error('At least two distinct reviewers are required');
  }
  return unique as CatId[];
}

function assertPullRequestPolicy(allowPush: boolean, allowPullRequest: boolean): void {
  if (allowPullRequest && !allowPush) {
    throw new Error('Pull request automation requires push permission');
  }
}

export function createDesktopDevelopmentProjectBinding(
  input: CreateDesktopDevelopmentProjectBindingInput,
): DesktopDevelopmentProjectBinding {
  assertValidDesktopDefaultBranch(input.defaultBranch);
  const allowPush = input.allowPush ?? false;
  const allowPullRequest = input.allowPullRequest ?? false;
  assertPullRequestPolicy(allowPush, allowPullRequest);

  return {
    protocolVersion: DESKTOP_DEVELOPMENT_PROTOCOL_VERSION,
    repository: normalizeGitHubRepository(input.repository),
    defaultBranch: input.defaultBranch.trim(),
    developmentActor: CHATGPT_DESKTOP_DEVELOPMENT_ACTOR,
    defaultReviewers: normalizeReviewers(input.defaultReviewers),
    mergeMode: 'manual_confirm_in_chatgpt',
    successfulManualPilotCount: 0,
    successfulManualPilotWorkIds: [],
    allowPush,
    allowPullRequest,
    requireFinalAcceptance: true,
    version: 1,
  };
}

export function applyDesktopDevelopmentPolicyUpdate(
  binding: DesktopDevelopmentProjectBinding,
  update: DesktopDevelopmentPolicyUpdate,
): DesktopDevelopmentProjectBinding {
  if (update.expectedVersion !== binding.version) {
    throw new Error(`Desktop development binding version conflict: expected ${update.expectedVersion}`);
  }
  const defaultBranch = update.defaultBranch?.trim() ?? binding.defaultBranch;
  assertValidDesktopDefaultBranch(defaultBranch);
  const mergeMode = update.mergeMode ?? binding.mergeMode;
  if (mergeMode === 'automatic' && binding.successfulManualPilotCount < DESKTOP_DEVELOPMENT_REQUIRED_PILOTS) {
    throw new Error('Automatic merge requires two successful manual pilots');
  }
  const allowPush = update.allowPush ?? binding.allowPush;
  const allowPullRequest = update.allowPullRequest ?? binding.allowPullRequest;
  assertPullRequestPolicy(allowPush, allowPullRequest);

  return {
    ...binding,
    defaultBranch,
    defaultReviewers:
      update.defaultReviewers === undefined ? binding.defaultReviewers : normalizeReviewers(update.defaultReviewers),
    mergeMode,
    allowPush,
    allowPullRequest,
    version: binding.version + 1,
  };
}

export function recordAcceptedManualPilot(
  binding: DesktopDevelopmentProjectBinding,
  workId: string,
): DesktopDevelopmentProjectBinding {
  const normalizedWorkId = workId.trim();
  if (!normalizedWorkId) throw new Error('Accepted pilot work id is required');
  if (binding.successfulManualPilotWorkIds.includes(normalizedWorkId)) return binding;
  if (binding.successfulManualPilotCount >= DESKTOP_DEVELOPMENT_REQUIRED_PILOTS) return binding;

  const nextCount = (binding.successfulManualPilotCount + 1) as 1 | 2;
  return {
    ...binding,
    successfulManualPilotCount: nextCount,
    successfulManualPilotWorkIds: [...binding.successfulManualPilotWorkIds, normalizedWorkId],
    version: binding.version + 1,
  };
}

export function buildProjectReviewHubId(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error('Invalid project id for Review Hub');
  }
  return `project-review-hub:${projectId}`;
}

export function toPublicDesktopDevelopmentProject(input: {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly binding: DesktopDevelopmentProjectBinding | null;
}): PublicDesktopDevelopmentProject {
  return {
    projectId: input.projectId,
    localCheckoutBound: input.sourcePath.trim().length > 0,
    binding: input.binding,
  };
}
