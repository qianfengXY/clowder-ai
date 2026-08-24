import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('EXT-001 desktop development loop contract', () => {
  it('normalizes supported GitHub repository references', async () => {
    const { normalizeGitHubRepository } = await import('../dist/types/desktop-development-loop.js');

    const expected = { host: 'github.com', owner: 'qianfengXY', name: 'clowder-ai', fullName: 'qianfengXY/clowder-ai' };
    assert.deepEqual(normalizeGitHubRepository('qianfengXY/clowder-ai'), expected);
    assert.deepEqual(normalizeGitHubRepository('https://github.com/qianfengXY/clowder-ai.git'), expected);
    assert.deepEqual(normalizeGitHubRepository('git@github.com:qianfengXY/clowder-ai.git'), expected);
  });

  it('rejects non-GitHub and ambiguous repository references', async () => {
    const { normalizeGitHubRepository } = await import('../dist/types/desktop-development-loop.js');

    for (const value of [
      '',
      'https://gitlab.com/qianfengXY/clowder-ai',
      'github.com/owner',
      '../owner/repo',
      'owner/repo/extra',
    ]) {
      assert.throws(() => normalizeGitHubRepository(value), /GitHub repository/i, value);
    }
  });

  it('creates a safe manual-pilot binding and excludes the Desktop author from reviewers', async () => {
    const { createDesktopDevelopmentProjectBinding } = await import('../dist/types/desktop-development-loop.js');

    const binding = createDesktopDevelopmentProjectBinding({
      repository: 'qianfengXY/clowder-ai',
      defaultBranch: 'main',
      defaultReviewers: ['cat-idwxwjba', 'cat-kimi'],
      allowPush: true,
      allowPullRequest: true,
    });

    assert.equal(binding.protocolVersion, 1);
    assert.equal(binding.developmentActor, 'chatgpt-desktop-dev');
    assert.equal(binding.mergeMode, 'manual_confirm_in_chatgpt');
    assert.equal(binding.successfulManualPilotCount, 0);
    assert.equal(binding.requireFinalAcceptance, true);
    assert.equal(binding.version, 1);

    assert.throws(
      () =>
        createDesktopDevelopmentProjectBinding({
          repository: 'owner/repo',
          defaultBranch: 'main',
          defaultReviewers: ['cat-idwxwjba', 'chatgpt-desktop-dev'],
        }),
      /Desktop author cannot review/i,
    );
  });

  it('validates Git branch names and requires two distinct reviewers', async () => {
    const { createDesktopDevelopmentProjectBinding } = await import('../dist/types/desktop-development-loop.js');

    for (const defaultBranch of ['', '../main', 'feature bad', 'main.lock', 'heads/main']) {
      assert.throws(
        () =>
          createDesktopDevelopmentProjectBinding({
            repository: 'owner/repo',
            defaultBranch,
            defaultReviewers: ['cat-a', 'cat-b'],
          }),
        /default branch/i,
      );
    }

    assert.throws(
      () =>
        createDesktopDevelopmentProjectBinding({
          repository: 'owner/repo',
          defaultBranch: 'main',
          defaultReviewers: ['cat-a', 'cat-a'],
        }),
      /two distinct reviewers/i,
    );
  });

  it('fails closed when automatic merge is requested before two accepted pilots', async () => {
    const { applyDesktopDevelopmentPolicyUpdate, createDesktopDevelopmentProjectBinding } = await import(
      '../dist/types/desktop-development-loop.js'
    );
    const binding = createDesktopDevelopmentProjectBinding({
      repository: 'owner/repo',
      defaultBranch: 'main',
      defaultReviewers: ['cat-a', 'cat-b'],
    });

    assert.throws(
      () => applyDesktopDevelopmentPolicyUpdate(binding, { expectedVersion: 1, mergeMode: 'automatic' }),
      /two successful manual pilots/i,
    );
    assert.throws(
      () => applyDesktopDevelopmentPolicyUpdate(binding, { expectedVersion: 0, allowPush: true }),
      /version conflict/i,
    );
  });

  it('increments successful pilots once per accepted work and enables auto-merge after the second pilot', async () => {
    const { recordAcceptedManualPilot, applyDesktopDevelopmentPolicyUpdate, createDesktopDevelopmentProjectBinding } =
      await import('../dist/types/desktop-development-loop.js');
    const initial = createDesktopDevelopmentProjectBinding({
      repository: 'owner/repo',
      defaultBranch: 'main',
      defaultReviewers: ['cat-a', 'cat-b'],
    });

    const first = recordAcceptedManualPilot(initial, 'work-1');
    const duplicate = recordAcceptedManualPilot(first, 'work-1');
    const second = recordAcceptedManualPilot(duplicate, 'work-2');
    assert.equal(first.successfulManualPilotCount, 1);
    assert.equal(duplicate.successfulManualPilotCount, 1);
    assert.equal(second.successfulManualPilotCount, 2);
    assert.equal(second.mergeMode, 'automatic');

    const enabled = applyDesktopDevelopmentPolicyUpdate(second, {
      expectedVersion: second.version,
      mergeMode: 'automatic',
    });
    assert.equal(enabled.mergeMode, 'automatic');
  });

  it('builds deterministic Review Hub ids without leaking local paths', async () => {
    const { buildFeatureWorkspaceThreadId, buildProjectReviewHubId, toPublicDesktopDevelopmentProject } = await import(
      '../dist/types/desktop-development-loop.js'
    );
    assert.equal(buildProjectReviewHubId('ep-123'), 'project-review-hub:ep-123');
    assert.throws(() => buildProjectReviewHubId('../ep-123'), /project id/i);
    assert.equal(
      buildFeatureWorkspaceThreadId('ep-123', 'backlog-456', 'review'),
      'project-feature-review:ep-123:backlog-456',
    );
    assert.equal(
      buildFeatureWorkspaceThreadId('ep-123', 'backlog-456', 'plan'),
      'project-feature-plan:ep-123:backlog-456',
    );
    assert.throws(() => buildFeatureWorkspaceThreadId('ep-123', '../backlog', 'review'), /backlog item id/i);

    const projection = toPublicDesktopDevelopmentProject({
      projectId: 'ep-123',
      sourcePath: '/Volumes/secret/repo',
      binding: null,
    });
    assert.deepEqual(projection, { projectId: 'ep-123', localCheckoutBound: true, binding: null });
    assert.equal(JSON.stringify(projection).includes('/Volumes/secret/repo'), false);
  });
});
