import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type WorkspacePathVerifier = (projectSourcePath: string, worktreePath: string) => Promise<void>;

async function canonicalPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function gitTopLevel(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    cwd: worktreePath,
    timeout: 5_000,
  });
  const topLevel = stdout.trim();
  if (!topLevel) throw new Error('Git workspace has no top-level directory');
  return canonicalPath(topLevel);
}

/**
 * Require the Desktop-reported path, the configured Cat Cafe source path, and Git's own
 * top-level path to identify one exact checkout. Separate clones, linked worktrees, path aliases,
 * and subdirectories are intentionally rejected even when they have the same remote and history.
 */
export const verifyWorkspacePath: WorkspacePathVerifier = async (projectSourcePath, worktreePath) => {
  if (resolve(projectSourcePath) !== resolve(worktreePath)) {
    throw new Error('Workspace path does not exactly match the project checkout');
  }

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
  if (sourcePath !== workspacePath) {
    throw new Error('Workspace path does not exactly match the project checkout');
  }

  let topLevel: string;
  try {
    topLevel = await gitTopLevel(workspacePath);
  } catch {
    throw new Error('Project workspace is not a valid Git checkout');
  }
  if (topLevel !== sourcePath) {
    throw new Error('Git top-level path does not match the project checkout');
  }
};
