import type { CatId, ManagedWorkBinding, WorkflowSopAdmissionBundle } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
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
  /** Server-owned A2A source; ordinary causal/reply ids do not grant peer scope. */
  a2aTriggerMessageId?: string;
  threadStore: IThreadStore | null;
  workflowSopStore?: IWorkflowSopStore;
}): Promise<ManagedWorkBinding | undefined> {
  if (input.ownerAuthProvenance !== 'strict' || !input.threadStore || !input.workflowSopStore) return undefined;

  // Review orchestration is server-authored reviewer work, not implementation
  // ownership. Its persisted provenance is minted only by canonical message
  // ingress, so it is safe to exempt without trusting prompt text or callers.
  const trigger = await readTriggerMessage(input.messageStore, input.a2aTriggerMessageId ?? input.triggerMessageId);
  if (trigger?.extra?.systemKind === 'review_orchestration') return undefined;

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

  // A peer's authenticated handoff is not a request to replace the parent
  // executor. Keep its invocation unattributed to that attempt. Incumbent
  // continuations still bind normally; Desktop ownership and unbound races
  // retain the existing atomic, fail-closed path.
  if (await isPeerOfBoundExecutor(trigger, input, thread.backlogItemId, input.workflowSopStore)) return undefined;

  const bundle = await input.workflowSopStore.bindManagedWorkAttempt(
    input.ownerUserId,
    thread.backlogItemId,
    input.executorCatId,
  );
  if (!bundle) return undefined;
  assertAdmissionIdentity(bundle, input.ownerUserId, thread.backlogItemId);
  if (bundle.attempt.executorCatId !== input.executorCatId) {
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

function assertAdmissionIdentity(bundle: WorkflowSopAdmissionBundle, ownerUserId: string, backlogItemId: string): void {
  if (
    bundle.admission.ownerUserId !== ownerUserId ||
    bundle.admission.producerKind !== 'workflow_sop_v1' ||
    bundle.admission.producerRef !== backlogItemId ||
    bundle.attempt.workId !== bundle.admission.workId ||
    bundle.attempt.attemptId !== bundle.admission.initialAttemptId ||
    bundle.attempt.attemptNumber !== 1
  ) {
    throw new Error('Managed-work invocation binding failed closed: admission bundle mismatch');
  }
}

type PeerTriggerScope = {
  a2aTriggerMessageId?: string;
  ownerUserId: string;
  threadId: string;
  executorCatId: CatId;
};

async function isPeerOfBoundExecutor(
  trigger: StoredMessage | null,
  input: PeerTriggerScope,
  backlogItemId: string,
  store: IWorkflowSopStore,
): Promise<boolean> {
  if (!isPersistedPeerTrigger(trigger, input)) return false;
  const bundle = await store.getManagedWorkAdmission(input.ownerUserId, backlogItemId);
  if (!bundle) return false;
  assertAdmissionIdentity(bundle, input.ownerUserId, backlogItemId);
  const actor = bundle.attempt.executorActor;
  const incumbentCatId = actor ? (actor.kind === 'cat' ? actor.catId : undefined) : bundle.attempt.executorCatId;
  return Boolean(incumbentCatId && incumbentCatId !== input.executorCatId);
}

function isPersistedPeerTrigger(message: StoredMessage | null, input: PeerTriggerScope): boolean {
  return Boolean(
    input.a2aTriggerMessageId &&
      message?.id === input.a2aTriggerMessageId &&
      message.userId === input.ownerUserId &&
      message.threadId === input.threadId &&
      message.catId &&
      (message.catId !== input.executorCatId ||
        (message.extra?.crossPost?.sourceThreadId && message.extra.crossPost.sourceThreadId !== message.threadId)) &&
      (message.mentions.includes(input.executorCatId) || message.extra?.targetCats?.includes(input.executorCatId)),
  );
}

async function readTriggerMessage(
  messageStore: Pick<IMessageStore, 'getById'>,
  triggerMessageId: string | undefined,
): Promise<StoredMessage | null> {
  if (!triggerMessageId) return null;
  try {
    return await messageStore.getById(triggerMessageId);
  } catch {
    // Fail closed: a provenance read outage must not manufacture an exemption.
    return null;
  }
}
