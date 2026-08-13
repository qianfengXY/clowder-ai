import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { verifyWorkspacePath } from '../dist/domains/desktop-development-loop/workspace-path-verifier.js';

let root;
let source;
let linkedWorktree;
let independentClone;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cat-cafe-workspace-path-'));
  source = join(root, 'source');
  linkedWorktree = join(root, 'linked-worktree');
  independentClone = join(root, 'independent-clone');
  execFileSync('git', ['init', source]);
  git(source, 'config', 'user.name', 'Cat Cafe Test');
  git(source, 'config', 'user.email', 'cat-cafe-test@example.invalid');
  writeFileSync(join(source, 'README.md'), '# fixture\n');
  git(source, 'add', 'README.md');
  git(source, 'commit', '-m', 'fixture');
  git(source, 'worktree', 'add', '-b', 'linked-fixture', linkedWorktree);
  execFileSync('git', ['clone', '--quiet', source, independentClone]);
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test('accepts the configured project checkout', async () => {
  await verifyWorkspacePath(source, source);
});

test('accepts a Git worktree registered to the configured checkout', async () => {
  await verifyWorkspacePath(source, linkedWorktree);
});

test('rejects an independent clone even when it has the same repository history', async () => {
  await assert.rejects(
    verifyWorkspacePath(source, independentClone),
    /Workspace path does not belong to the project checkout/,
  );
});
