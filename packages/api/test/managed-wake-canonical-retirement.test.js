import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as managedWake from '../dist/domains/ball-custody/managed-command-wake-carrier-adapter.js';
import { createManagedCommandWakeCarrierAdapter } from '../dist/domains/ball-custody/managed-command-wake-carrier-adapter.js';

const identity = { taskId: 'task-1', threadId: 'thread-1', userId: 'user-1', catId: 'codex', messageId: 'message-1' };
function harness(overrides = {}) {
  const events = [];
  const message = {
    id: identity.messageId,
    threadId: identity.threadId,
    userId: identity.userId,
    catId: null,
    from:
      overrides.legacy === 'hydrated'
        ? { kind: 'external', connectorId: 'hold-ball' }
        : overrides.legacy
          ? undefined
          : overrides.untrusted
            ? { kind: 'user', userId: identity.userId }
            : { kind: 'system', service: 'hold-ball' },
    deliveryStatus: overrides.processing ? 'delivered' : 'queued',
    source: {
      connector: 'hold-ball',
      meta: {
        wakeWhen: true,
        taskId: overrides.wrongTask ? 'other-task' : identity.taskId,
        threadId: identity.threadId,
        catId: identity.catId,
      },
    },
    ...(overrides.processing
      ? { lifecycle: { kind: 'source', dispatchRefs: [{ targetId: identity.catId, statusMessageId: 'response-1' }] } }
      : {}),
  };
  const entry = {
    id: 'entry-1',
    threadId: identity.threadId,
    owner: { kind: 'user', userId: identity.userId },
    targets: overrides.extraTarget ? ['codex', 'opus'] : ['codex'],
    status: 'queued',
    payload: { messageId: identity.messageId },
  };
  if (overrides.legacy) message.userId = 'scheduler';
  const deps = {
    messageStore: {
      getById: async (id) =>
        id === 'response-1'
          ? {
              id,
              threadId: identity.threadId,
              userId: identity.userId,
              lifecycle: {
                kind: 'response',
                status: 'processing',
                targetId: identity.catId,
                inputMessageIds: [identity.messageId],
              },
            }
          : message,
      markCanceled: async () => {
        events.push('cancel-source');
        if (overrides.failure) throw new Error('unavailable');
        return { deliveryTransitioned: true };
      },
    },
    invocationRecordStore: { get: async () => null },
    invocationQueue: {
      listScopes: () => [{ threadId: identity.threadId, userId: identity.userId }],
      list: () => [entry],
      getDurableEntriesForMessages: async () => new Map([[identity.messageId, overrides.processing ? [] : [entry]]]),
      claimQueuedEntryForWithdrawal: async () => {
        events.push('claim');
        return entry;
      },
      commitClaimedWithdrawal: async () => {
        events.push('commit');
        return entry;
      },
      restoreClaimedEntries: async () => {
        events.push('restore');
        return true;
      },
    },
  };
  const adapter = createManagedCommandWakeCarrierAdapter(deps);
  return { adapter, events, deps };
}
test('replacement retires the exact pending managed wake through canonical Queue claim/source/commit', async () => {
  const { adapter, events } = harness();
  assert.equal(await adapter.retireEventCarrier(identity), 'retired');
  assert.deepEqual(events, ['claim', 'cancel-source', 'commit']);
});
test('replacement preserves a running response and rejects task or target-scope mismatch', async () => {
  for (const [options, expected] of [
    [{ processing: true }, 'in_flight'],
    [{ wrongTask: true }, 'unavailable'],
    [{ extraTarget: true }, 'unavailable'],
  ]) {
    const { adapter, events } = harness(options);
    assert.equal(await adapter.retireEventCarrier(identity), expected);
    assert.deepEqual(events, []);
  }
});
test('replacement restores the Queue claim when the durable source cancellation fails', async () => {
  const { adapter, events } = harness({ failure: true });
  assert.equal(await adapter.retireEventCarrier(identity), 'unavailable');
  assert.deepEqual(events, ['claim', 'cancel-source', 'restore']);
});
test('startup retires exact missing-producer wakes through the current Queue, including legacy scheduler sources', async () => {
  for (const legacy of [false, true, 'hydrated']) {
    const { deps, events } = harness({ legacy });
    const retired = await managedWake.retireOrphanManagedCommandWakeCarriers({
      ...deps,
      dynamicTaskStore: { getById: () => null },
    });
    assert.equal(retired, 1);
    assert.deepEqual(events, ['claim', 'cancel-source', 'commit']);
  }
});
test('legacy raw and Redis-hydrated scheduler sources retain pending delivery observation', async () => {
  for (const legacy of [true, 'hydrated']) {
    const { adapter } = harness({ legacy });
    assert.deepEqual(await adapter.getEventCarrier(identity), { state: 'pending' });
    assert.deepEqual(await adapter.getEventCarrier({ ...identity, userId: 'foreign-user' }), { state: 'missing' });
    assert.equal(await adapter.retireEventCarrier({ ...identity, userId: 'foreign-user' }), 'unavailable');
  }
});
test('startup preserves existing producers, uncertain task reads, untrusted sources and shared-target rows', async () => {
  for (const options of [{}, { failure: true }, { untrusted: true }, { extraTarget: true }]) {
    const { deps, events } = harness(options);
    const dynamicTaskStore = {
      getById: () => {
        if (options.failure) throw new Error('task read unavailable');
        return Object.keys(options).length ? null : { id: identity.taskId };
      },
    };
    if (options.failure)
      await assert.rejects(
        () => managedWake.retireOrphanManagedCommandWakeCarriers({ ...deps, dynamicTaskStore }),
        /task read unavailable/,
      );
    else assert.equal(await managedWake.retireOrphanManagedCommandWakeCarriers({ ...deps, dynamicTaskStore }), 0);
    assert.deepEqual(events, []);
  }
});
