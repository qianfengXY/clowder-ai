import type { CatId } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { settleQueueCustodyWithdrawal } from '../cats/services/stores/ports/queued-message-custody.js';

export type ManagedCommandWakeCarrierRetirementResult = 'retired' | 'in_flight' | 'unavailable';

export interface ManagedCommandWakeCarrierIdentity {
  readonly taskId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
  readonly messageId: string;
}

function optionalMetaMatches(value: unknown, expected: string): boolean {
  return value === undefined || value === expected;
}

/**
 * Bind a scheduler-authored managed wake to one exact task, Queue owner, source
 * message, and target. The Queue carrier is deliberately single-target: a
 * retirement must never withdraw a coalesced sibling as collateral damage.
 */
export function isExactManagedCommandWakeCarrierMessage(
  message: StoredMessage | null | undefined,
  expected: ManagedCommandWakeCarrierIdentity,
): message is StoredMessage {
  const custody = message?.queueCustody;
  const meta = message?.source?.meta;
  return Boolean(
    message &&
      message.id === expected.messageId &&
      message.threadId === expected.threadId &&
      message.userId === 'scheduler' &&
      message.catId === null &&
      message.source?.connector === 'hold-ball' &&
      meta?.wakeWhen === true &&
      meta.taskId === expected.taskId &&
      optionalMetaMatches(meta.threadId, expected.threadId) &&
      optionalMetaMatches(meta.catId, expected.catId) &&
      custody &&
      custody.entryId.length > 0 &&
      custody.ownerUserId === expected.userId &&
      custody.allTargetCats.length === 1 &&
      custody.allTargetCats[0] === expected.catId,
  );
}

/** Strict startup classifier: historical orphan recovery has no task-side truth. */
export function readManagedCommandWakeCarrierIdentity(
  message: StoredMessage | null | undefined,
): ManagedCommandWakeCarrierIdentity | null {
  const meta = message?.source?.meta;
  const custody = message?.queueCustody;
  if (
    !message ||
    message.userId !== 'scheduler' ||
    message.catId !== null ||
    message.source?.connector !== 'hold-ball' ||
    meta?.wakeWhen !== true ||
    typeof meta.taskId !== 'string' ||
    typeof meta.threadId !== 'string' ||
    typeof meta.catId !== 'string' ||
    meta.threadId !== message.threadId ||
    !custody?.ownerUserId
  ) {
    return null;
  }
  const identity = {
    taskId: meta.taskId,
    threadId: meta.threadId,
    userId: custody.ownerUserId,
    catId: meta.catId,
    messageId: message.id,
  };
  return isExactManagedCommandWakeCarrierMessage(message, identity) ? identity : null;
}

/**
 * Commit the durable half of managed-wake retirement. Callers that also own a
 * process-local Queue row must freeze that exact snapshot before entering here.
 */
export async function retireManagedCommandWakeCarrierCustody(
  messageStore: Pick<IMessageStore, 'transitionQueueCustody'>,
  message: StoredMessage,
  identity: ManagedCommandWakeCarrierIdentity,
  retiredAt: number,
): Promise<Exclude<ManagedCommandWakeCarrierRetirementResult, 'in_flight'>> {
  if (!isExactManagedCommandWakeCarrierMessage(message, identity)) return 'unavailable';
  const custody = message.queueCustody;
  if (!custody) return 'unavailable';
  if (
    custody.status === 'terminal' &&
    custody.withdrawnByCatIds?.includes(identity.catId as CatId) &&
    message.deliveryStatus !== 'queued'
  ) {
    return 'retired';
  }
  if (message.deliveryStatus !== 'queued' || !custody.pendingTargetCats.includes(identity.catId as CatId)) {
    return 'unavailable';
  }
  const next = settleQueueCustodyWithdrawal(custody, [identity.catId], retiredAt);
  if (next === custody || next.status !== 'terminal') return 'unavailable';
  const result = await messageStore.transitionQueueCustody(message.id, {
    expectedRevision: custody.revision,
    next,
    deliveredAt: retiredAt,
  });
  return result.kind === 'updated' ? 'retired' : 'unavailable';
}
