---
cell_id: desktop-development-loop
title: Desktop Development Loop
summary: F289-owned project binding, one reusable Review Hub view, Desktop session/workspace projection, and guarded merge rollout over existing managed-work and review truth.
description: Project-scoped bridge between Cat Café design/review and ChatGPT Desktop implementation, without becoming a second workflow engine.
description_source: model
description_author: cat-idwxwjba
description_generated_by: cat-idwxwjba@gpt-5
description_generated_at: "2026-08-07T16:00:00+08:00"
doc_kind: architecture
created: 2026-08-07
canonical_features: [F289]
code_anchors:
  - packages/shared/src/types/desktop-development-loop.ts
  - packages/shared/src/types/external-project.ts
  - packages/api/src/domains/projects/external-project-store.ts
  - packages/api/src/domains/projects/project-review-hub-service.ts
  - packages/api/src/domains/desktop-development-loop/desktop-session-store.ts
  - packages/api/src/routes/desktop-development-loop.ts
  - packages/web/src/components/mission-control/DesktopDevelopmentPanel.tsx
  - packages/web/src/components/mission-control/ImportProjectModal.tsx
doc_anchors:
  - docs/features/F289-chatgpt-desktop-development-loop.md
  - docs/design/F289-chatgpt-desktop-development-loop.md
  - feature-specs/2026-08-05-chatgpt-desktop-development-loop.md
static_scan_hints: [DesktopDevelopmentProjectBinding, ProjectReviewHub, chatgpt-desktop-dev, successfulManualPilotCount, desktop-dev-loop, ReviewRound]
cited_by:
  - {feature: F289, date: 2026-08-07, delta: "new project binding and deterministic one-Review-Hub foundation"}
---

# Desktop Development Loop

Architecture cell: desktop-development-loop

## Canonical Owner

F289 owns the project-scoped adapter that connects Cat Café design/review to ChatGPT Desktop implementation. Its canonical state is limited to the Desktop development policy attached to an existing ExternalProject, one deterministic Review Hub view per project, Desktop session/workspace bindings, Resume Packet projection, and the two-successful-pilot merge rollout gate.

The cell is not a workflow identity root. F275 remains canonical for whole work, ordered attempts, evidence and terminal state. F253 remains canonical for exact-SHA independent review, barrier, consensus and finding closure. F211 owns runtime-session provenance, while F286 owns MCP inventory and authority.

## Durable Invariants

1. A project has at most one Desktop development binding and one deterministic Review Hub identity.
2. Review Hub soft deletion restores the same thread identity; a code SHA or delivery cycle never creates a new visible Hub.
3. Project policy updates use optimistic versioning. Automatic merge is illegal before two distinct merged-and-accepted manual pilot works.
4. The local checkout path remains a private project field and is absent from Desktop public projections.
5. Desktop author identity is distinct from reviewer CatIds and cannot appear in the reviewer roster.
6. Chat/lease disappearance never deletes work, ReviewRound, evidence or pilot state.
7. Missing F275/F253/F211/F286 capabilities fail closed at their mutation boundary; F289 does not invent fallback identities or ledgers.

## Extend By

- Add session/workspace state as a project/work-scoped F289 adapter that references F275 IDs and F211 provenance.
- Add ReviewRound persistence through the F253 review-coordination boundary; expose only barrier-safe consensus to Desktop.
- Add lifecycle tools only through the F286 strict `desktop-dev-loop` profile with server-derived actor, scope and legal actions.
- Add optional repository publication adapters as downstream consumers of consensus; never make them core round-completion requirements.

## Do NOT Unify With

- Do not use thread ID, ChatGPT chat ID, branch, PR, TaskItem or scheduled-task reference as work identity.
- Do not turn F167 cat baton custody into the Desktop execution lease.
- Do not let F289 own or infer F275 attempt order/terminal state.
- Do not let visible Hub/chat deletion cascade into durable lifecycle deletion.
- Do not expose shell, arbitrary filesystem writes, Git merge/deploy or credentials through the MCP profile.

## Static Scan Hints

Watch for `DesktopDevelopmentProjectBinding`, `project-review-hub:`, `chatgpt-desktop-dev`, `successfulManualPilotCount`, `ReviewRound`, `ResumePacket`, new work/job identity fields, local path leakage, and any code that creates a Review thread per SHA.
