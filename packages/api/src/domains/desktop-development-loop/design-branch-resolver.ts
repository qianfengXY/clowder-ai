import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertValidGitBranch, type GitHubRepositoryIdentity, normalizeGitHubRepository } from '@cat-cafe/shared';

const execFileAsync = promisify(execFile);

export interface ResolveDesignBranchInput {
  readonly sourcePath: string;
  readonly repository: GitHubRepositoryIdentity;
  readonly branch: string;
}

export interface ResolvedDesignBranch {
  readonly branch: string;
  readonly exactSha: string;
}

export interface ResolvedDesignAuthority extends ResolvedDesignBranch {
  readonly documents: readonly string[];
}

export type DesignBranchResolver = (input: ResolveDesignBranchInput) => Promise<ResolvedDesignBranch>;
export type DesignDocumentsResolver = (
  sourcePath: string,
  exactSha: string,
  documents: readonly string[],
) => Promise<readonly string[]>;

/**
 * Resolves a local project-wide design branch without checking it out or mutating
 * the repository. The configured path, Git top-level and origin identity must
 * all agree before a commit is accepted as plan authority.
 */
export const resolveDesignBranch: DesignBranchResolver = async (input) => {
  const branch = input.branch.trim();
  assertValidGitBranch(branch, 'design branch');

  let sourcePath: string;
  try {
    sourcePath = await realpath(resolve(input.sourcePath));
  } catch {
    throw new Error('Project source path is unavailable');
  }

  let topLevel: string;
  let remoteUrl: string;
  try {
    const [topLevelResult, remoteResult] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: sourcePath, timeout: 5_000 }),
      execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: sourcePath, timeout: 5_000 }),
    ]);
    topLevel = await realpath(topLevelResult.stdout.trim());
    remoteUrl = remoteResult.stdout.trim();
  } catch {
    throw new Error('Project source path is not a Git checkout with an origin remote');
  }
  if (topLevel !== sourcePath) throw new Error('Git top-level path does not match the project source path');

  let remote: GitHubRepositoryIdentity;
  try {
    remote = normalizeGitHubRepository(remoteUrl);
  } catch {
    throw new Error('Project origin is not a supported GitHub repository');
  }
  if (remote.fullName.toLowerCase() !== input.repository.fullName.toLowerCase()) {
    throw new Error('Project source path origin does not match the bound GitHub repository');
  }

  try {
    const result = await execFileAsync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`],
      { cwd: sourcePath, timeout: 5_000 },
    );
    const exactSha = result.stdout.trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(exactSha)) throw new Error('invalid sha');
    return { branch, exactSha };
  } catch {
    throw new Error(`Design branch ${branch} does not exist as a local committed branch`);
  }
};

export const resolveDesignDocuments: DesignDocumentsResolver = async (
  sourcePath: string,
  exactSha: string,
  documents: readonly string[],
): Promise<readonly string[]> => {
  const normalized = normalizeDesignDocuments(documents);
  await Promise.all(
    normalized.map(async (documentPath) => {
      try {
        await execFileAsync('git', ['cat-file', '-e', `${exactSha}:${documentPath}`], {
          cwd: sourcePath,
          timeout: 5_000,
        });
      } catch {
        throw new Error(`Design document ${documentPath} does not exist in design commit ${exactSha}`);
      }
    }),
  );
  return normalized;
};

export function normalizeDesignDocuments(documents: readonly string[]): readonly string[] {
  if (!Array.isArray(documents) || documents.length === 0 || documents.length > 20) {
    throw new Error('Select between 1 and 20 design documents for this feature');
  }
  const normalized = documents.map((value) => {
    const trimmed = value.trim().replaceAll('\\', '/');
    const path = posix.normalize(trimmed);
    if (
      !trimmed ||
      trimmed.startsWith('/') ||
      path === '.' ||
      path === '..' ||
      path.startsWith('../') ||
      path.includes('/../') ||
      path.startsWith('.git/') ||
      path === '.git' ||
      path.includes(':') ||
      path.length > 1_000
    ) {
      throw new Error(`Invalid repository-relative design document path: ${value}`);
    }
    return path;
  });
  return [...new Set(normalized)];
}
