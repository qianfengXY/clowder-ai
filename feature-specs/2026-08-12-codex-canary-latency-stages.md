# Codex Canary Latency Stages Implementation Plan

**Feature:** F254 — `docs/features/F254-side-effect-freshness-gate.md` (D2 app-server canary)
**Goal:** Make the existing per-cat Codex app-server canary deployable without widening rollout, and close the two timing blind spots before the existing lifecycle stages.
**Acceptance Criteria:** The existing `cli.carrier` override remains the only per-cat canary switch and still defaults to `exec_json`; no runtime config is modified by this change; app-server invocations record provider setup duration; carrier acquisition records whether a warm host was reused or a new/direct host was acquired; existing lifecycle and first-visible metrics remain unchanged; metric attributes stay bounded and contain no user, thread, session, prompt, or invocation identifiers.
**Architecture cell:** `transport`, `harness-eval`
**Map delta:** none
**Map delta why:** This extends descriptive telemetry around the existing Codex provider and host pool; it adds no new owner, store, queue, adapter, or persistence boundary.
**Architecture:** Reuse the existing `cat_cafe.codex_app_server.stage_duration` histogram and its bounded `status` attribute. Record the synchronous/async provider preparation gap in `CodexAgentService`, then record carrier acquisition in `CodexAppServerRunner` using the returned session's existing `reusedSessionHost` truth.
**Tech Stack:** TypeScript, Node test runner, OpenTelemetry metrics
**前端验证:** No — provider telemetry only; carrier activation continues through the existing Hub member editor/runtime configuration.

---

## Finish line

After deployment with one GPT cat explicitly configured as `cli.carrier=app_server`, operators can distinguish provider setup, warm/new carrier acquisition, initialize, thread resume/start, turn acceptance, first provider activity, and first visible text without changing the default carrier or restarting runtime during development.

Not building:

- no runtime configuration mutation or service restart;
- no broad app-server default rollout;
- no duplicate canary flag, persistent timing store, dashboard, or Eval Hub metric;
- no change to reasoning effort, MCP selection, or session semantics.

## Existing lifecycle object census

No new stateful object is introduced. This plan observes two existing lifecycle objects.

### Codex app-server host/lease

Lifecycle owner: `CodexAppServerHostPool` and `CodexAppServerHostLease`.

| State | Event | Result |
|---|---|---|
| no eligible host | acquire | spawn/connect host; record `carrier_acquire_new` |
| eligible idle host | acquire | grant exclusive lease; record `carrier_acquire_warm` |
| leased | normal close | return healthy host to bounded warm pool |
| leased | interrupt/abandon/failure | evict host; never report warm reuse |

Invariants:

- **INV-1:** A warm acquisition sample is emitted only when `reusedSessionHost === true`.
- **INV-2:** Every successful acquisition attempt emits exactly one acquisition sample.
- **INV-3:** Failed acquisition emits no success-classified timing sample.
- **INV-4:** Telemetry cannot change lease release, retry, affinity, or eviction behavior.

Adversarial coverage: warm reuse, new/direct acquisition, acquisition rejection, recovery retry.

### Invocation timing recorder

Lifecycle owner: one `CodexAgentService.invoke()` generator.

| State | Event | Result |
|---|---|---|
| started | app-server event source constructed | record one `provider_setup` sample |
| started | exec-json event source constructed | no app-server stage sample |
| any | early L0/config error | preserve existing error/done behavior; no false setup success |

Invariants:

- **INV-5:** Setup timing is recorded only for the selected app-server carrier.
- **INV-6:** Metric attributes use the existing bounded `status` key only.
- **INV-7:** Existing `exec_json`, lifecycle, and first-visible behavior remains byte/semantics stable.

Adversarial coverage: async MCP/L0 preparation, exec-json control path, early provider error.

## Task 1: Close provider-setup timing gap

**Files:**
- Modify: `packages/api/test/codex-app-server-pooling.test.js`
- Modify: `packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts`

1. Add a failing test proving app-server records exactly one `provider_setup` duration while exec-json records none.
2. Run the focused test and observe RED because no setup sample exists.
3. Start the setup clock at `invoke()` entry and record after the app-server event source is fully constructed.
4. Re-run the focused test to GREEN.

## Task 2: Close carrier-acquisition timing gap

**Files:**
- Modify: `packages/api/test/codex-app-server-transport.test.js`
- Modify: `packages/api/src/domains/cats/services/agents/providers/CodexAppServerRunner.ts`

1. Add failing tests for `carrier_acquire_new`, `carrier_acquire_warm`, and failed acquisition.
2. Run the focused test and observe RED because acquisition duration is not recorded.
3. Time each `sessionFactory` attempt and record one success sample from `reusedSessionHost` truth.
4. Re-run the focused test to GREEN.

## Task 3: Regression gate and deployment handoff

1. Format changed files with `pnpm biome check --write <changed files>`.
2. Run API build and the focused Codex provider/transport/host-pool/telemetry tests.
3. Run `git diff --check`, hotfix/fallback/architecture ownership checks, and artifact hygiene checks.
4. Request independent exact-HEAD review before merge.
5. Merge without modifying runtime config or restarting services; hand off the existing per-cat `cli.carrier=app_server` activation and verification steps to the deployer.

### Operator-owned deployment verification

1. Sync and build the merged `main` in the runtime checkout.
2. In the existing Hub member editor, set only the target GPT cat's `cli.carrier` to `app_server`; keep other cats on `exec_json`.
3. Activate the deployment using the operator's normal restart path.
4. Verify `GET /api/cats` reports `codexCarrier={effective:"app_server",source:"per-cat"}` for the target cat.
5. Run one cold turn and at least two turns within the five-minute warm-host window. Compare `provider_setup`, `carrier_acquire_new`, `carrier_acquire_warm`, the existing lifecycle stages, and `cat_cafe.codex.first_visible_text.duration`.
6. Roll back through the same member editor by restoring `cli.carrier=exec_json` if the canary regresses reliability or latency.
