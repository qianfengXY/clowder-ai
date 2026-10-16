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

  async function harness() {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
    const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const thread = threadStore.create('test-user', 'Review');
    const invocationQueue = new InvocationQueue();
    const invocationTracker = new InvocationTracker();
    const socketManager = { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} };
    const router = {
      resolveExplicitTargets: async (targets) => targets,
      resolveConversationTargetsAtAdmission: async (targets) => (targets.length ? targets : ['opus']),
    };
    const queueProcessor = new QueueProcessor({
      queue: invocationQueue,
      messageStore,
      invocationTracker,
      socketManager,
      router,
      log: { info() {}, warn() {}, error() {} },
    });
    app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      threadStore,
      invocationQueue,
      invocationTracker,
      queueProcessor,
      socketManager,
      router,
      internalMessageIngressToken: 'internal-secret',
    });
    await app.ready();
    const send = (key, { authorized = true, recoveryAttempt } = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/messages',
        headers: {
          'x-cat-cafe-user': 'test-user',
          ...(authorized ? { 'x-cat-cafe-internal-message-token': 'internal-secret' } : {}),
          ...(recoveryAttempt ? { 'x-cat-cafe-review-recovery-attempt': String(recoveryAttempt) } : {}),
        },
        payload: {
          threadId: thread.id,
          content: '@opus review this',
          mentions: ['opus'],
          serverAuthoredKind: 'review_orchestration',
          idempotencyKey: key,
        },
      });
    return { send, messageStore, invocationQueue, queueProcessor, thread };
  }
  const key = '33333333-3333-4333-8333-333333333333';

  it('rejects a server-authored marker without the process-local capability', async () => {
    const h = await harness();
    assert.equal((await h.send(key, { authorized: false })).statusCode, 403);
    assert.equal((await h.messageStore.getByThreadIncludingQueued(h.thread.id)).length, 0);
  });

  it('persists system orchestration provenance and the caller idempotency key through canonical send', async () => {
    const h = await harness();
    const response = await h.send(key);
    assert.equal(response.statusCode, 202, response.body);
    const stored = await h.messageStore.getById(response.json().userMessageId);
    assert.deepEqual(stored.from, { kind: 'system', service: 'review-orchestration' });
    assert.equal((await h.messageStore.getByIdempotencyKey('test-user', h.thread.id, key)).id, stored.id);
    assert.equal(stored.extra.systemKind, 'review_orchestration');
    assert.equal(h.invocationQueue.list(h.thread.id, 'test-user').length, 1);
  });

  it('does not admit a second source or Queue entry when a restart replays the same stage', async () => {
    const h = await harness();
    const first = await h.send(key);
    const replay = await h.send(key);
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().userMessageId, first.json().userMessageId);
    assert.equal(h.invocationQueue.list(h.thread.id, 'test-user').length, 1);
    assert.equal((await h.messageStore.getByThreadIncludingQueued(h.thread.id)).length, 1);
  });

  it('does not acknowledge a queued replay until durable Queue hydration restores its carrier', async () => {
    const h = await harness();
    const first = await h.send(key);
    const entry = h.invocationQueue.list(h.thread.id, 'test-user')[0];
    assert.ok(await h.invocationQueue.claimQueuedEntryForWithdrawal(h.thread.id, 'test-user', entry.id));
    assert.ok(await h.invocationQueue.commitClaimedWithdrawal(h.thread.id, entry.id));
    const replay = await h.send(key);
    assert.equal(replay.statusCode, 503, replay.body);
    assert.equal(replay.json().code, 'REVIEW_QUEUE_RECOVERY_PENDING');
    assert.equal((await h.messageStore.getByThreadIncludingQueued(h.thread.id)).length, 1);
    assert.equal((await h.messageStore.getById(first.json().userMessageId)).deliveryStatus, 'queued');
  });

  it('reports an existing durable carrier as queued without falsely acknowledging delivery', async () => {
    const h = await harness();
    const first = await h.send(key);
    const replay = await h.send(key);
    const entry = h.invocationQueue.list(h.thread.id, 'test-user')[0];
    assert.equal(replay.statusCode, 202, replay.body);
    assert.deepEqual(replay.json(), { status: 'queued', userMessageId: first.json().userMessageId, entryId: entry.id });
  });

  it('starts one bounded recovery attempt for an idle queued Review orchestration', async () => {
    const h = await harness();
    await h.send(key);
    const entry = h.invocationQueue.list(h.thread.id, 'test-user')[0];
    const processNext = mock.method(h.queueProcessor, 'processNext', async () => ({ started: true, entry }));
    const replay = await h.send(key, { recoveryAttempt: 1 });
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().status, 'recovery_started');
    assert.equal(replay.json().recoveryAttempt, 1);
    assert.equal(processNext.mock.callCount(), 1);
  });

  it('withdraws only the older pending Review stage before admitting the current stage', async () => {
    const h = await harness();
    const first = await h.send(key);
    const second = await h.send('44444444-4444-4444-8444-444444444444');
    assert.equal(second.statusCode, 202, second.body);
    assert.deepEqual(
      h.invocationQueue.list(h.thread.id, 'test-user').map((entry) => entry.payload.messageId),
      [second.json().userMessageId],
    );
    assert.equal((await h.messageStore.getById(first.json().userMessageId)).deliveryStatus, 'canceled');
  });
});
