import type { CreateDesktopDevelopmentProjectBindingInput } from '@cat-cafe/shared';

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
