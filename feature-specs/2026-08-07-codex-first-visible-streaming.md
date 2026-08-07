# Codex First-Visible Streaming Implementation Plan

**Feature:** F254 — `docs/features/F254-side-effect-freshness-gate.md`（AC-D14 carrier parity）+ F153 — `docs/features/F153-observability-infra.md`（descriptive telemetry）
**Goal:** Make Codex app-server text deltas visible immediately, reconcile them to one canonical completed reply, and measure first-visible latency without changing the default carrier.
**Acceptance Criteria:** F254 AC-D14 carrier parity/no-replay remains intact; F153 observability remains descriptive; `item/agentMessage/delta` reaches the existing `AgentMessage(type=text)` stream; `item/completed` never duplicates streamed prose and remains the canonical reconciliation source; exactly one runtime-canonical signature remains after successful completion; first-visible latency is recorded once per invocation for `exec_json_completed`, `app_server_delta`, or `app_server_completed`; `exec_json` remains the code default and no runtime config is changed.
**Architecture cell:** `transport`, `harness-eval`
**Map delta:** none
**Map delta why:** This extends the existing Codex app-server adapter and F153 metric plane; it adds no Store, Queue, Router, Adapter, Dispatcher, Binding, or ownership edge.
**Architecture:** Map the installed Codex protocol's exact `threadId/turnId/itemId/delta` notification into the current Codex event transformer. Stream suffix deltas with append semantics, then use the completed item as a replace-mode canonical snapshot so fragmented deltas, signature stripping, and protocol drift cannot duplicate persisted prose. Record one bounded-cardinality first-visible histogram from `CodexAgentService.invoke()` entry to the first non-empty text event.
**Tech Stack:** TypeScript, Node test runner, OpenTelemetry metrics, Codex app-server JSON-RPC
**前端验证:** No — the existing route/WebSocket text aggregation already supports `append` and `replace`; this change is provider/transport scoped.

---

## Finish line

One app-server invocation can emit fragmented agent-message deltas immediately, reconcile at `item/completed` to the exact canonical aggregate, and expose a single first-visible latency sample, while completion-only `exec_json` behavior and default carrier selection remain unchanged.

Not building:

- no `CAT_CAFE_CODEX_CARRIER` or startup-config mutation;
- no broad app-server rollout or F254 AC-D15–D17 signoff claim;
- no new host pool, draft store, or frontend protocol;
- no context-threshold or reasoning-effort change.

## Terminal schema

```ts
type CodexMappedDeltaEvent = {
  type: 'item.agent_message.delta';
  thread_id: string;
  turn_id: string;
  item_id: string;
  delta: string;
};

interface CodexStreamState {
  hadPriorTextTurn: boolean;
  canonicalText?: string;
  streamedAgentMessageIds?: Set<string>;
  // existing signature/final-terminal fields remain unchanged
}
```

The first-visible metric is `cat_cafe.codex.first_visible_text.duration` in seconds, with the existing allowlisted `status` attribute restricted to three values: `exec_json_completed`, `app_server_delta`, `app_server_completed`.

## Ephemeral stream-state gate

Lifecycle owner: one `CodexStreamState` instance owned by one `CodexAgentService.invoke()` generator. It is never persisted or restored.

| State | Event | Transition/output |
|---|---|---|
| completion-only | `item.completed(agent_message)` | append canonical turn; existing behavior |
| completion-only | first non-empty delta for item `I` | mark `I` streamed; append delta immediately |
| streaming `I` | later delta for `I` | append suffix only |
| streaming `I` | completed snapshot for `I` | strip provider signature; replace with cumulative canonical aggregate |
| any | duplicate completed snapshot for streamed `I` | deterministic same replacement; never append duplicate prose |
| any | unknown/malformed/empty delta | ignore; no first-visible sample |

Invariants:

- **INV-1:** A streamed item completion cannot append its full text after its deltas.
- **INV-2:** The completed snapshot is canonical and may replace, but never erase, earlier completed agent-message turns.
- **INV-3:** Completion-only `exec_json` output is byte-for-byte unchanged.
- **INV-4:** A successful stream finalizes exactly one runtime-canonical signature; failed/interrupted streams do not gain one.
- **INV-5:** First-visible latency records at most once and carries no thread, invocation, prompt, or user identifier.
- **INV-6:** Default carrier remains `exec_json`; app-server remains explicit canary only.

Adversarial coverage: delta fragmentation, multiple agent-message items separated by tools, provider signature split across deltas, completed text differing from concatenated deltas, malformed/foreign notification shape, completion without deltas, and failed/interrupted terminal finalization.

### Task 1: Protocol mapping and canonical delta reconciliation

