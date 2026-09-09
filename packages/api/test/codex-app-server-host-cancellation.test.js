import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServerHostPool } from '../dist/domains/cats/services/agents/providers/CodexAppServerHostPool.js';
import { createHarness, FakeConnection, FakeHost, sessionOptions } from './helpers/codex-host-pool-harness.js';

test('pre-cancelled acquisitions neither spawn nor consume a warm host', async () => {
  const { pool, hosts } = createHarness();
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  try {
    await assert.rejects(pool.createSession(sessionOptions({ signal: controller.signal })), /already cancelled/);
    assert.equal(hosts.length, 0);
    const first = await pool.createSession(sessionOptions({ sessionId: 'warm-session' }));
    await first.close();
    await assert.rejects(
      pool.createSession(sessionOptions({ sessionId: 'warm-session', signal: controller.signal })),
      /already cancelled/,
    );
    assert.equal(hosts[0].closeCalls, 0, 'a cancelled waiter must leave an available warm host untouched');
    assert.equal(hosts[0].connections.length, 1);
    const resumed = await pool.createSession(sessionOptions({ sessionId: 'warm-session' }));
    assert.equal(resumed.reusedSessionHost, true);
    await resumed.close();
  } finally {
    await pool.closeAll();
  }
});

for (const phase of ['spawn', 'connect']) {
  test(`cancellation during ${phase} closes acquired resources without returning a session`, async () => {
    const started = Promise.withResolvers();
    const gate = Promise.withResolvers();
    const controller = new AbortController();
    const host = new FakeHost('cancelled-host', null);
    const connections = [];
    const pool = new CodexAppServerHostPool(
      { idleTtlMs: 60_000, maxWarmHosts: 16, abortGraceMs: 60_000 },
      {
        createSocketDirectory: () => '/private/tmp/codex-host-cancellation',
        removeSocketDirectory: async () => {},
        spawnHost: async () => {
          if (phase === 'spawn') {
            started.resolve();
            await gate.promise;
          }
          return host;
        },
        connectHost: async () => {
          const connection = new FakeConnection(host);
          connections.push(connection);
          if (phase === 'connect') {
            started.resolve();
            await gate.promise;
          }
          return connection;
        },
      },
    );
    try {
      const acquiring = pool.createSession(sessionOptions({ signal: controller.signal }));
      const rejected = assert.rejects(acquiring, /cancel during acquisition/);
      await started.promise;
      controller.abort(new Error('cancel during acquisition'));
      gate.resolve();
      await rejected;
      assert.equal(host.closeCalls, 1);
      assert.equal(host.isAlive, false);
      assert.equal(pool.getMetrics().liveHostCount, 0);
      assert.equal(pool.getMetrics().activeLeaseCount, 0);
      assert.equal(connections.length, phase === 'spawn' ? 0 : 1);
      for (const connection of connections) assert.equal(connection.closeCalls, 1);
    } finally {
      gate.resolve();
      await pool.closeAll();
    }
  });
}

test('cancellation while reaping a dead host prevents a cold replacement', async () => {
  const { pool, hosts } = createHarness();
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  try {
    const first = await pool.createSession(sessionOptions());
    await first.close();
    hosts[0].alive = false;
    hosts[0].close = async () => {
      hosts[0].closeCalls++;
      started.resolve();
      await gate.promise;
    };
    const acquiring = pool.createSession(sessionOptions({ signal: controller.signal }));
    const rejected = assert.rejects(acquiring, /cancel during reap/);
    await started.promise;
    controller.abort(new Error('cancel during reap'));
    gate.resolve();
    await rejected;
    assert.equal(hosts.length, 1);
    assert.equal(pool.getMetrics().activeLeaseCount, 0);
  } finally {
    gate.resolve();
    await pool.closeAll();
  }
});

test('cancellation during dead-on-arrival host cleanup prevents a second spawn', async () => {
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const controller = new AbortController();
  const hosts = [];
  const pool = new CodexAppServerHostPool(
    { idleTtlMs: 60_000, maxWarmHosts: 16 },
    {
      createSocketDirectory: () => '/private/tmp/codex-host-dead-on-arrival',
      removeSocketDirectory: async () => {},
      spawnHost: async () => {
        const host = new FakeHost(`host-${hosts.length}`, null);
        if (hosts.length === 0) {
          host.alive = false;
          host.close = async () => {
            host.closeCalls++;
            started.resolve();
            await gate.promise;
          };
        }
        hosts.push(host);
        return host;
      },
      connectHost: async (host) => new FakeConnection(host),
    },
  );
  try {
    const acquiring = pool.createSession(sessionOptions({ signal: controller.signal }));
    const rejected = assert.rejects(acquiring, /cancel during dead-host close/);
    await started.promise;
    controller.abort(new Error('cancel during dead-host close'));
    gate.resolve();
    await rejected;
    assert.equal(hosts.length, 1);
    assert.equal(pool.getMetrics().activeLeaseCount, 0);
  } finally {
    gate.resolve();
    await pool.closeAll();
  }
});
