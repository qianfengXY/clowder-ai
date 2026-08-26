# F306 post-merge acceptance — APPROVED

- **Exact merged revision:** `fork/main@2ab1335c70f9bd29d1b3ee59b2c86cd280362418`
- **Environment:** isolated worktree, web `127.0.0.1:5172`, API `127.0.0.1:3172`, isolated Redis `6328`, synthetic `default-user` only.
- **Excluded:** dormant live runtime, production/user data, runtime configuration, repository files, historic failure evidence.

| Journey | Result | Evidence |
| --- | --- | --- |
| Project-first navigation | PASS | Cat Café and Traqen appeared on one first-level control; Cat Café was default. |
| Common workspace & no EXT surface | PASS | Both projects exposed Features, Dependencies and right workflow tabs; import form had exactly four project fields and no EXT/Desktop configuration. |
| Scope round-trip | PASS | Cat Café → Traqen → Cat Café left no external record or Mission Hub error in the home surface. |
| P1: same-feature isolation | PASS | A synthetic Traqen item tagged `feature:f305` (an actual Roadmap import candidate) was deep-equal before/after Cat Café import; the home F305 item was present and unbound. |
| P2: long import | PASS | Real browser POST lasted **68,064 ms**. It stayed pending past 30 s, returned 200, and the Cat Café list reloaded without manual refresh. |
| Narrow/accessibility | PASS | At 375×812, project selectors, view controls, and import action stayed visible; Tab moved focus from Cat Café to Traqen; `aria-current` represented the active project. |

## Focused regression checks

- API `test/backlog-routes.test.js`: **34/34 pass**, including `home backlog import never mutates project-bound items`.
- Web `api-client-timeout.test.ts` and `mission-control-page.test.ts`: **46/46 pass**.

## Screenshots

1. `S1-project-first-nav-catcafe-traqen.png`
2. `S2-import-form-no-ext-fields.png`
3. `S3-home-import-complete-and-isolated.png`

No open acceptance P1/P2 remains.
