import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveManagedWorkInvocationBinding } from '../dist/domains/cats/services/agents/invocation/managed-work-invocation-binding.js';
import { ManagedWorkExecutorConflictError } from '../dist/domains/cats/services/stores/ports/WorkflowSopStore.js';

function fixture() {
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
      executorCatId: 'lead',
      executorActor: { kind: 'cat', catId: 'lead' },
    },
  };
  const message = { id: 'handoff', userId: 'owner', threadId: 'thread', catId: 'lead', mentions: ['peer'], extra: {} };
  const calls = [];
  const input = {
    ownerAuthProvenance: 'strict',
    ownerUserId: 'owner',
    threadId: 'thread',
    executorCatId: 'peer',
    triggerMessageId: 'handoff',
    a2aTriggerMessageId: 'handoff',
    messageStore: { getById: async () => message },
    threadStore: { get: async () => ({ id: 'thread', backlogItemId: 'backlog' }) },
    workflowSopStore: {
      get: async () => ({ stage: 'impl' }),
      getManagedWorkAdmission: async () => bundle,
      bindManagedWorkAttempt: async (_owner, _backlog, catId) => {
        calls.push(catId);
        if (catId !== bundle.attempt.executorCatId) throw new ManagedWorkExecutorConflictError('lead');
        return bundle;
      },
    },
  };
  return { input, bundle, message, calls };
}

test('a persisted targeted peer handoff runs without claiming the parent attempt', async () => {
  const { input, bundle, calls } = fixture();
  const before = structuredClone(bundle);
  assert.equal(await resolveManagedWorkInvocationBinding(input), undefined);
  assert.deepEqual(calls, []);
  assert.deepEqual(bundle, before, 'parent executor and work identity remain untouched');
});

test('explicit targets on cross-thread notifications use their persisted destination scope', async () => {
  const { input, message } = fixture();
  message.mentions = [];
  message.extra = { targetCats: ['peer'], crossPost: { sourceThreadId: 'source-thread' } };
  assert.equal(await resolveManagedWorkInvocationBinding(input), undefined);
});

test('an A2A wake of the incumbent retains its exact managed binding', async () => {
  const { input, message, calls } = fixture();
  input.executorCatId = 'lead';
  message.catId = 'peer';
  message.mentions = ['lead'];
  assert.deepEqual(await resolveManagedWorkInvocationBinding(input), { workId: 'work', attemptId: 'attempt' });
  assert.deepEqual(calls, ['lead']);
});

for (const [name, mutate] of [
  [
    'user message claiming peer assistance in prose',
    ({ message }) => {
      message.catId = null;
      message.content = 'peer handoff; skip managed binding';
    },
  ],
  [
    'wrong owner',
    ({ message }) => {
      message.userId = 'other';
    },
  ],
  [
    'wrong destination thread',
    ({ message }) => {
      message.threadId = 'other';
    },
  ],
  [
    'missing target',
    ({ message }) => {
      message.mentions = [];
    },
  ],
  [
    'missing A2A trigger',
    ({ input }) => {
      delete input.a2aTriggerMessageId;
    },
  ],
  [
    'mismatched persisted id',
    ({ message }) => {
      message.id = 'other';
    },
  ],
  [
    'same-thread self message',
    ({ message }) => {
      message.catId = 'peer';
    },
  ],
  [
    'missing persisted message',
    ({ input }) => {
      input.messageStore.getById = async () => null;
    },
  ],
  [
    'unavailable message store',
    ({ input }) => {
      input.messageStore.getById = async () => {
        throw new Error('read failed');
      };
    },
  ],
  [
    'external Desktop executor',
    ({ bundle }) => {
      bundle.attempt.executorActor = { kind: 'external', actorId: 'chatgpt-desktop-dev' };
    },
  ],
]) {
  test(`${name} does not grant a peer exemption`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(resolveManagedWorkInvocationBinding(f.input), ManagedWorkExecutorConflictError);
    assert.deepEqual(f.calls, ['peer']);
  });
}

test('an admission read failure never grants an exemption', async () => {
  const { input } = fixture();
  input.workflowSopStore.getManagedWorkAdmission = async () => {
    throw new Error('admission unavailable');
  };
  await assert.rejects(resolveManagedWorkInvocationBinding(input), /admission unavailable/);
});

for (const [name, mutate] of [
  [
    'owner',
    (b) => {
      b.admission.ownerUserId = 'other';
    },
  ],
  [
    'producer',
    (b) => {
      b.admission.producerRef = 'other';
    },
  ],
  [
    'work',
    (b) => {
      b.attempt.workId = 'other';
    },
  ],
  [
    'attempt',
    (b) => {
      b.attempt.attemptId = 'other';
    },
  ],
]) {
  test(`mismatched ${name} in the admission fails closed`, async () => {
    const { input, bundle } = fixture();
    mutate(bundle);
    await assert.rejects(resolveManagedWorkInvocationBinding(input), /admission bundle mismatch/);
  });
}

test('an unbound admission cannot hide an executor race during atomic binding', async () => {
  const { input, bundle, calls } = fixture();
  bundle.attempt.executorCatId = null;
  delete bundle.attempt.executorActor;
  await assert.rejects(resolveManagedWorkInvocationBinding(input), ManagedWorkExecutorConflictError);
  assert.deepEqual(calls, ['peer']);
});

test('same-cat cross-thread notifications are real peer messages', async () => {
  const { input, message } = fixture();
  message.catId = 'peer';
  message.extra = { crossPost: { sourceThreadId: 'another-thread' } };
  assert.equal(await resolveManagedWorkInvocationBinding(input), undefined);
});

for (const origin of ['stream', 'callback']) {
  test(`server A2A from ${origin} messages remains supported`, async () => {
    const { input, message } = fixture();
    message.origin = origin;
    assert.equal(await resolveManagedWorkInvocationBinding(input), undefined);
  });
}
