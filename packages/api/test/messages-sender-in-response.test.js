/**
 * GET /api/messages — verify source.sender is included in API response.
 *
 * Regression test: the API serializer previously stripped source.sender,
 * so the frontend never received group chat sender identity.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');

function buildDeps(overrides = {}) {
  return {
    registry: new InvocationRegistry(),
    messageStore: {
      append: mock.fn(async (msg) => ({ id: `msg-${Date.now()}`, ...msg })),
      getByThread: mock.fn(async () => []),
      getByThreadBefore: mock.fn(async () => []),
      getByIdempotencyKey: mock.fn(async () => null),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    router: {
      resolveTargetsAndIntent: mock.fn(async () => ({
        targetCats: ['opus'],
        intent: { intent: 'execute' },
      })),
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
      route: mock.fn(async function* () {
        yield { type: 'done' };
      }),
    },
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      tryStartThread: mock.fn(() => new AbortController()),
      tryStartThreadAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
      cancel: mock.fn(() => ({ cancelled: true, catIds: ['opus'] })),
      cancelAll: mock.fn(() => ({ catIds: ['opus'], executionIds: [] })),
      cancelInvocation: mock.fn(() => ['opus']),
      isDeleting: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({
        outcome: 'created',
        invocationId: 'inv-stub',
      })),
      update: mock.fn(async () => {}),
      get: mock.fn(async () => null),
    },
    invocationQueue: new InvocationQueue(),
    queueProcessor: {
      clearPause: mock.fn(),
      onInvocationComplete: mock.fn(async () => {}),
      enqueueContinuation: mock.fn(async () => ({ outcome: 'enqueued' })),
    },
    threadStore: {
      get: mock.fn(async () => ({
        id: 'thread-1',
        title: 'Test Thread',
        createdBy: 'test-user',
      })),
      updateTitle: mock.fn(async () => {}),
    },
    ...overrides,
  };
}

describe('GET /api/messages source.sender serialization', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('includes source.sender in API response for group chat messages', async () => {
    const groupMessage = {
      id: 'msg-group-1',
      content: '嘿嘿 测试消息',
      catId: null,
      userId: 'test-user',
      threadId: 'thread-1',
      timestamp: Date.now(),
      status: 'delivered',
      source: {
        connector: 'feishu',
        label: '飞书群聊 · 猫猫咖啡',
        icon: '🐦',
        sender: { id: 'ou_abc123def456', name: 'co-creator' },
      },
    };

    const deps = buildDeps({
      messageStore: {
        append: mock.fn(async (msg) => ({ id: `msg-${Date.now()}`, ...msg })),
        getByThread: mock.fn(async () => [groupMessage]),
        getByThreadBefore: mock.fn(async () => []),
      },
    });

    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.messages.length > 0, 'should have messages');

    const msg = body.messages[0];
    assert.equal(msg.type, 'connector', 'should be connector type');
    assert.ok(msg.source, 'should have source');
    assert.ok(msg.source.sender, 'source.sender must be present in API response');
    assert.equal(msg.source.sender.id, 'ou_abc123def456');
    assert.equal(msg.source.sender.name, 'co-creator');
  });

  it('omits source.sender when not present (p2p messages)', async () => {
    const p2pMessage = {
      id: 'msg-p2p-1',
      content: '你好',
      catId: null,
      userId: 'test-user',
      threadId: 'thread-1',
      timestamp: Date.now(),
      status: 'delivered',
      source: {
        connector: 'feishu',
        label: '飞书',
        icon: '🐦',
        // no sender — p2p message
      },
    };

    const deps = buildDeps({
      messageStore: {
        append: mock.fn(async (msg) => ({ id: `msg-${Date.now()}`, ...msg })),
        getByThread: mock.fn(async () => [p2pMessage]),
        getByThreadBefore: mock.fn(async () => []),
      },
    });

    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const msg = body.messages[0];
    assert.equal(msg.source.connector, 'feishu');
    assert.equal(msg.source.sender, undefined, 'p2p should not have sender');
  });

  it('includes sender.id fallback when sender.name is absent', async () => {
    const noNameMessage = {
      id: 'msg-noname-1',
      content: '无名氏消息',
      catId: null,
      userId: 'test-user',
      threadId: 'thread-1',
      timestamp: Date.now(),
      status: 'delivered',
      source: {
        connector: 'feishu',
        label: '飞书群聊 · 测试群',
        icon: '🐦',
        sender: { id: 'ou_xyz789' },
      },
    };

    const deps = buildDeps({
      messageStore: {
        append: mock.fn(async (msg) => ({ id: `msg-${Date.now()}`, ...msg })),
        getByThread: mock.fn(async () => [noNameMessage]),
        getByThreadBefore: mock.fn(async () => []),
      },
    });

    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const msg = body.messages[0];
    assert.ok(msg.source.sender, 'sender must be present');
    assert.equal(msg.source.sender.id, 'ou_xyz789');
    assert.equal(msg.source.sender.name, undefined, 'name should not be fabricated');
  });
});

describe('POST /api/messages internal Review Hub orchestration', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('rejects a server-authored marker without the process-local capability', async () => {
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, buildDeps({ internalMessageIngressToken: 'internal-secret' }));
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: {
        content: '@opus review this',
        threadId: 'thread-1',
        serverAuthoredKind: 'review_orchestration',
      },
    });

    assert.equal(res.statusCode, 403);
  });

  it('persists internal orchestration provenance and the caller idempotency key', async () => {
    const deps = buildDeps({ internalMessageIngressToken: 'internal-secret' });
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();

    const idempotencyKey = '33333333-3333-4333-8333-333333333333';
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: {
        'x-cat-cafe-user': 'test-user',
        'x-cat-cafe-internal-message-token': 'internal-secret',
      },
      payload: {
        content: '@opus review this',
        threadId: 'thread-1',
        idempotencyKey,
        serverAuthoredKind: 'review_orchestration',
      },
    });

    assert.equal(res.statusCode, 200);
    const authored = deps.messageStore.append.mock.calls.find(
      (call) => call.arguments[0]?.content === '@opus review this',
    );
    assert.ok(authored);
    assert.equal(authored.arguments[0].idempotencyKey, idempotencyKey);
    assert.deepEqual(authored.arguments[0].extra, { systemKind: 'review_orchestration' });
  });

  it('does not invoke or append when a restart replays the same orchestration stage', async () => {
    const deps = buildDeps({
      internalMessageIngressToken: 'internal-secret',
      messageStore: {
        append: mock.fn(async (msg) => ({ id: `msg-${Date.now()}`, ...msg })),
        getByThread: mock.fn(async () => []),
        getByThreadBefore: mock.fn(async () => []),
        getByIdempotencyKey: mock.fn(async () => ({ id: 'existing-review-stage-message' })),
      },
    });
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: {
        'x-cat-cafe-user': 'test-user',
        'x-cat-cafe-internal-message-token': 'internal-secret',
      },
      payload: {
        content: '@opus review this',
        threadId: 'thread-1',
        idempotencyKey: '44444444-4444-4444-8444-444444444444',
        serverAuthoredKind: 'review_orchestration',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      status: 'duplicate',
      userMessageId: 'existing-review-stage-message',
    });
    assert.equal(deps.messageStore.append.mock.callCount(), 0);
    assert.equal(deps.invocationRecordStore.create.mock.callCount(), 0);
  });

  it('does not acknowledge a queued orchestration replay until durable queue recovery restores custody', async () => {
    const deps = buildDeps({
      internalMessageIngressToken: 'internal-secret',
      messageStore: {
        append: mock.fn(async (msg) => ({ id: `msg-${Date.now()}`, ...msg })),
        getByThread: mock.fn(async () => []),
        getByThreadBefore: mock.fn(async () => []),
        getByIdempotencyKey: mock.fn(async () => ({
          id: 'queued-review-stage-message',
          deliveryStatus: 'queued',
        })),
      },
    });
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: {
        'x-cat-cafe-user': 'test-user',
        'x-cat-cafe-internal-message-token': 'internal-secret',
      },
      payload: {
        content: '@opus review this',
        threadId: 'thread-1',
        idempotencyKey: '55555555-5555-4555-8555-555555555555',
        serverAuthoredKind: 'review_orchestration',
      },
    });

    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).code, 'REVIEW_QUEUE_RECOVERY_PENDING');
    assert.equal(deps.messageStore.append.mock.callCount(), 0);
    assert.equal(deps.invocationRecordStore.create.mock.callCount(), 0);
  });
});
