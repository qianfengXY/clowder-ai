---
feature_ids: [F167, F254, F264]
topics: [managed-command, queue-custody, startup-recovery, hold-ball]
doc_kind: bug-report
created: 2026-08-29
---

# Managed-command producer deletion leaves an immortal Queue carrier

## Bug diagnosis capsule

| Field | Evidence |
| --- | --- |
| Symptom | Traqen F006 message `0001787939571995-000280-b2ec29b9` remained visible as Queue entry `739e24e3-cd9c-4b5e-9416-11bfda547614` after the command and holder invocation had both terminated. Its only target was `pending + failed`, so normal dispatch excluded it while startup kept restoring it. |
| Evidence | Runtime GET after deployment showed `status=queued`, `queuedFailedByCatIds=[cat-4v94tazw]`, no active invocation, and `paused=false`. The exact task `hold-ball-1787939455006-asekpl` returned 404. Startup logged `1 Queue owner restored`; thread history shows later single-slot `hold_ball` commands in the same thread. The deployed recovery suite passed 79/79 because it covered only tasks that still existed. |
| Root cause | Queue custody and managed-command recovery each behaved correctly inside their own store, but no transition owned producer disappearance. Missing-disposition escalation disabled the task without closing the failed Queue target; single-slot replacement could delete a prior managed-command task without first withdrawing its Queue carrier; startup treated the surviving custody as retryable even when the exact producer no longer existed. |
| Diagnostic strategy | Trace the exact source message from `ManagedCommandWakeRecoverySweep` through `createManagedCommandWakeQueueAdapter`, failed target attempts, single-slot replacement, and `QueuedMessageCustodyStartupReconciler`. Compare the task store and MessageStore at every terminal boundary; do not infer resolution from command exit, provider text, or Queue visibility alone. |
| Timeout strategy | If a reproduction cannot reach the orphan state, freeze the Queue attempt immediately after `managed_hold_disposition_missing`, remove only the isolated test task, and run startup reconciliation. Do not use sleeps or rerun the command to manufacture terminal evidence. |
| Warning strategy | A fix is invalid if it retries the completed command, marks invocation success without a typed disposition, hides only the UI row, converts an ordinary connector, or deletes the producer before durable carrier terminalization. |
| User-visible correction | A replaced or irrecoverable managed-command wake leaves a terminal withdrawn/failed receipt instead of an actionable Queue row. Existing historical taskless carriers converge on the next startup without direct production-data surgery. |
| Acceptance | RED covers failed-disposition escalation, single-slot replacement, taskless startup recovery, processing-race preservation, and ordinary-connector isolation. GREEN requires the exact carrier to terminalize idempotently while preserving its failed attempt and never invoking the command again. |

## Report

1. **Reporter:** co-creator, from the live Traqen F006 backlog thread.
2. **Reproduction:** persist a managed-hold wake message with one failed target attempt and no typed
   disposition; remove its exact dynamic task; run startup custody reconciliation. Before the fix the
   message is restored as a Queue owner even though no recovery sweep can enumerate it.
3. **Root cause:** producer task retirement and Queue-carrier terminalization were separate best-effort
   actions with no fail-closed ordering. The surviving half became neither executable nor terminal.
4. **Fix direction:** add one exact carrier-retirement port to the existing managed-command recovery
   boundary; use it before escalation or replacement removes the task, and use the same typed
   provenance predicate during startup to terminalize historical taskless carriers.
5. **Verification:** targeted RED→GREEN tests, the existing 79-test managed-hold/Queue suite, repository
   `pnpm check`, exact-HEAD independent review, and isolated acceptance after merge. Deployment and
   runtime restart remain separately authorized operations.
