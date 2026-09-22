import assert from 'node:assert/strict';
import { get } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { registerInvocationTrajectoryRoutes } from '../dist/routes/invocation-trajectory-routes.js';

function createApp(readSessionEvents) {
  const app = Fastify();
  const thread = { id: 't', createdBy: 'user' };
  const sessions = [0, 1, 2].map((seq) => ({ id: `s${seq}`, threadId: 't', catId: 'c', seq, status: 'active' }));
  registerInvocationTrajectoryRoutes(app, {
    stores: {
      threadStore: { get: async () => thread, list: async () => [thread] },
      sessionChainStore: { getChainByThread: async () => sessions },
      invocationRecordStore: { get: async () => null },
    },
    readSessionEvents,
    readInvocationEvents: async () => [],
  });
  return app;
}

test('list releases each full transcript before reading the next, retaining total and newest ordering', async () => {
  let active = 0;
  let peak = 0;
  const app = createApp(async (session) => {
    active++;
    peak = Math.max(peak, active);
    await delay(5);
    active--;
    return [{ v: 1, t: session.seq, eventNo: 0, invocationId: `i${session.seq}`, event: { type: 'done' } }];
  });
  try {
    const result = await app.inject({
      url: '/api/threads/t/invocations?limit=1',
      headers: { 'x-cat-cafe-user': 'user' },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(peak, 1);
    assert.equal(result.json().total, 3);
    assert.equal(result.json().invocations[0].invocationId, 'i2');
  } finally {
    await app.close();
  }
});

test('disconnect cancels the in-progress read and never starts the remaining sessions', { timeout: 5000 }, async () => {
  let started;
  const reading = new Promise((resolve) => {
    started = resolve;
  });
  let sawAbort;
  const aborted = new Promise((resolve) => {
    sawAbort = resolve;
  });
  let reads = 0;
  const app = createApp(async (_session, signal) => {
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
    return [];
  });
  let request;
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    request = get(`${origin}/api/threads/t/invocations`, { headers: { 'x-cat-cafe-user': 'user' } });
    request.on('error', () => {});
    await reading;
    request.destroy();
    await aborted;
    assert.equal(reads, 1);
  } finally {
    request?.destroy();
    await app.close();
  }
});
