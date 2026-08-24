---
cell_id: desktop-development-loop
title: Desktop Development Loop
summary: EXT-001-owned project binding, one shared authoritative design branch plus per-feature design documents and discussion/review views, Desktop task/session projection, and guarded merge rollout over existing managed-work and review truth.
description: Project-scoped bridge between Cat Café design/review and ChatGPT Desktop implementation, without becoming a second workflow engine.
description_source: model
description_author: cat-idwxwjba
description_generated_by: cat-idwxwjba@gpt-5
description_generated_at: "2026-08-07T16:00:00+08:00"
doc_kind: architecture
created: 2026-08-07
canonical_features: [EXT-001]
code_anchors:
  - packages/shared/src/types/desktop-development-loop.ts
  - packages/shared/src/types/external-project.ts
  - packages/api/src/domains/projects/external-project-store.ts
  - packages/api/src/domains/projects/project-review-hub-service.ts
  - packages/api/src/domains/desktop-development-loop/desktop-session-store.ts
  - packages/api/src/domains/desktop-development-loop/design-branch-resolver.ts
  - packages/api/src/domains/desktop-development-loop/review-loop-policy.ts
  - packages/api/src/domains/desktop-development-loop/codex-desktop-task-launcher.ts
  - packages/api/src/routes/desktop-development-loop.ts
  - packages/web/src/components/mission-control/DesktopDevelopmentPanel.tsx
  - packages/web/src/components/mission-control/ImportProjectModal.tsx
doc_anchors:
  - docs/extensions/EXT-001-chatgpt-desktop-development-loop.md
  - docs/design/EXT-001-chatgpt-desktop-development-loop.md
  - feature-specs/2026-08-05-chatgpt-desktop-development-loop.md
static_scan_hints: [DesktopDevelopmentProjectBinding, ProjectDesignAuthorityView, FeatureDesignDocumentsView, ProjectReviewHub, chatgpt-desktop-dev, successfulManualPilotCount, desktop:development-loop, ReviewRound]
cited_by:
  - {feature: EXT-001, date: 2026-08-07, delta: "new project binding and deterministic one-Review-Hub foundation"}
---

# Desktop Development Loop

Architecture cell: desktop-development-loop

## Canonical Owner

EXT-001 owns the project-scoped adapter that connects Cat Café design/review to ChatGPT Desktop implementation. Its canonical state is limited to the Desktop development policy attached to an existing ExternalProject, one authoritative design-branch binding plus deterministic discussion/review views per imported backlog feature, Desktop task/session/workspace bindings, Resume Packet projection, and the two-successful-pilot merge rollout gate. The discussion view is context only; the validated branch commit is the design authority.

The cell is not a workflow identity root. F275 remains canonical for whole work, ordered attempts, evidence and terminal state. F253 remains canonical for exact-SHA independent review, barrier, consensus and finding closure. EXT-001 owns only the external Desktop session binding over those IDs. F211 remains canonical for Cat runtime sessions with CatId/agent-key/Antigravity provenance and is intentionally not extended for the Desktop developer external actor. F286 owns MCP inventory and authority.

## Durable Invariants

1. A project has at most one Desktop development binding and one authoritative local committed design branch; each imported backlog feature selects one or more design documents from it and has one deterministic discussion thread and one deterministic Review thread.
2. Feature-thread soft deletion restores the same identity; a code SHA or delivery cycle never creates another visible Review thread for that feature. The legacy project Review Hub remains callback-compatible for historical in-flight rounds only.
3. Project policy updates use optimistic versioning. Automatic merge is illegal before two distinct merged-and-accepted manual pilot works, and the second accepted pilot atomically enables it.
4. The local checkout path remains a private project field and is absent from Desktop public projections.
5. Desktop author identity is distinct from reviewer CatIds and cannot appear in the reviewer roster.
6. Chat disappearance never expires the binding and never deletes work, ReviewRound, evidence or pilot state.
7. Missing F275/F253/F286 capabilities fail closed at their mutation boundary; EXT-001 does not invent fallback identities or ledgers, and never falls through to F211 by impersonating a Cat session.
8. A changes-requested round cannot start attempt 16/31/... without the matching user continuation evidence, and cannot pass an unresolved architecture-decision finding without a persisted user decision.
9. A Desktop wake remains in the durable outbox until the deterministic delivery ID or objective is observable in an actual bound-task turn; IPC acknowledgement or goal metadata alone is insufficient. A dormant binding is opened in place with bounded owner-discovery retry and is never replaced.
10. Every implementation and Review wake carries the exact shared design-branch commit plus the feature's selected design documents. A serious design disagreement pauses the loop; continuing with a changed design requires that branch SHA to advance, while keeping the original requires the reviewed SHA to remain current.

## Extend By

- Add session/workspace state as a project/work-scoped EXT-001 adapter that references F275 IDs and preserves external-actor provenance independently from F211 Cat sessions.
- Add ReviewRound persistence through the F253 review-coordination boundary; expose only barrier-safe consensus to Desktop.
- Add lifecycle tools only through the F286 strict `desktop:development-loop` profile with server-derived actor, scope and legal actions.
- Add optional repository publication adapters as downstream consumers of consensus; never make them core round-completion requirements.

## Do NOT Unify With

- Do not use thread ID, ChatGPT chat ID, branch, PR, TaskItem or scheduled-task reference as work identity. The design branch is an authority input, not a replacement work ID.
- Do not turn F167 cat baton custody into a Desktop execution lease; Desktop ownership is fenced by epoch.
- Do not let EXT-001 own or infer F275 attempt order/terminal state.
- Do not let visible Hub/chat deletion cascade into durable lifecycle deletion.
- Do not expose shell, arbitrary filesystem writes, Git merge/deploy or credentials through the MCP profile.

## Static Scan Hints

Watch for `DesktopDevelopmentProjectBinding`, `ProjectDesignAuthorityView`, `FeatureDesignDocumentsView`, `designExactSha`, `project-feature-plan:`, `project-feature-review:`, legacy `project-review-hub:`, `chatgpt-desktop-dev`, `successfulManualPilotCount`, `review_continuation_approved`, `architecture_decision_recorded`, `ReviewRound`, `ResumePacket`, new work/job identity fields, local path leakage, and any code that creates a Review thread per SHA.
