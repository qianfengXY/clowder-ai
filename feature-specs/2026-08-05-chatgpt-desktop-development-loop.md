# F289 ChatGPT Desktop Development Loop — Implementation Plan

> **For Codex:** execute in `/Volumes/WorkSSD/cat-cafe-chatgpt-desktop-loop` using the worktree, TDD, quality-gate, request-review and merge-gate workflows. Never develop from `/Volumes/WorkSSD/cat-cafe-runtime`; never edit runtime config or secrets.

**Goal:** deliver a project-scoped, durable Cat Café ↔ ChatGPT Desktop development loop with one reusable Review Hub, replaceable chat bindings, two manual merge pilots and an explicit per-project auto-merge opt-in.

**Architecture:** extend ExternalProject with a versioned F289 binding; resolve one deterministic Review Hub thread per project; reuse F275 work/attempt/terminal truth, F253 ReviewRound semantics, F211 external runtime sessions and F286 MCP governance. Resume Packet is a projection, not another state root.

**Finish line:** the integration/recovery suite proves design → Desktop implementation → two-cat exact-SHA review → fix loop → guarded merge → operator acceptance, including deletion/rebinding of both visible chat surfaces.

## Phase 0 — Truth and ownership contract

### Task 0.1: shared contract and ownership cell

**Files**

- Create `packages/shared/src/types/desktop-development-loop.ts`
- Modify `packages/shared/src/index.ts`
- Create `docs/architecture/ownership/cells/desktop-development-loop.md`
- Modify `docs/architecture/ownership/cells/managed-work.md`
- Modify `docs/architecture/ownership/cells/identity-session.md`
- Regenerate `docs/architecture/ownership/README.md`
- Test in the repository's shared contract harness

**Red**

- invalid repository/default branch/full SHA rejected;
- Desktop actor rejected from reviewer roster;
- manual merge required while pilot count `< 2`;
- automatic merge rejected until pilot count `2`;
- public projection excludes local absolute path/private draft/secret fields.

**Green**

- define ProjectBinding, ReviewHub view, DesktopSessionBinding, WorkspaceBinding, ResumePacket and barrier-safe finding contracts;
- reuse F275 opaque IDs and do not define `DevelopmentJob`/parallel terminal state;
- expose protocol/capability version and discriminated failure codes.

**Verify**

```bash
pnpm --filter @cat-cafe/shared build
node docs/architecture/ownership/generate-readme.mjs
pnpm check:features
```

## Phase 1 — Project binding and one Review Hub

### Task 1.1: persist binding with ExternalProject

**Files**

- Modify `packages/shared/src/types/external-project.ts`
- Modify `packages/api/src/domains/projects/external-project-store.ts`
- Modify `packages/api/src/routes/external-projects.ts`
- Extend external-project route/store tests

**Red**

- create/update/reload binding;
- repo normalization and optimistic version conflict;
- reviewer roster contains Desktop actor;
- pilot policy illegal combination;
- public list/get path redaction.

**Green**

- persist the optional versioned binding under the existing project root with TTL=0;
- existing unbound projects remain compatible;
- local checkout validation stays server-side and private.

### Task 1.2: deterministic Review Hub resolver

**Files**

- Create `packages/api/src/domains/projects/project-review-hub-service.ts`
- Modify ThreadStore only where needed for idempotent deterministic ensure/restore
- Add project Review Hub routes
- Add restart/race/restore tests

**Red**

- 10 concurrent ensures produce one hub ID/thread;
- soft delete then ensure restores same thread and history;
- multiple SHAs/cycles reuse same Hub;
- cross-user ensure denied.

**Green**

- derive `hubId` from project ID;
- idempotently ensure/index the thread with project path;
- call existing restore semantics when `deletedAt` is present;
- never create a new visible thread per ReviewRound.

### Task 1.3: project setup/status UI

**Files**

- Modify `ImportProjectModal.tsx`
- Add development-loop panel to `ExternalProjectTab.tsx` or its focused child
- Add frontend types/client tests

**Verify**

- import a bound project;
- see repo/default branch/reviewer/pilot/merge status;
- open or restore the same Review Hub;
- verify with browser-preview at desktop and narrow widths.

## Phase 2 — Desktop session and Resume Packet

### Task 2.1: additive F211 runtime source

**Files**

- Modify runtime-session metadata/registration types and validators
- Modify external-runtime-session API/MCP tests and routes

**Red**: `chatgpt-desktop` register/list/read; `antigravity-desktop` regression; spoofed source/user denial.

**Green**: add provenance source only; do not copy Antigravity's execution bridge.

### Task 2.2: binding epoch, lease and workspace record

**Files**

- Create `packages/api/src/domains/desktop-development-loop/desktop-session-store.ts`
- Create Redis implementation and service
- Add route/store restart/concurrency tests

**Red**

- first bind, heartbeat, rebind, old epoch rejection;
- duplicate idempotency replay;
- lease expiry produces detached rather than failed work;
- missing worktree reports last committed recovery point.

**Green**

- persist TTL=0 binding/history with expiring active lease;
- highest epoch is the sole writer;
- validate repo/branch/SHA against project binding.

### Task 2.3: derived Resume Packet

