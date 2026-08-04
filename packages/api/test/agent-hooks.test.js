import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import Fastify from 'fastify';
import {
  buildAgentHookTargets,
  getAgentHookStatus,
  resolveAgentHookGlobalRoot,
  syncAgentHooks,
} from '../dist/agent-hooks/index.js';
import { agentHooksRoutes } from '../dist/routes/agent-hooks.js';

const HEADERS = { 'x-cat-cafe-user': 'test-user' };
const SESSION_HEADERS = { 'x-test-session-user': 'test-user' };

function bashCmd(scriptPath) {
  return `bash "${scriptPath}"`;
}

function codexStopCmd(scriptPath) {
  return `${bashCmd(scriptPath)} --codex-json`;
}

async function createProjectRoot() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-hooks-project-'));
  const hookDir = join(projectRoot, '.claude', 'hooks', 'user-level');
  await mkdir(hookDir, { recursive: true });
  await writeFile(join(hookDir, 'session-start-recall.sh'), '#!/bin/bash\necho start\n', 'utf8');
  await writeFile(join(hookDir, 'session-stop-check.sh'), '#!/bin/bash\necho stop\n', 'utf8');
  return projectRoot;
}

describe('agent hook sync targets', () => {
  let projectRoot;
  let targetRoot;
  let capabilityProjectRoot;

  beforeEach(async () => {
    projectRoot = await createProjectRoot();
    targetRoot = await mkdtemp(join(tmpdir(), 'agent-hooks-home-'));
    capabilityProjectRoot = await mkdtemp(join(tmpdir(), 'agent-hooks-capability-project-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(capabilityProjectRoot, { recursive: true, force: true });
  });

  it('uses the persistent workspace for implicit capabilities and preserves explicit project scope', async () => {
    const runtimeRoot = await createProjectRoot();
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-hooks-workspace-'));
    const externalRoot = await mkdtemp(join(tmpdir(), 'agent-hooks-external-'));
    const previousRuntimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
    const previousWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;

    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;

    try {
      const persistentRoot = await realpath(workspaceRoot);
      assert.equal(await resolveAgentHookGlobalRoot(runtimeRoot), persistentRoot);

      const runtimeCapabilitiesPath = join(runtimeRoot, '.cat-cafe', 'capabilities.json');
      const workspaceCapabilitiesPath = join(workspaceRoot, '.cat-cafe', 'capabilities.json');
      const externalCapabilitiesPath = join(externalRoot, '.cat-cafe', 'capabilities.json');
      const emptyCapabilities = { version: 2, capabilities: [] };
      const globalCapabilities = {
        version: 2,
        capabilities: [
          {
            type: 'mcp',
            id: 'persistent-baseline',
            source: 'cat-cafe',
            enabled: true,
            mcpServer: { command: 'echo', args: ['persistent'] },
          },
        ],
      };
      await mkdir(join(runtimeRoot, '.cat-cafe'), { recursive: true });
      await mkdir(join(workspaceRoot, '.cat-cafe'), { recursive: true });
      await mkdir(join(externalRoot, '.cat-cafe'), { recursive: true });
      await writeFile(runtimeCapabilitiesPath, JSON.stringify(emptyCapabilities), 'utf-8');
      await writeFile(workspaceCapabilitiesPath, JSON.stringify(globalCapabilities), 'utf-8');
      await writeFile(externalCapabilitiesPath, JSON.stringify(emptyCapabilities), 'utf-8');

      const implicitStatus = await getAgentHookStatus({ projectRoot: runtimeRoot, targetRoot });
      const implicitMcp = implicitStatus.targets.find((target) => target.name === 'mcp');
      assert.equal(implicitMcp?.status, 'configured');
      assert.equal(implicitMcp?.drifted, false);

      await syncAgentHooks({ projectRoot: runtimeRoot, targetRoot, ownerAuthorized: true });
      assert.deepEqual(JSON.parse(await readFile(runtimeCapabilitiesPath, 'utf-8')), emptyCapabilities);

      const explicitStatus = await getAgentHookStatus({
        projectRoot: runtimeRoot,
        targetRoot,
        capabilityProjectRoot: externalRoot,
      });
      const explicitMcp = explicitStatus.targets.find((target) => target.name === 'mcp');
      assert.equal(explicitMcp?.status, 'stale');
      assert.equal(explicitMcp?.drifted, true);
    } finally {
      if (previousRuntimeRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = previousRuntimeRoot;
      if (previousWorkspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = previousWorkspaceRoot;
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  it('selects only user-level hook targets and renders Codex/Gemini paths per target home', () => {
    const targets = buildAgentHookTargets({ projectRoot, targetRoot });
    assert.deepEqual(
      targets.map((target) => target.name),
      ['hooks/session-start', 'hooks/session-stop', 'codex-hooks', 'gemini-hooks'],
    );

    const startScript = bashCmd(join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh'));
    const stopScript = bashCmd(join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh'));

    const codexHooks = targets.find((target) => target.name === 'codex-hooks');
    assert.ok(codexHooks);
    const codexRendered = JSON.parse(codexHooks.render());
    assert.equal(codexRendered.hooks.SessionStart[0].hooks[0].command, startScript);
    assert.equal(
      codexRendered.hooks.Stop[0].hooks[0].command,
      codexStopCmd(join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh')),
    );

    const geminiHooks = targets.find((target) => target.name === 'gemini-hooks');
    assert.ok(geminiHooks);
    const geminiRendered = JSON.parse(geminiHooks.render());
    assert.equal(geminiRendered.hooks.SessionStart[0].hooks[0].command, startScript);
    assert.equal(geminiRendered.hooks.Stop[0].hooks[0].command, stopScript);
  });

  it('sync writes scripts, Codex hooks.json, and preserves unknown Claude settings hooks', async () => {
    const claudeDir = join(targetRoot, '.claude');
    await mkdir(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: 'command', command: '/custom/start.sh' },
                  { type: 'command', command: '/custom/session-start-recall.sh' },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: join(targetRoot, '.claude', 'hooks', 'legacy', 'session-stop-check.sh'),
                  },
                ],
              },
            ],
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/custom/pre.sh' }] }],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = await syncAgentHooks({ projectRoot, targetRoot });
    assert.equal(result.status, 'configured');

    const startScript = join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh');
    const stopScript = join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh');
    assert.equal(await readFile(startScript, 'utf8'), '#!/bin/bash\necho start\n');
    assert.equal(await readFile(stopScript, 'utf8'), '#!/bin/bash\necho stop\n');

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, '/custom/start.sh');
    assert.equal(settings.hooks.SessionStart[0].hooks[1].command, '/custom/session-start-recall.sh');
    assert.equal(settings.hooks.SessionStart[1].hooks[0].command, bashCmd(startScript));
    assert.equal(settings.hooks.Stop.length, 1);
    assert.equal(settings.hooks.Stop[0].hooks[0].command, bashCmd(stopScript));
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, '/custom/pre.sh');

    const codex = JSON.parse(await readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(codex.hooks.SessionStart[0].hooks[0].command, bashCmd(startScript));
    assert.equal(codex.hooks.Stop[0].hooks[0].command, codexStopCmd(stopScript));

    for (const target of buildAgentHookTargets({ projectRoot, targetRoot })) {
      assert.equal(
        await readFile(target.targetPath, 'utf8'),
        target.render(),
        `${target.name} should match renderer bytes`,
      );
    }
  });

  it('recognizes quoted $HOME Claude template commands and avoids duplicate managed hooks on sync', async () => {
    await rm(targetRoot, { recursive: true, force: true });
    targetRoot = await mkdtemp(join(tmpdir(), 'agent hooks home-'));

    const claudeHooksDir = join(targetRoot, '.claude', 'hooks');
    await mkdir(claudeHooksDir, { recursive: true });
    await writeFile(join(claudeHooksDir, 'session-start-recall.sh'), '#!/bin/bash\necho start\n', 'utf8');
    await writeFile(join(claudeHooksDir, 'session-stop-check.sh'), '#!/bin/bash\necho stop\n', 'utf8');

    const settingsPath = join(targetRoot, '.claude', 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: '"$HOME/.claude/hooks/session-start-recall.sh"' }] }],
            Stop: [{ hooks: [{ type: 'command', command: '"$HOME/.claude/hooks/session-stop-check.sh"' }] }],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const before = await getAgentHookStatus({ projectRoot, targetRoot });
    const beforeClaudeSettings = before.targets.find((target) => target.name === 'claude-settings');
    assert.equal(beforeClaudeSettings?.status, 'stale');

    await syncAgentHooks({ projectRoot, targetRoot });

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.deepEqual(settings.hooks.SessionStart, [
      {
        hooks: [{ type: 'command', command: bashCmd(join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh')) }],
      },
    ]);
    assert.deepEqual(settings.hooks.Stop, [
      { hooks: [{ type: 'command', command: bashCmd(join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh')) }] },
    ]);
  });

  it('detects old-format (no bash prefix) commands as stale so UI shows repair prompt', async () => {
    const claudeHooksDir = join(targetRoot, '.claude', 'hooks');
    await mkdir(claudeHooksDir, { recursive: true });
    await writeFile(join(claudeHooksDir, 'session-start-recall.sh'), '#!/bin/bash\necho start\n', 'utf8');
    await writeFile(join(claudeHooksDir, 'session-stop-check.sh'), '#!/bin/bash\necho stop\n', 'utf8');

    const settingsPath = join(targetRoot, '.claude', 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [{ type: 'command', command: join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh') }],
              },
            ],
            Stop: [
              { hooks: [{ type: 'command', command: join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh') }] },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const status = await getAgentHookStatus({ projectRoot, targetRoot });
    const claudeSettings = status.targets.find((target) => target.name === 'claude-settings');
    assert.equal(claudeSettings?.status, 'stale');
    assert.match(claudeSettings?.reason, /bash prefix/);
  });

  it('detects mixed old+new format entries in same event as stale', async () => {
    const claudeHooksDir = join(targetRoot, '.claude', 'hooks');
    await mkdir(claudeHooksDir, { recursive: true });
    await writeFile(join(claudeHooksDir, 'session-start-recall.sh'), '#!/bin/bash\necho start\n', 'utf8');
    await writeFile(join(claudeHooksDir, 'session-stop-check.sh'), '#!/bin/bash\necho stop\n', 'utf8');

    const settingsPath = join(targetRoot, '.claude', 'settings.json');
    const startScript = join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh');
    const stopScript = join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: startScript }] },
              { hooks: [{ type: 'command', command: bashCmd(startScript) }] },
            ],
            Stop: [{ hooks: [{ type: 'command', command: bashCmd(stopScript) }] }],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const status = await getAgentHookStatus({ projectRoot, targetRoot });
    const claudeSettings = status.targets.find((target) => target.name === 'claude-settings');
    assert.equal(claudeSettings?.status, 'stale');
    assert.match(claudeSettings?.reason, /bash prefix/);
  });

  it('detects bash-prefixed commands as configured', async () => {
    const claudeHooksDir = join(targetRoot, '.claude', 'hooks');
    await mkdir(claudeHooksDir, { recursive: true });
    await writeFile(join(claudeHooksDir, 'session-start-recall.sh'), '#!/bin/bash\necho start\n', 'utf8');
    await writeFile(join(claudeHooksDir, 'session-stop-check.sh'), '#!/bin/bash\necho stop\n', 'utf8');

    const settingsPath = join(targetRoot, '.claude', 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: bashCmd(join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh')),
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  { type: 'command', command: bashCmd(join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh')) },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const status = await getAgentHookStatus({ projectRoot, targetRoot });
    const claudeSettings = status.targets.find((target) => target.name === 'claude-settings');
    assert.equal(claudeSettings?.status, 'configured');
  });

  it('reports stale scripts with a diff summary and canonicalizes Codex hooks JSON', async () => {
    await syncAgentHooks({ projectRoot, targetRoot });

    await writeFile(
      join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh'),
      '#!/bin/bash\necho stale\n',
      'utf8',
    );
    await writeFile(
      join(targetRoot, '.codex', 'hooks.json'),
      JSON.stringify(JSON.parse(await readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'))),
      'utf8',
    );

    const status = await getAgentHookStatus({ projectRoot, targetRoot });
    const start = status.targets.find((target) => target.name === 'hooks/session-start');
    const codex = status.targets.find((target) => target.name === 'codex-hooks');
    assert.equal(status.status, 'stale');
    assert.equal(start?.status, 'stale');
    assert.equal(start?.drifted, true);
    assert.equal(start?.diff?.kind, 'text');
    assert.equal(start?.diff?.line, 2);
    assert.equal(codex?.status, 'configured');
    assert.equal(codex?.drifted, false);
  });

  it('ownerAuthorized=false syncs hooks but does not create capabilities.json', async () => {
    // Ensure no capabilities.json exists
    const capPath = join(projectRoot, '.cat-cafe', 'capabilities.json');
    await rm(capPath, { force: true });

    const result = await syncAgentHooks({ projectRoot, targetRoot, ownerAuthorized: false });

    // Hooks should still be written
    const startScript = join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh');
    assert.equal(await readFile(startScript, 'utf8'), '#!/bin/bash\necho start\n');

    // capabilities.json must NOT be created (fail-closed)
    const capExists = (await readFile(capPath, 'utf8').catch(() => null)) !== null;
    assert.equal(capExists, false, 'capabilities.json should not be created by non-owner sync');

    assert.ok(result.targets.length > 0);
  });

  it('health sync preserves project-local plugin MCP entries (no orphan removal)', async () => {
    // Regression: syncAgentHooks with ownerAuthorized=true must NOT remove
    // project-local MCP entries that are absent from the global config.
    // The keep-project policy only protects config-mismatch; project-orphan
    // issues must be filtered out of the health sync path entirely.
    const globalCatCafeDir = join(projectRoot, '.cat-cafe');
    const projectCatCafeDir = join(capabilityProjectRoot, '.cat-cafe');
    await mkdir(globalCatCafeDir, { recursive: true });
    await mkdir(projectCatCafeDir, { recursive: true });
    await writeFile(
      join(globalCatCafeDir, 'capabilities.json'),
      JSON.stringify({ version: 2, capabilities: [] }),
      'utf-8',
    );

    const pluginMcpId = `probe-plugin-${randomUUID().slice(0, 8)}`;
    const capabilities = {
      version: 2,
      capabilities: [
        {
          type: 'mcp',
          id: pluginMcpId,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          enabled: true,
          mcpServer: { command: 'echo', args: ['test'] },
        },
      ],
    };
    const projectCapabilitiesPath = join(projectCatCafeDir, 'capabilities.json');
    await writeFile(projectCapabilitiesPath, JSON.stringify(capabilities, null, 2), 'utf-8');

    await syncAgentHooks({ projectRoot, targetRoot, capabilityProjectRoot, ownerAuthorized: true });

    const afterSync = JSON.parse(await readFile(projectCapabilitiesPath, 'utf-8'));
    const pluginEntry = afterSync.capabilities.find((c) => c.id === pluginMcpId);
    assert.ok(pluginEntry, `Plugin MCP "${pluginMcpId}" must survive health sync (not removed as orphan)`);
    assert.equal(pluginEntry.pluginId, 'test-plugin');
  });

  it('health status reports configured (not stale) when only orphan MCP drift exists', async () => {
    // Regression: checkMcpHealth must filter project-orphan issues the same way
    // syncAgentHooks does. Otherwise the UI shows an un-clearable stale badge
    // for projects with plugin MCPs not in global config.
    //
    // Model host global and external project scopes independently. The global
    // config is empty, so the project plugin entry is the only MCP difference.
    const globalCatCafeDir = join(projectRoot, '.cat-cafe');
    const projectCatCafeDir = join(capabilityProjectRoot, '.cat-cafe');
    const projectCapabilitiesPath = join(projectCatCafeDir, 'capabilities.json');
    await mkdir(globalCatCafeDir, { recursive: true });
    await mkdir(projectCatCafeDir, { recursive: true });
    await writeFile(
      join(globalCatCafeDir, 'capabilities.json'),
      JSON.stringify({ version: 2, capabilities: [] }),
      'utf-8',
    );

    const pluginMcpId = `orphan-only-${randomUUID().slice(0, 8)}`;
    await writeFile(
      projectCapabilitiesPath,
      JSON.stringify(
        {
          version: 2,
          capabilities: [
            {
              type: 'mcp',
              id: pluginMcpId,
              source: 'cat-cafe',
              pluginId: 'test-plugin',
              enabled: true,
              mcpServer: { command: 'echo', args: ['test'] },
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const status = await getAgentHookStatus({ projectRoot, targetRoot, capabilityProjectRoot, ownerAuthorized: true });
    const mcpResult = status.targets.find((t) => t.name === 'mcp');
    assert.ok(mcpResult, 'health status must include mcp target');
    assert.equal(mcpResult.status, 'configured', 'orphan-only MCP drift must not report stale');
    assert.equal(mcpResult.drifted, false, 'orphan-only MCP drift must not report drifted');
  });

  it('health status reports stale for non-plugin managed MCP orphans', async () => {
    // Non-plugin orphans (managed MCPs removed from global config) should
    // surface as stale — they represent real drift, unlike plugin orphans.
    const globalCatCafeDir = join(projectRoot, '.cat-cafe');
    const projectCatCafeDir = join(capabilityProjectRoot, '.cat-cafe');
    const projectCapabilitiesPath = join(projectCatCafeDir, 'capabilities.json');
    await mkdir(globalCatCafeDir, { recursive: true });
    await mkdir(projectCatCafeDir, { recursive: true });
    await writeFile(
      join(globalCatCafeDir, 'capabilities.json'),
      JSON.stringify({ version: 2, capabilities: [] }),
      'utf-8',
    );

    // Inject a managed (non-plugin) orphan — source 'cat-cafe' but NO pluginId
    const managedOrphanId = `managed-orphan-${randomUUID().slice(0, 8)}`;
    await writeFile(
      projectCapabilitiesPath,
      JSON.stringify(
        {
          version: 2,
          capabilities: [
            {
              type: 'mcp',
              id: managedOrphanId,
              source: 'cat-cafe',
              enabled: true,
              mcpServer: { command: 'echo', args: ['test'] },
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const status = await getAgentHookStatus({ projectRoot, targetRoot, capabilityProjectRoot, ownerAuthorized: true });
    const mcpResult = status.targets.find((t) => t.name === 'mcp');
    assert.ok(mcpResult, 'health status must include mcp target');
    assert.equal(mcpResult.status, 'stale', 'non-plugin managed orphan must report stale');
    assert.equal(mcpResult.drifted, true, 'non-plugin managed orphan must report drifted');
  });

  it('ownerAuthorized omitted defaults to fail-closed (no capability sync)', async () => {
    // When ownerAuthorized is not passed at all (undefined), capability sync should NOT run.
    // This is the fail-closed default demanded by P2-4 re-review.
    const capPath = join(projectRoot, '.cat-cafe', 'capabilities.json');
    await rm(capPath, { force: true });

    // Call without ownerAuthorized (undefined)
    const result = await syncAgentHooks({ projectRoot, targetRoot });

    const capExists = (await readFile(capPath, 'utf8').catch(() => null)) !== null;
    assert.equal(capExists, false, 'capabilities.json should not be created when ownerAuthorized is omitted');
    assert.ok(result.targets.length > 0);
  });

  it('uses an explicit Clowder AI project as the skill and MCP truth root', async () => {
    const catCafeRoot = await createProjectRoot();
    const catCafeHome = await mkdtemp(join(tmpdir(), 'agent-hooks-cat-cafe-home-'));
    const skillName = 'debugging';
    const skillSource = join(catCafeRoot, 'cat-cafe-skills', skillName);
    const skillLink = join(catCafeRoot, '.claude', 'skills', skillName);
    const capDir = join(catCafeRoot, '.cat-cafe');

    try {
      await mkdir(skillSource, { recursive: true });
      await writeFile(join(catCafeRoot, 'cat-cafe-skills', 'manifest.yaml'), 'version: 1\n', 'utf-8');
      await writeFile(join(skillSource, 'SKILL.md'), '# debugging\n', 'utf-8');
      await mkdir(join(catCafeRoot, '.claude', 'skills'), { recursive: true });
      await symlink(skillSource, skillLink);
      await mkdir(capDir, { recursive: true });
      await writeFile(
        join(capDir, 'capabilities.json'),
        JSON.stringify(
          {
            version: 2,
            capabilities: [
              {
                id: skillName,
                type: 'skill',
                enabled: true,
                source: 'cat-cafe',
                mountPaths: ['claude'],
                globalEnabled: true,
              },
              {
                id: 'local-cat-cafe-mcp',
                type: 'mcp',
                enabled: true,
                source: 'cat-cafe',
                mcpServer: { command: 'node', args: [join(catCafeRoot, 'packages/mcp-server/dist/local.js')] },
                globalEnabled: true,
              },
            ],
          },
          null,
          2,
        ),
        'utf-8',
      );

      const status = await getAgentHookStatus({
        projectRoot,
        targetRoot: catCafeHome,
        capabilityProjectRoot: catCafeRoot,
      });
      const skills = status.targets.find((target) => target.name === 'skills');
      const mcp = status.targets.find((target) => target.name === 'mcp');

      assert.equal(skills?.status, 'configured');
      assert.equal(mcp?.status, 'configured');
    } finally {
      await rm(catCafeRoot, { recursive: true, force: true });
      await rm(catCafeHome, { recursive: true, force: true });
    }
  });
});

describe('agent hook routes', () => {
  let app;
  let projectRoot;
  let targetRoot;

  function addSessionTestHook(fastify) {
    fastify.addHook('preHandler', async (request) => {
      const sessionUser = request.headers['x-test-session-user'];
      if (typeof sessionUser === 'string' && sessionUser.trim()) {
        request.sessionUserId = sessionUser.trim();
      }
    });
  }

  beforeEach(async () => {
    projectRoot = await createProjectRoot();
    targetRoot = await mkdtemp(join(tmpdir(), `agent-hooks-route-${randomUUID()}-`));
    app = Fastify();
    addSessionTestHook(app);
    await app.register(agentHooksRoutes, { projectRoot, targetRoot });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  });

  it('GET requires session identity and does not write user home files', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/agent-hooks/status' });
    assert.equal(unauthorized.statusCode, 401);

    const headerOnly = await app.inject({ method: 'GET', url: '/api/agent-hooks/status', headers: HEADERS });
    assert.equal(headerOnly.statusCode, 401);

    const res = await app.inject({ method: 'GET', url: '/api/agent-hooks/status', headers: SESSION_HEADERS });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'missing');
    const start = body.targets.find((target) => target.name === 'hooks/session-start');
    const codex = body.targets.find((target) => target.name === 'codex-hooks');
    assert.equal(start?.drifted, true);
    assert.equal(start?.diff?.kind, 'text');
    assert.equal(codex?.status, 'unsupported');
    assert.equal(codex?.drifted, false);

    await assert.rejects(readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'));
  });

  it('browser requests require a real session before hook sync can write files', async () => {
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/agent-hooks/sync',
      headers: { origin: 'http://localhost:3003', host: 'localhost:3003' },
    });
    assert.equal(unauthorized.statusCode, 401);
    await assert.rejects(readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'));

    const authorized = await app.inject({
      method: 'POST',
      url: '/api/agent-hooks/sync',
      headers: { origin: 'http://localhost:3003', host: 'localhost:3003', 'x-test-session-user': 'session-user' },
    });
    assert.equal(authorized.statusCode, 200);
    const hooksJson = JSON.parse(await readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(
      hooksJson.hooks.SessionStart[0].hooks[0].command,
      bashCmd(join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh')),
    );
    assert.equal(
      hooksJson.hooks.Stop[0].hooks[0].command,
      codexStopCmd(join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh')),
    );
  });

  it('rejects no-origin header-only sync requests before writing hook files', async () => {
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/agent-hooks/sync',
      headers: HEADERS,
    });
    assert.equal(unauthorized.statusCode, 401);
    await assert.rejects(readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'));
  });

  it('does not fall back to the API process home for non-local peers', async () => {
    const implicitApp = Fastify();
    addSessionTestHook(implicitApp);
    await implicitApp.register(agentHooksRoutes, { projectRoot });
    await implicitApp.ready();

    try {
      const res = await implicitApp.inject({
        method: 'GET',
        url: '/api/agent-hooks/status',
        headers: { ...SESSION_HEADERS, host: 'cat-cafe.example.com' },
        remoteAddress: '203.0.113.10',
      });
      assert.equal(res.statusCode, 403);
      assert.match(res.payload, /local API host/);
    } finally {
      await implicitApp.close();
    }
  });

  it('GET rejects remote access before validating an explicit projectPath', async () => {
    const implicitApp = Fastify();
    addSessionTestHook(implicitApp);
    await implicitApp.register(agentHooksRoutes, { projectRoot });
    await implicitApp.ready();
    const uninitDir = await mkdtemp(join(tmpdir(), 'agent-hooks-remote-uninit-'));

    try {
      const res = await implicitApp.inject({
        method: 'GET',
        url: `/api/agent-hooks/status?projectPath=${encodeURIComponent(uninitDir)}`,
        headers: {
          ...SESSION_HEADERS,
          host: 'skycat-api.cpolar.top',
          origin: 'https://skycat.cpolar.top',
        },
        remoteAddress: '127.0.0.1',
      });

      assert.equal(res.statusCode, 403);
      assert.match(res.payload, /local API host/);
      assert.doesNotMatch(res.payload, /Project not initialized|missing \.cat-cafe/);
    } finally {
      await implicitApp.close();
      await rm(uninitDir, { recursive: true, force: true });
    }
  });

  it('POST rejects remote access before validating an explicit projectPath', async () => {
    const implicitApp = Fastify();
    addSessionTestHook(implicitApp);
    await implicitApp.register(agentHooksRoutes, { projectRoot });
    await implicitApp.ready();
    const uninitDir = await mkdtemp(join(tmpdir(), 'agent-hooks-remote-uninit-sync-'));

    try {
      const res = await implicitApp.inject({
        method: 'POST',
        url: '/api/agent-hooks/sync',
        headers: {
          ...SESSION_HEADERS,
          host: 'skycat-api.cpolar.top',
          origin: 'https://skycat.cpolar.top',
        },
        payload: { projectPath: uninitDir },
        remoteAddress: '127.0.0.1',
      });

      assert.equal(res.statusCode, 403);
      assert.match(res.payload, /local API host/);
      assert.doesNotMatch(res.payload, /Project not initialized|missing \.cat-cafe/);
    } finally {
      await implicitApp.close();
      await rm(uninitDir, { recursive: true, force: true });
    }
  });

  it('allows implicit status checks for local browser hosts', async () => {
    const implicitApp = Fastify();
    addSessionTestHook(implicitApp);
    await implicitApp.register(agentHooksRoutes, { projectRoot });
    await implicitApp.ready();

    try {
      const res = await implicitApp.inject({
        method: 'GET',
        url: '/api/agent-hooks/status',
        headers: {
          ...SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body.targets));
    } finally {
      await implicitApp.close();
    }
  });

  it('does not trust loopback proxy sockets for public Host headers', async () => {
    const implicitApp = Fastify();
    addSessionTestHook(implicitApp);
    await implicitApp.register(agentHooksRoutes, { projectRoot });
    await implicitApp.ready();

    try {
      const res = await implicitApp.inject({
        method: 'GET',
        url: '/api/agent-hooks/status',
        headers: {
          ...SESSION_HEADERS,
          host: 'cafe.example.com',
          origin: 'https://cafe.example.com',
        },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(res.statusCode, 403);
      assert.match(res.payload, /local API host/);
    } finally {
      await implicitApp.close();
    }
  });

  it('does not trust spoofed local Host headers with public browser origins', async () => {
    const implicitApp = Fastify();
    addSessionTestHook(implicitApp);
    await implicitApp.register(agentHooksRoutes, { projectRoot });
    await implicitApp.ready();

    try {
      const res = await implicitApp.inject({
        method: 'GET',
        url: '/api/agent-hooks/status',
        headers: {
          ...SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'https://cafe.example.com',
        },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(res.statusCode, 403);
      assert.match(res.payload, /local API host/);
    } finally {
      await implicitApp.close();
    }
  });

  it('does not trust a forged localhost Host header from a remote peer', async () => {
    const implicitApp = Fastify();
    addSessionTestHook(implicitApp);
    await implicitApp.register(agentHooksRoutes, { projectRoot });
    await implicitApp.ready();

    try {
      const res = await implicitApp.inject({
        method: 'GET',
        url: '/api/agent-hooks/status',
        headers: { ...SESSION_HEADERS, host: 'localhost:3003' },
        remoteAddress: '203.0.113.10',
      });
      assert.equal(res.statusCode, 403);
      assert.match(res.payload, /local API host/);
    } finally {
      await implicitApp.close();
    }
  });

  it('POST is the explicit action that syncs and returns configured status', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/agent-hooks/sync', headers: SESSION_HEADERS });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'configured');
    assert.ok(body.targets.every((target) => target.status === 'configured'));

    const hooksJson = JSON.parse(await readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(
      hooksJson.hooks.SessionStart[0].hooks[0].command,
      bashCmd(join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh')),
    );
    assert.equal(
      hooksJson.hooks.Stop[0].hooks[0].command,
      codexStopCmd(join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh')),
    );
  });

  it('returns error status instead of throwing when a target file cannot be read', async () => {
    await syncAgentHooks({ projectRoot, targetRoot });
    const startPath = join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh');
    await chmod(startPath, 0o000);

    try {
      const body = await getAgentHookStatus({ projectRoot, targetRoot });
      const start = body.targets.find((target) => target.name === 'hooks/session-start');
      assert.equal(start?.status, 'error');
      assert.equal(body.status, 'error');
    } finally {
      await chmod(startPath, 0o755);
    }
  });

  it('GET rejects explicit invalid projectPath instead of falling back to host (#1049 regression)', async () => {
    // An explicit projectPath that does not exist must return 400,
    // NOT silently fall back to host repo health.
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-hooks/status?projectPath=/nonexistent/path/that/does/not/exist`,
      headers: SESSION_HEADERS,
    });
    assert.equal(res.statusCode, 400, 'invalid projectPath must fail loud with 400');
    const body = JSON.parse(res.payload);
    assert.ok(body.error, 'response must include error message');
    // Must NOT contain health targets (which would mean it read host state)
    assert.equal(body.targets, undefined, 'must not return host health targets');
  });

  it('GET rejects explicit uninitialized projectPath (no .cat-cafe/) instead of falling back to host', async () => {
    // A valid directory that is not initialized as a project must not fall back to host
    const uninitDir = await mkdtemp(join(tmpdir(), 'agent-hooks-uninit-'));
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agent-hooks/status?projectPath=${encodeURIComponent(uninitDir)}`,
        headers: SESSION_HEADERS,
      });
      assert.equal(res.statusCode, 400, 'uninitialized projectPath must fail loud with 400');
      const body = JSON.parse(res.payload);
      assert.ok(body.error, 'response must include error message');
      assert.equal(body.targets, undefined, 'must not return host health targets');
    } finally {
      await rm(uninitDir, { recursive: true, force: true });
    }
  });

  it('POST rejects explicit invalid projectPath instead of mutating host capabilities (#1049 regression)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent-hooks/sync',
      headers: SESSION_HEADERS,
      payload: { projectPath: '/nonexistent/sync/target' },
    });
    assert.equal(res.statusCode, 400, 'invalid projectPath must fail loud with 400');
    const body = JSON.parse(res.payload);
    assert.ok(body.error, 'response must include error message');
    assert.equal(body.targets, undefined, 'must not return sync results');
  });

  it('POST rejects explicit uninitialized projectPath instead of mutating host capabilities', async () => {
    const uninitDir = await mkdtemp(join(tmpdir(), 'agent-hooks-uninit-sync-'));
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent-hooks/sync',
        headers: SESSION_HEADERS,
        payload: { projectPath: uninitDir },
      });
      assert.equal(res.statusCode, 400, 'uninitialized projectPath must fail loud with 400');
      const body = JSON.parse(res.payload);
      assert.ok(body.error, 'response must include error message');
      assert.equal(body.targets, undefined, 'must not return sync results');
    } finally {
      await rm(uninitDir, { recursive: true, force: true });
    }
  });
});
