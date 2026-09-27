import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callbackTools } from '../src/tools/callback-tools.js';

test('existing local documents have a discoverable authenticated publication tool', () => {
  const tool = callbackTools.find((t) => t.name === 'cat_cafe_publish_file');
  assert.ok(tool, 'local attachment publication must not require a runtime filesystem write');
  assert.equal(tool.annotations?.readOnlyHint, false);
});

test('publisher sends exact bytes and filename, checks expected hash, and rejects unsupported files/symlinks', async (t) => {
  const tool = callbackTools.find((t) => t.name === 'cat_cafe_publish_file');
  assert.ok(tool);
  const env = { ...process.env };
  const fetch = globalThis.fetch;
  t.after(() => {
    process.env = env;
    globalThis.fetch = fetch;
  });
  // No real service or credentials may be used by this test.
  delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'synthetic-token';
  const dir = await mkdtemp(join(tmpdir(), 'publish-file-mcp-'));
  const sourcePath = join(dir, '合成文档.txt');
  const bytes = Buffer.from('test-only payload');
  const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(sourcePath, bytes);
  const calls: Array<{ url: string; options: RequestInit }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options: options! });
    return new Response(JSON.stringify({ status: 'ok', sha256: expectedSha256 }), { status: 200 });
  };
  const result = await tool.handler({ sourcePath, expectedSha256 });
  assert.ok(!result.isError);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/api\/callbacks\/publish-file$/);
  const body = JSON.parse(String(calls[0]!.options.body));
  assert.equal(body.fileName, '合成文档.txt');
  assert.equal(body.mimeType, 'text/plain');
  assert.equal(body.sha256, expectedSha256);
  assert.deepEqual(Buffer.from(body.dataBase64, 'base64'), bytes);
  assert.equal(body.sourcePath, undefined);
  assert.equal(body.callbackToken, undefined);
  assert.equal(new Headers(calls[0]!.options.headers).get('x-callback-token'), 'synthetic-token');

  const link = join(dir, 'link.txt');
  await symlink(sourcePath, link);
  for (const input of [
    { sourcePath, expectedSha256: '0'.repeat(64) },
    { sourcePath: link },
    { sourcePath: dir },
    { sourcePath: join(dir, 'unknown.html') },
  ]) {
    assert.ok((await tool.handler(input)).isError);
  }
  assert.equal(calls.length, 1, 'rejected local files must never be uploaded');
});
