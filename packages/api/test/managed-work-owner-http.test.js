import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { migrateRouterOpts } from './helpers/agent-registry-helpers.js';

test('owner HTTP mention reaches the provider and a reloadable reply without taking parent custody', async (t) => {
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'owner-http-wake-'));
  for (const [key, value] of Object.entries({
    AUDIT_LOG_DIR: isolatedRoot,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: isolatedRoot,
    CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const threadStore = new ThreadStore();
  const messageStore = new MessageStore();
  const invocationRecordStore = new InvocationRecordStore();
  const turnExecutionStore = new InMemoryTurnExecutionStore();
  const registry = new InvocationRegistry();
  const invocationTracker = new InvocationTracker();
  const thread = threadStore.create('owner', 'Owner wake acceptance', isolatedRoot);
  threadStore.linkBacklogItem(thread.id, 'backlog');
  const bundle = {
    admission: {
      ownerUserId: 'owner',
      producerKind: 'workflow_sop_v1',
      producerRef: 'backlog',
      workId: 'work',
      initialAttemptId: 'attempt',
    },
    attempt: {
      workId: 'work',
      attemptId: 'attempt',
      attemptNumber: 1,
      executorCatId: 'opus',
      executorActor: { kind: 'cat', catId: 'opus' },
    },
  };
  const originalBundle = structuredClone(bundle);
  const binds = t.mock.fn(async () => {
    throw new Error('must not take parent implementation custody');
  });
  const creations = t.mock.method(registry, 'create');
  let providerCalls = 0;
  const router = new AgentRouter(
    await migrateRouterOpts({
      registry,
      messageStore,
      threadStore,
      turnExecutionStore,
      workflowSopStore: {
        get: async () => ({ stage: 'impl' }),
        getManagedWorkAdmission: async () => bundle,
        bindManagedWorkAttempt: binds,
      },
      codexService: {
        async *invoke() {
          providerCalls++;
          yield { type: 'text', catId: 'codex', content: 'I can respond to your direct call.', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        },
      },
    }),
  );
  const terminal = Promise.withResolvers();
  const update = invocationRecordStore.update.bind(invocationRecordStore);
  t.mock.method(invocationRecordStore, 'update', (...args) => {
    const result = update(...args);
    if (['succeeded', 'failed', 'canceled'].includes(args[1].status)) terminal.resolve(args[1]);
    return result;
  });
  const events = [];
  const app = Fastify();
  t.after(() => app.close());
  await app.register(messagesRoutes, {
    registry,
    router,
    messageStore,
    threadStore,
    invocationRecordStore,
    invocationTracker,
    socketManager: {
      broadcastAgentMessage: (event) => events.push(event),
      broadcastToRoom() {},
      emitToUser() {},
    },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: thread.id, content: '@codex please continue our discussion' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const accepted = response.json();
  assert.equal(accepted.status, 'processing');
  assert.equal((await terminal.promise).status, 'succeeded', JSON.stringify(events));
  assert.equal(providerCalls, 1);
  assert.equal(binds.mock.callCount(), 0);
  assert.deepEqual(bundle, originalBundle);
  const source = messageStore.getById(accepted.userMessageId);
  assert.equal(source.catId, null);
  assert.deepEqual(source.mentions, ['codex']);
  const call = creations.mock.calls[0];
  assert.equal(call.arguments[4], undefined, 'HTTP user ingress must not acquire A2A provenance');
  assert.equal(call.arguments[6], source.id);
  assert.equal(call.arguments[7], 'strict');
  assert.equal(call.arguments[8], undefined, 'callback must not acquire parent work identity');
  const child = await call.result;
  assert.equal((await turnExecutionStore.get(child.invocationId)).status, 'succeeded');
  const history = await app.inject({
    method: 'GET',
    url: `/api/messages?threadId=${thread.id}`,
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(history.statusCode, 200);
  assert.ok(
    history
      .json()
      .messages.some(
        (message) => message.catId === 'codex' && message.content.includes('I can respond to your direct call.'),
      ),
  );
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
});
