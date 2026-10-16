import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';

test('the retired stateless callback cannot create a parallel freshness notice source', async () => {
  const registry = new InvocationRegistry();
  const identity = await registry.create('owner', 'codex-astra', 'home');
  let redisCalls = 0;
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore: new MessageStore(),
    socketManager: { broadcastAgentMessage() {} },
    deliveryCursorStore: { getSeenCursor: async () => 'seed' },
    redis: new Proxy(
      {},
      {
        get: () => async () => {
          redisCalls++;
          throw new Error('fixture Redis unavailable');
        },
      },
    ),
  });
  const request = {
    method: 'POST',
    url: '/api/callbacks/freshness-notice-check',
    payload: { toolName: 'get_thread_context', isReadOnly: true },
    headers: { 'x-invocation-id': identity.invocationId, 'x-callback-token': identity.callbackToken },
  };
  try {
    // Upstream #1398 removed this endpoint. Native/Live broker coverage lives
    // in f254-provider-native-freshness and f317-idle-freshness tests.
    assert.equal((await app.inject({ ...request, headers: {} })).statusCode, 404);
    assert.equal((await app.inject(request)).statusCode, 404);
    assert.equal(redisCalls, 0, 'an old callback must not query or mint freshness beside the current owner');
  } finally {
    await app.close();
  }
});
