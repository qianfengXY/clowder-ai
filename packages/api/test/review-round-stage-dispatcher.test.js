import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F289 ReviewRoundStageDispatcher', () => {
  test('dispatches each stage into the existing Review Hub with stable server-derived routing', async () => {
    const { ReviewRoundStageDispatcher } = await import(
      '../dist/domains/desktop-development-loop/review-round-stage-dispatcher.js'
    );
    const requests = [];
    const dispatcher = new ReviewRoundStageDispatcher({
      sendMessage: async (request) => {
        requests.push(request);
        return { statusCode: 202, body: '{}' };
      },
      resolveMentionHandle: (catId) => ({ 'cat-codex': '@gpt', 'cat-kimi': '@kimi' })[catId] ?? null,
    });
    const base = {
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      reviewHubThreadId: 'project-review-hub:project-1',
      roundId: 'rr-round-1',
      exactSha: 'a'.repeat(40),
      reviewerCatIds: ['cat-codex', 'cat-kimi'],
      allReviewerCatIds: ['cat-codex', 'cat-kimi'],
      completedReviewerCatIds: [],
      recorderCatId: 'cat-codex',
      displayContext: {
        projectName: 'Traqen',
        repository: 'qianfengXY/Traqen',
        backlogItemId: 'backlog-1',
        featureId: 'F006',
        featureTitle: 'Workspace capability settings',
        attemptNumber: 3,
      },
    };

    await dispatcher.dispatch({ ...base, stage: 'independent' });
    await dispatcher.dispatch({ ...base, stage: 'cross_review' });
    await dispatcher.dispatch({ ...base, stage: 'consensus' });

    assert.equal(requests.length, 3);
    assert.deepEqual(
      requests.map((request) => request.payload.threadId),
      Array(3).fill('project-review-hub:project-1'),
    );
    assert.equal(requests[0].headers['x-cat-cafe-user'], 'owner-1');
    assert.equal(requests[0].payload.idempotencyKey, '11991fed-3249-5197-8c55-b2ecd003663e');
    assert.equal(
      requests.every((request) => request.payload.serverAuthoredKind === 'review_orchestration'),
      true,
    );
    assert.match(requests[0].payload.content, /^@gpt\n@kimi\n/);
    assert.match(requests[0].payload.content, /Traqen · F006 Workspace capability settings/);
    assert.match(requests[0].payload.content, /阶段：独立检视/);
    assert.match(requests[0].payload.content, /仓库：qianfengXY\/Traqen/);
    assert.match(requests[0].payload.content, /权威方案会话：project-feature-plan:project-1:backlog-1/);
    assert.match(requests[0].payload.content, /每条 finding 必须填写非空 designRefs/);
    assert.match(requests[0].payload.content, /禁止把个人偏好、超出方案的重构或新增需求包装成 finding/);
    assert.match(requests[0].payload.content, /GPT 与 Kimi 共用同一模板/);
    assert.match(
      requests[0].payload.content,
      /\| 编号 \| 检视者 \| 级别 \| 结论 \| 检视意见 \| 证据 \| 方案依据 \| 处理要求 \|/,
    );
    assert.match(requests[0].payload.content, /没有 finding 时仍必须输出一行/);
    assert.match(requests[0].payload.content, /Attempt #3/);
    assert.doesNotMatch(requests[0].payload.content, /F289/);
    assert.match(requests[0].payload.content, /a{40}/);
    assert.match(requests[1].payload.content, /^@gpt\n@kimi\n/);
    assert.match(requests[1].payload.content, /独立检视 Barrier 已开启/);
    assert.match(requests[1].payload.content, /成立 \/ 不成立 \/ 重复 \/ 待用户决策/);
    assert.match(requests[2].payload.content, /^@gpt\n/);
    assert.doesNotMatch(requests[2].payload.content, /^@gpt\n@kimi/m);
    assert.match(requests[2].payload.content, /阶段：共识整理/);
    assert.match(requests[2].payload.content, /纳入共识 \/ 驳回 \/ 已解决 \/ 待用户决策/);
    assert.equal(new Set(requests.map((request) => request.payload.idempotencyKey)).size, 3);
    assert.equal(
      requests.every((request) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.payload.idempotencyKey),
      ),
      true,
    );

    await dispatcher.dispatch({ ...base, stage: 'independent', deliveryKey: 'replay:1' });
    assert.notEqual(requests[0].payload.idempotencyKey, requests[3].payload.idempotencyKey);
    await dispatcher.dispatch({ ...base, stage: 'independent', deliveryKey: 'replay:1' });
    assert.equal(requests[3].payload.idempotencyKey, requests[4].payload.idempotencyKey);

    await dispatcher.dispatch({
      ...base,
      stage: 'consensus',
      managedWorkVersion: 60,
      consensusAuthorization: {
        instruction: '采纳 GPT 第 2–5 项；驳回 Kimi 第 1 项。',
        authorizedByUserId: 'owner-1',
        authorizedAt: 8_000,
      },
      deliveryKey: 'user-consensus:round-1',
    });
    const authorizedMessage = requests.at(-1).payload.content;
    assert.match(authorizedMessage, /【用户共识裁决授权】/);
    assert.match(authorizedMessage, /Managed work version：60/);
    assert.match(authorizedMessage, /采纳 GPT 第 2–5 项；驳回 Kimi 第 1 项/);
    assert.match(authorizedMessage, /不再引入新 reviewer/);
    assert.match(authorizedMessage, /立即调用 cat_cafe_review_consensus_publish/);
  });

  test('fails closed for unroutable cats or rejected message ingress', async () => {
    const { ReviewRoundStageDispatcher } = await import(
      '../dist/domains/desktop-development-loop/review-round-stage-dispatcher.js'
    );
    const base = {
      stage: 'independent',
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      reviewHubThreadId: 'project-review-hub:project-1',
      roundId: 'rr-round-1',
      exactSha: 'a'.repeat(40),
      reviewerCatIds: ['cat-codex'],
      recorderCatId: 'cat-codex',
      displayContext: {
        projectName: 'Traqen',
        repository: 'qianfengXY/Traqen',
        backlogItemId: 'backlog-1',
        featureId: 'F006',
        featureTitle: 'Workspace capability settings',
        attemptNumber: 3,
      },
    };
    await assert.rejects(
      () =>
        new ReviewRoundStageDispatcher({
          sendMessage: async () => ({ statusCode: 202, body: '{}' }),
          resolveMentionHandle: () => null,
        }).dispatch(base),
      /mention handle/i,
    );
    await assert.rejects(
      () =>
        new ReviewRoundStageDispatcher({
          sendMessage: async () => ({ statusCode: 409, body: '{"error":"thread unavailable"}' }),
          resolveMentionHandle: () => '@gpt',
        }).dispatch(base),
      /409.*thread unavailable/i,
    );
  });

  test('persists a failed stage message and retries it after restart', async () => {
    const { ReviewRoundStageDispatcher } = await import(
      '../dist/domains/desktop-development-loop/review-round-stage-dispatcher.js'
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
    let attempts = 0;
    const delivered = [];
    const dispatcher = new ReviewRoundStageDispatcher(
      {
        sendMessage: async (request) => {
          attempts += 1;
          if (attempts === 1) return { statusCode: 503, body: 'temporarily unavailable' };
          delivered.push(request);
          return { statusCode: 200, body: '{"status":"processing"}' };
        },
        resolveMentionHandle: () => '@kimi',
      },
      { redis, recoveryIntervalMs: 0 },
    );
    const input = {
      stage: 'independent',
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      reviewHubThreadId: 'project-feature-review:project-1:backlog-1',
      roundId: 'round-recovery',
      exactSha: 'b'.repeat(40),
      reviewerCatIds: ['cat-kimi'],
      allReviewerCatIds: ['cat-codex', 'cat-kimi'],
      completedReviewerCatIds: ['cat-codex'],
      recorderCatId: 'cat-codex',
      displayContext: {
        projectName: 'Traqen',
        repository: 'qianfengXY/Traqen',
        backlogItemId: 'backlog-1',
        featureId: 'F006',
        featureTitle: 'Workspace capability settings',
        attemptNumber: 3,
      },
      deliveryKey: 'replay:2',
    };

    await dispatcher.dispatch(input);
    assert.equal((await redis.smembers('desktop-development:pending-review-stage-dispatches')).length, 1);
    await dispatcher.recoverPendingDispatches();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].payload.content, /独立检视进度：1 \/ 2/);
    assert.doesNotMatch(delivered[0].payload.content, /^@kimi\n@gpt/m);
    assert.deepEqual(await redis.smembers('desktop-development:pending-review-stage-dispatches'), []);
  });

  test('keeps a queued stage durable and performs a bounded automatic recovery start', async () => {
    const { ReviewRoundStageDispatcher } = await import(
      '../dist/domains/desktop-development-loop/review-round-stage-dispatcher.js'
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
    const requests = [];
    const responses = [
      { statusCode: 202, body: '{"status":"queued"}' },
      { statusCode: 202, body: '{"status":"recovery_started"}' },
      { statusCode: 200, body: '{"status":"duplicate"}' },
    ];
    const dispatcher = new ReviewRoundStageDispatcher(
      {
        sendMessage: async (request) => {
          requests.push(request);
          return responses.shift();
        },
        resolveMentionHandle: () => '@gpt',
      },
      { redis, recoveryIntervalMs: 0 },
    );
    const input = {
      stage: 'independent',
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      reviewHubThreadId: 'project-feature-review:project-1:backlog-1',
      roundId: 'round-queued-recovery',
      exactSha: 'c'.repeat(40),
      reviewerCatIds: ['cat-codex'],
      recorderCatId: 'cat-codex',
      displayContext: {
        projectName: 'Traqen',
        repository: 'qianfengXY/Traqen',
        backlogItemId: 'backlog-1',
        featureId: 'F006',
        featureTitle: 'Workspace capability settings',
        attemptNumber: 10,
      },
    };

    await dispatcher.dispatch(input);
    assert.equal((await redis.smembers('desktop-development:pending-review-stage-dispatches')).length, 1);
    await dispatcher.recoverPendingDispatches();
    assert.equal(requests[1].headers['x-cat-cafe-review-recovery-attempt'], '1');
    assert.equal((await redis.smembers('desktop-development:pending-review-stage-dispatches')).length, 1);
    await dispatcher.recoverPendingDispatches();
    assert.equal(requests[2].headers['x-cat-cafe-review-recovery-attempt'], '2');
    assert.deepEqual(await redis.smembers('desktop-development:pending-review-stage-dispatches'), []);
  });

  test('supersedes an older pending stage in the same feature Review thread', async () => {
    const { ReviewRoundStageDispatcher } = await import(
      '../dist/domains/desktop-development-loop/review-round-stage-dispatcher.js'
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
    const dispatcher = new ReviewRoundStageDispatcher(
      {
        sendMessage: async () => ({ statusCode: 202, body: '{"status":"queued"}' }),
        resolveMentionHandle: () => '@gpt',
      },
      { redis, recoveryIntervalMs: 0 },
    );
    const base = {
      ownerUserId: 'owner-1',
      projectId: 'project-1',
      reviewHubThreadId: 'project-feature-review:project-1:backlog-1',
      exactSha: 'd'.repeat(40),
      reviewerCatIds: ['cat-codex'],
      recorderCatId: 'cat-codex',
      displayContext: {
        projectName: 'Traqen',
        repository: 'qianfengXY/Traqen',
        backlogItemId: 'backlog-1',
        featureId: 'F006',
        featureTitle: 'Workspace capability settings',
        attemptNumber: 10,
      },
    };

    await dispatcher.dispatch({ ...base, roundId: 'round-old', stage: 'independent' });
    const oldPending = await redis.smembers('desktop-development:pending-review-stage-dispatches');
    assert.equal(oldPending.length, 1);
    await dispatcher.dispatch({ ...base, roundId: 'round-current', stage: 'independent' });
    const currentPending = await redis.smembers('desktop-development:pending-review-stage-dispatches');
    assert.equal(currentPending.length, 1);
    assert.notEqual(currentPending[0], oldPending[0]);
    assert.equal(await redis.get(`desktop-development:review-stage-dispatch:${oldPending[0]}`), null);
  });
});
