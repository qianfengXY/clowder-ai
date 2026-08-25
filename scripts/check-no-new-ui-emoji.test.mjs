import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'check-no-new-ui-emoji.mjs');

function runGit(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(repo, relativePath, content) {
  const absolutePath = join(repo, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function createFixture(context) {
  const repo = mkdtempSync(join(tmpdir(), 'no-new-ui-emoji-'));
  context.after(() => rmSync(repo, { force: true, recursive: true }));
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(SCRIPT_PATH, join(repo, 'scripts/check-no-new-ui-emoji.mjs'));
  runGit(repo, ['init', '-q']);
  runGit(repo, ['config', 'user.email', 'test@example.com']);
  runGit(repo, ['config', 'user.name', 'Test']);
  write(repo, 'packages/web/src/Legacy.tsx', 'export const Legacy = () => <span>🔌 legacy</span>;\n');
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-qm', 'base']);
  return { repo, base: runGit(repo, ['rev-parse', 'HEAD']) };
}

function commit(repo) {
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-qm', 'change']);
}

function runGuard(repo, base) {
  return spawnSync(process.execPath, ['scripts/check-no-new-ui-emoji.mjs', '--base', base], {
    cwd: repo,
    encoding: 'utf8',
  });
}

test('blocks a raw emoji added to production TSX', (context) => {
  const { repo, base } = createFixture(context);
  write(repo, 'packages/web/src/NewControl.tsx', 'export const NewControl = () => <button>🚀 Launch</button>;\n');
  commit(repo);

  const result = runGuard(repo, base);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/web\/src\/NewControl\.tsx:1/);
  assert.match(result.stderr, /🚀 Launch/);
});

test('allows unchanged legacy emoji and additions outside production UI', (context) => {
  const { repo, base } = createFixture(context);
  write(
    repo,
    'packages/web/src/Icon.tsx',
    'export const Icon = () => <svg aria-label="launch"><path d="M0 0h16v16H0z" /></svg>;\n',
  );
  write(repo, 'packages/web/src/__tests__/emoji.test.tsx', 'export const fixture = <span>🚀 test only</span>;\n');
  write(repo, 'packages/web/test/emoji.fixture.jsx', 'export const fixture = <span>🚀 fixture only</span>;\n');
  write(repo, 'packages/web/src/emoji-parser.ts', "export const legacyToken = '🚀';\n");
  commit(repo);

  const result = runGuard(repo, base);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No new raw UI emoji detected/);
});

test('fails closed when the requested comparison base is invalid', (context) => {
  const { repo } = createFixture(context);

  const result = runGuard(repo, 'missing-base');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to inspect UI diff/);
});
