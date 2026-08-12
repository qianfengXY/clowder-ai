# Quality Gate Report — Remote polling browser lag

Spec: `feature-specs/2026-08-12-remote-realtime-transport-fallback.md`
Original requirement: operator messages in `thread_mspuhjh2woc2qy2d` on 2026-08-12
Implementation head: `03bcab3383a3193c4083cce435d9dbfd0d3a1f33`
Check date: 2026-08-12

## Vision coverage

| # | Operator requirement | AC coverage | Implementation |
|---|---|---|---|
| 1 | Remote browser becomes very laggy after switching to polling. | Prefer low-overhead WebSocket and yield polling backlog work. | Met: WebSocket-first plus task-yielding coalescer backlog. |
| 2 | WebSocket probably does not work from the company network. | Polling remains the ordered fallback and no message is merged or dropped. | Met: `polling` remains second with `tryAllTransports: true`; FIFO/no-drop tests cover 200-event bursts. |
| 3 | Try the proposed fix. | Preserve reconnect/catch-up/security behavior and avoid runtime-config mutation. | Met: the diff is limited to client transport/scheduling, tests, and evidence docs. |

Delivery completeness: this is a complete regression correction, not a partial feature. A later performance trace would extend the diagnosis only if the company network still reproduces lag; it would not require rewriting this transport contract.

## Functional acceptance

| # | Requirement | Status | Code | Evidence |
|---|---|---|---|---|
| AC-1 | Primary chat socket attempts WebSocket first. | Met | `packages/web/src/hooks/useSocket.ts:484` | `useSocket-reconnect-catchup.test.ts` transport option contract. |
| AC-2 | Corporate/proxy rejection can fall back to polling. | Met | `packages/web/src/hooks/useSocket.ts:489` | Ordered `['websocket', 'polling']` plus `tryAllTransports: true` assertion. |
| AC-3 | Polling-delivered backlog yields without merge/drop/reorder. | Met | `packages/web/src/hooks/useSocket-message-coalescer.ts:49` | Coalescer unit and real-Zustand integration tests: prompt first chunk, task boundary, FIFO, 200/200 delivery, per-turn notification ceiling. |
| AC-4 | Reconnect and durable catch-up semantics remain intact. | Met | Existing `useSocket` recovery path unchanged. | Focused reconnect/catch-up suite passes 9/9. |
| AC-5 | Runtime config, persistence, and security boundary remain unchanged. | Met | No config, API, persistence, auth, room, or `allowRequest` diff. | Final name/diff audit; F156/LL-047 reviewed. |

## Close gate

```yaml
close_gate_report:
  feature_id: BUG-remote-polling-browser-lag
  spec_path: feature-specs/2026-08-12-remote-realtime-transport-fallback.md
  head_sha: 03bcab3383a3193c4083cce435d9dbfd0d3a1f33
  report_date: 2026-08-12
  ac_matrix:
    - ac_id: AC-1
      status: met
      evidence:
        - kind: commit
          ref: 03bcab338
          description: WebSocket-first transport preference
        - kind: test
          ref: packages/web/src/hooks/__tests__/useSocket-reconnect-catchup.test.ts
      resolution: null
    - ac_id: AC-2
      status: met
      evidence:
        - kind: test
          ref: packages/web/src/hooks/__tests__/useSocket-reconnect-catchup.test.ts
          description: polling remains ordered fallback with tryAllTransports enabled
      resolution: null
    - ac_id: AC-3
      status: met
      evidence:
        - kind: test
          ref: packages/web/src/hooks/__tests__/useSocket-message-coalescer.test.ts
        - kind: test
          ref: packages/web/src/hooks/__tests__/useSocket-burst-coalesce.integration.test.ts
      resolution: null
    - ac_id: AC-4
      status: met
      evidence:
        - kind: test
          ref: packages/web/src/hooks/__tests__/useSocket-reconnect-catchup.test.ts
      resolution: null
    - ac_id: AC-5
      status: met
      evidence:
        - kind: doc
          ref: docs/bug-report/remote-polling-browser-lag/bug-report.md
          description: runtime, config, persistence, and F156 boundary audit
      resolution: null
```

