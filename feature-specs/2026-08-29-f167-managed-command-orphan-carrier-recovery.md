# F167 Managed-command Orphan Carrier Recovery Implementation Plan

**Feature:** F167 — `docs/features/F167-a2a-chain-quality.md`
**Goal:** Ensure every terminal or replaced managed command converges its exact Queue carrier without replaying the completed command, including historical carriers whose producer task is already absent.
**Acceptance Criteria:** AC-MCO-1 escalation retires the failed carrier before disabling its task; AC-MCO-2 single-slot replacement retires queued/failed carriers and preserves in-flight ownership; AC-MCO-3 startup terminalizes exact taskless managed-hold carriers without touching ordinary connectors or live work; AC-MCO-4 all transitions are revision-fenced, idempotent, receipt-preserving, and command-replay-free.
**Architecture cell:** `ball-custody` + `dispatch`
**Map delta:** none
**Map delta why:** The repair connects terminal transitions already owned by managed-command recovery and Queue custody; it adds no store, Queue, receipt, lifecycle object, or ownership edge.
**Architecture:** Extend the existing managed-command Queue adapter with one exact carrier-retirement operation. Producer retirement calls that operation before disabling or deleting a task; startup uses the same server-authored source predicate plus task absence after child recovery to close historical orphans. InvocationQueue remains a live projection and MessageStore custody remains restart truth.
**Tech Stack:** TypeScript, Node.js test runner, Redis-backed MessageStore, SQLite DynamicTaskStore
**前端验证:** No — the observable surface is the existing Queue/receipt API; targeted API and startup tests cover it.

---

## Finish line

For an exact managed-hold `wakeWhen` source, there is no reachable state in which the command has
already run, its producer task is absent or terminal, and the same target remains an actionable Queue
owner. Cleanup preserves the failed attempt and produces terminal custody; it never reruns the command
or invents invocation success. We are not building a new lifecycle ledger, generic orphan collector,
periodic MessageStore scan, or UI-only filter.

## Stateful-object gate

### Census and ownership

| Object | Authoritative owner | Persistence | Role in this repair |
| --- | --- | --- | --- |
| `DynamicTaskDef.params.holdLifecycle.managedCommand` | F167 `ball-custody` / `ManagedCommandWakeRecoverySweep` | SQLite, TTL=0 lifecycle tombstone while retained | Producer identity, command terminal evidence, recovery eligibility |
| `StoredMessage.queueCustody` and `targetAttempts` | F254/F264 `dispatch` / MessageStore | Redis, TTL=0 | Exact carrier, failed-attempt history, terminal withdrawal truth |
| `InvocationQueue` entry | F175 `dispatch` | Process-local derived projection | Scheduling only; removed after durable custody commits and rebuilt only from nonterminal custody |
| Active managed runner | callback hold route | Process-local | Command process only; never evidence that Queue custody is handled |

No new state is persisted. “Orphan managed-command carrier” is a pure predicate over typed message
source, task existence, custody target state, and restart-reconciled child truth.

### State × event transitions

| Producer task | Queue target | Event | Required next state |
| --- | --- | --- | --- |
| active | failed after first missing disposition | recovery retry available | Append one exact retry attempt; keep task active |
| active | failed after bounded retry | escalation | Withdraw/terminalize exact target first, then mark task escalated and disabled |
| active | queued or failed | same-slot replacement | Withdraw exact carrier first, then unregister/remove old task and launch replacement |
| active | processing with live child | same-slot replacement | Keep old task until the current child settles; new hold may exist, but old custody is not withdrawn early |
| active | no published message | same-slot replacement | Cancel/remove old task; no Queue carrier exists to retire |
| missing | nonterminal exact managed-hold custody after restart child reconciliation | startup recovery | Terminal withdrawn/failed receipt; no InvocationQueue restoration |
| present | nonterminal exact managed-hold custody | startup recovery | Preserve normal managed-command recovery ownership |
| missing | ordinary/malformed connector custody | startup recovery | Preserve existing generic Queue reconciliation; never infer managed-command authority |
| any | already terminal/withdrawn custody | duplicate retirement/restart | Idempotent no-op success |

### Invariants

- **INV-1:** A producer task cannot be disabled or deleted while its exact managed-command Queue target
  remains actionable, unless a live child currently owns settlement.
- **INV-2:** Carrier retirement never launches a provider or reruns the managed command.
- **INV-3:** Queue custody commits before process-local Queue removal becomes final; CAS conflict or
  store failure preserves/retries the old owner.
- **INV-4:** Missing-disposition escalation is terminal only after exact carrier retirement succeeds.
- **INV-5:** Startup orphan classification requires `connector=hold-ball`, `wakeWhen=true`, a non-empty
  exact `taskId`, missing task truth, and no restart-surviving live child.
- **INV-6:** Failed attempts remain append-only receipt history; withdrawal adds terminal truth without
  rewriting an invocation to success.
- **INV-7:** Duplicate replacement, escalation, or startup passes converge idempotently.
- **INV-8:** Ordinary connectors, wait carriers, action-successor carriers, and malformed sources retain
  their existing lifecycle.

