---
feature_ids: [F275]
topics: [managed-work, a2a, codex, cancellation]
doc_kind: bug-report
created: 2026-09-07
tips_exempt: restores existing peer dispatch and cancellation semantics; no new user action or configuration
---

# Peer dispatch conflicts with parent execution ownership

## Diagnosis capsule

| Field | Evidence |
| --- | --- |
| Symptom | A peer cannot start after a parent implementation executor is bound. Separately, a replacement turn can fail while the cancelled native-session host is still draining. |
| Evidence | Runtime emits `MANAGED_WORK_EXECUTOR_CONFLICT` before provider invocation for the peer. A preempting continuation emits `already has an active host lease`. Persisted delivery and queued-body exposure precede these failures and do not prove successful execution. |
| Root cause | Invocation attribution treats an authenticated peer handoff as a claim to the parent attempt. Host acquisition treats an aborted predecessor lease as an ordinary duplicate instead of waiting for retirement. |
| Diagnostic strategy | Correlate persisted trigger, invocation failure, executor admission, and host lease; reproduce through the real invocation entry and the host pool with gated host exit. |
| Timeout strategy | Preserve failed queue receipts and original messages; inspect exact terminal evidence before retrying. Do not reset rate limits, archive native sessions, or transfer the parent executor to make dispatch pass. |
| Warning strategy | An untrusted causal id must not grant a peer exemption. Cancellation must not permit two native-session writers or start a replacement after its own cancellation. Task closure must consume task status, not an ordinary A2A completion receipt. |

## Reproduction and correction

1. **Reporter:** operator reports a stuck peer and a queue item with no response.
2. **Reproduce:** bind a workflow implementation attempt to a lead cat, persist a same-owner targeted A2A message to another cat, and invoke the peer. For host acquisition, abort a leased native session, start its successor, and delay predecessor host exit.
3. **Expected:** the peer reaches its provider without replacing or acquiring the parent work identity. A successor waits for the exact old writer to exit. An active, uncancelled duplicate remains rejected.
4. **Correction:** pass the server-owned A2A trigger separately from causal metadata; verify its persisted message id, owner, destination, author, and target. Exempt only a peer of an already bound cat executor. Preserve external executor enforcement, admission identity checks, and atomic binding races. Retire an aborted host through the existing lease-release and actual-host-exit path.
5. **Verification:** the original regression run produced 12 failures. Independent review reproduced a late cancellation during host exit; the initial correction passed 119 tests on its original base. On the updated integration base, review found another cancelled successor waiting behind acquisition ownership. The resulting six failing regression cases cover queued cancellation, pre-cancelled cold/warm acquisition, cancellation during spawn/connection, dead-host reaping, and dead-on-arrival cleanup. Final-head build, regression counts, and independent verdict belong in the PR evidence.

### Cancellation invariant

An acquisition must still be live after every asynchronous boundary before it starts a writer or returns a provider connection. Queue ownership, dead-host cleanup, retirement, spawn, and connection can each outlive the requesting invocation. Check both pool shutdown and invocation cancellation at those boundaries. If a host or connection was already acquired when cancellation arrived, close that exact resource before rejecting; never leave an unleased spawned host or return a cancelled lease. Keep source-host exit fencing and release the acquisition queue so a later live request can recover normally.

## Risk and acceptance

- Behavior: medium; two existing invocation lifecycle boundaries change.
- Data: no schema, persistence policy, or user-data mutation.
- Security: no authentication or authority grant change; persisted provenance must continue to fail closed. External executor ownership is preserved.
- Contract: no public API, task authority, or callback completion contract change.
- Irreversible: none in the code patch. Runtime activation is a separate authorized action.
- Architecture cells: invocation attribution and Codex host lifecycle; map delta none, existing owners and stores remain authoritative.
- Independent validation: local peer review for parent/child attribution and asynchronous writer lifetime. Targeted API compilation and behavioral regressions cover the changed surfaces.
- Runtime acceptance remains pending: load the merged patch into a new authorized runtime instance, confirm the peer reaches its provider, and let the original task owner close its completed validation task through the canonical task API. Delivery, a green unit suite, or ordinary dispatch completion alone cannot close this recovery.

No product-project code, test results, or private incident payload is copied into this report.

## Operator direct-call follow-up

The operator reported that directly addressing a participating cat still failed after the peer-dispatch correction was loaded. A fresh process, runtime source/dist, and the failed invocation stack confirmed this was a separate ingress gap, not a stale deployment.

