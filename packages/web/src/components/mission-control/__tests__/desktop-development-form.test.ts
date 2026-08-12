import { describe, expect, it } from 'vitest';
import { buildDesktopAcceptanceRequest, buildDesktopDevelopmentCreateInput } from '../desktop-development-form';

describe('F289 desktop development project form', () => {
  it('omits the optional binding when the loop is disabled', () => {
    expect(
      buildDesktopDevelopmentCreateInput({
        enabled: false,
        repository: '',
        defaultBranch: '',
        reviewerIds: [],
        allowPush: false,
        allowPullRequest: false,
      }),
    ).toBeUndefined();
  });

  it('builds a safe two-reviewer binding request', () => {
    expect(
      buildDesktopDevelopmentCreateInput({
        enabled: true,
        repository: 'owner/repo',
        defaultBranch: 'main',
        reviewerIds: ['cat-a', 'cat-b'],
        allowPush: true,
        allowPullRequest: true,
      }),
    ).toEqual({
      repository: 'owner/repo',
      defaultBranch: 'main',
      defaultReviewers: ['cat-a', 'cat-b'],
      allowPush: true,
      allowPullRequest: true,
    });
  });

  it('rejects missing repository, branch, or two distinct reviewers', () => {
    expect(() =>
      buildDesktopDevelopmentCreateInput({
        enabled: true,
        repository: '',
        defaultBranch: 'main',
        reviewerIds: ['cat-a', 'cat-b'],
        allowPush: false,
        allowPullRequest: false,
      }),
    ).toThrow(/GitHub repository/i);
    expect(() =>
      buildDesktopDevelopmentCreateInput({
        enabled: true,
        repository: 'owner/repo',
        defaultBranch: '',
        reviewerIds: ['cat-a', 'cat-b'],
        allowPush: false,
        allowPullRequest: false,
      }),
    ).toThrow(/default branch/i);
    expect(() =>
      buildDesktopDevelopmentCreateInput({
        enabled: true,
        repository: 'owner/repo',
        defaultBranch: 'main',
        reviewerIds: ['cat-a', 'cat-a'],
        allowPush: false,
        allowPullRequest: false,
      }),
    ).toThrow(/two reviewers/i);
  });

  it('builds an idempotent final-acceptance request from the current Resume Packet', () => {
    expect(
      buildDesktopAcceptanceRequest(
        {
          protocolVersion: 1,
          projectId: 'project-1',
          workId: 'work-1',
          attemptId: 'attempt-2',
          managedWorkVersion: 9,
          currentSha: 'a'.repeat(40),
          acceptancePending: true,
        },
        false,
      ),
    ).toEqual({
      protocolVersion: 1,
      attemptId: 'attempt-2',
      expectedManagedWorkVersion: 9,
      exactSha: 'a'.repeat(40),
      accepted: false,
      idempotencyKey: `acceptance:work-1:${'a'.repeat(40)}:rejected`,
    });
  });

  it('refuses to build acceptance for work that is not awaiting acceptance', () => {
    expect(() =>
      buildDesktopAcceptanceRequest(
        {
          protocolVersion: 1,
          projectId: 'project-1',
          workId: 'work-1',
          attemptId: 'attempt-1',
          managedWorkVersion: 3,
          currentSha: 'b'.repeat(40),
          acceptancePending: false,
        },
        true,
      ),
    ).toThrow(/not awaiting final acceptance/i);
  });
});
