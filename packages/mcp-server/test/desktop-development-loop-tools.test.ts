import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  desktopDevelopmentLoopTools,
  developmentReviewWaitInputSchema,
  handleDevelopmentMergeConfirmationRecord,
  handleDevelopmentMergeReport,
  handleDevelopmentProjectRead,
  handleDevelopmentReviewWait,
  handleDevelopmentWorkConnect,
  handleDevelopmentWorkRead,
} from '../src/tools/desktop-development-loop-tools.js';

describe('F289 ChatGPT Desktop development-loop tools', () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CAT_CAFE_DESKTOP_DEVELOPMENT_TOKEN;
  const originalApiUrl = process.env.CAT_CAFE_API_URL;
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    requests.length = 0;
    process.env.CAT_CAFE_DESKTOP_DEVELOPMENT_TOKEN = 'desktop-secret';
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
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
    if (originalToken === undefined) delete process.env.CAT_CAFE_DESKTOP_DEVELOPMENT_TOKEN;
    else process.env.CAT_CAFE_DESKTOP_DEVELOPMENT_TOKEN = originalToken;
    if (originalApiUrl === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = originalApiUrl;
  });

  it('has exactly eight lifecycle tools with no merge primitive, deploy, shell, Git, or credential input', () => {
    assert.deepEqual(desktopDevelopmentLoopTools.map((tool) => tool.name).sort(), [
      'cat_cafe_development_implementation_report',
      'cat_cafe_development_merge_confirmation_record',
      'cat_cafe_development_merge_report',
      'cat_cafe_development_project_read',
      'cat_cafe_development_review_wait',
      'cat_cafe_development_work_connect',
      'cat_cafe_development_work_heartbeat',
      'cat_cafe_development_work_read',
    ]);
    const serialized = JSON.stringify(desktopDevelopmentLoopTools.map((tool) => tool.inputSchema));
    assert.doesNotMatch(serialized, /ownerUserId|token|credential|command|deploy/i);
    assert.equal(
      desktopDevelopmentLoopTools.some((tool) => tool.name === 'cat_cafe_development_merge'),
      false,
    );
    assert.equal(
      desktopDevelopmentLoopTools.some((tool) => tool.annotations.destructiveHint),
      false,
    );
  });

  it('waits in the current Desktop turn until Review leaves its in-progress phases', async () => {
    let reads = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      reads += 1;
      return new Response(
        JSON.stringify(
          reads === 1
            ? { phase: 'independent_review', nextLegalActions: ['wait_for_independent_review'] }
            : { phase: 'fix_required', nextLegalActions: ['start_fix_attempt'] },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await handleDevelopmentReviewWait({
      protocolVersion: 1,
      projectId: 'project-1',
      workId: 'work-1',
      attemptId: 'attempt-1',
      timeoutMs: 2_000,
    });
    assert.equal(result.isError, undefined);
    assert.equal(reads, 2);
    const output = JSON.parse(result.content[0].text);
    assert.equal(output.reviewWait, 'complete');
    assert.equal(output.resumePacket.phase, 'fix_required');
  });

  it('keeps one Desktop tool call alive for a full Review round', () => {
    const timeoutSchema = developmentReviewWaitInputSchema.timeoutMs;
    assert.equal(timeoutSchema.safeParse(60 * 60 * 1_000).success, true);
    assert.equal(timeoutSchema.safeParse(60 * 60 * 1_000 + 1).success, false);
    assert.match(timeoutSchema.description ?? '', /defaults to 60 minutes/i);

    const waitTool = desktopDevelopmentLoopTools.find((tool) => tool.name === 'cat_cafe_development_review_wait');
    assert.ok(waitTool);
    assert.match(waitTool.description, /one long-lived call/i);
    assert.doesNotMatch(waitTool.description, /call again when reviewWait is pending/i);
  });

  it('documents routing, exclusions, output, and every top-level input parameter', () => {
    for (const tool of desktopDevelopmentLoopTools) {
      assert.match(tool.description, /Use when:/);
      assert.match(tool.description, /NOT for:/);
      assert.match(tool.description, /Output:/);
      for (const [name, schema] of Object.entries(tool.inputSchema)) {
        assert.ok(schema.description, `${tool.name}.${name} must have an MCP input description`);
      }
    }
  });

  it('uses the provider credential internally and never sends caller identity', async () => {
    const result = await handleDevelopmentProjectRead({ protocolVersion: 1, projectId: 'project-1' });
    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /projects\/project-1\?protocolVersion=1$/);
    assert.equal(new Headers(requests[0].init?.headers).get('authorization'), 'Bearer desktop-secret');
    assert.equal(new Headers(requests[0].init?.headers).get('x-cat-cafe-user'), null);
  });

  it('resolves the Cat Cafe project from the repository when Desktop does not know projectId', async () => {
    const result = await handleDevelopmentProjectRead({ protocolVersion: 1, repository: 'owner/repo' });
    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /projects\/resolve\?protocolVersion=1&repository=owner%2Frepo$/);
  });

  it('requires exactly one project selector', async () => {
    let result = await handleDevelopmentProjectRead({ protocolVersion: 1 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exactly one/i);

    result = await handleDevelopmentProjectRead({
      protocolVersion: 1,
      projectId: 'project-1',
      repository: 'owner/repo',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exactly one/i);
    assert.equal(requests.length, 0);
  });

  it('fails closed without the provider token and makes no request', async () => {
    delete process.env.CAT_CAFE_DESKTOP_DEVELOPMENT_TOKEN;
    const result = await handleDevelopmentWorkRead({
      protocolVersion: 1,
      projectId: 'project-1',
      workId: 'work-1',
      attemptId: 'attempt-1',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not configured/i);
    assert.equal(requests.length, 0);
  });

  it('posts only the bounded connect payload to the lifecycle API', async () => {
    await handleDevelopmentWorkConnect({
      protocolVersion: 1,
      projectId: 'project-1',
      workId: 'work-1',
      attemptId: 'attempt-1',
      runtimeSessionId: 'runtime-1',
      expectedBindingEpoch: 0,
      expectedManagedWorkVersion: 1,
      idempotencyKey: 'connect-1',
      leaseDurationMs: 60_000,
      workspace: {
        repository: { host: 'github.com', owner: 'owner', name: 'repo', fullName: 'owner/repo' },
        branch: 'feat/example',
        baseSha: '0'.repeat(40),
        currentSha: 'a'.repeat(40),
        lastCommittedSha: 'a'.repeat(40),
        worktreePresent: true,
        worktreePath: '/private/worktree',
        validatedAt: 1_000,
      },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
      protocolVersion: 1,
      projectId: 'project-1',
      workId: 'work-1',
      attemptId: 'attempt-1',
      runtimeSessionId: 'runtime-1',
      expectedBindingEpoch: 0,
      expectedManagedWorkVersion: 1,
      idempotencyKey: 'connect-1',
      leaseDurationMs: 60_000,
      workspace: {
        repository: { host: 'github.com', owner: 'owner', name: 'repo', fullName: 'owner/repo' },
        branch: 'feat/example',
        baseSha: '0'.repeat(40),
        currentSha: 'a'.repeat(40),
        lastCommittedSha: 'a'.repeat(40),
        worktreePresent: true,
        worktreePath: '/private/worktree',
        validatedAt: 1_000,
      },
    });
  });

  it('records confirmation and reports native merge output without executing Git', async () => {
    const common = {
      protocolVersion: 1,
      projectId: 'project-1',
      workId: 'work-1',
      attemptId: 'attempt-1',
      runtimeSessionId: 'runtime-1',
      bindingEpoch: 2,
      expectedManagedWorkVersion: 7,
      exactSha: 'a'.repeat(40),
      idempotencyKey: 'merge-flow-1',
    };
    await handleDevelopmentMergeConfirmationRecord(common);
    await handleDevelopmentMergeReport({
      ...common,
      idempotencyKey: 'merge-flow-2',
      mergeCommitSha: 'b'.repeat(40),
    });
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /\/merge-confirmation$/);
    assert.match(requests[1].url, /\/merge-report$/);
    assert.equal(
      requests.every((request) => request.init?.method === 'POST'),
      true,
    );
  });
});
