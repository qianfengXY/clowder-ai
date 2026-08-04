# Review Request: Capability drift remote false positives

Review-Target-ID: fix-agent-hook-health-cpolar
Branch: fix/agent-hook-health-cpolar
Code commit: `976c22352`

## What

Skill / MCP drift checks now report whether a requested project scope is initialized. The web client keeps checking historical paths for visibility, but excludes paths without `.cat-cafe` from anomaly aggregation and sync targets. Through cpolar or another non-loopback hostname, drift remains readable while all write controls are hidden.

## Why

The operator's remote Settings page said “检测到 7 处 Skill 异常”. The number represented seven scopes, not seven Skill issues: six historical thread paths were no longer initialized projects and were each contributing 96 false-positive Skill issues. The remaining Traqen project had 192 genuine conflicts and has already been synchronized through the guarded local API.

The previous UI also showed sync controls remotely even though the API correctly rejected those writes with 403. This change aligns the UI with that existing security boundary without weakening it.

## Original Requirement

> “我现在需要怎么才能解决这个异常显示？”

Context: cpolar displayed “检测到 7 处 Skill 异常” and “Capability writes require direct localhost Hub access”.

## Tradeoff

Historical paths are still probed, so a project becomes visible again if `.cat-cafe` is restored. They are omitted only while the API explicitly reports `initialized: false`. The localhost classifier is deliberately strict: `localhost`, IPv6 loopback, and `127/8` are writable; tunneled or custom hostnames are read-only.

## Architecture Ownership

Architecture cell: capability synchronization boundary (F228 / F249)
Map delta: none
Why: this extends the existing drift response, hook, and banner. It adds no Store, Queue, Router, Adapter, Dispatcher, Binding, or new extension point.

Please verify:

- uninitialized historical paths cannot contribute issue counts or receive sync writes;
- an absent `initialized` field remains backward compatible;
- the browser hostname classifier does not treat cpolar/custom hosts as local;
- remote write controls are absent while the existing API 403 guard remains authoritative;
- the new wording distinguishes scope count from individual issue count.

## Open Questions

None blocking. The optional `initialized` field is intentional for rolling web/API deployment compatibility.

## Next Action

Review code commit `976c22352` plus this request note and return an APPROVE or REQUEST-CHANGES verdict with P1/P2/P3 severities.

## Review Sandbox

- Path: `/private/tmp/cat-cafe-review/fix-agent-hook-health-cpolar/{reviewer}`
- Start command: `pnpm review:start`
- Suggested ports: any non-reserved pair
- Storage: memory only

## Verification Evidence

- TDD red states were observed for missing remote-readonly copy, incorrect aggregation, and missing API initialization metadata.
- Web banner/hostname tests: 9/9 passed.
- Skill aggregation and sync regressions: 4/4 passed.
- MCP sync-all regression: 1/1 passed.
- API drift suites: 18/18 passed.
- API initialization metadata: 2/2 passed.
- Web `tsc --noEmit`: passed.
- API build and repository recursive build: passed.
- `pnpm check`: passed.
- `pnpm lint`: passed with pre-existing warnings only.
- Capability-tip validation: passed.
- `git diff --check`: clean.
- Isolated memory-mode browser smoke test: Settings → Skill 管理 loaded with 0 console errors and rendered “✓ 全部 Skill 同步一致”.

Full `pnpm test` is not green in this historical worktree. Failures are unrelated baseline/environment gaps: missing untracked `.claude` and root-document fixtures, absent `tmux`, and suites that depend on the host capability baseline. Relevant suites, builds, type checks, Biome checks, and browser smoke validation are green.

## Dogfood State

- `/Volumes/WorkSSD/projects/Traqen`: Skill drift 0 after guarded local sync.
- 192/192 managed Skill links now point to the persistent runtime skill source.
- Six historical paths without `.cat-cafe` were not modified.
- Remote capability write guard remains closed.

[砚砚/GPT-5.6🐾]
