# F289 Design — Project-scoped ChatGPT Desktop Development Loop

Date: 2026-08-07<br>
Status: implementation design (requires fresh non-author review after code delta)<br>
Feature truth: `docs/features/F289-chatgpt-desktop-development-loop.md`

## Decision summary

F289 is a project-scoped bridge, not a second workflow engine. Cat Café owns the durable project, design context and Review Hub view; F275 owns work/attempt/terminal truth; F253 owns ReviewRound semantics; F289 owns the external Desktop session binding; F286 governs the strict MCP profile. ChatGPT Desktop owns repository mutation through its native local tools. F211 remains unchanged because its runtime-session records require a CatId, agent-key principal and Antigravity provenance, none of which is valid for the `chatgpt-desktop-dev` external actor.

The central UX decision is **one imported feature, one plan conversation, one Review conversation, one native Desktop task**. Delivery cycles and code SHAs reuse the feature Review conversation. Historical project-wide Review Hub rounds remain callback-compatible during migration. Cat Café and ChatGPT chats are replaceable bindings over persisted state.

## System flow

```text
Cat Café Project
  ├─ ordinary design threads ──> committed design sources
  ├─ DesktopDevelopmentProjectBinding
  │    ├─ repo/default branch/local checkout
  │    ├─ reviewer + merge policy
  │    └─ successfulManualPilotCount
  └─ imported feature
       ├─ deterministic plan thread
       ├─ deterministic Review thread -> F253 ReviewRounds
       └─ DeliveryCycle -> F275 Work -> Attempts
                                      ^                 |
                                      | Resume Packet   | consensus findings
                                      |                 v
                              ChatGPT Desktop session binding
                              permanent worktree + native Git tools
```

## Ownership decisions

| Concern | Owner | F289 action |
|---|---|---|
| Project/repo/reviewer/rollout policy | F289 on ExternalProject | persist versioned binding; no secret storage |
| Visible feature plan/Review conversations | F289 resolver + ThreadStore | deterministic project + backlog identities; ensure/restore the same two threads |
| Work/attempt/evidence/terminal | F275 managed-work | consume named port; no fallback identity/state |
| Independent review/barrier/consensus | F253 review coordination | add durable project/work/SHA records behind shared interface |
| Desktop session provenance | F289 | persist the external actor session, chat ref, lease and binding epoch without impersonating a Cat session |
| Existing Cat runtime sessions | F211 identity-session | remain `antigravity-desktop` only; no F289 write or schema expansion |
| Desktop execution lease | F289 | narrow work/session claim, distinct from F167 cat baton lease |
| MCP inventory/authority | F286 | strict `desktop:development-loop` profile and annotations |
| Repository writes | ChatGPT Desktop | native workspace/Git tools; absent from MCP |

## Persistent records

### DesktopDevelopmentProjectBinding

Stored with the external project so creation has one durable project root.

```ts
type DesktopDevelopmentProjectBinding = {
  protocolVersion: 1;
  repository: { host: 'github.com'; owner: string; name: string };
  defaultBranch: string;
  defaultReviewers: CatId[];
  mergeMode: 'manual_confirm_in_chatgpt' | 'automatic';
  successfulManualPilotCount: 0 | 1 | 2;
  allowPush: boolean;
  allowPullRequest: boolean;
  requireFinalAcceptance: true;
  version: number;
};
```

`sourcePath` remains the project-private local checkout reference. Public DTOs use a boolean such as `localCheckoutBound`, not the absolute path.

### FeatureWorkspaceThreads

- `planThreadId = project-feature-plan:<projectId>:<backlogItemId>`.
- `reviewThreadId = project-feature-review:<projectId>:<backlogItemId>`.
- Both ThreadStore IDs are deterministic and idempotently ensured.
- `deletedAt != null` means hidden view; resolver calls existing restore semantics and returns the same ID.
- Hard-loss recovery re-creates the same deterministic thread ID. The project/work/round records do not move or get copied.
- Concurrent ensure is safe because the identity is deterministic and the store operation is idempotent.
- `project-review-hub:<projectId>` is a legacy callback surface for historical in-flight rounds, not the destination for new rounds.

### DesktopSessionBinding

```ts
type DesktopSessionBinding = {
  projectId: string;
  workId: WorkId;
  attemptId: AttemptId;
  runtimeSessionId: string;
  chatRef?: string;            // opaque, never treated as truth
  bindingEpoch: number;
  leaseExpiresAt: string;
  status: 'active' | 'detached' | 'superseded';
  workspace: WorkspaceBinding;
  version: number;
};
```

Only the highest active epoch can mutate. Rebind is a CAS transaction that supersedes the previous binding. Lease expiry changes availability, not durable work state.

### ReviewRound

Round identity includes project/work/attempt and full SHA. Full SHA and roster are immutable. Private drafts are stored separately from the barrier-safe projection. Atomic finish logic opens the barrier only when every required reviewer independently finishes. Consensus/finding status changes are versioned/idempotent.

### Managed-work discovery

