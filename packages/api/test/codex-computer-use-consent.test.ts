import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseRuntimeInteractionRequest,
  parseRuntimeInteractionResponse,
  type RuntimeInteractionResponse,
} from '@cat-cafe/shared';
import { respondToCodexRuntimeInteraction } from '../src/domains/cats/services/agents/providers/CodexRuntimeInteractionAdapter.js';
import { createCodexRuntimeInteractionRunState } from '../src/domains/cats/services/agents/providers/CodexRuntimeInteractionRun.js';

const owner = { userId: 'u1', threadId: 'chat1', catId: 'codex', invocationId: 'inv1' };
function consent(meta = {}, params = {}) {
  return {
    id: 123,
    method: 'mcpServer/elicitation/request',
    params: {
      serverName: 'cua_repl',
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      mode: 'form',
      message: 'Allow Computer Use to use "Google Chrome"?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        connector_id: 'computer-use',
        connector_name: 'Computer Use',
        persist: ['session', 'always'],
        riskLevel: 'medium',
        tool_call_id: 'call1',
        tool_name: 'get_app',
        tool_params: { app: 'com.google.Chrome' },
        ...meta,
      },
      ...params,
    },
  };
}

for (const persistence of ['session', 'always']) {
  test(`native app consent round-trips the explicit ${persistence} choice through the canonical response schema`, async () => {
    const response = await respondToCodexRuntimeInteraction(consent(), {
      owner,
      port: {
        request: async (input) => {
          const request = parseRuntimeInteractionRequest(input);
          assert.equal(request.kind, 'elicitation');
          assert.match(request.title, /Computer Use.*授权/);
          assert.match(request.description ?? '', /com.google.Chrome/);
          assert.deepEqual(
            request.decisions.map((d) => d.id),
            ['accept:session', 'accept:always', 'decline', 'cancel'],
          );
          return parseRuntimeInteractionResponse(request, {
            kind: 'decision',
            decisionId: `accept:${persistence}`,
            content: {},
          });
        },
      },
    });
    assert.deepEqual(response, { id: 123, result: { action: 'accept', content: {}, _meta: { persist: persistence } } });
  });
}

test('session-only policy never offers or accepts always, generic accept, or forged metadata', async () => {
  for (const decisionId of ['accept:always', 'accept']) {
    let offered: string[] | undefined;
    const response = await respondToCodexRuntimeInteraction(consent({ persist: ['session'] }), {
      owner,
      port: {
        request: async (request) => {
          offered = request.decisions.map((d) => d.id);
          return { kind: 'decision', decisionId, content: {} };
        },
      },
    });
    assert.deepEqual(offered, ['accept:session', 'decline', 'cancel']);
    assert.equal(response?.error?.code, -32602);
  }
});

test('decline and cancel never create persistence metadata or accept content', async () => {
  for (const decisionId of ['decline', 'cancel']) {
    const response = await respondToCodexRuntimeInteraction(consent(), {
      owner,
      port: { request: async (request) => parseRuntimeInteractionResponse(request, { kind: 'decision', decisionId }) },
    });
    assert.deepEqual(response, { id: 123, result: { action: decisionId } });
  }
});

test('unknown consent metadata, connector, source and malformed scope fail before publishing a generic form', async () => {
  let published = 0;
  const cases = [
    consent({ connector_id: 'other-app' }),
    consent({ codex_approval_kind: 'unknown' }),
    consent({ persist: ['forever'] }),
    consent({ persist: [] }),
    consent({ persist: ['session', 'session'] }),
    consent({ tool_params: {} }),
    consent({ tool_params: { app: 'com.google.Chrome', extra: 'widen-scope' } }),
    consent({ tool_call_id: '' }),
    consent({}, { serverName: 'untrusted-mcp' }),
    consent({ codex_approval_kind: undefined }),
    consent({}, { requestedSchema: { type: 'object', properties: { extra: { type: 'string' } } } }),
  ];
  for (const envelope of cases) {
    const response = await respondToCodexRuntimeInteraction(envelope, {
      owner,
      port: {
        request: async () => {
          published++;
          return { kind: 'decision', decisionId: 'accept', content: {} };
        },
      },
    });
    assert.equal(response?.error?.code, -32602, JSON.stringify(envelope.params._meta));
  }
  assert.equal(published, 0);
});

test('duplicate server request ids are rejected without a second consent publication', async () => {
  let published = 0;
  const state = createCodexRuntimeInteractionRunState(
    {
      owner,
      port: {
        request: async () => {
          published++;
          return { kind: 'decision', decisionId: 'accept:session', content: {} };
        },
      },
    },
    'auto_review',
  );
  assert.ok(state);
  state.bindProviderTurn({ threadId: 'provider-thread', turnId: 'provider-turn' });
  const written: Record<string, unknown>[] = [];
  const failures: Error[] = [];
  state.dispatch(
    consent(),
    async (r) => {
      written.push(r);
    },
    (error) => {
      failures.push(error);
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  state.dispatch(
    consent(),
    async (r) => {
      written.push(r);
    },
    (error) => {
      failures.push(error);
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published, 1);
  assert.equal(written.length, 1);
  assert.match(failures[0]?.message ?? '', /Duplicate/);
  state.close('provider_cancelled');
});

test('foreign provider coordinates and closed runs cannot publish consent or replay an old answer', async () => {
  let published = 0;
  const state = createCodexRuntimeInteractionRunState(
    {
      owner,
      port: {
        request: async () => {
          published++;
          return { kind: 'decision', decisionId: 'accept:session', content: {} };
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
      consent({}, params),
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
    consent(),
    async (r) => {
      written.push(r);
    },
    assert.fail,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published, 0, 'closed run must not stage a new interaction');
  assert.equal(written.length, 2);
});

test('cancellation and transport timeout suppress a late accepted consent even if the waiter ignores abort', async () => {
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
      consent(),
      async (response) => {
        written.push(response);
      },
      assert.fail,
    );
    await new Promise((resolve) => setImmediate(resolve));
    state.close(reason);
    assert.ok(answer);
    answer({ kind: 'decision', decisionId: 'accept:always', content: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, []);
    assert.deepEqual(invalidations, [[owner.invocationId, reason]]);
  }
});
