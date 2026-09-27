import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { getRichBlockBuffer } from '../src/domains/cats/services/agents/invocation/RichBlockBuffer.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.js';
import { registerCallbackDocumentRoutes } from '../src/routes/callback-document-routes.js';
import { uploadsRoutes } from '../src/routes/uploads.js';

const bytes = Buffer.from('synthetic document bytes\n');
const payload = {
  fileName: '测试附件.txt',
  mimeType: 'text/plain',
  dataBase64: bytes.toString('base64'),
  sha256: createHash('sha256').update(bytes).digest('hex'),
};

async function harness(t) {
  const uploadDir = await mkdtemp(join(tmpdir(), 'agent-publication-test-'));
  const registry = new InvocationRegistry();
  const threadId = `attachment-${randomUUID()}`;
  const auth = await registry.create('owner', 'codex', threadId, 'parent-chain');
  const app = Fastify();
  const messageStore = new MessageStore();
  const broadcasts = [];
  let deleted = false;
  registerCallbackAuthHook(app, registry);
  registerCallbackDocumentRoutes(app, {
    registry,
    messageStore,
    uploadDir,
    threadStore: { get: async () => ({ id: threadId, userId: 'owner', deletedAt: deleted ? 1 : undefined }) },
    socketManager: { broadcastToRoom: (...args) => broadcasts.push(args) },
  });
  t.after(() => app.close());
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const post = (body = payload, customHeaders = headers) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/publish-file',
      headers: customHeaders,
      payload: body,
    });
  return {
    app,
    registry,
    messageStore,
    auth,
    threadId,
    uploadDir,
    broadcasts,
    post,
    removeThread: () => {
      deleted = true;
    },
  };
}

test('publishes authenticated unchanged bytes as one invocation-bound attachment, with idempotent retries', async (t) => {
  const h = await harness(t);
  const response = await h.post();
  assert.equal(response.statusCode, 200);
  const result = response.json();
  assert.equal(result.sha256, payload.sha256);
  assert.equal(result.fileName, payload.fileName);
  assert.equal(result.fileSize, bytes.length);
  assert.match(result.url, /^\/uploads\/agent-[a-f0-9]+\.txt$/);
  assert.deepEqual(await readFile(join(h.uploadDir, result.url.slice('/uploads/'.length))), bytes);
  assert.deepEqual((await h.post()).json(), result);
  assert.equal((await readdir(h.uploadDir)).length, 1);
  assert.deepEqual(h.broadcasts[0][0], [`thread:${h.threadId}`, 'user:owner']);
  assert.equal(h.broadcasts[0][1], 'connector_message');
  const message = h.messageStore.getById(result.messageId);
  assert.ok(message);
  assert.equal(message.catId, 'codex');
  assert.equal(message.extra?.stream?.invocationId, 'parent-chain');
  assert.equal(message.extra?.stream?.turnInvocationId, h.auth.invocationId);
  assert.equal(message.extra?.isExplicitPost, true);
  assert.equal(message.extra?.rich?.blocks[0].url, result.url);
  assert.equal(h.broadcasts[1][2].message.id, result.messageId, 'retry broadcasts the same durable message');
  assert.deepEqual(getRichBlockBuffer().consume(h.threadId, 'codex', h.auth.invocationId), []);
  assert.deepEqual((await h.post()).json(), result, 'buffer consumption cannot lose a published attachment');
});

test('rejects unauthenticated, malformed and forged-scope uploads without writing files', async (t) => {
  const h = await harness(t);
  assert.equal((await h.post(payload, {})).statusCode, 401);
  assert.equal(
    (await h.post(payload, { 'x-invocation-id': h.auth.invocationId, 'x-callback-token': 'wrong' })).statusCode,
    401,
  );
  for (const patch of [
    { sha256: '0'.repeat(64) },
    { dataBase64: '!!!' },
    { fileName: '../escape.txt' },
    { mimeType: 'text/html' },
    { fileName: 'deck.pptx' },
    { threadId: 'foreign' },
    { sourcePath: '/etc/passwd' },
  ]) {
    assert.equal((await h.post({ ...payload, ...patch })).statusCode, 400, JSON.stringify(patch));
  }
  assert.deepEqual(await readdir(h.uploadDir), []);
  assert.equal(h.broadcasts.length, 0);
});

