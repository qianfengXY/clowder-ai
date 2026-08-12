# Per-Turn Execution Timeline Implementation Plan

**Feature:** F254 — `docs/features/F254-side-effect-freshness-gate.md` (D2 execution glass box)
**Goal:** Put an honest, refresh-safe execution timeline inside every new assistant reply so the operator can see where each turn spends time.
**Acceptance Criteria:** F254 AC-D19; running replies auto-expand and update; completed replies collapse to a total/first-visible/carrier summary; generic providers expose only shared verified boundaries; Codex app-server exposes provider setup, warm/new carrier acquisition, and canonical lifecycle; exact tool durations require a persisted start/end pair; failed/interrupted turns stop at the last verified boundary; legacy messages never fabricate timing; no prompt, credential, tool arguments, or raw tool output appears in the timeline; `ThreadExecutionBar` remains the owner of active-turn cancel/continue controls.
**Architecture cell:** `bubble-pipeline`, `transport`
**Map delta:** none
**Map delta why:** This adds a versioned projection inside the existing message stream and reply bubble. It introduces no store, queue, transport, or lifecycle owner.
**Architecture:** Define a shared versioned timeline contract, collect verified provider-neutral milestones in `route-serial`, emit app-server preparation spans through existing status metadata, persist the terminal projection in `StoredMessage.extra`, mirror live steps into `CatInvocationInfo`, and render one reusable disclosure inside `ChatMessage` by combining system steps with safe tool-event durations.
**Tech Stack:** TypeScript, React, Zustand, Node test runner, Vitest, Testing Library
**前端验证:** Yes — golden path, running state, failed/interrupted state, and legacy timestamp-gap state in an isolated Browser Preview.

---

## Finish line

For every newly invoked cat, the reply bubble shows a live execution timeline while work is in progress and a compact persisted summary after completion. Refreshing the thread preserves the same verified steps and durations. Codex app-server cold/warm acquisition is distinguishable, tool timings are shown only when exact, and legacy/failed turns remain honest.

Not building:

- no runtime config mutation, deployment, restart, or carrier rollout;
- no replacement of `ThreadExecutionBar`, trace storage, Eval Hub, or OTel dashboards;
- no new persistence service or duplicated tool-event ledger;
- no exposure of prompt content, tool arguments, credentials, raw results, session IDs, or invocation IDs;
- no guessed durations for historical messages.

## Terminal schema

```typescript
type TurnExecutionStepKey =
  | 'request_accepted'
  | 'context_prepared'
  | 'provider_setup'
  | 'carrier_acquire_new'
  | 'carrier_acquire_warm'
  | 'child_spawned'
  | 'initialized'
  | 'thread_ready'
  | 'turn_accepted'
  | 'provider_active'
  | 'session_ready'
  | 'first_text'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'closing'
  | 'closed';

interface TurnExecutionStepV1 {
  key: TurnExecutionStepKey;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  attempt?: number;
}

interface TurnExecutionTimelineV1 {
  v: 1;
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  steps: TurnExecutionStepV1[];
}
```

Tool rows remain in the existing `toolEvents` ledger and are joined only for presentation. A tool duration is exact only when one `toolUseId` has a finite `startTimeMs` and a later finite `endTimeMs`.

## Stateful object census

No new stateful object is introduced. This plan projects three existing objects.

### Active cat invocation

Lifecycle owner: `TurnExecutionStore` / `invokeSingleCat`; live read projection: `CatInvocationInfo`.

| State | Verified event | Timeline result |
|---|---|---|
| admitted | `invocation_created` | start `request_accepted` / `context_prepared` |
| provider ready | `session_started` or provider status boundary | complete the current preparation step |
| first visible text | first non-empty text event | append `first_text` exactly once |
| terminal | done/error/interrupt truth | close the last running step and set terminal status |

Invariants:

- **INV-1:** one turn has at most one `first_text` step.
- **INV-2:** timestamps are monotonic after normalization; invalid or backward boundaries are omitted, not corrected by invention.
- **INV-3:** terminal persistence happens in the same existing message append path as the assistant reply.
- **INV-4:** live Web state is a projection; persisted message metadata is the refresh source of truth.

### Codex app-server preparation/lifecycle

Lifecycle owner: `CodexAgentService`, `CodexAppServerRunner`, and `CodexAppServerLifecycle`.

| State | Verified event | Timeline result |
|---|---|---|
| provider setup | app-server event source ready | one `provider_setup` span |
| carrier acquired | `reusedSessionHost` truth | exactly one `carrier_acquire_warm` or `carrier_acquire_new` span |
| protocol lifecycle | canonical stage transition | append/close the matching lifecycle step |
| recovery | retry attempt | retain bounded `attempt`; do not replay earlier completed spans |

Invariants:

- **INV-5:** warm/new classification comes only from `reusedSessionHost`.
- **INV-6:** setup/acquisition status metadata is bounded and contains no user content or identifiers.
- **INV-7:** observation callbacks cannot change lease, retry, interrupt, cleanup, or session semantics.

