---
cell_id: review-coordination
title: Review Coordination
summary: Durable exact-SHA independent review, private-draft barrier, cross-review, consensus findings, and latest-round provenance for the ChatGPT-authored lane.
description: F253-owned review semantics and persisted carrier consumed by F289 without making a visible thread or Git ledger the truth root.
description_source: model
description_author: cat-idwxwjba
description_generated_by: cat-idwxwjba@gpt-5
description_generated_at: "2026-08-08T18:00:00+08:00"
doc_kind: architecture
created: 2026-08-08
canonical_features: [F253, F289]
code_anchors:
  - packages/shared/src/types/review-round.ts
  - packages/api/src/domains/review-coordination/ReviewRoundStore.ts
  - packages/api/src/domains/review-coordination/RedisReviewRoundStore.ts
doc_anchors:
  - docs/features/F253-qc-loop.md
  - docs/features/F289-chatgpt-desktop-development-loop.md
  - docs/design/F289-chatgpt-desktop-development-loop.md
static_scan_hints: [ReviewRound, ReviewPrivateDraft, ReviewConsensusFinding, consensus_ready, review-round:work-current]
cited_by:
  - {feature: F289, date: 2026-08-08, delta: "replace conversational/markdown-only round state with a durable exact-SHA carrier"}
---

# Review Coordination

Architecture cell: review-coordination

## Canonical Owner

F253 owns the independent-first review protocol: immutable exact-SHA roster, reviewer-private drafts, the atomic independent barrier, cross-review completion, the designated recorder, consensus verdict, and stable finding closure. F289 consumes this truth to connect Cat Café review with ChatGPT Desktop; it does not copy the protocol into a project adapter or visible Review Hub thread.

## Durable Invariants

1. One project/work/full-SHA tuple identifies one immutable round; changing the attempt, author, roster, or recorder conflicts instead of rewriting history.
2. A round has at least two distinct named reviewer cats, and a cat author cannot be in its roster. ChatGPT Desktop remains a non-cat external author actor.
3. Before every reviewer finishes independently, only a reviewer may read their own draft. Barrier-safe reads expose progress but no draft content.
4. The independent barrier and cross-review completion use optimistic versioning plus Redis atomic writes. A concurrent duplicate gets one winner.
5. Only the designated recorder can publish consensus, and only after every reviewer finishes cross-review.
6. Approval requires green checks and zero open findings across the work. A new exact-SHA round makes older approval non-current without deleting history.
7. Round, draft, receipt, index and finding records default to TTL=0. A visible thread/chat deletion never deletes them.
8. Every consensus finding carries non-empty frozen-design references and an explicit `plan_conformance` or `architecture_decision` scope. Review cannot silently introduce out-of-plan work; serious architecture conflicts are escalated to the F289 user-decision gate.

## Extend By

- Add authenticated routes/tools through server-derived reviewer identity; never accept a caller-supplied cat as authority.
- Project a new round into the backlog feature's reusable Review thread, while retaining the Redis carrier as truth; accept the legacy project Hub only for historical in-flight callbacks.
- Add telemetry as a read-only consumer of completed rounds and finding transitions.

## Do NOT Unify With

- Do not use a Git ledger, PR comment, Issue, thread message, or chat context as the canonical round state.
- Do not expose reviewer-private drafts through Desktop/read-only projections before the barrier.
- Do not let the author submit review verdicts or let a non-recorder publish consensus.
- Do not treat an approved older SHA as merge authorization after a newer round exists.

## Static Scan Hints

Watch for `ReviewRound`, `ReviewPrivateDraft`, `ReviewConsensusFinding`, `designRefs`, `architecture_decision`, `review-round:`, exact-SHA normalization, reviewer/author identity checks, barrier reads, and any alternative round/finding ledger under F289.
