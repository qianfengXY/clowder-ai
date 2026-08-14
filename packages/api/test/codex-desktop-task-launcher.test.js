// @ts-check

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.equal(goal.params.status, 'paused');
  assert.match(goal.params.objective, /runtimeSessionId/);
  const turn = sessions[0].writes.find((message) => message.method === 'turn/start');
  assert.equal(turn.params.threadId, 'native-thread-f006');
  assert.match(turn.params.input[0].text, /runtimeSessionId/);
});

test('Review completion forwards one visible turn to the current Desktop owner', async () => {
  const { CodexDesktopTaskLauncher } = await import(
    '../dist/domains/desktop-development-loop/codex-desktop-task-launcher.js'
  );
  let session;
  const opened = [];
  const delivered = [];
  const launcher = new CodexDesktopTaskLauncher(undefined, {
    sessionFactory: async () => {
      throw new Error('Review wake must not use the pooled daemon session');
    },
    goalSessionFactory: async () => {
      session = new FakeNativeSession();
      return session;
    },
    sendDesktopTurn: async (threadId, objective) => delivered.push({ threadId, objective }),
    openThread: async (threadId) => opened.push(threadId),
  });

  await launcher.activate({
    threadId: 'bound-thread-f006',
    sourcePath: '/work/traqen',
    objective: '[Review 系统消息] Traqen · F006',
  });

  assert.deepEqual(
    session.writes.map((message) => message.method),
    ['initialize', 'initialized', 'thread/goal/set'],
  );
  const goal = session.writes.find((message) => message.method === 'thread/goal/set');
  assert.equal(goal.params.threadId, 'bound-thread-f006');
  assert.equal(goal.params.objective, '[Review 系统消息] Traqen · F006');
  assert.equal(goal.params.status, 'paused');
  assert.deepEqual(delivered, [
    { threadId: 'bound-thread-f006', objective: '[Review 系统消息] Traqen · F006' },
  ]);
  assert.deepEqual(opened, ['bound-thread-f006']);
});

test('implementation report parks the goal and tells the owner turn to complete it', async () => {
  const { CodexDesktopTaskLauncher } = await import(
    '../dist/domains/desktop-development-loop/codex-desktop-task-launcher.js'
  );
  let session;
  const opened = [];
  const stopped = [];
  const launcher = new CodexDesktopTaskLauncher(undefined, {
    sessionFactory: async () => {
      throw new Error('Review pause must not use the pooled daemon session');
    },
    goalSessionFactory: async () => {
      session = new FakeNativeSession();
      return session;
    },
    stopDesktopTurn: async (threadId, sourcePath) => stopped.push({ threadId, sourcePath }),
    openThread: async (threadId) => opened.push(threadId),
  });

  await launcher.pause({ threadId: 'bound-thread-f006', sourcePath: '/work/traqen' });

  assert.deepEqual(
    session.writes.map((message) => message.method),
    ['initialize', 'initialized', 'thread/goal/set'],
  );
  const goal = session.writes.find((message) => message.method === 'thread/goal/set');
  assert.deepEqual(goal.params, { threadId: 'bound-thread-f006', status: 'paused' });
  assert.deepEqual(stopped, [{ threadId: 'bound-thread-f006', sourcePath: '/work/traqen' }]);
  assert.deepEqual(opened, []);
});

test('failed Review goal delivery remains in the durable outbox and recovery reuses the same thread', async () => {
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
  let fail = true;
  const opened = [];
  const delivered = [];
  const launcher = new CodexDesktopTaskLauncher(redis, {
    recoveryIntervalMs: 0,
    goalSessionFactory: async () => new FakeNativeSession(),
    sendDesktopTurn: async (threadId, objective) => {
      if (fail) throw new Error('Desktop unavailable');
      delivered.push({ threadId, objective });
    },
    openThread: async (threadId) => opened.push(threadId),
  });
  const activation = {
    threadId: 'bound-thread-f006',
    sourcePath: '/work/traqen',
    objective: '[Review 系统消息] Traqen · F006',
  };

  await launcher.activate(activation);
  assert.deepEqual(await redis.smembers('desktop-development:pending-native-wakes'), ['bound-thread-f006']);
  assert.equal(
    values.get('desktop-development:native-wake:bound-thread-f006'),
    JSON.stringify({ kind: 'activate', ...activation }),
  );

  fail = false;
  await launcher.recoverPendingActivations();
  assert.deepEqual(delivered, [
    { threadId: 'bound-thread-f006', objective: '[Review 系统消息] Traqen · F006' },
  ]);
  assert.deepEqual(opened, ['bound-thread-f006']);
  assert.deepEqual(await redis.smembers('desktop-development:pending-native-wakes'), []);
  assert.equal(values.has('desktop-development:native-wake:bound-thread-f006'), false);
});

