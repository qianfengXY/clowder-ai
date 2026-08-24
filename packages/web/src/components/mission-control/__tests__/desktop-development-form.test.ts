import { describe, expect, it } from 'vitest';
import {
  buildDesktopAcceptanceRequest,
  buildDesktopConsensusAuthorizationRequest,
  buildDesktopDevelopmentCreateInput,
} from '../desktop-development-form';

describe('EXT-001 desktop development project form', () => {
  it('omits the optional binding when the loop is disabled', () => {
    expect(
      buildDesktopDevelopmentCreateInput({
        enabled: false,
        repository: '',
        defaultBranch: '',
        reviewerIds: [],
        reviewRecorderId: '',
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
        reviewRecorderId: 'cat-b',
        allowPush: true,
        allowPullRequest: true,
      }),
    ).toEqual({
      repository: 'owner/repo',
      defaultBranch: 'main',
      defaultReviewers: ['cat-a', 'cat-b'],
      defaultReviewRecorder: 'cat-b',
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
        reviewRecorderId: 'cat-a',
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
        reviewRecorderId: 'cat-a',
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
        reviewRecorderId: 'cat-a',
        allowPush: false,
        allowPullRequest: false,
      }),
    ).toThrow(/two reviewers/i);
    expect(() =>
      buildDesktopDevelopmentCreateInput({
        enabled: true,
        repository: 'owner/repo',
        defaultBranch: 'main',
        reviewerIds: ['cat-a', 'cat-b'],
        reviewRecorderId: 'cat-c',
        allowPush: false,
        allowPullRequest: false,
      }),
    ).toThrow(/recorder.*selected reviewers/i);
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

  it('builds a round-and-SHA-bound user consensus authorization', () => {
    expect(
      buildDesktopConsensusAuthorizationRequest(
        {
          protocolVersion: 1,
          workId: 'work-1',
          attemptId: 'attempt-20',
          managedWorkVersion: 59,
          currentSha: 'c'.repeat(40),
          reviewRoundId: 'round-20',
          reviewPhase: 'consensus_ready',
        },
        '  采纳第 2–5 项，驳回第 1 项。  ',
      ),
    ).toEqual({
      protocolVersion: 1,
      attemptId: 'attempt-20',
      expectedManagedWorkVersion: 59,
      reviewRoundId: 'round-20',
      instruction: '采纳第 2–5 项，驳回第 1 项。',
      idempotencyKey: `consensus-authorization:round-20:${'c'.repeat(40)}`,
    });
  });

  it('refuses consensus authorization outside consensus_ready or without an instruction', () => {
    const work = {
      protocolVersion: 1 as const,
      workId: 'work-1',
      attemptId: 'attempt-1',
      managedWorkVersion: 3,
      currentSha: 'd'.repeat(40),
      reviewRoundId: 'round-1',
      reviewPhase: 'cross_review' as const,
    };
    expect(() => buildDesktopConsensusAuthorizationRequest(work, '以用户意见为准')).toThrow(/not awaiting/i);
    expect(() =>
      buildDesktopConsensusAuthorizationRequest({ ...work, reviewPhase: 'consensus_ready' }, '   '),
    ).toThrow(/最终裁决意见/i);
  });
});
