// Opt-in, credential-free protocol probe. Run only via scripts/with-test-home.sh.
// This fake MCP never calls CUA or grants access to an application.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { respondToCodexRuntimeInteraction } from '../../src/domains/cats/services/agents/providers/CodexRuntimeInteractionAdapter.ts';

assert.equal(process.env.CAT_CAFE_TEST_SANDBOX, '1', 'use the repository isolated test-home runner');
assert.equal(process.env.CODEX_HOME, undefined, 'do not inherit a real Codex home');
const binary = process.argv[2];
assert.ok(binary, 'supply the installed codex binary path');
const probeDir = await mkdtemp(join(tmpdir(), 'cua-wire-probe-'));
const serverFile = join(probeDir, 'fake-mcp.mjs');
await writeFile(
  serverFile,
  `
import { createInterface } from 'node:readline';
let pending;
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
for await (const line of createInterface({input:process.stdin})) {
  const m=JSON.parse(line);
  if (m.method==='initialize') send({id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'synthetic-consent-probe',version:'1'}}});
  else if (m.method==='tools/list') send({id:m.id,result:{tools:[{name:'probe',description:'Synthetic wire echo only',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}});
  else if (m.method==='tools/call') {
    pending=m.id;
    send({id:101,method:'elicitation/create',params:{serverName:'cua_repl',mode:'form',message:'Synthetic test only',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',connector_name:'Computer Use',persist:['session','always'],riskLevel:'low',tool_call_id:'synthetic-call',tool_name:'probe',tool_params:{app:'org.example.ContractTest'}}}});
  } else if (m.id===101) send({id:pending,result:{content:[{type:'text',text:JSON.stringify(m.result ?? m.error)}]}});
  else if (m.method==='ping') send({id:m.id,result:{}});
}
`,
);
// Allowlist child environment; no callback tokens, API keys, or real MCP config.
const child = spawn(binary, ['app-server', '--stdio'], {
  cwd: probeDir,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir() },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let nextId = 1;
let stderr = '';
let observed;
let choice = 'session';
let published = 0;
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-4000);
});
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
const timer = setTimeout(() => {
  for (const waiter of pending.values()) waiter.reject(new Error('probe timeout'));
  child.kill('SIGTERM');
}, 45000);
const reader = (async () => {
  for await (const line of createInterface({ input: child.stdout })) {
    const m = JSON.parse(line);
    if (m.method === 'mcpServer/elicitation/request') {
      observed = m.params;
      // Answer only our synthetic app and request. This is not an operator grant.
      assert.equal(m.params._meta?.tool_params?.app, 'org.example.ContractTest');
      const response = await respondToCodexRuntimeInteraction(m, {
        // This standalone RPC has no model turn/item notifications. Its binding
        // comes from our explicit outbound mcpServer/tool/call below, not _meta.
        isActiveMcpToolCall: (id, server) => id === 'synthetic-call' && server === 'cua_repl',
        owner: {
          userId: 'synthetic-owner',
          threadId: 'synthetic-thread',
          catId: 'codex',
          invocationId: 'synthetic-invocation',
        },
        port: {
          request: async () => {
            published++;
            return {
              kind: 'decision',
              decisionId: choice === 'decline' || choice === 'cancel' ? choice : `accept:${choice}`,
              ...(choice === 'decline' || choice === 'cancel' ? {} : { content: {} }),
            };
          },
        },
      });
      send(response);
    } else if (m.id !== undefined && pending.has(m.id)) {
      const waiter = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) waiter.reject(new Error(JSON.stringify(m.error)));
      else waiter.resolve(m.result);
    } else if (m.id !== undefined && m.method) {
      send({ id: m.id, error: { code: -32601, message: 'Probe does not authorize other requests' } });
    }
  }
})();
try {
  await request('initialize', {
    clientInfo: { name: 'clowder-wire-probe', version: '1' },
    capabilities: { experimentalApi: true },
  });
  send({ method: 'initialized' });
  const started = await request('thread/start', {
    cwd: probeDir,
    ephemeral: true,
    config: {
      mcp_servers: {
        cua_repl: { command: process.execPath, args: [serverFile] },
        impostor: { command: process.execPath, args: [serverFile] },
      },
    },
  });
  const results = [];
  for (choice of ['session', 'always', 'decline', 'cancel']) {
    const result = await request('mcpServer/tool/call', {
      threadId: started.thread.id,
      server: 'cua_repl',
      tool: 'probe',
      arguments: {},
    });
    assert.ok(observed, 'app-server must expose native metadata as elicitation');
    assert.equal(observed._meta.connector_id, 'computer-use');
    assert.deepEqual(observed._meta.persist, ['session', 'always']);
    const echoed = JSON.parse(result.content[0].text);
    const accepted = choice === 'session' || choice === 'always';
    assert.equal(echoed.action, accepted ? 'accept' : choice);
    assert.deepEqual(echoed._meta, accepted ? { persist: choice } : undefined);
    results.push(echoed);
  }
  const publicationCount = published;
  const impostor = await request('mcpServer/tool/call', {
    threadId: started.thread.id,
    server: 'impostor',
    tool: 'probe',
    arguments: {},
  });
  assert.equal(observed.serverName, 'impostor', 'app-server must bind the configured connection, not a claimed name');
  assert.equal(published, publicationCount, 'forged metadata from another configured server must not publish consent');
  assert.deepEqual(JSON.parse(impostor.content[0].text), { action: 'decline' });
  console.log(
    JSON.stringify(
      { result: 'wire-pass', sourceSpoof: 'rejected', responses: results, persistenceReuse: 'not-tested' },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(String(error));
  console.error(stderr);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  child.stdin.end();
  child.kill('SIGTERM');
  await reader;
}