test('failed implementation stop steering remains in the outbox until the owner turn accepts it', async () => {
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
  let fail = true;
  const stops = [];
  const launcher = new CodexDesktopTaskLauncher(redis, {
    recoveryIntervalMs: 0,
    goalSessionFactory: async () => new FakeNativeSession(),
    stopDesktopTurn: async (threadId, sourcePath) => {
      if (fail) throw new Error('Owner turn unavailable');
      stops.push({ threadId, sourcePath });
    },
  });

  await launcher.pause({ threadId: 'bound-thread-f006', sourcePath: '/work/traqen' });
  assert.deepEqual(await redis.smembers('desktop-development:pending-native-wakes'), ['bound-thread-f006']);
  assert.equal(
    values.get('desktop-development:native-wake:bound-thread-f006'),
    JSON.stringify({ kind: 'pause', threadId: 'bound-thread-f006', sourcePath: '/work/traqen' }),
  );

  fail = false;
  await launcher.recoverPendingActivations();
  assert.deepEqual(stops, [{ threadId: 'bound-thread-f006', sourcePath: '/work/traqen' }]);
  assert.deepEqual(await redis.smembers('desktop-development:pending-native-wakes'), []);
});

test('Desktop IPC discovers the owning window and asks it to start the turn', async (t) => {
  const { sendChatGptDesktopTurn, steerChatGptDesktopTurnToStop } = await import(
    '../dist/domains/desktop-development-loop/codex-desktop-task-launcher.js'
  );
  const directory = await mkdtemp(join(tmpdir(), 'cat-cafe-desktop-ipc-'));
  const socketPath = join(directory, 'ipc.sock');
  const requests = [];
  const server = createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const frameBytes = buffered.readUInt32LE(0);
        if (buffered.length < frameBytes + 4) return;
        const request = JSON.parse(buffered.subarray(4, frameBytes + 4).toString('utf8'));
        buffered = buffered.subarray(frameBytes + 4);
        requests.push(request);

        const response = {
          type: 'response',
          requestId: request.requestId,
          resultType: 'success',
          method: request.method,
          handledByClientId: request.method === 'thread-owner-discovery' ? 'desktop-owner' : 'router',
          result: request.method === 'initialize' ? { clientId: 'cat-cafe-client' } : {},
        };
        const body = Buffer.from(JSON.stringify(response));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length, 0);
        socket.write(Buffer.concat([header, body]));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  await sendChatGptDesktopTurn(socketPath, 'bound-thread-f006', '[Review 系统消息] Traqen · F006');
  await steerChatGptDesktopTurnToStop(socketPath, 'bound-thread-f006', '/work/traqen');

  assert.deepEqual(
    requests.map((request) => request.method),
    [
      'initialize',
      'thread-owner-discovery',
      'thread-follower-start-turn',
      'initialize',
      'thread-owner-discovery',
      'thread-follower-steer-turn',
    ],
  );
  assert.equal(requests[0].version, 0);
  assert.equal(requests[1].params.conversationId, 'bound-thread-f006');
  assert.equal(requests[2].targetClientId, 'desktop-owner');
  assert.equal(requests[2].params.conversationId, 'bound-thread-f006');
  assert.equal(requests[2].params.turnStartParams.input[0].text, '[Review 系统消息] Traqen · F006');
  assert.equal(requests[5].targetClientId, 'desktop-owner');
  assert.equal(requests[5].params.restoreMessage.cwd, '/work/traqen');
  assert.match(requests[5].params.input[0].text, /update_goal/);
  assert.match(requests[5].params.input[0].text, /不得读取或轮询 Resume Packet/);
});

test('Desktop task launcher reopens an existing task without writing a new turn', async () => {
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
  values.set(
    'desktop-development:feature-task:project-1:backlog-1',
    JSON.stringify({ status: 'created', threadId: 'existing-thread', runtimeSessionId: 'runtime-1' }),
  );
  const opened = [];
  let sessionCreated = false;
  const launcher = new CodexDesktopTaskLauncher(redis, {
    sessionFactory: async () => {
      sessionCreated = true;
      return new FakeNativeSession();
    },
    openThread: async (threadId) => opened.push(threadId),
  });
  launcher.threadExists = async () => true;

  await launcher.launch({
    projectId: 'project-1',
    projectName: 'Traqen',
    repository: 'owner/traqen',
    sourcePath: '/work/traqen',
    backlogItemId: 'backlog-1',
    featureId: 'F006',
    title: 'Workspace settings',
  });
  assert.deepEqual(opened, ['existing-thread']);
  assert.equal(sessionCreated, false);
});
