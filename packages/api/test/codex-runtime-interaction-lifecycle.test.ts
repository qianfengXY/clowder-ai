import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeInteractionResponse } from '@cat-cafe/shared';
import { createCodexRuntimeInteractionRunState } from '../src/domains/cats/services/agents/providers/CodexRuntimeInteractionRun.js';

const owner = { userId: 'u1', threadId: 'chat1', catId: 'codex', invocationId: 'inv1' };
function ordinaryForm(params = {}) {
  return {
    id: 123,
    method: 'mcpServer/elicitation/request',
    params: {
      serverName: 'ordinary-mcp',
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      mode: 'form',
      message: 'Ordinary form',
      requestedSchema: { type: 'object', properties: {} },
      ...params,
    },
  };
}

const nonPublishingRequests = [
  { name: 'foreign thread', request: () => ordinaryForm({ threadId: 'foreign' }) },
  { name: 'stale turn', request: () => ordinaryForm({ turnId: 'old-turn' }) },
  { name: 'missing binding', request: () => ({ ...ordinaryForm(), params: {} }) },
  { name: 'unsupported method', request: () => ({ ...ordinaryForm(), method: 'unsupported/request' }) },
  { name: 'legacy approval', request: () => ({ ...ordinaryForm(), method: 'execCommandApproval' }) },
];

test('wire ID collisions on rejection paths invalidate an existing pending answer', async (t) => {
  for (const variant of nonPublishingRequests) {
    await t.test(variant.name, async () => {
      let answer: ((response: RuntimeInteractionResponse) => void) | undefined;
      let published = 0;
      const invalidations: unknown[] = [];
      const failures: Error[] = [];
      const written: unknown[] = [];
      const state = createCodexRuntimeInteractionRunState(
        {
          owner,
          port: {
            request: () => {
              published++;
              return new Promise((resolve) => {
                answer = resolve;
              });
            },
            invalidateInvocation: async (...args) => {
              invalidations.push(args);
            },
          },
        },
        'auto_review',
      );
      assert.ok(state);
      state.bindProviderTurn({ threadId: 'provider-thread', turnId: 'provider-turn' });
      const write = async (response: unknown) => {
        written.push(response);
      };
      const fail = (error: Error) => {
        failures.push(error);
      };
      state.dispatch(ordinaryForm(), write, fail);
      assert.ok(answer);
      state.dispatch(variant.request(), write, fail);
      answer({ kind: 'decision', decisionId: 'accept', content: {} });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(published, 1);
      assert.equal(failures.length, 1);
      assert.deepEqual(invalidations, [[owner.invocationId, 'transport_lost']]);
      assert.deepEqual(written, []);
    });
  }
});

test('wire IDs consumed by rejection paths cannot later publish a valid request', async (t) => {
  for (const variant of nonPublishingRequests) {
    await t.test(variant.name, async () => {
      let published = 0;
      const invalidations: unknown[] = [];
      const failures: Error[] = [];
      const written: unknown[] = [];
      const state = createCodexRuntimeInteractionRunState(
        {
          owner,
          port: {
            request: async () => {
              published++;
              return { kind: 'decision', decisionId: 'accept', content: {} };
            },
            invalidateInvocation: async (...args) => {
              invalidations.push(args);
            },
          },
        },
        'auto_review',
      );
      assert.ok(state);
      state.bindProviderTurn({ threadId: 'provider-thread', turnId: 'provider-turn' });
      const write = async (response: unknown) => {
        written.push(response);
      };
      const fail = (error: Error) => {
        failures.push(error);
      };
      state.dispatch(variant.request(), write, fail);
      await new Promise((resolve) => setImmediate(resolve));
      const firstResponse = [...written];
      assert.equal(firstResponse.length, 1);
      state.dispatch(ordinaryForm(), write, fail);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(published, 0);
      assert.equal(failures.length, 1);
      assert.deepEqual(invalidations, [[owner.invocationId, 'transport_lost']]);
      assert.deepEqual(written, firstResponse);
    });
  }
});

test('rejection of a fresh ID leaves other IDs usable and does not consume IDs in another run', async () => {
  for (const rejectFirst of [true, false]) {
    let published = 0;
    const written: unknown[] = [];
    const state = createCodexRuntimeInteractionRunState(
      {
        owner,
        port: {
          request: async () => {
            published++;
            return { kind: 'decision', decisionId: 'accept', content: {} };
          },
        },
      },
      'auto_review',
    );
    assert.ok(state);
    state.bindProviderTurn({ threadId: 'provider-thread', turnId: 'provider-turn' });
    const write = async (response: unknown) => {
      written.push(response);
    };
    if (rejectFirst) {
      state.dispatch(ordinaryForm({ threadId: 'foreign' }), write, assert.fail);
      await new Promise((resolve) => setImmediate(resolve));
    }
    // The second run may use the ID rejected in the first run.
    state.dispatch({ ...ordinaryForm(), id: rejectFirst ? 124 : 123 }, write, assert.fail);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(published, 1);
    assert.deepEqual(written.at(-1), {
      id: rejectFirst ? 124 : 123,
      result: { action: 'accept', content: {} },
    });
    state.close('provider_cancelled');
  }
});

