import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';

export type ManagedCommandWakeCarrierRetirementResult = 'retired' | 'in_flight' | 'unavailable';

export interface ManagedCommandWakeCarrierIdentity {
  readonly taskId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
  readonly messageId: string;
}

/** Legacy scheduler identity also requires exact metadata and a separately verified Queue owner. */
export function isExactManagedCommandWakeCarrierMessage(
  message: StoredMessage | null | undefined,
  expected: ManagedCommandWakeCarrierIdentity,
): message is StoredMessage {
  if (!message || message.id !== expected.messageId || message.threadId !== expected.threadId || message.catId !== null)
    return false;
  const meta = message.source?.meta;
  const legacyScheduler =
    message.userId === 'scheduler' &&
    (message.from === undefined || (message.from.kind === 'external' && message.from.connectorId === 'hold-ball'));
  const canonicalSystem = message.from?.kind === 'system' && message.from.service === 'hold-ball';
  return Boolean(
    (canonicalSystem || legacyScheduler) &&
      (message.userId === expected.userId || legacyScheduler) &&
      message.source?.connector === 'hold-ball' &&
      meta?.wakeWhen === true &&
      meta.taskId === expected.taskId &&
      meta.threadId === expected.threadId &&
      meta.catId === expected.catId,
  );
}

export function readManagedCommandWakeCarrierIdentity(
  message: StoredMessage | null | undefined,
  ownerUserId: string,
): ManagedCommandWakeCarrierIdentity | null {
  const meta = message?.source?.meta;
  if (!message || !ownerUserId || typeof meta?.taskId !== 'string' || !meta.taskId || typeof meta.catId !== 'string')
    return null;
  const identity = {
    taskId: meta.taskId,
    threadId: message.threadId,
    userId: ownerUserId,
    catId: meta.catId,
    messageId: message.id,
  };
  return isExactManagedCommandWakeCarrierMessage(message, identity) ? identity : null;
}