**Files:**
- Modify: `packages/api/test/codex-event-transform.test.js`
- Modify: `packages/api/src/domains/cats/services/agents/providers/CodexAppServerEventMapper.ts`
- Modify: `packages/api/src/domains/cats/services/agents/providers/codex-event-transform.ts`

**Step 1: Write failing tests**

Add behavioral tests for the exact installed schema and INV-1–INV-4, including fragmented deltas followed by a completed full snapshot and a second streamed agent-message item.

**Step 2: Verify RED**

Run:

```bash
pnpm --filter @cat-cafe/api run build
node --import packages/api/test/helpers/setup-cat-registry.js --test packages/api/test/codex-event-transform.test.js
```

Expected: new delta mapping/reconciliation assertions fail because the mapper returns `null` and the transformer has no delta branch.

**Step 3: Implement minimal mapping and reconciliation**

Map only a fully typed non-empty `item/agentMessage/delta` notification. Lazily allocate streamed item state, emit deltas in append mode, and emit the cumulative stripped completion snapshot in replace mode.

**Step 4: Verify GREEN**

Repeat the Task 1 command; expect all tests to pass.

### Task 2: Transport integration and exact-turn isolation

**Files:**
- Modify: `packages/api/test/codex-app-server-transport.test.js`
- Modify: `packages/api/src/domains/cats/services/agents/providers/CodexAppServerClient.ts`

**Step 1: Write failing transport tests**

Exercise a protocol wire that emits exact-turn delta → completed snapshot → turn completed. Assert the mapped delta arrives before completion, and a delta for another thread/turn is ignored.

**Step 2: Verify RED**

Run:

```bash
pnpm --filter @cat-cafe/api run build
node --import packages/api/test/helpers/setup-cat-registry.js --test packages/api/test/codex-app-server-transport.test.js
```

Expected: delta is absent and/or foreign delta is not fenced.

**Step 3: Implement exact-turn filtering**

Forward delta notifications only when `threadId` and `turnId` match the active invocation. Preserve lifecycle touch/timeout behavior and all existing safe-boundary handling.

**Step 4: Verify GREEN**

Repeat the Task 2 command; expect all tests to pass.

### Task 3: First-visible latency metric

**Files:**
- Modify: `packages/api/src/infrastructure/telemetry/instruments.ts`
- Modify: `packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts`
- Modify: `packages/api/test/codex-agent-service.test.js`
- Modify: `packages/api/test/telemetry/cli-spawn-redaction.test.js`

**Step 1: Write failing tests**

Add a bounded-cardinality contract test for the three `status` values and a service behavior test proving only the first non-empty text event records. Verify no high-cardinality identifiers are added to the metric allowlist.

**Step 2: Verify RED**

Run:

```bash
pnpm --filter @cat-cafe/api run build
node --import packages/api/test/helpers/setup-cat-registry.js --test packages/api/test/codex-agent-service.test.js packages/api/test/telemetry/cli-spawn-redaction.test.js
```

Expected: metric/instrument and first-text observation assertions fail.

**Step 3: Implement one-shot recording**

Start the clock at `invoke()` entry. Immediately before the first non-empty transformed text yield, record seconds once with one of the three bounded `status` values. Do not attach prompt, thread, invocation, user, or session IDs.

**Step 4: Verify GREEN**

Repeat the Task 3 command; expect all tests to pass.

### Task 4: Regression and gate

**Files:**
- Modify only if formatting requires it: files listed above

**Step 1: Format only changed files**

Run:

```bash
pnpm biome format --write packages/api/src/domains/cats/services/agents/providers/CodexAppServerEventMapper.ts packages/api/src/domains/cats/services/agents/providers/codex-event-transform.ts packages/api/src/domains/cats/services/agents/providers/CodexAppServerClient.ts packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts packages/api/src/infrastructure/telemetry/instruments.ts packages/api/test/codex-event-transform.test.js packages/api/test/codex-app-server-transport.test.js packages/api/test/codex-agent-service.test.js packages/api/test/telemetry/cli-spawn-redaction.test.js
```

Expected: formatter exits 0.

**Step 2: Run the focused protection set**

```bash
pnpm --filter @cat-cafe/api run build
node --import packages/api/test/helpers/setup-cat-registry.js --test packages/api/test/codex-event-transform.test.js packages/api/test/codex-app-server-transport.test.js packages/api/test/codex-agent-service.test.js packages/api/test/codex-app-server-host-pool.test.js packages/api/test/telemetry/cli-spawn-redaction.test.js
```

Expected: all focused tests pass.

**Step 3: Run repository check**

```bash
pnpm check
```

Expected: exit 0 with no generated protocol census drift and no provider-canary residue.

**Step 4: Commit**

Commit with a Why body and this provenance footer:

```text
Thread-Context: threadId=thread_ms8cnrohzvoxqqli catId=cat-idwxwjba
```
