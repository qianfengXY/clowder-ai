import type { CreateDesktopDevelopmentProjectBindingInput, DesktopDevelopmentResumePacket } from '@cat-cafe/shared';

export interface DesktopDevelopmentFormValues {
  enabled: boolean;
  repository: string;
  defaultBranch: string;
  reviewerIds: readonly string[];
  allowPush: boolean;
  allowPullRequest: boolean;
}

export function buildDesktopDevelopmentCreateInput(
  values: DesktopDevelopmentFormValues,
): CreateDesktopDevelopmentProjectBindingInput | undefined {
  if (!values.enabled) return undefined;
  const repository = values.repository.trim();
  const defaultBranch = values.defaultBranch.trim();
  const defaultReviewers = [...new Set(values.reviewerIds.map((id) => id.trim()).filter(Boolean))];
  if (!repository) throw new Error('GitHub repository is required');
  if (!defaultBranch) throw new Error('Default branch is required');
  if (defaultReviewers.length < 2) throw new Error('Select at least two reviewers');
  return {
    repository,
    defaultBranch,
    defaultReviewers,
    allowPush: values.allowPush,
    allowPullRequest: values.allowPullRequest,
  };
}

type AcceptanceResumePacket = Pick<
  DesktopDevelopmentResumePacket,
  'protocolVersion' | 'projectId' | 'workId' | 'attemptId' | 'managedWorkVersion' | 'currentSha' | 'acceptancePending'
>;

export function buildDesktopAcceptanceRequest(work: AcceptanceResumePacket, accepted: boolean) {
  if (!work.acceptancePending) throw new Error('Work is not awaiting final acceptance');
  return {
    protocolVersion: work.protocolVersion,
    attemptId: work.attemptId,
    expectedManagedWorkVersion: work.managedWorkVersion,
    exactSha: work.currentSha,
    accepted,
    idempotencyKey: `acceptance:${work.workId}:${work.currentSha}:${accepted ? 'accepted' : 'rejected'}`,
  };
}
