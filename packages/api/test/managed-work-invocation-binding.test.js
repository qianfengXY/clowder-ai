import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('managed-work invocation binding provenance', () => {
  async function loadResolver() {
    return import('../dist/domains/cats/services/agents/invocation/managed-work-invocation-binding.js');
  }

  function fixture(messageForId) {
    const bindCalls = [];
    return {
      bindCalls,
      input: {
        ownerAuthProvenance: 'strict',
        ownerUserId: 'owner-1',
        threadId: 'feature-review-thread',
        executorCatId: 'cat-codex',
        messageStore: { getById: messageForId },
        threadStore: { get: async () => ({ backlogItemId: 'backlog-1' }) },
        workflowSopStore: {
          bindManagedWorkAttempt: async (ownerUserId, backlogItemId, executorCatId) => {
            bindCalls.push({ ownerUserId, backlogItemId, executorCatId });
            return {
              admission: {
                workId: 'work-1',
                ownerUserId,
                producerKind: 'workflow_sop_v1',
                producerRef: backlogItemId,
                initialAttemptId: 'attempt-1',
                admittedAt: 1,
              },
              attempt: {
                attemptId: 'attempt-1',
                workId: 'work-1',
                attemptNumber: 1,
                executorCatId,
                createdAt: 1,
                executorBoundAt: 2,
              },
            };
          },
        },
      },
    };
  }

  test('does not claim implementation ownership for a persisted Review orchestration trigger', async () => {
    const { resolveManagedWorkInvocationBinding } = await loadResolver();
    const { input, bindCalls } = fixture(async (id) =>
      id === 'review-trigger' ? { extra: { systemKind: 'review_orchestration' } } : null,
    );
    const result = await resolveManagedWorkInvocationBinding({ ...input, triggerMessageId: 'review-trigger' });
    assert.equal(result, undefined);
    assert.deepEqual(bindCalls, []);
  });

  test('ordinary trigger still binds, even if its text claims to be Review orchestration', async () => {
    const { resolveManagedWorkInvocationBinding } = await loadResolver();
    const { input, bindCalls } = fixture(async () => ({ content: 'review_orchestration' }));
    const result = await resolveManagedWorkInvocationBinding({ ...input, triggerMessageId: 'ordinary-trigger' });
    assert.deepEqual(result, { workId: 'work-1', attemptId: 'attempt-1' });
    assert.equal(bindCalls.length, 1);
  });

  test('provenance read failure does not manufacture an exemption', async () => {
    const { resolveManagedWorkInvocationBinding } = await loadResolver();
    const { input, bindCalls } = fixture(async () => {
      throw new Error('message store unavailable');
    });
    const result = await resolveManagedWorkInvocationBinding({ ...input, triggerMessageId: 'unknown-trigger' });
    assert.deepEqual(result, { workId: 'work-1', attemptId: 'attempt-1' });
    assert.equal(bindCalls.length, 1);
  });
});
