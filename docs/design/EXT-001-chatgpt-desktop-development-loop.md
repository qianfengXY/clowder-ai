# EXT-001 Design — Project-scoped ChatGPT Desktop Development Loop

Date: 2026-08-24<br>
Status: implementation design (requires fresh non-author review after code delta)<br>
Feature truth: `docs/extensions/EXT-001-chatgpt-desktop-development-loop.md`

## Decision summary

EXT-001 is a project-scoped bridge, not a second workflow engine. Cat Café owns the durable project, per-feature design-branch binding and Review Hub view; F275 owns work/attempt/terminal truth; F253 owns ReviewRound semantics; EXT-001 owns the external Desktop session binding; F286 governs the strict MCP profile. ChatGPT Desktop owns repository mutation through its native local tools. F211 remains unchanged because its runtime-session records require a CatId, agent-key principal and Antigravity provenance, none of which is valid for the `chatgpt-desktop-dev` external actor.

The central UX decision is **one imported feature, one authoritative design branch, one discussion conversation, one Review conversation, one native Desktop task**. A conversation may contain competing ideas; only the exact commit on the bound design branch governs implementation and Review. Delivery cycles and code SHAs reuse the feature Review conversation. Historical project-wide Review Hub rounds remain callback-compatible during migration. Cat Café and ChatGPT chats are replaceable bindings over persisted state.

## System flow

```text
Cat Café Project
  ├─ ordinary design threads (discussion only)
  ├─ DesktopDevelopmentProjectBinding
  │    ├─ repo/default branch/local checkout
  │    ├─ reviewer + merge policy
  │    └─ successfulManualPilotCount
  └─ imported feature
       ├─ bound design branch -> frozen exact design SHA
       ├─ deterministic discussion thread
       ├─ deterministic Review thread -> F253 ReviewRounds
       └─ DeliveryCycle -> F275 Work -> Attempts
                                      ^                 |
                                      | Resume Packet   | consensus findings
                                      |                 v
                              ChatGPT Desktop session binding
                              permanent worktree + native Git tools
```

## Ownership decisions

| Concern | Owner | EXT-001 action |
|---|---|---|
| Project/repo/reviewer/rollout policy | EXT-001 on ExternalProject | persist versioned binding; no secret storage |
| Authoritative feature design | EXT-001 + project Git checkout | persist branch binding; validate exact Git root/repository/local branch commit; freeze SHA per implementation and ReviewRound |
| Visible feature discussion/Review conversations | EXT-001 resolver + ThreadStore | deterministic project + backlog identities; ensure/restore the same two threads; discussion is never promoted to authority |
| Work/attempt/evidence/terminal | F275 managed-work | consume named port; no fallback identity/state |
| Independent review/barrier/consensus | F253 review coordination | add durable project/work/SHA records behind shared interface |
| Desktop session provenance | EXT-001 | persist the external actor session, chat ref and permanent binding epoch without impersonating a Cat session |
| Existing Cat runtime sessions | F211 identity-session | remain `antigravity-desktop` only; no EXT-001 write or schema expansion |
| Desktop execution ownership | EXT-001 | permanent work/session binding fenced by epoch, distinct from F167 cat baton lease |
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

### FeatureDesignBranchBinding

- Persist `featureDesignBranches[backlogItemId] = branch` with the external project.
- Resolve only the exact local `refs/heads/<branch>^{commit}` in the configured project checkout.
- Require the checkout Git top-level and normalized GitHub origin to match the project binding.
- Resolution is read-only: never checkout, fetch, merge or mutate the working tree.
- Start and resume fail closed in `awaiting_design_branch` until a valid committed branch exists.
- Every Desktop objective and ReviewRound records the branch plus full design SHA. Later branch movement does not rewrite historical round authority.

### FeatureWorkspaceThreads

