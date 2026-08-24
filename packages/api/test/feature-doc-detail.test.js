import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';

test('feature doc detail reads EXT specs from the extension catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-feature-detail-'));
  const previousCwd = process.cwd();
  try {
    await mkdir(join(root, 'docs', 'extensions'), { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(
      join(root, 'docs', 'extensions', 'catalog.json'),
      JSON.stringify({
        schemaVersion: 1,
        extensions: [
          {
            id: 'EXT-001',
            name: 'ChatGPT Desktop Development Loop',
            status: 'implementation',
            owner: 'CodeX',
            specPath: 'docs/extensions/EXT-001-chatgpt-desktop-development-loop.md',
            legacyIds: ['F289'],
          },
        ],
      }),
    );
    await writeFile(
      join(root, 'docs', 'extensions', 'EXT-001-chatgpt-desktop-development-loop.md'),
      [
        '# EXT-001: ChatGPT Desktop Development Loop',
        '',
        '> **Status**: implementation',
        '> **Owner**: CodeX',
        '',
        '### Phase A: Extension recognition',
        '',
        '- [x] AC-A1: Show EXT-001 in Traqen.',
      ].join('\n'),
    );

    process.chdir(root);
    const { featureDocDetailRoutes } = await import('../dist/routes/feature-doc-detail.js');
    const app = Fastify();
    await app.register(featureDocDetailRoutes);
    const response = await app.inject({
      method: 'GET',
      url: '/api/backlog/feature-doc-detail?featureId=EXT-001',
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().featureId, 'EXT-001');
    assert.equal(response.json().status, 'implementation');
    assert.equal(response.json().phases[0].id, 'A');
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
