---
feature_ids: [F063, F307]
doc_kind: note
topics: [workspace, file-refresh, regression]
created: 2026-09-21
---

# Workspace displayed document does not follow disk changes

Reporter: operator, source `thread_mtqkycp918zlran6#0001789974264565-000431-401710ef`.
Implementation thread: `thread_muawnsb8bz9uxrtc`.

## Diagnosis capsule

| Field | Evidence / plan |
|---|---|
| Symptom | Disk and Git contain document v0.3.1, visible Workspace remains v0.2 until switching worktrees. |
| Evidence | Source report verified disk/Git blobs; independently inspected actual render chain: WorkspacePanel → F307FileOwnerSurface → WorkspaceFileViewer. Runtime API 3004, PID 45283, started 2026-09-18 08:40:24 PDT, runtime HEAD 38781d234c60199a592750faef3766e67c4164fc (08:20:54 PDT); process after target=yes; current api.2026-09-21.1.log had 1,398 PID matches. File owner and watcher sources match canonical main. |
| Root cause | F307FileOwnerSurface owns a separate GET-only file state. The old useWorkspace watcher updates state no renderer consumes; dirty/conflict callbacks are also absent from the actual viewer. Real-owner regression reproduced a visible version-1 after version-2 notification. |
| Diagnosis strategy | Render the real owner component, drive subscription/reopen/recovery, assert content and draft. Exercise real file watcher with isolated temporary files and atomic replacement. |
| Timeout | If this component-level counterexample does not reproduce, follow HTTP responses and rendered props before expanding scope. |
| Warning | An event or navigation acknowledgment is not body freshness evidence. No runtime/Traqen writes; no production stores. |
| User interaction | Same file updates automatically; dirty draft remains, existing external-change banner offers reload/ignore. |
| Acceptance | Red→green on actual content owner; browser DOM equals disk after write/rename; same-path reopen, reconnect, dirty edits, request ordering. Independent review and merged isolation acceptance remain separate pending stages. |

## Ownership and implementation plan

Architecture cell: `hub-action-surface`.
Map delta: none — F063 owns file contents/lifecycle; F307 owns working-set layout.
Why: restore file freshness in the actual F063 owner adapter and retire the orphan content subscription.
Canonical source: `packages/web/src/components/workbench/F307FileOwnerSurface.tsx#ResolvedFileOwnerSurface`.
Consumer evidence: `rg -n 'useWorkspace\(|F307FileOwnerSurface|pendingExternalSha' packages/web/src` identifies the metadata host, actual file renderer, and existing conflict affordance.
Claim guard: owner-content regression asserts visible versions and dirty draft preservation; fails when subscriptions only update the unused legacy hook.

1. Reproduce against the real owner and document observable failures.
2. Bind one file lifecycle to descriptor worktree/path, including subscription, recovery, explicit reopen, stale reads and dirty-edit protection.
3. Verify temporary disk writes/atomic replacements through browser DOM, run related tests/typecheck, request non-author local review.
4. Merge through canonical fork policy, validate merged code in isolated acceptance; runtime activation is separate and requires explicit authorization.

Canonical repository: `https://github.com/qianfengXY/clowder-ai`; `main` tracks `fork/main`, verified remote head `fbafc8b46860b15856a962173c2625c617614666`. `origin` is upstream and push-blocked, not this installation's integration base. No active fork PR touches this scope; F063/F131/F307 discovery returned no owner thread to notify.

## Fix and failure-mode sweep