### Adversarial scenarios

- Crash after Queue withdrawal but before task removal: startup sees terminal custody and does not
  restore it; later task recovery consumes/disables the same producer idempotently.
- Crash after a replacement task is registered but before old-task cleanup: both producer tasks may
  temporarily survive (the existing safer single-slot failure mode), but the old task still owns its
  carrier and cannot become taskless.
- Queue CAS changes while replacement attempts retirement: retirement reports pending/unavailable,
  the new task is rolled back, and the old task remains recoverable.
- Replacement arrives while the old carrier is processing: no early withdrawal; the exact child and
  stop gate retain settlement authority.
- Startup sees a taskless failed carrier and an adjacent ordinary connector: only the exact managed-hold
  message terminalizes; the ordinary connector is restored normally.
- A forged `taskId` appears on a non-hold connector or mismatched thread/target: retirement fails closed.
- Startup/recovery runs twice: the second pass produces no additional attempt or status transition.

## Tasks

### Task 1: Pin carrier retirement at the recovery boundary

**Files:**

- Modify: `packages/api/test/managed-command-wake-queue-adapter.test.js`
- Modify: `packages/api/test/managed-command-wake-recovery-sweep.test.js`
- Modify: `packages/api/src/domains/ball-custody/managed-command-wake-lifecycle.ts`
- Modify: `packages/api/src/domains/ball-custody/managed-command-wake-queue-adapter.ts`
- Modify: `packages/api/src/domains/ball-custody/managed-command-wake-recovery-policy.ts`
- Modify: `packages/api/src/domains/ball-custody/ManagedCommandWakeRecoverySweep.ts`

1. Add RED tests for exact failed-carrier retirement, active-processing refusal, malformed-source
   rejection, and escalation that must not disable the task when retirement fails.
2. Run `node --test packages/api/test/managed-command-wake-queue-adapter.test.js packages/api/test/managed-command-wake-recovery-sweep.test.js`; expect the new cases to fail because no retirement port exists.
3. Add a typed `retireEventCarrier` port. Validate task/message/thread/user/target identity, use Queue
   custody CAS and the existing Queue removal seam, and return explicit retired/in-flight/pending truth.
4. Make bounded missing-disposition escalation call the retirement port before writing `escalated` and
   disabling the task.
5. Re-run the focused command; expect all cases to pass.

### Task 2: Make single-slot replacement fail closed

**Files:**

- Modify: `packages/api/test/callback-hold-ball-route-scheduling.test.js`
- Modify: `packages/api/src/routes/callback-hold-ball-routes.ts`

1. Add RED cases proving queued/failed prior carrier retirement precedes task deletion, an in-flight
   prior task is retained, and retirement failure rolls back the newly registered hold.
2. Run `node --test packages/api/test/callback-hold-ball-route-scheduling.test.js`; expect the new cases
   to expose unconditional prior-task deletion.
3. Route prior managed-command tasks through the recovery retirement method before cancellation/removal.
   Preserve the existing “new task registered first” availability guarantee, but roll the new task back
   when durable prior retirement cannot be established.
4. Re-run the focused test; expect all replacement and atomic-rollback cases to pass.

### Task 3: Converge historical taskless carriers at startup

**Files:**

- Modify: `packages/api/test/f254-queue-restart-custody.test.js`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupTypes.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupMessageReconciler.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/StartupReconciler.ts`
- Modify: `packages/api/src/index.ts`

1. Add a RED startup case matching F006: exact managed-hold source, failed attempt, absent task, no live
   child. Assert terminal custody, preserved attempt, zero Queue restoration, and no trigger call.
2. Add adjacent negative cases for a present task and an ordinary connector with a task-like meta field.
3. Run `node --test packages/api/test/f254-queue-restart-custody.test.js`; expect the orphan case to
   restore one Queue owner before implementation.
4. Inject read-only `DynamicTaskStore.getById` into startup reconciliation. Before Queue projection,
   terminalize only the exact typed taskless managed-hold target using the existing withdrawal transition.
5. Re-run the focused test; expect all startup cases to pass.

### Task 4: Update ownership evidence and verify the full repair

**Files:**

- Modify: `docs/architecture/ownership/cells/ball-custody.md`
- Modify: `docs/architecture/ownership/cells/dispatch.md`

1. Add cited-by deltas describing producer-retirement ordering and taskless startup convergence; do not
   change cell ownership or create a new diagram.
2. Run the focused regression set:
   `node --test packages/api/test/managed-hold-disposition.test.js packages/api/test/managed-command-wake-queue-adapter.test.js packages/api/test/managed-command-wake-recovery-sweep.test.js packages/api/test/callback-hold-ball-route-scheduling.test.js packages/api/test/f254-queue-restart-custody.test.js`.
3. Run `pnpm check`; expect exit 0. This is the repository-confirmed terminal formatting/type/lint gate.
4. Run `git diff --check` and inspect the exact diff for new stores, command replay, runtime-config edits,
   and unrelated files; expect none.
5. Commit the exact candidate, push it to `fork`, open a PR, and obtain non-author exact-HEAD review
   before merge. Deployment/restart is excluded until separately authorized.