Desktop resolves a project from the exact GitHub `owner/name`, then receives `managedWorkDiscovery` built from project-scoped Backlog items and their Workflow SOP admissions. Each candidate carries the canonical F275 work ID, current attempt, lifecycle and consumer version plus its F289 session status. F289 never creates a work root during discovery. If several active candidates remain after matching the user request, Desktop must ask the user to choose instead of using list order, branch or chat history.

## Derived Resume Packet

Resume Packet is composed on read from project binding, F275 work/attempt, Desktop session/workspace and the latest safe ReviewRound view. It contains:

- project/repository/default branch and protocol compatibility;
- delivery cycle, attempt and server-derived phase;
- current branch/full SHA/last committed recovery point;
- checks and evidence references;
- barrier-safe open findings and exact round version;
- current binding epoch/lease state;
- `nextLegalActions` and the evidence required for each.

It excludes credentials, raw agent keys, private reviewer drafts and public exposure of the local absolute path.

The packet exposes both `attemptId` and `attemptNumber`. `phase` and `nextLegalActions` are produced by one
server-side derivation, so clients never reverse-engineer lifecycle from action strings. A completed
`changes_requested` round yields `phase=fix_required` and `start_fix_attempt`; replaying `work_connect` with the same
idempotency key allocates exactly one next F275 attempt, rebinds the same Desktop chat, and returns
`phase=implementing` without adding another MCP tool or state root.

## Merge rollout state machine

```text
pilotCount 0/1
  latest SHA approved + checks green
    -> awaiting_manual_merge_confirmation
    -> operator confirms in current active ChatGPT binding
    -> merge -> acceptance_pending
    -> accepted -> pilotCount + 1 (idempotent)

pilotCount 2
  -> auto-merge available (not enabled)
  -> operator explicitly updates project policy
  -> automatic merge allowed under the same SHA/review/check gates
```

Confirmation is evidence scoped to `{projectId, workId, exactSha, bindingEpoch}`. A confirmation from a superseded chat, another SHA or another project is invalid.

## Deletion and failure recovery

| Failure | Durable truth | Recovery |
|---|---|---|
| Cat Café Review Hub soft-deleted | project/work/round unchanged; thread has `deletedAt` | restore same deterministic thread |
| ChatGPT chat deleted | session becomes detached after lease/heartbeat expiry | bind new chat, increment epoch, return Resume Packet |
| ChatGPT app/Mac asleep | work and lease record remain | resume after restart; never mark failed only for absence |
| service crashes during write | prior CAS version/idempotency record remains | retry same key, return same result |
| permanent worktree missing | last committed SHA remains | rebuild checkout/worktree; disclose loss of uncommitted state |
| protocol/capability mismatch | read state remains available | deny write with supported version/capability details |
| F275 named port unavailable | project/session/read-only data remains | deny claims/transitions; no local fallback ledger |

## Concurrency boundaries

1. Project binding updates use expected version.
2. Hub ensure uses deterministic identity and idempotent store operation.
3. Session rebind/claim/heartbeat validate version + highest binding epoch in one write boundary.
4. Review independent finish/barrier open is atomic; duplicate finish is replay-safe.
5. Finding close and next-attempt creation share an idempotency key so retries cannot duplicate attempts.
6. Pilot increment is keyed by accepted work/cycle and capped at two.

## MCP security design

The `desktop:development-loop` runtime profile contains only seven typed lifecycle/session tools. It has no arbitrary thread/user scope, shell, filesystem write, Git mutation, merge, deploy, credential or configuration tool. The authenticated service actor is mapped server-side; clients cannot submit an actor ID to impersonate another role.

Every write validates:

- protocol/capability version;
- authenticated actor and role;
- project/work/attempt scope;
- expected resource version;
- active binding epoch/lease when applicable;
- idempotency key;
- server-derived legal transition.

## Compatibility choices

- F211 `antigravity-desktop` remains valid and unchanged. F289's `chatgpt-desktop-dev` session binding is additive in its own project/work-scoped store, not a new F211 runtime variant.
- Existing projects without a binding behave exactly as before and show an opt-in setup surface.
- Existing ordinary threads remain ordinary; only the deterministic Review Hub receives ReviewRound projection.
- Optional project publication adapters may consume consensus later, but cannot block or redefine core round completion.

## Verification matrix

| Object/boundary | Crash/restart | Concurrency | Restore | Side-path/bypass |
|---|---|---|---|---|
| Project binding | reload TTL=0 record | stale version rejected | authenticated rebind | repo/path inference denied |
| Review Hub | ensure after restart | parallel ensure -> one ID | soft delete -> same ID | new window per SHA denied |
| Session binding | lease survives restart | two binds -> highest epoch | deleted chat -> Resume Packet | stale chat write denied |
| F275 work/attempt | durable canonical IDs | next-attempt idempotency | continue same work | F289 fallback key absent |
| ReviewRound | private drafts persist | barrier race atomic | latest safe projection | author/self/cross-project denied |
| Pilot gate | accepted evidence persists | duplicate acceptance increments once | rejection starts new cycle | auto-merge before 2 denied |

## Human activation boundary

Implementation may add routes, MCP tools and a Desktop executor skill. It does not edit ChatGPT/Codex runtime configuration, create credentials, alter approval policy, grant GitHub permissions or enable auto-merge. Those are explicit user actions after the local implementation and independent review are complete.
