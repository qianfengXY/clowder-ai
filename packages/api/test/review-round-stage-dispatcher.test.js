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
      recorderCatId: 'cat-codex',
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
    assert.equal(
      requests.every((request) => request.payload.serverAuthoredKind === 'review_orchestration'),
      true,
    );
    assert.match(requests[0].payload.content, /^@gpt\n@kimi\n/);
    assert.match(requests[0].payload.content, /independent/i);
    assert.match(requests[0].payload.content, /a{40}/);
    assert.match(requests[1].payload.content, /^@gpt\n@kimi\n/);
    assert.match(requests[1].payload.content, /barrier.*open/i);
    assert.match(requests[2].payload.content, /^@gpt\n/);
    assert.doesNotMatch(requests[2].payload.content, /^@gpt\n@kimi/m);
    assert.match(requests[2].payload.content, /consensus/i);
    assert.equal(new Set(requests.map((request) => request.payload.idempotencyKey)).size, 3);
    assert.equal(
      requests.every((request) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.payload.idempotencyKey),
      ),
      true,
    );
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
});