test('deleted threads and stale invocations cannot publish', async (t) => {
  const h = await harness(t);
  h.removeThread();
  assert.equal((await h.post()).statusCode, 410);
  const stale = await harness(t);
  await stale.registry.create('owner', 'codex', stale.threadId);
  assert.notEqual((await stale.post()).json().status, 'ok');
  assert.deepEqual(await readdir(stale.uploadDir), []);
  assert.equal(stale.broadcasts.length, 0);
});

test('MCP publisher, authenticated HTTP endpoint and attachment download preserve the same bytes', async (t) => {
  const h = await harness(t);
  await h.app.register(uploadsRoutes, { uploadDir: h.uploadDir });
  const address = await h.app.listen({ host: '127.0.0.1', port: 0 });
  const sourceDir = await mkdtemp(join(tmpdir(), 'agent-source-test-'));
  const sourcePath = join(sourceDir, payload.fileName);
  await writeFile(sourcePath, bytes);
  const env = { ...process.env };
  t.after(() => {
    process.env = env;
  });
  delete process.env.CAT_CAFE_CREDENTIAL_FILE;
  process.env.CAT_CAFE_API_URL = address;
  process.env.CAT_CAFE_INVOCATION_ID = h.auth.invocationId;
  process.env.CAT_CAFE_CALLBACK_TOKEN = h.auth.callbackToken;
  const { handlePublishFile } = await import('../../mcp-server/src/tools/callback-tools.js');
  const result = await handlePublishFile({ sourcePath, expectedSha256: payload.sha256 });
  assert.ok(!result.isError, JSON.stringify(result));
  const receipt = JSON.parse(result.content[0].text);
  const response = await fetch(`${address}${receipt.url}`);
  assert.equal(response.status, 200);
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), payload.sha256);
  assert.deepEqual(downloaded, bytes);
  assert.equal(h.broadcasts.length, 1);
  assert.equal(h.broadcasts[0][2].threadId, h.threadId);
});

test('retry after a lost persistence acknowledgement recovers the one durable attachment', async (t) => {
  const h = await harness(t);
  const append = h.messageStore.appendIdempotent.bind(h.messageStore);
  let failed = false;
  h.messageStore.appendIdempotent = (input) => {
    const result = append(input);
    if (!failed) {
      failed = true;
      throw new Error('synthetic lost acknowledgement');
    }
    return result;
  };
  assert.equal((await h.post()).statusCode, 500);
  const response = await h.post();
  assert.equal(response.statusCode, 200);
  assert.equal(h.broadcasts.length, 1);
  assert.equal(h.broadcasts[0][2].message.id, response.json().messageId);
  assert.equal((await readdir(h.uploadDir)).length, 1);
  assert.equal(h.messageStore.getByThread(h.threadId).length, 1);
});

test('retry cannot resurrect or rebroadcast an attachment message removed by its owner', async (t) => {
  for (const removal of ['softDelete', 'hardDelete']) {
    const h = await harness(t);
    const published = await h.post();
    assert.equal(published.statusCode, 200);
    const id = published.json().messageId;
    h.messageStore[removal](id, 'owner');
    const retry = await h.post();
    assert.equal(retry.statusCode, 409, removal);
    assert.equal(h.broadcasts.length, 1, 'rejected retry must not rebroadcast the file');
    assert.equal(h.messageStore.size, 1, 'retry must not create a replacement message');
    assert.ok(h.messageStore.getById(id)?.deletedAt);
    assert.equal((await readdir(h.uploadDir)).length, 1, 'retention is independent of message visibility');
  }
});
