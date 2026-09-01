import type { CatId, ManagedWorkBinding } from '@cat-cafe/shared';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';
import type { IWorkflowSopStore } from '../../stores/ports/WorkflowSopStore.js';
import type { OwnerAuthProvenance } from './owner-auth-provenance.js';

export async function resolveManagedWorkInvocationBinding(input: {
  ownerAuthProvenance: OwnerAuthProvenance;
  ownerUserId: string;
  threadId: string;
  executorCatId: CatId;
  messageStore: Pick<IMessageStore, 'getById'>;
  triggerMessageId?: string;
  threadStore: IThreadStore | null;
  workflowSopStore?: IWorkflowSopStore;
}): Promise<ManagedWorkBinding | undefined> {
  if (input.ownerAuthProvenance !== 'strict' || !input.threadStore || !input.workflowSopStore) return undefined;

  // Review orchestration is server-authored reviewer work, not implementation
  // ownership. Its persisted provenance is minted only by canonical message
  // ingress, so it is safe to exempt without trusting prompt text or callers.
  if (await hasReviewOrchestrationProvenance(input.messageStore, input.triggerMessageId)) return undefined;

  let thread: Awaited<ReturnType<IThreadStore['get']>>;
  try {
    thread = await input.threadStore.get(input.threadId);
  } catch {
    // Identity plumbing must not turn a read outage into new chat ceremony.
    // Proceed without attribution; no inferred or caller-supplied binding is allowed.
    return undefined;
  }
  // A persisted Review workspace is never an implementation executor. Users
  // must be able to resume a reviewer after an infrastructure failure without
  // that reviewer competing with the Desktop actor already bound to the
  // managed-work attempt. Check the stored thread identity (rather than prompt
  // text or the caller-provided id alone) so ordinary managed-work threads keep
  // the existing fail-closed binding behavior.
  if (thread && isReviewWorkspaceThreadId(thread.id)) return undefined;
  if (!thread?.backlogItemId) return undefined;

  // Kickoff is a collaborative planning surface, not implementation execution.
  // Binding its first responding cat would make later @mentions of peers fail
  // closed on the same attempt and turn an ordinary brainstorming thread into a
  // single-executor lane. The persisted SOP stage is the authority here; prompt
  // content and the requested cat must not decide work identity.
  const workflowSop = await input.workflowSopStore.get(thread.backlogItemId);
  if (workflowSop?.stage === 'kickoff') return undefined;

  const bundle = await input.workflowSopStore.bindManagedWorkAttempt(
    input.ownerUserId,
    thread.backlogItemId,
    input.executorCatId,
  );
  if (!bundle) return undefined;
  if (
    bundle.admission.ownerUserId !== input.ownerUserId ||
    bundle.admission.producerRef !== thread.backlogItemId ||
    bundle.attempt.workId !== bundle.admission.workId ||
    bundle.attempt.attemptId !== bundle.admission.initialAttemptId ||
    bundle.attempt.executorCatId !== input.executorCatId
  ) {
    throw new Error('Managed-work invocation binding failed closed: admission bundle mismatch');
  }

  return Object.freeze({
    workId: bundle.admission.workId,
    attemptId: bundle.attempt.attemptId,
  });
}

function isReviewWorkspaceThreadId(threadId: string): boolean {
  return threadId.startsWith('project-feature-review:') || threadId.startsWith('project-review-hub:');
}

async function hasReviewOrchestrationProvenance(
  messageStore: Pick<IMessageStore, 'getById'>,
  triggerMessageId: string | undefined,
): Promise<boolean> {
  if (!triggerMessageId) return false;
  try {
    const message = await messageStore.getById(triggerMessageId);
    return message?.extra?.systemKind === 'review_orchestration';
  } catch {
    // Fail closed: a provenance read outage must not manufacture an exemption.
    return false;
  }
}
