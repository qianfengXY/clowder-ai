import assert from 'node:assert/strict';
import { get } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { registerInvocationTrajectoryRoutes } from '../dist/routes/invocation-trajectory-routes.js';

function createApp(listInvocationSummaries) {
  const app = Fastify();
  const thread = { id: 't', createdBy: 'user' };
  const sessions = [0, 1, 2].map((seq) => ({ id: `s${seq}`, threadId: 't', catId: 'c', seq, status: 'active' }));
  registerInvocationTrajectoryRoutes(app, {
    stores: {
      threadStore: { get: async () => thread, list: async () => [thread] },
      sessionChainStore: { getChainByThread: async () => sessions },
      invocationRecordStore: { get: async () => null },
    },
    listInvocationSummaries,
    readInvocationEvents: async () => [],
  });
  return app;
}

// Whole-session payload avoidance and bounded worker cancellation are exercised
// against the real indexed reader in transcript-invocation-read-liveness.test.js.
test('list delegates scoped sessions and pagination to the indexed owner without reading full transcripts', async () => {
  const calls = [];
  const app = createApp(async (sessions, limit, signal) => {
    calls.push({ sessions, limit, signal });
    return { total: 3, invocations: [{ invocationId: 'i2' }] };
  });
  try {
    const result = await app.inject({
      url: '/api/threads/t/invocations?limit=1',
      headers: { 'x-cat-cafe-user': 'user' },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].sessions.map(({ id }) => id),
      ['s0', 's1', 's2'],
    );
    assert.equal(calls[0].limit, 1);
    assert.ok(calls[0].signal instanceof AbortSignal);
    assert.equal(result.json().total, 3);
    assert.equal(result.json().invocations[0].invocationId, 'i2');
  } finally {
    await app.close();
  }
});

test('disconnect cancels the indexed owner read without starting another read', { timeout: 5000 }, async () => {
  let started;
  const reading = new Promise((resolve) => {
    started = resolve;
  });
  let sawAbort;
  const aborted = new Promise((resolve) => {
    sawAbort = resolve;
  });
  let reads = 0;
  const app = createApp(async (_sessions, _limit, signal) => {
    reads++;
    started();
    await new Promise((resolve) =>
      signal.addEventListener(
        'abort',
        () => {
          sawAbort();
          resolve();
        },
        { once: true },
      ),
    );
    signal.throwIfAborted();
    return { invocations: [], total: 0 };
  });
  let request;
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    request = get(`${origin}/api/threads/t/invocations`, { headers: { 'x-cat-cafe-user': 'user' } });
    request.on('error', () => {});
    await Promise.race([reading, delay(1000).then(() => assert.fail('indexed list owner was never called'))]);
    request.destroy();
    await Promise.race([aborted, delay(1000).then(() => assert.fail('disconnect did not abort the indexed read'))]);
    assert.equal(reads, 1);
  } finally {
    request?.destroy();
    await app.close();
  }
});
