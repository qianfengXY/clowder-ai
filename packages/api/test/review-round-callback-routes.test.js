import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('EXT-001 ReviewRound callback routes', () => {
  let app;

  afterEach(async () => {
    await app?.close();
  });

  async function setup() {
    const { reviewRoundCallbackRoutes } = await import('../dist/routes/review-round-callbacks.js');
    const calls = [];
    const coordinator = {
      readSafe: async (input) => {
        calls.push(['readSafe', input]);
        return { round: { roundId: input.roundId }, findings: [] };
      },
      readPrivateDraft: async (input) => {
        calls.push(['readPrivateDraft', input]);
        return null;
      },
      readBarrierDrafts: async (input) => {
        calls.push(['readBarrierDrafts', input]);
        return [];
      },
      submitDraft: async (input) => {
        calls.push(['submitDraft', input]);
        return { version: 1 };
      },
      finishIndependent: async (input) => {
        calls.push(['finishIndependent', input]);
        return { version: 2 };
      },
      finishCrossReview: async (input) => {
        calls.push(['finishCrossReview', input]);
        return { version: 3 };
      },
      publishConsensus: async (input) => {
        calls.push(['publishConsensus', input]);
        return { round: { roundId: input.roundId, phase: 'complete' }, consensus: { verdict: input.verdict } };
      },
    };
    const registry = {
      verify: async (invocationId, token) =>
        invocationId === 'inv-1' && token === 'token-1'
          ? {
              ok: true,
              record: {
                invocationId,
                callbackToken: token,
                threadId: 'project-review-hub:project-1',
                userId: 'owner-1',
                catId: 'cat-codex',
                isLatest: true,
                createdAt: 1,
              },
            }
          : { ok: false, reason: 'invalid_token' },
    };
    app = Fastify();
    await app.register(reviewRoundCallbackRoutes, { registry, coordinator });
    return { calls };
  }

  const headers = { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' };

  test('requires invocation authentication and derives reviewer, owner, and Review Hub thread', async () => {
    const { calls } = await setup();
    let response = await app.inject({ method: 'GET', url: '/api/callbacks/review-rounds/round-1' });
    assert.equal(response.statusCode, 401);

    response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/review-rounds/round-1',
      headers: { ...headers, 'x-cat-cafe-user': 'spoofed', 'x-cat-id': 'spoofed-cat' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [
      [
        'readSafe',
        {
          ownerUserId: 'owner-1',
          threadId: 'project-review-hub:project-1',
          reviewerCatId: 'cat-codex',
          roundId: 'round-1',
        },
      ],
    ]);
  });

  test('routes private/barrier reads and every versioned review mutation without caller identity', async () => {
    const { calls } = await setup();
    let response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/review-rounds/round-1/private-draft',
      headers,
    });
    assert.equal(response.statusCode, 200);
    response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/review-rounds/round-1/barrier-drafts',
      headers,
    });
    assert.equal(response.statusCode, 200);
    response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/review-rounds/round-1/draft',
      headers,
      payload: {
        expectedDraftVersion: 0,
        idempotencyKey: 'draft-1',
        verdict: 'approve',
        findings: [],
      },
    });
    assert.equal(response.statusCode, 200);
    response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/review-rounds/round-1/finish-independent',
      headers,
      payload: { expectedRoundVersion: 1, idempotencyKey: 'independent-1' },
    });
    assert.equal(response.statusCode, 200);
    response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/review-rounds/round-1/finish-cross-review',
      headers,
      payload: { expectedRoundVersion: 2, idempotencyKey: 'cross-1' },
    });
    assert.equal(response.statusCode, 200);
    response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/review-rounds/round-1/consensus',
      headers,
      payload: {
        expectedRoundVersion: 3,
        expectedManagedWorkVersion: 4,
        idempotencyKey: 'consensus-1',
        verdict: 'approved',
        checksPassed: true,
        findings: [],
        resolvedFindingIds: [],
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      calls.map(([name]) => name),
      [
        'readPrivateDraft',
        'readBarrierDrafts',
        'submitDraft',
        'finishIndependent',
        'finishCrossReview',
        'publishConsensus',
      ],
    );
    assert.equal(
      calls.every(([, input]) => input.ownerUserId === 'owner-1'),
      true,
    );
    assert.equal(
      calls.every(([, input]) => input.reviewerCatId === 'cat-codex'),
      true,
    );
  });

  test('rejects unknown identity and caller-supplied actor fields', async () => {
    await setup();
    let response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/review-rounds/round-1',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'wrong' },
    });
    assert.equal(response.statusCode, 401);
    response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/review-rounds/round-1/draft',
      headers,
      payload: {
        reviewerCatId: 'cat-kimi',
        expectedDraftVersion: 0,
        idempotencyKey: 'draft-1',
        verdict: 'approve',
        findings: [],
      },
    });
    assert.equal(response.statusCode, 400);
    response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/review-rounds/round-1/draft',
      headers,
      payload: {
        expectedDraftVersion: 0,
        idempotencyKey: 'draft-without-plan-ref',
        verdict: 'findings',
        findings: [{ severity: 'P2', title: 'Unscoped suggestion', details: 'This has no plan authority.' }],
      },
    });
    assert.equal(response.statusCode, 400);
  });
});
