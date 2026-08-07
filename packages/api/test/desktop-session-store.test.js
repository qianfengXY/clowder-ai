// @ts-check

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const workspace = {
  repository: { host: 'github.com', owner: 'owner', name: 'repo', fullName: 'owner/repo' },
  branch: 'feat/f289',
  baseSha: '1'.repeat(40),
  currentSha: '2'.repeat(40),
  lastCommittedSha: '2'.repeat(40),
  worktreePresent: true,
  worktreePath: '/Volumes/WorkSSD/project-worktree',
  validatedAt: 1_000,
};

function bindInput(overrides = {}) {
  return {
    projectId: 'ep-1',
    workId: 'work-1',
    attemptId: 'attempt-1',
    runtimeSessionId: 'chatgpt-session-1',
    chatRef: 'opaque-chat-1',
    expectedEpoch: 0,
    idempotencyKey: 'bind-1',
    leaseDurationMs: 60_000,
    workspace,
    now: 1_000,
    ...overrides,
  };
}

describe('F289 DesktopSessionStore', () => {
  test('binds once and replays the same idempotent request', async () => {
    const { DesktopSessionStore } = await import('../dist/domains/desktop-development-loop/desktop-session-store.js');
    const store = new DesktopSessionStore();

    const first = await store.bind(bindInput());
    const replay = await store.bind(bindInput());
    assert.deepEqual(replay, first);
    assert.equal(first.bindingEpoch, 1);
    assert.equal(first.version, 1);
    assert.equal(first.status, 'active');
    assert.equal(first.leaseExpiresAt, 61_000);

    await assert.rejects(
      () => store.bind(bindInput({ runtimeSessionId: 'different-session' })),
      /idempotency key reused with different input/i,
    );
  });

  test('rebind supersedes the previous epoch and rejects its heartbeat', async () => {
    const { DesktopSessionStore } = await import('../dist/domains/desktop-development-loop/desktop-session-store.js');
    const store = new DesktopSessionStore();
    const first = await store.bind(bindInput());
    const second = await store.bind(
      bindInput({
        runtimeSessionId: 'chatgpt-session-2',
        chatRef: 'opaque-chat-2',
        expectedEpoch: first.bindingEpoch,
        idempotencyKey: 'bind-2',
        now: 2_000,
      }),
    );

    assert.equal(second.bindingEpoch, 2);
    assert.equal((await store.getByEpoch('ep-1', 'work-1', 1)).status, 'superseded');
    await assert.rejects(
      () =>
        store.heartbeat({
          projectId: 'ep-1',
          workId: 'work-1',
          bindingEpoch: 1,
          runtimeSessionId: 'chatgpt-session-1',
          expectedVersion: 1,
          idempotencyKey: 'heartbeat-old',
          leaseDurationMs: 60_000,
          now: 3_000,
        }),
      /stale binding epoch/i,
    );
  });

  test('heartbeat is versioned, replay-safe, and can revive a detached current epoch', async () => {
    const { DesktopSessionStore } = await import('../dist/domains/desktop-development-loop/desktop-session-store.js');
    const store = new DesktopSessionStore();
    const first = await store.bind(bindInput({ leaseDurationMs: 1_000 }));
    assert.equal((await store.getCurrent('ep-1', 'work-1', 2_000)).status, 'detached');

    const heartbeat = {
      projectId: 'ep-1',
      workId: 'work-1',
      bindingEpoch: first.bindingEpoch,
      runtimeSessionId: first.runtimeSessionId,
      expectedVersion: first.version,
      idempotencyKey: 'heartbeat-1',
      leaseDurationMs: 1_000,
      now: 2_500,
      workspace: { ...workspace, currentSha: '3'.repeat(40), lastCommittedSha: '3'.repeat(40) },
    };
    const updated = await store.heartbeat(heartbeat);
    assert.equal(updated.status, 'active');
    assert.equal(updated.version, 2);
    assert.equal(updated.leaseExpiresAt, 3_500);
    assert.equal(updated.workspace.currentSha, '3'.repeat(40));
    assert.deepEqual(await store.heartbeat(heartbeat), updated);

    await assert.rejects(
      () => store.heartbeat({ ...heartbeat, idempotencyKey: 'heartbeat-stale-version' }),
      /version conflict/i,
    );
  });

  test('exactly one concurrent rebind wins the epoch CAS', async () => {
    const { DesktopSessionStore } = await import('../dist/domains/desktop-development-loop/desktop-session-store.js');
    const store = new DesktopSessionStore();
    const first = await store.bind(bindInput());
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        store.bind(
          bindInput({
            expectedEpoch: first.bindingEpoch,
            runtimeSessionId: `chatgpt-session-${index + 2}`,
            idempotencyKey: `rebind-${index}`,
            now: 2_000 + index,
          }),
        ),
      ),
    );

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 9);
    assert.equal((await store.getCurrent('ep-1', 'work-1', 2_100)).bindingEpoch, 2);
  });

  test('missing worktree remains recoverable from the last committed SHA', async () => {
    const { DesktopSessionStore } = await import('../dist/domains/desktop-development-loop/desktop-session-store.js');
    const store = new DesktopSessionStore();
    const binding = await store.bind(
      bindInput({
        workspace: {
          ...workspace,
          currentSha: '4'.repeat(40),
          lastCommittedSha: '3'.repeat(40),
          worktreePresent: false,
        },
      }),
    );

    assert.equal(binding.workspace.worktreePresent, false);
    assert.equal(binding.workspace.lastCommittedSha, '3'.repeat(40));
  });

  test(
    'Redis backend persists without TTL and atomically selects one rebind winner',
    { skip: !process.env.F289_TEST_REDIS_URL },
    async () => {
      const { Redis } = await import('ioredis');
      const { DesktopSessionStore } = await import('../dist/domains/desktop-development-loop/desktop-session-store.js');
      const suffix = `${process.pid}-${Date.now()}`;
      const projectId = `ep-redis-${suffix}`;
      const workId = `work-redis-${suffix}`;
      const key = `desktop-development:session:${encodeURIComponent(projectId)}:${encodeURIComponent(workId)}`;
      const redis = new Redis(process.env.F289_TEST_REDIS_URL, { maxRetriesPerRequest: 1 });

      try {
        const firstStore = new DesktopSessionStore(redis);
        const first = await firstStore.bind(bindInput({ projectId, workId, idempotencyKey: `bind-${suffix}` }));
        assert.equal(await redis.pttl(key), -1);

        const restartedStore = new DesktopSessionStore(redis);
        assert.deepEqual(await restartedStore.getCurrent(projectId, workId, 1_001), first);
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, (_, index) =>
            restartedStore.bind(
              bindInput({
                projectId,
                workId,
                expectedEpoch: first.bindingEpoch,
                runtimeSessionId: `redis-session-${index}`,
                idempotencyKey: `redis-rebind-${suffix}-${index}`,
              }),
            ),
          ),
        );
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        assert.equal((await restartedStore.getCurrent(projectId, workId, 1_001)).bindingEpoch, 2);
        assert.equal(await redis.pttl(key), -1);
      } finally {
        await redis.del(key);
        await redis.quit();
      }
    },
  );
});
