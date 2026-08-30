# EXT-002 Mission Hub Project Workspaces — Implementation Plan

> **For 砚砚/CodeX:** execute in `/Volumes/WorkSSD/cat-cafe-mission-hub-project-workspaces` using the worktree, TDD, console-dev, browser-preview, quality-gate, request-review and merge-gate workflows. Development data uses Redis 6398 only; never run unmerged code in `/Volumes/WorkSSD/cat-cafe-runtime` or against Redis 6399.

**Goal:** make Project the first-class Mission Hub coordinate so Cat Café, Traqen and future registered projects share one Feature/workflow experience, while removing EXT-001 from the default product projection without deleting its history.

**Architecture:** introduce a small `ProjectWorkspaceRef` UI projection over the existing Cat Café home backlog and `ExternalProject` registry. The active project selects endpoints and scopes all derived UI state. Reuse existing `FeatureRowList`, `DependencyGraphTab`, Suggestion, SOP and Thread components; do not add a parallel workflow engine. External mutations derive ownership from the server registry. EXT remains a dormant compatibility adapter.

**Finish line:** focused API/Web tests and an isolated browser journey prove Cat Café → Traqen → Cat Café switching, project-scoped import/create/workflow, no cross-project Feature/Thread leakage, no EXT UI and no stale-response overwrite; a non-author reviewer returns no blocking findings.

Architecture cell: `mission-hub-projects`

Map delta: `new cell required`

Why: project registry, project-scoped backlog projection and common Mission Hub navigation become one canonical boundary; the Desktop adapter no longer owns `ExternalProject`, its store or project import UI.

## State and event contract

| State | Authority | Persistence | Invariant |
|-------|-----------|-------------|-----------|
| Registered projects | `ExternalProjectStore` | Redis TTL=0 | caller sees only same-user projects |
| Cat Café project | server/application built-in constant | code | always available even if external list fails |
| Project backlog | `BacklogStore` | Redis TTL=0 | home items have no projectId; external items match owned projectId |
| Active project/view | browser navigation preference | localStorage, optional | never treated as business truth; invalid value falls back to Cat Café/features |
| Selected item | MissionControl store projection | in-memory | null or belongs to current project items |
| Async list result | current request sequence | in-memory | only latest project request may commit data/error/loading |

Events:

```text
projects loaded → resolve saved/fallback active project
select project → persist preference → invalidate old request → load scoped items
select view → persist per-project preference → render scoped features/dependencies
import backlog → choose endpoint from active ProjectWorkspaceRef → reload same scope
quick create → choose ownership-checked endpoint → reload same scope
```

## Task 0 — Documentation and ownership boundary

**Files**

- Create `docs/extensions/EXT-002-mission-hub-project-workspaces.md`
- Create `docs/design/EXT-002-mission-hub-project-workspaces.md`
- Create `docs/architecture/ownership/cells/mission-hub-projects.md`
- Modify `docs/architecture/ownership/cells/desktop-development-loop.md`
- Modify `docs/features/F076-mission-hub-cross-project.md`
- Modify `docs/ROADMAP.md`
- Modify `packages/web/src/lib/capability-tips.seed.json`
- Regenerate `docs/architecture/ownership/README.md`

**Verify**

```bash
node docs/architecture/ownership/generate-readme.mjs
pnpm check:features
pnpm check:capability-tips
pnpm check:co-creation-docs-lane
```

Commit and push this docs-only truth update on `main` before creating the code worktree.

## Task 1 — Project workspace selection model

**Files**

- Create `packages/web/src/components/mission-control/project-workspace.ts`
- Create `packages/web/src/components/mission-control/ProjectWorkspaceNav.tsx`
- Add focused unit tests under `packages/web/src/components/mission-control/__tests__/`

**Red**

- Cat Café is always first and external projects follow in registry order;
- old `active-tab=features|dependencies` migrates to Cat Café plus the matching view;
- old external project ID migrates to that project;
- missing/deleted saved project falls back to Cat Café, not the first external project;
- per-project view preference is isolated and invalid values fall back to features;
- EXT/custom capability fields are absent from the projection.

**Green**

- define discriminated `ProjectWorkspaceRef` (`home` / `external`);
- centralize list/create/import endpoints and preference keys;
- render semantic project navigation with `aria-current`, scroll-safe narrow layout and shared view tabs.

## Task 2 — Ownership-checked external quick create

**Files**

- Modify `packages/api/src/routes/external-projects.ts`
- Modify/add external project route tests

**Red**

