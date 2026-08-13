import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type WorkspacePathVerifier = (projectSourcePath: string, worktreePath: string) => Promise<void>;

async function canonicalPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function gitCommonDir(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
    cwd: worktreePath,
    timeout: 5_000,
  });
  const commonDir = stdout.trim();
  if (!commonDir) throw new Error('Git workspace has no common directory');
  return canonicalPath(resolve(worktreePath, commonDir));
}

/**
 * Accept the configured project checkout itself or one of its registered Git worktrees.
 * A second clone with the same remote is intentionally rejected because it has a different
 * Git common directory and can diverge from the Cat Cafe project workspace.
 */
export const verifyWorkspacePath: WorkspacePathVerifier = async (projectSourcePath, worktreePath) => {
  let sourcePath: string;
  let workspacePath: string;
  try {
    [sourcePath, workspacePath] = await Promise.all([
      canonicalPath(projectSourcePath),
      canonicalPath(worktreePath),
    ]);
  } catch {
    throw new Error('Project workspace path is unavailable');
  }
  if (sourcePath === workspacePath) return;

  try {
    const [sourceCommonDir, workspaceCommonDir] = await Promise.all([
      gitCommonDir(sourcePath),
      gitCommonDir(workspacePath),
    ]);
    if (sourceCommonDir === workspaceCommonDir) return;
  } catch {
    // Convert filesystem and Git details into one stable, non-path-leaking protocol error.
  }
  throw new Error('Workspace path does not belong to the project checkout');
};
