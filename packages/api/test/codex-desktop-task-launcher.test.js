// @ts-check

import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Desktop task launcher reuses the persisted task for one project feature', async () => {
  const { CodexDesktopTaskLauncher } = await import(
    '../dist/domains/desktop-development-loop/codex-desktop-task-launcher.js'
  );
  const values = new Map();
  const redis = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
      return 'OK';
    },
    del: async (key) => (values.delete(key) ? 1 : 0),
  };
  const launcher = new CodexDesktopTaskLauncher(redis);
  launcher.threadExists = async () => true;
  let starts = 0;
  launcher.start = async () => {
    starts += 1;
    return { status: 'created', threadId: 'codex-thread-f006' };
  };
  const input = {
    projectId: 'project-1',
    projectName: 'Traqen',
    repository: 'owner/traqen',
    sourcePath: '/work/traqen',
    backlogItemId: 'backlog-1',
    featureId: 'F006',
    title: 'Workspace settings',
  };
  assert.deepEqual(await launcher.launch(input), { status: 'created', threadId: 'codex-thread-f006' });
  assert.deepEqual(await launcher.launch(input), { status: 'created', threadId: 'codex-thread-f006' });
  assert.equal(starts, 1);

  const afterRestart = new CodexDesktopTaskLauncher(redis);
  afterRestart.threadExists = async () => true;
  afterRestart.start = async () => {
    throw new Error('must not create a duplicate task');
  };
  assert.deepEqual(await afterRestart.launch(input), { status: 'created', threadId: 'codex-thread-f006' });

  const afterDeletion = new CodexDesktopTaskLauncher(redis);
  afterDeletion.threadExists = async () => false;
  afterDeletion.start = async (_input, existingThreadId) => {
    assert.equal(existingThreadId, undefined);
    return { status: 'created', threadId: 'codex-thread-f006-replacement' };
  };
  assert.deepEqual(await afterDeletion.launch(input), {
    status: 'created',
    threadId: 'codex-thread-f006-replacement',
  });
});