- Move file content/subscription to `useWorkspaceFile`, consumed by the actual `F307FileOwnerSurface`; remove unused legacy content state and the tests that copied its handler instead of exercising production code.
- Descriptor worktree/path is the owner boundary. Reopening a descriptor, reconnecting, foregrounding and returning online revalidate through the existing bounded API client. Invalidations use `afterCurrentGet` so a stale in-flight response cannot consume the only change notification. Request sequencing and keyed owner mounts prevent old responses crossing files/worktrees.
- Keep the actual editor mounted during background reads and read failures. Dirty drafts retain their base SHA and show the existing external-change banner; only successful explicit reload discards a draft. Explicit reload also works when disk has reverted to the original content.
- Browser sweep found a second defect: `CodeViewer` included `scrollToLine` in editor-construction dependencies. Same-file line navigation destroyed unsaved text. Reproduce: edit → reopen at another line → observed original disk body instead of draft. Scroll now updates the existing editor; the same browser counterexample passes.
- Backend watcher already monitors parent directories, checks subscription SHA, and polls to recover missed atomic-save notifications. The real watcher survived write → atomic rename → subsequent write in the browser test; no backend watch, security or event-schema change was needed.

## Verification evidence

Development checkout: `/Volumes/WorkSSD/cat-cafe-workspace-live-refresh`, branch `fix/workspace-live-refresh`.
Fixtures bind ephemeral loopback ports and register only newly created temporary files. No Redis connection or runtime API is used.

- RED: new real-owner suite on unchanged code displayed version-1 after a version-2 change, did not subscribe on reconnect, did not refresh on same-path open, and omitted the dirty conflict banner.
- RED: actual Chromium/CodeMirror test lost `my unsaved draft` when reopening the same file at line 2. GREEN after separating editor creation from scroll navigation.
- RED: explicit reload after disk reverted to the original body retained a draft. GREEN after resetting the editor only upon a successful explicit discard.
- `env -u NODE_ENV pnpm --filter @cat-cafe/web exec vitest run src/components/workbench/__tests__/F307FileOwnerSurface.refresh.test.tsx src/components/workbench/__tests__/F307FilesOwnerSurface.test.tsx src/hooks/__tests__/useWorkspace-worktrees.test.tsx src/components/workspace/__tests__/selection-action-position.test.ts src/components/__tests__/selection-annotation-action.test.tsx` — 34 tests passed, including 12 new owner tests.
- Related renderer/adapters/navigation suite also passed: 43 tests before the final explicit-discard regression was added; affected owner tests were rerun afterward.
- `pnpm --filter @cat-cafe/web test:workspace-live-refresh` — real browser + production file renderer/CodeMirror/apiFetch/Socket.IO/watcher; DOM equals disk after 8 versions, including write, atomic replacement, subsequent write, reconnection and explicit reopen with notifications suppressed. Draft and conflict choices verified. Final GREEN URL `http://127.0.0.1:55628` (ephemeral fixture, stopped after test).
- `pnpm --filter @cat-cafe/web exec tsc --noEmit --incremental false` — final rerun passed (exit 0).
- Biome and `git diff --check` passed. `pnpm check:capability-tips` passed with existing catalog warnings; existing Workspace navigation tip and external-change affordance cover this repair. No new action/tip or visual redesign.
- No `designs/` directory exists in this checkout. This change preserves the existing viewer/banners; browser assertions verify behavior, not a new visual design.

Five-axis risk: user-visible behavior and editor lifecycle; no production data/persistence changes, auth/security policy changes, public contract changes, new dependencies, or irreversible operation. Targeted tests, web typecheck, real browser exercise and non-author local review selected. Existing unrelated browser-runner wrapper cannot load missing `scripts/lib/process-resource-lease.mjs`; this focused test runs directly with the already-installed API `tsx`, and does not claim a full-repository gate.

The skill's warning-only `pnpm check:architecture-ownership` command is not defined in this checkout. Ownership evidence is the explicit F063/F307 source/spec census above; no successful mechanical ownership check is claimed.

## Release boundary

Code delivery is not live activation. Independent review, canonical PR merge, and isolated merged acceptance must be recorded on the task/PR. Runtime remains unchanged until explicitly authorized activation through the project's canonical start workflow. The final source-thread report must distinguish merged acceptance from what the user's current runtime has loaded.
