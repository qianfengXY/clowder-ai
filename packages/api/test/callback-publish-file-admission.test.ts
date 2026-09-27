import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.js';
import { registerCallbackFilePublication } from '../src/routes/callback-file-publication.js';

const headers = { 'x-invocation-id': 'admission-inv', 'x-callback-token': 'synthetic-token' };
const bytes = Buffer.alloc(1024 * 1024 + 1, 65);
const body = {
  fileName: 'synthetic.txt',
  mimeType: 'text/plain',
  dataBase64: bytes.toString('base64'),
  sha256: createHash('sha256').update(bytes).digest('hex'),
};

async function harness(t, options = {}) {
  const uploadDir = await mkdtemp(join(tmpdir(), 'publication-admission-'));
  const app = Fastify();
  const observed = { parsed: 0, verified: 0, valid: true, recovering: false, policy: undefined };
  const registry = {
    isStartupRecoveryComplete: () => !observed.recovering,
    verify: async (id, token) => {
      observed.verified++;
      return observed.valid && id === headers['x-invocation-id'] && token === headers['x-callback-token']
        ? {
            ok: true,
            record: {
              invocationId: id,
              threadId: 'test-thread',
              catId: 'codex',
              userId: 'test-owner',
              toolExecutionPolicy: observed.policy,
            },
          }
        : { ok: false, reason: 'revoked' };
    },
    isLatest: async () => true,
  };
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, raw, done) => {
    observed.parsed++;
    done(null, JSON.parse(raw));
  });
  if (options.afterParse) app.addHook('preValidation', async () => options.afterParse(observed));
  registerCallbackAuthHook(app, registry);
  registerCallbackFilePublication(app, {
    registry,
    uploadDir,
    messageStore: new MessageStore(),
    socketManager: { broadcastToRoom() {} },
  });
  t.after(() => app.close());
  const post = (customHeaders = headers, payload = body, query = '') =>
    app.inject({
      method: 'POST',
      url: `/api/callbacks/publish-file${query}`,
      headers: customHeaders,
      payload,
    });
  return { observed, post, uploadDir };
}

test('rejects large unauthorized publications before the JSON parser runs', async (t) => {
  for (const [name, supplied] of [
    ['absent', {}],
    ['partial', { 'x-invocation-id': 'admission-inv' }],
    ['wrong', { ...headers, 'x-callback-token': 'wrong' }],
    ['agent-key', { 'x-agent-key-secret': 'synthetic' }],
  ]) {
    await t.test(name, async (t) => {
      const h = await harness(t);
      const response = await h.post(supplied);
      assert.equal(response.statusCode, 401);
      assert.equal(h.observed.parsed, 0, 'body must not reach the parser');
      assert.deepEqual(await readdir(h.uploadDir), []);
    });
  }
  const h = await harness(t);
  assert.equal(
    (
      await h.post(
        {},
        { ...body, invocationId: 'admission-inv', callbackToken: 'synthetic-token' },
        '?invocationId=admission-inv&callbackToken=synthetic-token',
      )
    ).statusCode,
    401,
  );
  assert.equal(h.observed.parsed, 0, 'body/query credentials cannot admit a large body');
});

test('read-only policy and recovery reject before parsing; valid headers admit a large document', async (t) => {
  const h = await harness(t);
  h.observed.policy = { mode: 'read_only', replayDeniedToolNames: [] };
  assert.equal((await h.post()).statusCode, 403);
  assert.equal(h.observed.parsed, 0);
  h.observed.policy = undefined;
  h.observed.recovering = true;
  assert.equal((await h.post()).statusCode, 503);
  assert.equal(h.observed.parsed, 0);
  h.observed.recovering = false;
  assert.equal((await h.post()).statusCode, 200);
  assert.equal(h.observed.parsed, 1);
});

test('early admission does not bypass credential or policy changes while the body is read', async (t) => {
  for (const [name, afterParse, expected] of [
    [
      'revocation',
      (state) => {
        state.valid = false;
      },
      401,
    ],
    [
      'read-only',
      (state) => {
        state.policy = { mode: 'read_only', replayDeniedToolNames: [] };
      },
      403,
    ],
  ]) {
    await t.test(name, async (t) => {
      const h = await harness(t, { afterParse });
      assert.equal((await h.post()).statusCode, expected);
      assert.equal(h.observed.parsed, 1);
      assert.equal(h.observed.verified, 2, 'reverify after body parsing');
      assert.deepEqual(await readdir(h.uploadDir), []);
    });
  }
});
