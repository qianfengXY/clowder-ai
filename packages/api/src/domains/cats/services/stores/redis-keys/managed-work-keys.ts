import { createHash } from 'node:crypto';

const WORKFLOW_SOP_PRODUCER = 'workflow_sop_v1';

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function deriveWorkflowSopAdmissionIds(
  ownerUserId: string,
  backlogItemId: string,
): {
  workId: string;
  attemptId: string;
} {
  const workDigest = digest([ownerUserId, WORKFLOW_SOP_PRODUCER, backlogItemId]);
  const workId = `wrk_${workDigest.slice(0, 32)}`;
  const attemptDigest = digest([workId, 'attempt', '1']);
  return { workId, attemptId: `wat_${attemptDigest.slice(0, 32)}` };
}

export function deriveManagedWorkAttemptId(workId: string, attemptNumber: number): string {
  const attemptDigest = digest([workId, 'attempt', String(attemptNumber)]);
  return `wat_${attemptDigest.slice(0, 32)}`;
}

export const ManagedWorkKeys = {
  admission: (workId: string) => `managed-work:admission:${workId}`,
  attempt: (attemptId: string) => `managed-work:attempt:${attemptId}`,
  consumerState: (consumerId: string, workId: string) => `managed-work:consumer:${consumerId}:state:${workId}`,
  consumerEvidence: (consumerId: string, workId: string) =>
    `managed-work:consumer:${consumerId}:evidence:${workId}`,
  consumerReceipt: (consumerId: string, workId: string, operation: string, idempotencyKey: string) =>
    `managed-work:consumer:${consumerId}:receipt:${workId}:${operation}:${idempotencyKey}`,
} as const;