- `planThreadId = project-feature-plan:<projectId>:<backlogItemId>`.
- `reviewThreadId = project-feature-review:<projectId>:<backlogItemId>`.
- The legacy `plan` kind is displayed as “方案讨论”. It remains a conversation binding only and is not an implementation input.
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
  leaseExpiresAt: string; // deprecated protocol-v1 compatibility field; ignored
  status: 'active' | 'detached' | 'superseded';
  workspace: WorkspaceBinding;
  version: number;
};
```

Only the highest active epoch can mutate. Rebind is a CAS transaction that supersedes the previous binding. Time and app sleep do not expire a binding.

### ReviewRound

Round identity includes project/work/attempt, full implementation SHA and the frozen design SHA. Both SHAs and the roster are immutable. Private drafts are stored separately from the barrier-safe projection. Atomic finish logic opens the barrier only when every required reviewer independently finishes. Consensus/finding status changes are versioned/idempotent.

### Managed-work discovery

Desktop resolves a project from the exact GitHub `owner/name`, then receives `managedWorkDiscovery` built from project-scoped Backlog items and their Workflow SOP admissions. Each candidate carries the canonical F275 work ID, current attempt, lifecycle and consumer version plus its EXT-001 session status. EXT-001 never creates a work root during discovery. If several active candidates remain after matching the user request, Desktop must ask the user to choose instead of using list order, branch or chat history.

## Derived Resume Packet

Resume Packet is composed on read from project binding, F275 work/attempt, Desktop session/workspace and the latest safe ReviewRound view. It contains:

- project/repository/default branch and protocol compatibility;
- authoritative design branch/current exact SHA plus the design SHA frozen by the current ReviewRound;
- delivery cycle, attempt and server-derived phase;
- current branch/full SHA/last committed recovery point;
- checks and evidence references;
- barrier-safe open findings and exact round version;
- current permanent binding epoch/state;
- `nextLegalActions` and the evidence required for each.

It excludes credentials, raw agent keys, private reviewer drafts and public exposure of the local absolute path.

The packet exposes both `attemptId` and `attemptNumber`. `phase` and `nextLegalActions` are produced by one
server-side derivation, so clients never reverse-engineer lifecycle from action strings. A completed
`changes_requested` round yields `phase=fix_required` and `start_fix_attempt`; replaying `work_connect` with the same
idempotency key allocates exactly one next F275 attempt, rebinds the same Desktop chat, and returns
`phase=implementing` without adding another MCP tool or state root.

The retry path is bounded and design-commit-governed. Every consensus finding carries the canonical
`git:refs/heads/<branch>@<full-sha>` in `designRefs` and an explicit
scope. Ordinary findings use `plan_conformance`; reviewers may not introduce preferences, new requirements or
out-of-plan refactors, and security/performance concerns still cite the frozen design commit. A serious architectural conflict
uses P1 `architecture_decision` and pauses in `awaiting_architecture_decision` until the authenticated user records
whether to keep the reviewed design or continue after a revised design was committed to the bound branch. The latter
requires the branch SHA to advance; ordinary chat edits or verbal approval cannot pass the gate. Attempt 15 is the first continuation boundary; if it
still ends with open findings, `awaiting_review_continuation` blocks attempt 16. Each user approval extends the ceiling
by 15 attempts. Both decisions are append-only managed-work evidence and therefore survive restart and replay.
Legacy findings written before `designRefs` became mandatory are projected with the feature's validated design-branch
commit when available; otherwise the workflow stops at the design-branch gate. The write path stays strict, and no
discussion thread or review evidence is promoted into a design decision.

Consensus non-convergence does not create another reviewer or another round. The authenticated user may append one
`review_consensus_authorized` ruling scoped to the current `reviewRoundId + exactSha`. The designated recorder is then
re-dispatched with that ruling and the current managed-work version, and must publish the final structured consensus.
An identical authorization is idempotent; a conflicting replacement is rejected. This evidence decides only the
reviewer disagreement and cannot satisfy the Cat Café pre-merge acceptance gate.

The same read builds an ordered `workflowNodes` projection for Mission Hub. Each node carries a semantic node ID,
server-derived `pending / active / blocked / completed` status, responsible actor, timestamps, optional reviewer
progress and one legal manual action. It is deliberately not persisted: F275 evidence, F253 ReviewRound progress and
the EXT-001 session binding remain the only truth. A hand-off is visible as complete only after the destination's
canonical state exists; a Resume Capsule or conversational claim alone is insufficient.

The authenticated Cat Café surface may retry the current stage with the observed attempt and managed-work version.
Desktop implementation/fix/merge retries wake the same permanent task; Review retries re-dispatch only unfinished
participants (or the designated consensus recorder) with a new deterministic delivery key. Architecture choice,
15-attempt continuation and pre-merge acceptance remain dedicated user decisions and are rejected by the generic retry
route. Terminal or stale attempts cannot be replayed.
While a round is `consensus_ready`, Mission Hub additionally exposes the dedicated user-ruling action. Before a ruling,
generic replay may only remind the existing recorder; after a ruling, replay carries the same durable instruction and
never asks for a third reviewer.

Review dispatch is intentionally a compact envelope: routing handles, project/feature identity, stage, implementation
SHA, design branch/SHA, round/progress and an optional unique user ruling. It tells the reviewer to load
`chatgpt-review-rounds`; the table schema, callback procedure and stable constraints live in that skill and its reference
template instead of being copied into every system message.

Desktop IPC acknowledgement is not delivery proof. Cat Café assigns a deterministic `clientUserMessageId`, then reads
the bound task with turns included. The durable wake outbox is cleared only when the ID or exact objective is visible
inside an actual turn; goal metadata alone cannot satisfy confirmation. Recovery reads actual turns before sending, so
an upgrade-era outbox record whose objective is already visible is cleared instead of replayed. If the bound task is
dormant and has no IPC owner, Cat Café persists an owner-discovery claim before opening that same task and performs
bounded retries; one durable wake may deep-link at most once. It never creates a replacement task, and every
pre-acknowledgement retry reuses the same message ID. Once the owner acknowledges the start-turn request, the outbox
changes to verification-only recovery: it may keep checking for the actual turn but cannot send the message again. A
successful delivery to an existing owner does not deep-link or steal the user's current Codex focus. Recovery for a task
is serialized with live delivery so overlapping timer passes cannot emit duplicate turns or repeated focus changes.

## Acceptance-before-merge state machine

```text
latest SHA approved + checks green + zero open findings
  -> acceptance_pending
  -> operator rejects in Cat Café
     -> fix_required -> new attempt -> new SHA -> full ReviewRound
  -> operator accepts in Cat Café
     -> persist acceptance_recorded(true)
     -> wake the original ChatGPT Desktop task
     -> merge_with_native_git
     -> merge receipt -> accepted -> pilotCount + 1 (idempotent, capped at 2)
