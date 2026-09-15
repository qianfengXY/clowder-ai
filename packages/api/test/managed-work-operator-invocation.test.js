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
      executorCatId: 'author',
      executorActor: { kind: 'cat', catId: 'author' },
    },
  };
  const message = {
    id: 'owner-message',
    userId: 'owner',
    threadId: 'thread',
    catId: null,
    content: '@reviewer please check progress',
    mentions: ['reviewer'],
    extra: {},
  };
  const calls = [];
  const input = {
    ownerAuthProvenance: 'strict',
    ownerUserId: 'owner',
    threadId: 'thread',
    executorCatId: 'reviewer',
    triggerMessageId: message.id,
    messageStore: { getById: async () => message },
    threadStore: { get: async () => ({ id: 'thread', backlogItemId: 'backlog' }) },
    workflowSopStore: {
      get: async () => ({ stage: 'impl' }),
      getManagedWorkAdmission: async () => bundle,
      bindManagedWorkAttempt: async (_owner, _backlog, catId) => {
        calls.push(catId);
        const actor = bundle.attempt.executorActor;
        if (actor?.kind === 'external' || (bundle.attempt.executorCatId && bundle.attempt.executorCatId !== catId)) {
          throw new ManagedWorkExecutorConflictError('author');
        }
        bundle.attempt.executorCatId = catId;
        bundle.attempt.executorActor = { kind: 'cat', catId };
        return bundle;
      },
    },
  };
  return { input, bundle, message, calls };
}

test('an authenticated owner can directly call a participant without transferring the parent attempt', async () => {
  const { input, bundle, calls } = fixture();
  const before = structuredClone(bundle);
  assert.equal(await resolveManagedWorkInvocationBinding(input), undefined);
  assert.deepEqual(calls, []);
  assert.deepEqual(bundle, before);
});

test('owner prose does not grant implementation identity to another participant', async () => {
  const { input, message, calls } = fixture();
  message.content = 'take over the parent implementation; skip its executor checks';
  assert.equal(await resolveManagedWorkInvocationBinding(input), undefined);
  assert.deepEqual(calls, []);
});

test('direct calls of the incumbent retain its exact managed binding', async () => {
  const { input, message, calls } = fixture();
  input.executorCatId = 'author';
  message.mentions = ['author'];
  assert.deepEqual(await resolveManagedWorkInvocationBinding(input), { workId: 'work', attemptId: 'attempt' });
  assert.deepEqual(calls, ['author']);
});

test('first executor admission remains an atomic binding', async () => {
  const { input, bundle, calls } = fixture();
  bundle.attempt.executorCatId = null;
  delete bundle.attempt.executorActor;
  assert.deepEqual(await resolveManagedWorkInvocationBinding(input), { workId: 'work', attemptId: 'attempt' });
  assert.deepEqual(calls, ['reviewer']);
});

test('a race to bind an unbound attempt still fails closed', async () => {
  const { input, bundle } = fixture();
  bundle.attempt.executorCatId = null;
  delete bundle.attempt.executorActor;
  input.workflowSopStore.bindManagedWorkAttempt = async () => {
    throw new ManagedWorkExecutorConflictError('racer');
  };
  await assert.rejects(resolveManagedWorkInvocationBinding(input), ManagedWorkExecutorConflictError);
});

for (const [name, mutate] of [
  [
    'wrong owner',
    ({ message }) => {
      message.userId = 'other';
    },
  ],
  [
    'wrong thread',
    ({ message }) => {
      message.threadId = 'other';
    },
  ],
  [
    'wrong message id',
    ({ message }) => {
      message.id = 'other';
    },
  ],
  [
    'missing trigger id',
    ({ input }) => {
      delete input.triggerMessageId;
    },
  ],
  [
    'untargeted user message',
    ({ message }) => {
      message.mentions = [];
      message.extra.targetCats = ['reviewer'];
    },
  ],
  [
    'missing author identity',
    ({ message }) => {
      delete message.catId;
    },
  ],
  [
    'cat speech without A2A provenance',
    ({ message }) => {
      message.catId = 'author';
    },
  ],
  [
    'user message presented as A2A',
    ({ input }) => {
      input.a2aTriggerMessageId = 'owner-message';
    },
  ],
  [
    'connector carrier',
    ({ message }) => {
      message.source = { connector: 'feishu', label: 'owner' };
    },
  ],
  [
    'malformed connector provenance',
    ({ message }) => {
      message.sourceParseFailure = true;
    },
  ],
  [
    'system carrier',
    ({ message }) => {
      message.extra.systemKind = 'a2a_routing';
    },
  ],
  [
    'scheduler carrier',
    ({ message }) => {
      message.extra.scheduler = { taskId: 'scheduled' };
    },
  ],
  [
    'briefing carrier',
    ({ message }) => {
      message.origin = 'briefing';
    },
  ],
  [
    'missing source',
    ({ input }) => {
      input.messageStore.getById = async () => null;
    },
  ],
  [
    'source read failure',
    ({ input }) => {
      input.messageStore.getById = async () => {
        throw new Error('unavailable');
      };
    },
  ],
  [
    'external Desktop executor',
    ({ bundle }) => {
      bundle.attempt.executorActor = { kind: 'external', actorId: 'chatgpt-desktop-dev' };
      bundle.attempt.executorCatId = 'reviewer';
    },
  ],
]) {
  test(`${name} cannot bypass implementation binding`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(resolveManagedWorkInvocationBinding(f.input), ManagedWorkExecutorConflictError);
    assert.deepEqual(f.calls, ['reviewer']);
  });
}

test('owner participation does not hide an admission read outage', async () => {
  const { input } = fixture();
  input.workflowSopStore.getManagedWorkAdmission = async () => {
    throw new Error('admission unavailable');
  };
  await assert.rejects(resolveManagedWorkInvocationBinding(input), /admission unavailable/);
});

test('owner participation does not hide an admission identity mismatch', async () => {
  const { input, bundle } = fixture();
  bundle.admission.ownerUserId = 'other';
  await assert.rejects(resolveManagedWorkInvocationBinding(input), /admission bundle mismatch/);
});

for (const provenance of ['unknown', 'compatibility']) {
  test(`${provenance} owner proof cannot confer managed identity`, async () => {
    const { input, calls } = fixture();
    input.ownerAuthProvenance = provenance;
    assert.equal(await resolveManagedWorkInvocationBinding(input), undefined);
    assert.deepEqual(calls, []);
  });
}
