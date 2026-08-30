---
cell_id: mission-hub-projects
title: Mission Hub Project Workspaces
summary: First-class Cat Café and registered-project navigation, project-scoped backlog projection, and common Feature workflow surfaces without owning their underlying lifecycle engines.
description: Mission Hub project registry and scope projection over the home backlog and ExternalProjectStore.
description_source: human
description_author: co-creator
description_generated_by: cat-idwxwjba@gpt-5.6
description_generated_at: "2026-08-25T01:45:00-07:00"
doc_kind: architecture
created: 2026-08-25
canonical_features: [F049, F058, F076, EXT-002]
code_anchors:
  - packages/shared/src/types/external-project.ts
  - packages/shared/src/types/backlog.ts
  - packages/api/src/domains/projects/external-project-store.ts
  - packages/api/src/routes/external-projects.ts
  - packages/api/src/routes/backlog.ts
  - packages/web/src/components/mission-control/MissionControlPage.tsx
  - packages/web/src/components/mission-control/ProjectWorkspaceNav.tsx
  - packages/web/src/components/mission-control/project-workspace.ts
  - packages/web/src/components/mission-control/ImportProjectModal.tsx
doc_anchors:
  - docs/features/F049-mission-control-backlog-center.md
  - docs/features/F058-mission-control-enhancements.md
  - docs/features/F076-mission-hub-cross-project.md
  - docs/extensions/EXT-002-mission-hub-project-workspaces.md
  - docs/design/EXT-002-mission-hub-project-workspaces.md
  - feature-specs/2026-08-25-mission-hub-project-workspaces.md
static_scan_hints: [ExternalProject, projectId, ProjectWorkspaceRef, MissionControlPage, ProjectWorkspaceNav, import-active-features, import-backlog]
cited_by:
  - {feature: EXT-002, date: 2026-08-25, delta: "project becomes Mission Hub's first-class coordinate; ExternalProject registry leaves the Desktop adapter boundary"}
---

# Mission Hub Project Workspaces

Architecture cell: mission-hub-projects

## Canonical Owner

This cell owns how Mission Hub enumerates Cat Café and registered projects, selects one current project, derives the correct project-scoped backlog endpoints, and projects the same Feature/workflow UI over that scope. `ExternalProjectStore` is the durable registry for non-home projects. The Cat Café home backlog remains storage-compatible as items without `projectId`, while the UI presents it as an explicit built-in project.

The cell does not own Feature lifecycle, backlog transitions, Thread identity, Review, Workflow SOP or dependency semantics. Those existing domains remain canonical; this cell supplies the project scope through which Mission Hub consumes them.

## Durable Invariants

1. Cat Café is always a visible built-in project. A registered project is visible only to its owning user.
2. Project registration and backlog data are durable with TTL=0. Navigation preferences may be local and lossy because they are not business truth.
3. Every list, count, selection, detail and mutation shown in a project workspace is derived from the same active project scope.
4. An external project mutation derives project ownership server-side. Client-supplied project IDs or paths never bypass registry ownership.
5. Same-named Feature IDs in different projects are distinct. Backlog item binding is canonical; an unscoped Feature-ID lookup must not cross projects.
6. A late result from a previous project selection cannot overwrite the current workspace's data, error, loading or selection.
7. Optional project adapters such as EXT-001 may consume project identity, but cannot own or redefine the project registry or common Feature workflow.
8. Hiding an optional adapter from the default projection never deletes its persisted state, evidence or history.

## Extend By

- Add a common project view by consuming the current `ProjectWorkspaceRef` and existing domain APIs.
- Add a project-specific capability as an explicit opt-in surface that preserves the common Feature workflow and references the project ID.
- Add project-aware document or Thread resolvers only when the server can derive and validate the project source from the registry.

## Do NOT Unify With

- Do not make project name, source path, Feature ID, tab key or localStorage value a workflow identity.
- Do not copy an external repository into Cat Café or write governance files merely to make it appear in Mission Hub.
- Do not turn EXT-001/Desktop policy into required project metadata.
- Do not duplicate backlog, Thread, Review or SOP state in a project-specific store.
- Do not infer a project from list order or special-case `Traqen` as the default.

## Static Scan Hints

Watch `ExternalProject`, `projectId`, `ProjectWorkspaceRef`, `activeProject`, `MissionControlPage`, `ProjectWorkspaceNav`, `/api/backlog/items`, `/api/external-projects/:id/import-backlog`, project-scoped create endpoints, unscoped Feature-ID queries and navigation localStorage keys.
