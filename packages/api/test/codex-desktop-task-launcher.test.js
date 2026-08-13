// @ts-check

import assert from 'node:assert/strict';
import { test } from 'node:test';

class FakeNativeSession {
  writes = [];
  responses = [];
  waiters = [];

  async write(message) {
    this.writes.push(message);
    if (message.id === undefined) return;
    let result = {};
    if (message.method === 'thread/start') result = { thread: { id: 'native-thread-f006' } };
    this.push({ id: message.id, result });
  }

  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.responses.push(value);
  }

  async *read() {
    while (true) {
      if (this.responses.length > 0) yield this.responses.shift();
      else yield await new Promise((resolve) => this.waiters.push(resolve)).then((entry) => entry.value);
    }
  }

  async close() {}
}

test('Desktop task names include the feature name without repeating the project name', async () => {
  const { buildDesktopTaskName } = await import(
    '../dist/domains/desktop-development-loop/codex-desktop-task-launcher.js'
  );
  assert.equal(
    buildDesktopTaskName('F006', '[F006] Workspace capability settings'),
    'F006 · Workspace capability settings',
  );
  assert.equal(buildDesktopTaskName('f120', 'F120 — Export audit trail'), 'F120 · Export audit trail');
  assert.equal(buildDesktopTaskName('F009', 'Traqen sync'), 'F009 · Traqen sync');
});

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
  launcher.activate = async () => {};
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
  afterRestart.activate = async () => {};
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

test('Desktop task launcher starts the visible turn through the durable ChatGPT daemon', async () => {
  const { CodexDesktopTaskLauncher } = await import(
    '../dist/domains/desktop-development-loop/codex-desktop-task-launcher.js'
  );
  const sessions = [];
  const opened = [];
  const launcher = new CodexDesktopTaskLauncher(undefined, {
    sessionFactory: async () => {
      const session = new FakeNativeSession();
      sessions.push(session);
      return session;
    },
    openThread: async (threadId) => opened.push(threadId),
    recoveryIntervalMs: 0,
  });
  const result = await launcher.launch({
    projectId: 'project-1',
    projectName: 'Traqen',
    repository: 'owner/traqen',
    sourcePath: '/work/traqen',
    backlogItemId: 'backlog-1',
    featureId: 'F006',
    title: 'Workspace settings',
  });

  assert.deepEqual(result, { status: 'created', threadId: 'native-thread-f006' });
  assert.deepEqual(opened, ['native-thread-f006']);
  const methods = sessions[0].writes.map((message) => message.method);
  assert.deepEqual(methods, [
    'initialize',
    'initialized',
    'thread/start',
    'thread/name/set',
    'thread/goal/set',
    'turn/start',
  ]);
  const goal = sessions[0].writes.find((message) => message.method === 'thread/goal/set');
  assert.equal(goal.params.threadId, 'native-thread-f006');
  assert.equal(goal.params.status, 'active');
  assert.match(goal.params.objective, /runtimeSessionId/);
  const turn = sessions[0].writes.find((message) => message.method === 'turn/start');
  assert.equal(turn.params.threadId, 'native-thread-f006');
  assert.match(turn.params.input[0].text, /runtimeSessionId/);
});

test('Desktop task activation starts the daemon-owned turn before opening the task', async () => {
  const { CodexDesktopTaskLauncher } = await import(
    '../dist/domains/desktop-development-loop/codex-desktop-task-launcher.js'
  );
  const order = [];
  let session;
  const launcher = new CodexDesktopTaskLauncher(undefined, {
    sessionFactory: async () => {
      session = new FakeNativeSession();
      const originalWrite = session.write.bind(session);
      session.write = async (message) => {
        if (message.method === 'thread/resume') order.push('resume');
        if (message.method === 'thread/goal/set') order.push('goal');
        if (message.method === 'turn/start') order.push('turn');
        await originalWrite(message);
      };
      return session;
    },
    openThread: async () => order.push('open'),
    recoveryIntervalMs: 0,
  });

  await launcher.activate({
    threadId: 'existing-thread',
    sourcePath: '/work/traqen',
    objective: 'Continue from the latest Resume Packet',
  });

  assert.deepEqual(order, ['resume', 'goal', 'turn', 'open']);
  const turn = session.writes.find((message) => message.method === 'turn/start');
  assert.equal(turn.params.threadId, 'existing-thread');
  assert.equal(turn.params.input[0].text, 'Continue from the latest Resume Packet');
});

test('Desktop task activation reuses a thread already loaded by the durable daemon', async () => {
  const { CodexDesktopTaskLauncher } = await import(
    '../dist/domains/desktop-development-loop/codex-desktop-task-launcher.js'
  );
  let session;
  const launcher = new CodexDesktopTaskLauncher(undefined, {
    sessionFactory: async () => {
      session = new FakeNativeSession();
      const originalWrite = session.write.bind(session);
      session.write = async (message) => {
        if (message.method === 'thread/resume') {
          session.writes.push(message);
          session.push({
            id: message.id,
            error: { code: -32600, message: 'thread already has an active writer' },
          });
          return;
        }
        await originalWrite(message);
      };
      return session;
    },
    openThread: async () => {},
    recoveryIntervalMs: 0,
  });

  await launcher.activate({
    threadId: 'loaded-thread',
    sourcePath: '/work/traqen',
    objective: 'Continue after Review',
  });

  assert.equal(session.writes.some((message) => message.method === 'thread/goal/set'), true);
  assert.equal(session.writes.some((message) => message.method === 'turn/start'), true);
});

test('Desktop task activation survives a temporary ChatGPT open failure and recovers from Redis', async () => {
  const { CodexDesktopTaskLauncher } = await import(
    '../dist/domains/desktop-development-loop/codex-desktop-task-launcher.js'
  );
  const values = new Map();
  const sets = new Map();
  const redis = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
      return 'OK';
    },
    del: async (key) => (values.delete(key) ? 1 : 0),
    sadd: async (key, value) => {
      const members = sets.get(key) ?? new Set();
      members.add(value);
      sets.set(key, members);
      return 1;
    },
    srem: async (key, value) => (sets.get(key)?.delete(value) ? 1 : 0),
    smembers: async (key) => [...(sets.get(key) ?? [])],
  };
  let opens = 0;
  const launcher = new CodexDesktopTaskLauncher(redis, {
    sessionFactory: async () => new FakeNativeSession(),
    openThread: async () => {
      opens += 1;
      if (opens === 1) throw new Error('ChatGPT is restarting');
    },
    recoveryIntervalMs: 0,
  });

  await launcher.activate({
    threadId: 'recoverable-thread',
    sourcePath: '/work/traqen',
    objective: 'Continue after Review',
  });
  assert.deepEqual(await redis.smembers('desktop-development:pending-native-wakes'), ['recoverable-thread']);

  await launcher.recoverPendingActivations();
  assert.equal(opens, 2);
  assert.deepEqual(await redis.smembers('desktop-development:pending-native-wakes'), []);
});