| Field | Evidence and disposition |
| --- | --- |
| Symptom | An owner directly calls a coordinating or reviewing cat in an implementation thread already bound to another cat; the call fails before provider startup. |
| Evidence | The ordinary user-message path supplies a persisted causal message id, not an A2A trigger. The resolver reaches `bindManagedWorkAttempt` and raises `MANAGED_WORK_EXECUTOR_CONFLICT`. |
| Root cause | Conversation participation was separated from parent implementation attribution only for cat-authored A2A triggers. The same distinction was omitted for authenticated owner-authored direct messages. |
| Diagnostic strategy | Reproduce the actual `invokeSingleCat` owner path without A2A metadata, and test persisted source provenance plus admission identity independently. |
| Timeout strategy | Preserve original messages, attempts, and failed receipts. Do not rebind the parent executor or manufacture an A2A source to make a user call pass. |
| Warning strategy | A working cross-thread wake proves only the A2A path. Direct owner calls require their own provider and visible-response evidence. |
| User-visible correction | The owner can directly address another participating cat without that conversation acquiring or replacing the parent's implementation identity. |
| Acceptance | Same-source RED→GREEN, unchanged A2A/admission/consumer regressions, independent review, and a new live direct-owner invocation with a visible reply. |

The correction recognizes only strict owner provenance and an exact persisted user message matching owner, thread, and resolved mention target. It rejects A2A-shaped user sources and connector, scheduler, or system carriers from this owner-only path. Prompt text grants no implementation identity. The existing admission checks, incumbent continuation, unbound atomic binding, and external Desktop executor enforcement remain authoritative; no public contract or persistent ownership record changes.

The initial isolated build succeeded, then the new regression run failed 5 of 27 tests: the real owner invocation, owner participation/prose cases, and admission read/identity error propagation. The existing A2A invocation and negative provenance/ownership cases passed. Final GREEN counts and exact-head independent verdict belong in the PR evidence. Live direct-call acceptance remains pending until the new correction is loaded and exercised.

The isolated HTTP acceptance sends an owner-authenticated `POST /api/messages` through the real `AgentRouter` and `invokeSingleCat`, using in-memory stores and a fake provider. It verifies a successful child execution, a reply readable through `GET /api/messages`, exact source identity without A2A or parent work attribution, and unchanged incumbent ownership. The same test fails on the pre-correction resolver before provider startup and passes with the correction. This exercises application ingress and persistence within the test process; it does not claim a native provider or the live conversation has recovered.

## Unmentioned owner reply follow-up (2026-10-19)

The owner reported the same conflict while submitting a free-text answer to a native async question card. Read-only runtime evidence showed that the prior explicit mention reached its provider, while the new answer repeatedly failed before child invocation creation. The runtime stack reached the current resolver, whose compiled owner predicate still required a mention; this was a distinct ingress gap rather than evidence of a missing deployment.

The canonical conversation fallback selects a Queue recipient for an unmentioned reply, while message ingress intentionally preserves an empty `mentions` array. Requiring `mentions.includes(executorCatId)` in the invocation resolver misclassified that ordinary conversation as a competing implementation executor. Interactive answers and plain unmentioned replies share this mechanism.

The correction accepts an exact persisted owner message with no explicit mentions, after verifying canonical sender identity through `messageFrom`. Explicit mentions of another participant, foreign owners/threads, missing provenance, system/plugin/connector carriers, external Desktop ownership, identity mismatches, and unbound executor races remain rejected by the existing boundaries. The conversation receives no parent work binding and changes no persisted attempt or Queue source.

Architecture cell: managed-work. Map delta: none; the invocation resolver remains the attribution owner and reuses the canonical sender resolver.

- Canonical source: `packages/api/src/domains/cats/services/stores/message-from.ts#messageFrom` and `agents/invocation/managed-work-invocation-binding.ts#isPersistedOwnerTrigger`.
- Consumer evidence: `rg -n 'resolveManagedWorkInvocationBinding|isPersistedOwnerTrigger' packages/api/src` identifies the single production caller in `invoke-single-cat.ts`. `AgentRouter.resolveSendTargets` and `messagesRoutes` preserve the distinction between admitted recipients and source mentions; both serial and parallel routes use that invocation entry.
- Claim guard: `managed-work-operator-invocation.test.js` rejects invalid provenance and conflicting ownership; its unmentioned-owner case fails with the original `ManagedWorkExecutorConflictError` and passes after this correction. `managed-work-owner-http.test.js` sends both an explicit mention and a mention-free card answer through real HTTP admission, conversation fallback, Queue processing, provider startup, and reloadable History, with the incumbent bundle unchanged.

Validation uses an isolated feature checkout, in-memory stores, sandboxed configuration, and a fake provider. Live acceptance still requires an authorized runtime activation and successful handling of the original queued answer; neither compilation nor these isolated checks proves that live recovery.