```

Acceptance evidence is scoped to `{projectId, workId, attemptId, exactSha}` and survives a Desktop binding replacement.
The legacy `merge_confirmed` evidence remains readable only for protocol-v1 in-flight compatibility and cannot authorize
a new-flow merge without Cat Café acceptance. A matching acceptance plus merge receipt is required before F275 may
transition the work to `accepted`. Records already merged under the former ordering retain a compatibility path to
capture their post-merge acceptance and terminate safely.

## Deletion and failure recovery

| Failure | Durable truth | Recovery |
|---|---|---|
| Cat Café Review Hub soft-deleted | project/work/round unchanged; thread has `deletedAt` | restore same deterministic thread |
| ChatGPT chat deleted | binding remains active but its UI entry is gone | bind a replacement chat, increment epoch, return Resume Packet |
| ChatGPT app/Mac asleep | permanent binding and work remain | resume after restart; never mark failed only for absence |
| service crashes during write | prior CAS version/idempotency record remains | retry same key, return same result |
| permanent worktree missing | last committed SHA remains | rebuild checkout/worktree; disclose loss of uncommitted state |
| protocol/capability mismatch | read state remains available | deny write with supported version/capability details |
| F275 named port unavailable | project/session/read-only data remains | deny claims/transitions; no local fallback ledger |

## Concurrency boundaries

1. Project binding updates use expected version.
2. Hub ensure uses deterministic identity and idempotent store operation.
3. Session rebind/claim/metadata heartbeat validate version + highest binding epoch in one write boundary.
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
- active permanent binding epoch when applicable;
- idempotency key;
- server-derived legal transition.

## Compatibility choices

- F211 `antigravity-desktop` remains valid and unchanged. EXT-001's `chatgpt-desktop-dev` session binding is additive in its own project/work-scoped store, not a new F211 runtime variant.
- Existing projects without a binding behave exactly as before and show an opt-in setup surface.
- Existing ordinary threads remain ordinary; only the deterministic Review Hub receives ReviewRound projection.
- Optional project publication adapters may consume consensus later, but cannot block or redefine core round completion.

## Verification matrix

| Object/boundary | Crash/restart | Concurrency | Restore | Side-path/bypass |
|---|---|---|---|---|
| Project binding | reload TTL=0 record | stale version rejected | authenticated rebind | repo/path inference denied |
| Review Hub | ensure after restart | parallel ensure -> one ID | soft delete -> same ID | new window per SHA denied |
| Session binding | permanent binding survives restart | two binds -> highest epoch | deleted chat -> Resume Packet | stale chat write denied |
| F275 work/attempt | durable canonical IDs | next-attempt idempotency | continue same work | EXT-001 fallback key absent |
| ReviewRound | private drafts persist | barrier race atomic | latest safe projection | author/self/cross-project denied |
| Merge acceptance gate | acceptance + merge evidence persist | duplicate acceptance/wake/receipt are idempotent | rejection creates the next attempt in the same lineage | merge receipt before acceptance denied |
| Review-loop gate | continuation/architecture evidence persists | duplicate decisions are idempotent; conflicts rejected | next 15-attempt block resumes same work/task | attempt 16/31/... and undecided architecture change denied |
| Consensus ruling | round + SHA scoped evidence persists | identical replay idempotent; conflicting rewrite rejected | original recorder receives the same ruling | new reviewer, stale round/SHA, merge/acceptance bypass denied |

## Human activation boundary

Implementation may add routes, MCP tools and a Desktop executor skill. It does not edit ChatGPT/Codex runtime configuration, create credentials or grant GitHub permissions. Historical pilot/merge-mode fields remain backward compatible, but no new delivery cycle may bypass the authenticated Cat Café acceptance decision for its current exact SHA.
