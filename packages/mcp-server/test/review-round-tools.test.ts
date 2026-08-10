import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  handleReviewConsensusPublish,
  handleReviewDraftSubmit,
  handleReviewRoundRead,
  reviewRoundTools,
} from '../src/tools/review-round-tools.js';

describe('F289 project Review Hub tools', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    apiUrl: process.env.CAT_CAFE_API_URL,
    invocationId: process.env.CAT_CAFE_INVOCATION_ID,
    callbackToken: process.env.CAT_CAFE_CALLBACK_TOKEN,
    credentialFile: process.env.CAT_CAFE_CREDENTIAL_FILE,
  };
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    requests.length = 0;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-reviewer';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'callback-secret';
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv('CAT_CAFE_API_URL', originalEnv.apiUrl);
    restoreEnv('CAT_CAFE_INVOCATION_ID', originalEnv.invocationId);
    restoreEnv('CAT_CAFE_CALLBACK_TOKEN', originalEnv.callbackToken);
    restoreEnv('CAT_CAFE_CREDENTIAL_FILE', originalEnv.credentialFile);
  });

  it('exposes only bounded full-profile review lifecycle actions without identity inputs', () => {
    assert.deepEqual(reviewRoundTools.map((tool) => tool.name).sort(), [
      'cat_cafe_review_barrier_drafts_read',
      'cat_cafe_review_consensus_publish',
      'cat_cafe_review_cross_finish',
      'cat_cafe_review_draft_submit',
      'cat_cafe_review_independent_finish',
      'cat_cafe_review_private_draft_read',
      'cat_cafe_review_round_read',
    ]);
    const serialized = JSON.stringify(reviewRoundTools.map((tool) => tool.inputSchema));
    assert.doesNotMatch(serialized, /ownerUserId|threadId|reviewerCatId|catId|token|credential/i);
    assert.equal(
      reviewRoundTools.every((tool) => tool.policy.runtimeProfiles.join(',') === 'full'),
      true,
    );
    assert.equal(
      reviewRoundTools.some((tool) => tool.annotations.destructiveHint),
      false,
    );
  });

  it('documents routing, exclusions, output, and every top-level input parameter', () => {
    for (const tool of reviewRoundTools) {
      assert.match(tool.description, /Use when:/);
      assert.match(tool.description, /NOT for:/);
      assert.match(tool.description, /Output:/);
      for (const [name, schema] of Object.entries(tool.inputSchema)) {
        assert.ok(schema.description, `${tool.name}.${name} must have an MCP input description`);
      }
    }
  });

  it('reads through callback auth without caller-supplied identity', async () => {
    const result = await handleReviewRoundRead({ roundId: 'round-1' });
    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://127.0.0.1:3004/api/callbacks/review-rounds/round-1');
    const headers = new Headers(requests[0].init?.headers);
    assert.equal(headers.get('x-invocation-id'), 'inv-reviewer');
    assert.equal(headers.get('x-callback-token'), 'callback-secret');
  });

  it('posts only versioned review payloads and never accepts identity fields', async () => {
    await handleReviewDraftSubmit({
      roundId: 'round-1',
      expectedDraftVersion: 0,
      idempotencyKey: 'draft-1',
      verdict: 'findings',
      findings: [{ severity: 'P2', title: 'Missing fence', details: 'Add an epoch check.' }],
    });
    await handleReviewConsensusPublish({
      roundId: 'round-1',
      expectedRoundVersion: 5,
      expectedManagedWorkVersion: 7,
      idempotencyKey: 'consensus-1',
      verdict: 'changes_requested',
      checksPassed: true,
      findings: [{ severity: 'P2', title: 'Missing fence', details: 'Add an epoch check.' }],
      resolvedFindingIds: [],
    });
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /\/round-1\/draft$/);
    assert.match(requests[1].url, /\/round-1\/consensus$/);
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
      expectedDraftVersion: 0,
      idempotencyKey: 'draft-1',
      verdict: 'findings',
      findings: [{ severity: 'P2', title: 'Missing fence', details: 'Add an epoch check.' }],
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
