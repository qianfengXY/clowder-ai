import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

test('current skills avoid unsupported publishing instructions', async () => {
  const root = fileURLToPath(new URL('../../../cat-cafe-skills/', import.meta.url));
  const violations = [];
  const unsafeInstructions = [
    /手动 `cp`.*(?:runtime|uploads)/,
    /(?:先(?:显式)?放到|先把视频放到|本地 mp4 先变成).*\/uploads\//,
    /(?:调用|需手动) `publishGeneratedImage\(/,
    /原图[^\n]*750\s*(?:KiB|KB)/i,
  ];
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const lines = (await readFile(path, 'utf8')).split('\n');
        for (const [index, line] of lines.entries()) {
          if (unsafeInstructions.some((pattern) => pattern.test(line))) {
            violations.push(`${path.slice(root.length)}:${index + 1}: ${line.trim()}`);
          }
        }
      }
    }
  }
  await scan(root);
  assert.deepEqual(violations, [], 'agent-facing publishing instructions must use a callable, authorized publisher');
});

describe('Callback Docs Routes', () => {
  async function createApp() {
    const { registerCallbackDocsRoutes } = await import('../dist/routes/callback-docs-routes.js');
    const app = Fastify();
    await app.register(registerCallbackDocsRoutes);
    await app.ready();
    return app;
  }

  test('GET /api/callbacks/instructions returns 200 with skill content', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/callbacks/instructions',
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.ok(body.instructions, 'response should have instructions field');
      assert.ok(body.instructions.includes('# MCP Callbacks HTTP API Reference'), 'should contain refs heading');
      assert.ok(!body.instructions.startsWith('---'), 'frontmatter should be stripped');
    } finally {
      await app.close();
    }
  });

  test('GET /api/callbacks/rich-block-rules returns 200 with rules', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/callbacks/rich-block-rules',
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.ok(body.rules, 'response should have rules field');
      assert.ok(body.rules.length > 0, 'rules should be non-empty');
      assert.ok(
        body.rules.includes('cat_cafe_publish_file'),
        'rules should direct existing documents through the authenticated publisher',
      );
      assert.ok(!body.rules.includes('cat-cafe-runtime/packages/api/uploads/'), 'rules must not direct runtime writes');
    } finally {
      await app.close();
    }
  });
});