Compose project, F275, session/workspace and latest barrier-safe ReviewRound. Add cold-chat, restart, redaction, protocol mismatch and deterministic legal-action fixtures.

## Phase 3 — F275 named consumer port

### Task 3.1: ordered attempts and typed evidence

**Files**

- Extend F275 shared/port/Redis store selected by existing architecture
- Update F275 feature truth and managed-work ownership cell
- Add focused F275 Phase-C tests

**Required operations**

1. read/validate an existing `{workId, attemptId}`;
2. idempotently create the next ordered attempt;
3. append typed implementation/review/merge/acceptance evidence;
4. apply/reject F275-owned whole-work terminal transitions.

**Red**: two simultaneous next-attempt calls; duplicate evidence; wrong consumer/work; stale version; restart; illegal terminal transition.

**Green**: atomic compare-and-set/idempotency at the F275 boundary. If this port is absent or incompatible, F289 claims return `managed_work_capability_unavailable`; never add a fallback work root.

## Phase 4 — Durable ReviewRound coordinator

### Task 4.1: F253-compatible round store

**Files**

- Add review-coordination shared types/port if absent
- Create Redis ReviewRound store and coordinator
- Add barrier race/restart/stale-SHA tests

**Red**

- fewer than two reviewers/author in roster;
- private draft leak before barrier;
- concurrent final finishes;
- new SHA stales old round;
- one supporter cannot become consensus;
- historical open finding blocks approval.

**Green**

- immutable full SHA/roster;
- private per-reviewer draft records;
- atomic independent barrier;
- barrier-safe consensus/finding projection;
- repeat-until-zero using F275 next-attempt port.

### Task 4.2: Review Hub projection/dispatch

Dispatch CodeX + Kimi using existing Cat Café invocation semantics, pin identical SHA, keep private payloads isolated, and publish only phase/verdict/finding summaries into the one Review Hub. Duplicate dispatch must not duplicate reviewer work.

## Phase 5 — Strict MCP and Desktop executor

### Task 5.1: strict lifecycle tools

**Files**

- Create `packages/mcp-server/src/tools/desktop-development-loop-tools.ts`
- Modify canonical registry/toolsets/profile metadata
- Add MCP contract/profile/auth tests

**Red**: missing auth/version/epoch/idempotency; wrong actor; stale SHA; cross-project access; profile inventory contains forbidden mutation primitive.

**Green**: typed project/work/review reads and constrained lifecycle actions; server-derived actor and legal actions; accurate side-effect annotations.

### Task 5.2: Desktop executor skill

**Files**

- Create `cat-cafe-skills/catcafe-desktop-executor/SKILL.md`
- Update skill manifest and wakeup index
- Add deterministic guard tests

The skill reads Resume Packet, reuses a permanent worktree, implements/tests/commits through Desktop native tools, reports exact SHA/checks, fixes all safe findings, and stops for the correct merge/acceptance gate. It never infers state from chat history when the server packet is available.

### Task 5.3: Scheduled Task recovery contract

Polling is idempotent and may reconnect the same current chat. The task reference is non-authoritative metadata. Deleting the task/chat cannot delete work. Empty polls and transient MCP failures are non-terminal.

## Phase 6 — Merge pilot and end-to-end verification

### Task 6.1: project-scoped pilot gate

**Red**

- first/second pilot without active-chat confirmation denied;
- confirmation for wrong project/work/SHA/epoch denied;
- rejected/aborted cycle does not increment;
- duplicate accepted event increments once;
- auto-merge before two denied;
- changing mode to automatic after two requires authenticated operator update.

**Green**

- persist scoped confirmation evidence;
- increment pilot count only on merge + final accepted;
- keep final acceptance required in both merge modes.

### Task 6.2: integration/recovery/bypass suite

Scenarios:

1. design admission → Desktop claim → implementation evidence → two-private-reviewer barrier → finding → new attempt/SHA → zero findings → manual merge confirmation → acceptance;
2. service restart at every persisted transition;
3. Cat Café Hub soft deletion/restore and ChatGPT chat deletion/rebind;
4. stale epoch/SHA/version, wrong actor/project, protocol mismatch and deploy attempt fail closed;
5. two projects/works never exchange attempts, findings or confirmations;
6. one project runs multiple cycles without creating extra Review Hub threads.

### Task 6.3: quality and independent review

```bash
pnpm check:features
node docs/architecture/ownership/generate-readme.mjs
pnpm check:skills
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/mcp-server test
REDIS_URL=redis://localhost:6398 CAT_CAFE_REDIS_TEST_ISOLATED=1 pnpm --filter @cat-cafe/api test
pnpm gate
git diff --check main...HEAD
```

Run fresh-context/security review on the exact HEAD, then route to a non-author cat. Activation of ChatGPT Desktop MCP config, credentials, Git permissions and auto-merge remains a human action after approval.

## Done evidence

- Feature AC table references exact tests/commits.
- Ownership map has no competing work/review/session truth.
- Stateful object restart/concurrency/restore/bypass tests pass on isolated Redis.
- MCP inventory proves absence of repo mutation/deploy tools.
- Browser evidence shows bound project status and one reusable/restorable Review Hub.
- Two pilot records demonstrate manual merge confirmation and final acceptance before auto-merge becomes available.
- No runtime config, credentials, production data or unrelated worktree changes enter the branch.