test('a duplicate pending request invalidates its first waiter before a late accept', async () => {
  let answer: ((response: RuntimeInteractionResponse) => void) | undefined;
  let published = 0;
  const invalidations: unknown[] = [];
  const failures: Error[] = [];
  const written: unknown[] = [];
  const state = createCodexRuntimeInteractionRunState(
    {
      owner,
      port: {
        request: () => {
          published++;
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
        invalidateInvocation: async (...args) => {
          invalidations.push(args);
        },
      },
    },
    'auto_review',
  );
  assert.ok(state);
  state.bindProviderTurn({ threadId: 'provider-thread', turnId: 'provider-turn' });
  const write = async (response: unknown) => {
    written.push(response);
  };
  const fail = (error: Error) => {
    failures.push(error);
  };
  state.dispatch(ordinaryForm(), write, fail);
  const firstAnswer = answer;
  assert.ok(firstAnswer);
  state.dispatch(ordinaryForm(), write, fail);
  firstAnswer({ kind: 'decision', decisionId: 'accept', content: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published, 1);
  assert.equal(failures.length, 1);
  assert.match(failures[0]?.message ?? '', /Duplicate/);
  assert.deepEqual(invalidations, [[owner.invocationId, 'transport_lost']]);
  assert.deepEqual(written, []);
});

test('duplicate server request ids are rejected without a second publication', async () => {
  let published = 0;
  const state = createCodexRuntimeInteractionRunState(
    {
      owner,
      port: {
        request: async () => {
          published++;
          return { kind: 'decision', decisionId: 'accept', content: {} };
        },
      },
    },
    'auto_review',
  );
  assert.ok(state);
  state.bindProviderTurn({ threadId: 'provider-thread', turnId: 'provider-turn' });
  const written: unknown[] = [];
  const failures: Error[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    state.dispatch(
      ordinaryForm(),
      async (r) => {
        written.push(r);
      },
      (error) => {
        failures.push(error);
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(published, 1);
  assert.equal(written.length, 1);
  assert.match(failures[0]?.message ?? '', /Duplicate/);
  state.close('provider_cancelled');
});

test('foreign provider coordinates and closed runs cannot publish or replay an old answer', async () => {
  let published = 0;
  const state = createCodexRuntimeInteractionRunState(
    {
      owner,
      port: {
        request: async () => {
          published++;
          return { kind: 'decision', decisionId: 'accept', content: {} };
        },
      },
    },
    'auto_review',
  );
  assert.ok(state);
  state.bindProviderTurn({ threadId: 'provider-thread', turnId: 'provider-turn' });
  const written: unknown[] = [];
  for (const [index, params] of [{ threadId: 'foreign' }, { turnId: 'old-turn' }].entries()) {
    state.dispatch(
      { ...ordinaryForm(params), id: 123 + index },
      async (r) => {
        written.push(r);
      },
      assert.fail,
    );
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published, 0);
  assert.equal(written.length, 2);
  state.close('provider_cancelled');
  state.dispatch(
    ordinaryForm(),
    async (r) => {
      written.push(r);
    },
    assert.fail,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published, 0);
  assert.equal(written.length, 2);
});

test('cancellation and transport timeout suppress a late accept even if the waiter ignores abort', async () => {
  for (const reason of ['provider_cancelled', 'transport_lost'] as const) {
    let answer: ((response: RuntimeInteractionResponse) => void) | undefined;
    const invalidations: unknown[] = [];
    const state = createCodexRuntimeInteractionRunState(
      {
        owner,
        port: {
          request: () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
          invalidateInvocation: async (...args) => {
            invalidations.push(args);
          },
        },
      },
      'auto_review',
    );
    assert.ok(state);
    state.bindProviderTurn({ threadId: 'provider-thread', turnId: 'provider-turn' });
    const written: unknown[] = [];
    state.dispatch(
      ordinaryForm(),
      async (r) => {
        written.push(r);
      },
      assert.fail,
    );
    await new Promise((resolve) => setImmediate(resolve));
    state.close(reason);
    assert.ok(answer);
    answer({ kind: 'decision', decisionId: 'accept', content: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, []);
    assert.deepEqual(invalidations, [[owner.invocationId, reason]]);
  }
});
