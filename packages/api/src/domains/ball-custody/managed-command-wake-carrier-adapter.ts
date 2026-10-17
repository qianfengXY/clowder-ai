import type { DynamicTaskStore } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import type { InvocationQueue } from '../cats/services/agents/invocation/InvocationQueue.js';
import type { IInvocationRecordStore } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import {
  isExactManagedCommandWakeCarrierMessage,
  readManagedCommandWakeCarrierIdentity,
} from './managed-command-wake-carrier-retirement.js';
import {
  type ManagedCommandWakeRecoveryDeps,
  resolveManagedCommandWakeEventCarrier,
} from './managed-command-wake-lifecycle.js';

interface ManagedCommandWakeCarrierAdapterDeps {
  readonly messageStore: Pick<IMessageStore, 'getById' | 'markCanceled'>;
  readonly invocationRecordStore: Pick<IInvocationRecordStore, 'get'>;
  readonly invocationQueue: Pick<
    InvocationQueue,
    | 'getDurableEntriesForMessages'
    | 'claimQueuedEntryForWithdrawal'
    | 'commitClaimedWithdrawal'
    | 'restoreClaimedEntries'
  >;
}

/** Observe Task producer truth before startup makes a persisted Queue scope runnable. */
export async function retireOrphanManagedCommandWakeCarriers(
  deps: ManagedCommandWakeCarrierAdapterDeps & {
    invocationQueue: Pick<InvocationQueue, 'listScopes' | 'list'> &
      ManagedCommandWakeCarrierAdapterDeps['invocationQueue'];
    dynamicTaskStore: Pick<DynamicTaskStore, 'getById'>;
  },
): Promise<number> {
  const adapter = createManagedCommandWakeCarrierAdapter(deps);
  let retired = 0;
  for (const { threadId, userId } of deps.invocationQueue.listScopes()) {
    for (const entry of deps.invocationQueue.list(threadId, userId)) {
      if (entry.status !== 'queued' || entry.targets.length !== 1 || !entry.payload.messageId) continue;
      const source = await deps.messageStore.getById(entry.payload.messageId);
      const identity = readManagedCommandWakeCarrierIdentity(source, userId);
      if (!identity || identity.catId !== entry.targets[0]) continue;
      // An unavailable producer read is not evidence of absence: fail startup closed before any drain.
      if (deps.dynamicTaskStore.getById(identity.taskId)) continue;
      const outcome = await adapter.retireEventCarrier!(identity);
      if (outcome !== 'retired') throw new Error(`Orphan managed wake retirement is pending: ${identity.messageId}`);
      retired++;
    }
  }
  return retired;
}

/**
 * Resolve managed-command delivery from its canonical owners:
 * Queue only proves an exact target is still pending; once delivered, the
 * source dispatchRef and response bubble in History own every later state.
 */
export function createManagedCommandWakeCarrierAdapter(
  deps: ManagedCommandWakeCarrierAdapterDeps,
): Pick<ManagedCommandWakeRecoveryDeps, 'getEventCarrier' | 'retireEventCarrier'> {
  return {
    retireEventCarrier: async (identity) => {
      const { threadId, userId, catId, messageId } = identity;
      const message = await deps.messageStore.getById(messageId);
      if (!isExactManagedCommandWakeCarrierMessage(message, identity)) return 'unavailable';
      const ref = message.lifecycle?.dispatchRefs?.find((candidate) => candidate.targetId === catId);
      if (ref) {
        const response = await deps.messageStore.getById(ref.statusMessageId);
        if (!response || response.threadId !== threadId || response.userId !== userId) return 'unavailable';
        const state = response?.lifecycle;
        if (state?.kind === 'response' && state.targetId === catId && state.inputMessageIds.includes(messageId))
          return state.status === 'processing' ? 'in_flight' : 'retired';
        if (
          state?.kind === 'delivery_failure' &&
          state.inputMessageId === messageId &&
          state.requestedTargets.includes(catId)
        )
          return 'retired';
        return 'unavailable';
      }
      const entries =
        (await deps.invocationQueue.getDurableEntriesForMessages(threadId, [messageId])).get(messageId) ?? [];
      if (entries.length === 0) return message.deliveryStatus === 'canceled' ? 'retired' : 'unavailable';
      if (entries.length !== 1) return 'unavailable';
      const row = entries[0]!;
      const matches = (entry: typeof row) =>
        entry.threadId === threadId &&
        entry.owner.kind === 'user' &&
        entry.owner.userId === userId &&
        entry.payload.messageId === messageId &&
        entry.targets.length === 1 &&
        entry.targets[0] === catId;
      if (!matches(row)) return 'unavailable';
      const claimed = await deps.invocationQueue.claimQueuedEntryForWithdrawal(threadId, userId, row.id);
      if (!claimed) return 'in_flight';
      try {
        if (!matches(claimed)) {
          await deps.invocationQueue.restoreClaimedEntries(threadId, [row.id]);
          return 'unavailable';
        }
        const canceled = await deps.messageStore.markCanceled(messageId);
        if (!canceled) throw new Error('Managed wake source cancellation is unavailable');
        const committed = await deps.invocationQueue.commitClaimedWithdrawal(threadId, row.id);
        if (!committed) throw new Error('Managed wake withdrawal claim changed');
        return 'retired';
      } catch {
        await deps.invocationQueue.restoreClaimedEntries(threadId, [row.id]);
        return 'unavailable';
      }
    },
    getEventCarrier: async ({ threadId, userId, catId, messageId }) => {
      const message = await deps.messageStore.getById(messageId);
      const refs =
        message?.lifecycle && 'dispatchRefs' in message.lifecycle ? (message.lifecycle.dispatchRefs ?? []) : [];
      const matchingRef = refs.find((ref) => ref.targetId === catId);
      const response = matchingRef ? await deps.messageStore.getById(matchingRef.statusMessageId) : null;
      let pendingTarget = false;
      if (!matchingRef) {
        const entries = (await deps.invocationQueue.getDurableEntriesForMessages(threadId, [messageId])).get(messageId);
        pendingTarget =
          entries?.some(
            (entry) =>
              entry.owner.kind === 'user' &&
              entry.owner.userId === userId &&
              entry.threadId === threadId &&
              entry.targets.includes(catId),
          ) ?? false;
      }
      const legacyIdentity = readManagedCommandWakeCarrierIdentity(message, userId);
      const legacyOwnerProven =
        pendingTarget || Boolean(response && response.threadId === threadId && response.userId === userId);
      const observedMessage =
        message && message.userId === 'scheduler' && legacyIdentity?.catId === catId && legacyOwnerProven
          ? { ...message, userId }
          : message;
      const carrier = resolveManagedCommandWakeEventCarrier(observedMessage, response, pendingTarget, {
        threadId,
        userId,
        catId,
      });
      if (carrier.state !== 'failed' || !carrier.invocationId) return carrier;
      const invocation = await deps.invocationRecordStore.get(carrier.invocationId);
      return {
        ...carrier,
        ...(invocation?.status === 'failed' && invocation.error ? { errorCode: invocation.error } : {}),
      };
    },
  };
}
