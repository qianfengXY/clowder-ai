import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';

test('the invocation path carries exact A2A provenance and reaches the peer provider without parent binding', async (t) => {
  const auditDir = await mkdtemp(join(tmpdir(), 'managed-peer-audit-'));
  const priorAudit = process.env.AUDIT_LOG_DIR;
  const priorPreflight = process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
  process.env.AUDIT_LOG_DIR = auditDir;
  process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1';
  t.after(() => {
    if (priorAudit === undefined) delete process.env.AUDIT_LOG_DIR;
    else process.env.AUDIT_LOG_DIR = priorAudit;
    if (priorPreflight === undefined) delete process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
    else process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = priorPreflight;
  });
  const source = {
    id: 'peer-source',
    userId: 'owner',
    threadId: 'thread',
    catId: 'opus',
    mentions: ['codex'],
    extra: {},
  };
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
  const ledger = new InMemoryTurnExecutionStore();
  let providerCalled = false;
  let registryArgs;
  const messages = [];
  for await (const message of invokeSingleCat(
    {
      registry: {
        create: async (...args) => {
          registryArgs = args;
          return { invocationId: 'peer-invocation', callbackToken: 'test-token' };
        },
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: { get: async () => ({ id: 'thread', backlogItemId: 'backlog' }) },
      messageStore: { getById: async (id) => (id === source.id ? source : null) },
      workflowSopStore: {
        get: async () => ({ stage: 'impl' }),
        getManagedWorkAdmission: async () => bundle,
        bindManagedWorkAttempt: async () => {
          throw new Error('peer must not bind the parent executor');
        },
      },
      turnExecutionStore: ledger,
      apiUrl: 'http://127.0.0.1:3152',
    },
    {
      ownerAuthProvenance: 'strict',
      userId: 'owner',
      threadId: 'thread',
      catId: 'codex',
      prompt: 'verify existing child task',
      parentInvocationId: 'parent',
      a2aTriggerMessageId: source.id,
      isLastCat: true,
      service: {
        async *invoke() {
          providerCalled = true;
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        },
      },
    },
  ))
    messages.push(message);
  assert.equal(providerCalled, true);
  assert.equal(registryArgs[8], undefined, 'peer callback credentials must not acquire the parent work identity');
  assert.equal((await ledger.get('peer-invocation')).status, 'succeeded');
  assert.equal(
    messages.some((message) => message.type === 'error'),
    false,
  );
});
