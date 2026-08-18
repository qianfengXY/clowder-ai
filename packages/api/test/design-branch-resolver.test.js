import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let repositoryPath;

before(async () => {
  repositoryPath = await mkdtemp(join(tmpdir(), 'catcafe-design-branch-'));
  await execFileAsync('git', ['init'], { cwd: repositoryPath });
  await execFileAsync('git', ['config', 'user.name', 'CatCafe Test'], { cwd: repositoryPath });
  await execFileAsync('git', ['config', 'user.email', 'catcafe@example.test'], { cwd: repositoryPath });
  await writeFile(join(repositoryPath, 'README.md'), '# plan\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repositoryPath });
  await execFileAsync('git', ['commit', '-m', 'design: initial'], { cwd: repositoryPath });
  await execFileAsync('git', ['branch', 'design/f006-workspace'], { cwd: repositoryPath });
  await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], { cwd: repositoryPath });
});

after(async () => {
  if (repositoryPath) await rm(repositoryPath, { recursive: true, force: true });
});

test('resolves an exact local design commit only when path and origin identity agree', async () => {
  const { resolveDesignBranch } = await import('../dist/domains/desktop-development-loop/design-branch-resolver.js');
  const expected = (
    await execFileAsync('git', ['rev-parse', 'refs/heads/design/f006-workspace'], { cwd: repositoryPath })
  ).stdout.trim();

  assert.deepEqual(
    await resolveDesignBranch({
      sourcePath: repositoryPath,
      repository: { host: 'github.com', owner: 'owner', name: 'repo', fullName: 'owner/repo' },
      branch: 'design/f006-workspace',
    }),
    { branch: 'design/f006-workspace', exactSha: expected },
  );
  await assert.rejects(
    () =>
      resolveDesignBranch({
        sourcePath: repositoryPath,
        repository: { host: 'github.com', owner: 'other', name: 'repo', fullName: 'other/repo' },
        branch: 'design/f006-workspace',
      }),
    /origin does not match/i,
  );
  await assert.rejects(
    () =>
      resolveDesignBranch({
        sourcePath: repositoryPath,
        repository: { host: 'github.com', owner: 'owner', name: 'repo', fullName: 'owner/repo' },
        branch: 'design/missing',
      }),
    /does not exist as a local committed branch/i,
  );
});

test('validates feature design documents against the frozen design commit', async () => {
  const { preferChineseDesignDocuments, resolveDesignDocuments } = await import(
    '../dist/domains/desktop-development-loop/design-branch-resolver.js'
  );
  const exactSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath })).stdout.trim();
  assert.deepEqual(await resolveDesignDocuments(repositoryPath, exactSha, ['README.md']), ['README.md']);
  await assert.rejects(
    () => resolveDesignDocuments(repositoryPath, exactSha, ['docs/missing.md']),
    /does not exist in design commit/i,
  );
  await assert.rejects(
    () => resolveDesignDocuments(repositoryPath, exactSha, ['../outside.md']),
    /invalid repository-relative/i,
  );
  assert.deepEqual(
    preferChineseDesignDocuments(['docs/features/F006.md', 'docs/features/F006.zh-CN.md', 'docs/features/F007.md']),
    ['docs/features/F006.zh-CN.md', 'docs/features/F007.md'],
  );
});