- POST project backlog item persists the owned `projectId`;
- unknown and cross-user project return 404;
- missing/invalid body returns 400;
- payload cannot override projectId or userId;
- restart/store round-trip retains item.

**Green**

- reuse the common backlog create validation contract or an equivalent shared schema;
- add `POST /api/external-projects/:id/backlog/items` after `requireOwnedProject`;
- server injects userId and projectId.

## Task 3 — MissionControlPage project-scoped data path

**Files**

- Modify `packages/web/src/components/mission-control/MissionControlPage.tsx`
- Modify `packages/web/src/components/mission-control/FeatureRowList.tsx`
- Modify `packages/web/src/components/mission-control/FeatureRow.tsx`
- Modify `packages/web/src/components/mission-control/ThreadSituationPanel.tsx` only if required to disable unscoped title matching
- Modify `packages/web/src/components/__tests__/mission-control-page.test.ts`

**Red**

- first level renders Cat Café and Traqen projects; second level renders shared features/dependencies;
- initial project is Cat Café unless a valid saved project exists;
- active project fetches the correct backlog endpoint and scopes counts/selection;
- external project does not call home-only feature-doc detail or unscoped Feature-ID thread search;
- backlog-bound threads still render for external items;
- project switch clears/guards previous data and ignores late responses including late `finally`;
- create/import use the active project's endpoint and remain on that project;
- `feature-kind:extension` / `EXT-*` items are excluded from the default projection;
- no `ExternalProjectTab` / `开发闭环` path is rendered.

**Green**

- move project selection before item loading;
- protect the complete load state with request sequence and/or AbortController;
- derive `visibleItems` once and use it for counts, selection, dependency graph and right panels;
- add a project-aware option to `FeatureRowList`/`FeatureRow` so external rows do not read Cat Café docs;
- only perform title-based Thread matching for Cat Café until a server-owned project-aware resolver exists; exact backlog bindings remain available for all projects;
- keep existing item-ID mutations unchanged because store ownership already binds them to the same user.

## Task 4 — Remove EXT from the new project entry experience

**Files**

- Modify `packages/web/src/components/mission-control/ImportProjectModal.tsx`
- Modify its tests
- Keep EXT-001 shared types, routes, stores and historical components intact

**Red**

- modal does not render Desktop, GitHub repository, Review roster, push or PR fields;
- POST body contains only name/sourcePath/backlogPath/description;
- importing a project with existing legacy Desktop binding does not delete or overwrite that binding;
- Mission Hub default view contains no EXT feature or Desktop development label.

**Green**

- reduce modal state to canonical project registration fields;
- remove `useCatData` and desktop form builder dependency from this entry point;
- leave legacy `ExternalProjectTab`, `DesktopDevelopmentPanel` and API compatibility paths unmodified but unreachable from EXT-002 navigation.

## Task 5 — Focused verification and refactor

**Commands**

```bash
pnpm --filter @cat-cafe/api build
node --test packages/api/test/external-projects.test.js
pnpm --filter @cat-cafe/web test -- mission-control-page project-workspace ImportProjectModal
pnpm --filter @cat-cafe/web lint
pnpm check:features
pnpm check:capability-tips
```

- keep new UI modules below the 350-line warning threshold;
- run formatter only on touched files;
- inspect diff for accidental EXT data/schema deletion and production Redis/port references.

## Task 6 — Isolated real-page verification

**Environment**

- Worktree: `/Volumes/WorkSSD/cat-cafe-mission-hub-project-workspaces`
- Redis: `redis://localhost:6398`
- API/Web: use non-runtime ports selected by the repo launcher (target 3102/5102 when free)

**Journeys**

1. Open Mission Hub and confirm Cat Café is the explicit current project.
2. Select Traqen and confirm F007/task/status are Traqen-scoped.
3. Toggle features/dependencies inside both projects.
4. Create/import in Traqen and verify the item carries Traqen projectId.
5. Switch rapidly Cat Café ↔ Traqen and verify no stale list/error/selection.
6. Open project import modal and confirm no EXT/Desktop controls.
7. Repeat key journey at 375px width and keyboard-only navigation.

Capture screenshots/notes in the quality-gate evidence; do not mutate production data.

## Task 7 — Quality and independent review

- Run `quality-gate` against every EXT-002 AC.
- Run `fresh-context-review` if selected by risk routing.
- Route exact HEAD to a non-author reviewer with emphasis on cross-project leakage, ownership validation, stale async state and EXT history preservation.
- Resolve all P1/P2 findings through `receive-review`, rerun focused gates, then use `merge-gate`.
- After merge, verify the merged revision in an isolated acceptance environment before updating EXT-002 to done.
