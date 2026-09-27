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
  for (const params of [{ threadId: 'foreign' }, { turnId: 'old-turn' }]) {
    state.dispatch(
      ordinaryForm(params),
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