Follow-up-tail semantic scan: only the plan's lineage phrase and explicit scope boundary matched keywords; no unmet AC is presented as complete or deferred. No `cvo_signoff` is needed.

## Architecture ownership

- Architecture cell: `transport`
- Map delta: `none`
- Why: the existing browser Socket.IO connection and event coalescer change preference/scheduling only; no owner or architecture edge changes.
- Automated command status: `pnpm check:architecture-ownership` is not exported in this private workspace and its checker target is absent; `scripts/check-env-port-drift.test.mjs` explicitly guards that removal.
- Manual mismatch scan: no changed path introduces a parallel `Store`, `Queue`, `Router`, `Adapter`, `Dispatcher`, or `Binding` owner.
- Fallback-layer check: no fallback-pattern growth detected.

## Dogfood-Your-Slice

Scope verdict: required because the bug is user-visible.

Pre-merge path exercised:

1. A fresh WebSocket upgrade request to the current public API tunnel returned `HTTP/1.1 101 Switching Protocols` (curl then timed out intentionally because the upgraded socket stayed open).
2. The production coalescer processed a 200-event burst through the real Zustand notification mechanism with FIFO/no-drop semantics and bounded per-turn work.
3. The transport hook test exercised the exact application options and all reconnect/durable-history callbacks around them.

Structural boundary: the company proxy cannot be reproduced from this worktree. The typed Hub preview-open tool is not exposed in this session, and the browser-preview rules prohibit substituting an external Playwright/Chrome window. Therefore pre-merge evidence stops at the public upgrade plus application-level transport and backlog contracts. After the changed frontend is deployed, the next company-network session is the valid trigger to observe the selected transport; if it still selects polling and remains laggy, CodeX owns collection of a Performance trace and polling packet-burst counts before any further batching design.

Dogfood bugs found: none in the changed slice.

## Design and artifact hygiene

- `designs/**/*.pen` keyword scan (`poll|socket|transport|remote|realtime`): no match.
- UI component/layout diff: none; no visual comparison is applicable.
- Root media/design artifacts in worktree or committed diff: none.

## Five-axis risk and fresh verification

Risk: behavior=medium; data=none; security=low (security gate unchanged); contract=medium (transport order and FIFO scheduling); irreversible=none.

| Command/evidence | Result | Claim covered |
|---|---|---|
| Focused Vitest: reconnect + coalescer unit + Zustand burst integration | 21/21 passed | Transport option, fallback retained, FIFO/no-drop, yielding, reconnect/catch-up. |
| `pnpm --filter @cat-cafe/web exec tsc --noEmit` | Exit 0 | Web TypeScript contract. |
| Touched-file `pnpm biome check --write ...` | Exit 0; no errors, only pre-existing complexity/non-null warnings | Formatting/lint delta. |
| `pnpm --filter @cat-cafe/web test` | 5854 passed, 4 failed | Full-package regression scan; all 4 failures were reproduced unchanged on main. |
| Exact four-test main baseline reproduction | Same 4 failures | Proves the full-suite red is pre-existing and unrelated. |
| `pnpm check:capability-tips` | PASS (11 checker tests; existing repository warnings only) | `tips_exempt`/discovery policy. |
| `HOTFIX_BASE=main node scripts/check-hotfix-pattern.mjs` | `hotfix: false` | Normal planned performance correction, not hotfix lane. |
| `node scripts/check-fallback-layers.mjs --base main` | No fallback pattern changes | No fallback-layer growth. |
| Public API WebSocket upgrade | `101 Switching Protocols` | Current public tunnel supports the preferred transport. |
| `git diff --check` and scoped diff audit | Exit 0 / no unrelated code | Patch hygiene and boundary. |

Full-suite baseline failures disclosed:

- F232 PR URL mapping: two tests expect `clowder-ai` while main returns `cat-cafe`.
- F232 artifact content: one test expects `docs/BACKLOG.md` while main requests `docs/ROADMAP.md`.
- F252 adaptive pass-ball: one test expects `@co-creator` to match while main returns false.

Verdict: the scoped quality gate passes. The unrelated full-suite baseline remains red and is not modified by this patch.