### Persisted tool events

Lifecycle owner: `MessageStore` tool-event stream.

| State | Verified event | Timeline result |
|---|---|---|
| start only | tool use with start timestamp | running row, no duration |
| paired terminal | matching result with later end timestamp | exact duration row |
| missing/invalid pair | legacy or malformed event | status/name only; omit duration |

Invariants:

- **INV-8:** UI never renders tool arguments, prompt text, credentials, or raw results in the execution disclosure.
- **INV-9:** timeline persistence never duplicates or mutates the tool ledger.

## Task 1: Freeze the shared timeline contract and reducer

**Files:**
- Add: `packages/shared/src/types/turn-execution-timeline.ts`
- Modify: `packages/shared/src/index.ts`
- Add: `packages/api/src/domains/cats/services/agents/routing/turn-execution-timeline.ts`
- Add: `packages/api/test/turn-execution-timeline.test.js`

1. Write RED tests for monotonic step closure, one-shot first text, terminal status, retry attempt, and invalid timestamp omission.
2. Run `node --test test/turn-execution-timeline.test.js` from `packages/api` and observe RED.
3. Implement the smallest pure collector/reducer and shared V1 contract.
4. Re-run the focused test to GREEN.

## Task 2: Emit app-server preparation spans without changing behavior

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts`
- Modify: `packages/api/src/domains/cats/services/agents/providers/CodexAppServerRunner.ts`
- Modify: `packages/api/test/codex-app-server-pooling.test.js`
- Modify: `packages/api/test/codex-app-server-transport.test.js`

1. Add RED tests for provider setup, warm/new acquisition, acquisition failure, and recovery attempt metadata.
2. Observe RED with the existing focused Node tests.
3. Emit bounded `executionStep` diagnostics through existing status events/callbacks using epoch timestamps and `reusedSessionHost` truth.
4. Re-run the focused tests to GREEN and prove exec-json behavior is unchanged.

## Task 3: Persist the terminal timeline with the reply

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-serial.ts`
- Modify: `packages/api/src/domains/cats/services/stores/ports/MessageStore.ts`
- Modify: `packages/api/src/routes/messages.ts`
- Add: `packages/api/test/route-serial-execution-timeline.test.js`
- Modify: `packages/api/test/messages-endpoint.test.js`

1. Add RED tests for normal text, tool-only, failed/interrupted, and message-endpoint round trips.
2. Collect invocation, session, provider status, lifecycle, first-text, and terminal boundaries in `route-serial`.
3. Store V1 under the existing message `extra`; preserve it through API serialization.
4. Re-run the focused tests to GREEN.

## Task 4: Mirror live execution state in the Web store

**Files:**
- Modify: `packages/web/src/stores/chat-types.ts`
- Modify: `packages/web/src/stores/chatStore.ts`
- Modify: `packages/web/src/hooks/useAgentMessages.ts`
- Add: `packages/web/src/hooks/__tests__/useAgentMessages-execution-timeline.test.ts`

1. Add RED tests for invocation creation, app-server preparation/lifecycle, first text, and terminal convergence in active and background threads.
2. Parse only the bounded status schema and update `CatInvocationInfo.executionTimeline`.
3. Ensure final persisted message metadata replaces, rather than forks, the live projection.
4. Re-run the focused Web tests to GREEN.

## Task 5: Render the reply-bubble disclosure

**Files:**
- Add: `packages/web/src/components/TurnExecutionTimeline.tsx`
- Add: `packages/web/src/components/turn-execution-timeline.css`
- Modify: `packages/web/src/components/ChatMessage.tsx`
- Modify: `packages/web/src/components/ChatContainer.tsx`
- Add: `packages/web/src/components/__tests__/turn-execution-timeline.test.tsx`
- Modify: `packages/web/src/components/__tests__/thread-execution-bar.test.ts`

1. Add RED component tests for running auto-expand, completed collapse/summary, warm/new labels, tool timing privacy, failure/interruption, and legacy missing timestamps.
2. Implement a semantic disclosure with existing color/spacing tokens and one-second live elapsed updates only while running.
3. Attach it to assistant replies and pending reply bubbles without moving Cancel/continue controls out of `ThreadExecutionBar`.
4. Re-run component tests to GREEN.

## Task 6: Risk-matched validation and visual acceptance

1. Format changed files with `pnpm biome check --write <changed files>`.
2. Run shared/API/Web builds and focused tests from Tasks 1–5.
3. Run `git diff --check`, architecture ownership, fallback/hotfix, generated-artifact, and root-media hygiene checks.
4. Start an isolated worktree dev stack with a non-production Redis and non-runtime ports.
5. Use Browser Preview to verify golden running/completed flow plus failed/interrupted and legacy timestamp-gap states at desktop and narrow widths.
6. Capture console/network errors and close any product-facing regressions before review.
7. Request independent exact-HEAD review, address P1/P2 findings, then enter merge gate. Do not deploy or restart runtime as part of this task.
