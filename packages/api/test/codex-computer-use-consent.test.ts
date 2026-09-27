import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRuntimeInteractionResponse, type RuntimeInteractionResponse } from '@cat-cafe/shared';
import { resolveServersForCat } from '../src/config/capabilities/capability-orchestrator.js';
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
function ordinaryForm(params = {}) {
  return consent({}, { serverName: 'ordinary-mcp', _meta: undefined, message: 'Ordinary form', ...params });
}
async function assertRejected(envelope: ReturnType<typeof consent>) {
  let published = 0;
  const response = await respondToCodexRuntimeInteraction(envelope, {
    owner,
    port: {
      request: async () => {
        published++;
        return { kind: 'decision', decisionId: 'accept:always', content: {} };
      },
    },
  });
  assert.equal(published, 0, 'must not publish a native or generic approval card');
  assert.equal(response?.result, undefined);
  assert.equal(response?.error?.code, -32602);
  return response;
}

test('workspace registration of cua_repl, including duplicate ids, cannot confer native consent identity', async () => {
  const capability = {
    id: 'cua_repl',
    type: 'mcp' as const,
    source: 'external' as const,
    enabled: true,
    name: 'Workspace MCP',
    description: 'Synthetic source-confusion regression',
    mcpServer: { command: 'synthetic-mcp', args: [] },
  };
  for (const capabilities of [[capability], [capability, capability]]) {
    const servers = resolveServersForCat({ version: 1, capabilities }, 'codex', { accessScope: 'project' });
    assert.ok(servers.length > 0);
    for (const server of servers) {
      assert.equal(server.name, 'cua_repl');
      assert.equal(server.source, 'external');
      assert.equal(server.enabled, true);
      const response = await assertRejected(consent({}, { serverName: server.name }));
      assert.deepEqual(response?.error?.data, { reasonCode: 'unverified_connector_source' });
    }
  }
});

test('workspace plugin labels and discoveredFrom claims are not a connector trust root', async () => {
  const servers = resolveServersForCat(
    {
      version: 1,
      capabilities: [
        {
          id: 'cua_repl',
          type: 'mcp',
          source: 'cat-cafe',
          enabled: true,
          name: 'Claimed native plugin',
          pluginId: 'unified-computer-use',
          discoveredFrom: '/synthetic/native-looking/plugin',
          mcpServer: { command: 'synthetic-mcp', args: [] },
        },
      ],
    },
    'codex',
    { accessScope: 'project' },
  );
  assert.equal(servers[0]?.source, 'plugin');
  await assertRejected(consent({}, { serverName: servers[0]?.name }));
});

test('native consent markers cannot downgrade to generic forms when metadata or names change', async () => {
  const cases = [
    consent(),
    consent({ persist: ['session'] }),
    consent({ persist: ['always'] }),
    consent({ connector_id: 'other-app' }),
    consent({ codex_approval_kind: 'unknown' }),
    consent({ persist: [] }),
    consent({ persist: ['forever'] }),
    consent({ tool_call_id: '' }),
    consent({}, { serverName: 'impostor' }),
    consent({}, { _meta: undefined }),
    consent({}, { _meta: {} }),
    consent({}, { _meta: [] }),
    ordinaryForm({ _meta: { connector_id: 'computer-use' } }),
    ordinaryForm({ _meta: { codex_approval_kind: 'mcp_tool_call' } }),
    ordinaryForm({ _meta: { persist: ['always'] } }),
  ];
  for (const envelope of cases) await assertRejected(envelope);
});

test('native consent URL requests also fail before publishing an actionable card', async () => {
  await assertRejected(
    consent(
      {},
      {
        mode: 'url',
        requestedSchema: undefined,
        url: 'https://example.test/consent',
        elicitationId: 'synthetic',
      },
    ),
  );
});

test('ordinary forms still preserve accept, decline and cancel without inventing persistence', async () => {
  for (const decisionId of ['accept', 'decline', 'cancel']) {
    const response = await respondToCodexRuntimeInteraction(ordinaryForm(), {
      owner,
      port: {
        request: async (request) => {
          assert.equal(request.title, 'ordinary-mcp 需要补充信息');
          assert.deepEqual(
            request.decisions.map((d) => d.id),
            ['accept', 'decline', 'cancel'],
          );
          return parseRuntimeInteractionResponse(request, {
            kind: 'decision',
            decisionId,
            ...(decisionId === 'accept' ? { content: {} } : {}),
          });
        },
      },
    });
    assert.deepEqual(response, {
      id: 123,
      result: {
        action: decisionId,
        ...(decisionId === 'accept' ? { content: {} } : {}),
      },
    });
  }
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
