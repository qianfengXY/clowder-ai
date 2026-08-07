import { describe, expect, it } from 'vitest';
import { buildDesktopDevelopmentCreateInput } from '../desktop-development-form';

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
});
