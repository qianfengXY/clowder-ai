# Literature Reader Bootcamp Demo Implementation Plan

**Feature:** F087 bootcamp custom project — [docs/features/F087-cvo-bootcamp.md](../docs/features/F087-cvo-bootcamp.md)
**Goal:** Let a new operator paste a paper title and abstract, then receive a structured, locally generated reading brief.
**Acceptance Criteria:**
- The page accepts a title and abstract and clearly explains that analysis stays local.
- One action produces research question, method, findings, limitations, keywords, reading confidence, and follow-up questions.
- Empty or too-short input receives a useful validation message instead of fabricated analysis.
- A built-in example, clear action, and copyable Markdown brief make the demo usable without configuration.
- Core analysis behavior is covered by tests, the package builds, and the page runs on an isolated localhost port.
**Architecture cell:** N/A — isolated bootcamp demo package
**Map delta:** none
**Map delta why:** The package has no Cat Café runtime ownership, data-store, API, or routing changes.
**Architecture:** A dependency-free browser app imports a pure analysis module. A small Node static server serves the source in development, while a build script copies the same final assets into `dist/`.
**Tech Stack:** HTML, CSS, browser JavaScript modules, Node.js test runner and HTTP server.
**前端验证:** Yes — focused tests, production build, HTTP smoke check, and browser preview.

---

## Finish line and exclusions

The operator can open one page, paste an abstract, and export a structured reading brief without an API key. This demo does **not** parse PDFs, call external AI services, claim to replace careful reading, or persist document content.

## Terminal contract

```js
analyzeLiterature({ title, abstract }) => {
  title,
  wordCount,
  readingConfidence,
  researchQuestion,
  methods,
  findings,
  limitations,
  keywords,
  followUpQuestions,
  markdown
}
```

All results are derived projections of the current text. There are no lifecycle-owned or persisted state objects.

### Task 1: Specify the analysis behavior

**Files:**
- Create: `packages/bootcamp-literature-reader/test/analyze.test.js`
- Create: `packages/bootcamp-literature-reader/package.json`

**Step 1:** Write failing tests for structured extraction, English-text support, short-input rejection, keyword filtering, and Markdown export.

**Step 2:** Run `pnpm --filter @cat-cafe/bootcamp-literature-reader test` and confirm failure because the analysis module does not exist.

### Task 2: Implement the pure analyzer

**Files:**
- Create: `packages/bootcamp-literature-reader/src/analyze.js`
- Test: `packages/bootcamp-literature-reader/test/analyze.test.js`

**Step 1:** Implement sentence classification, keyword scoring, evidence confidence, critical follow-up generation, and Markdown formatting.

**Step 2:** Re-run focused tests and keep the module free of DOM and network dependencies.

### Task 3: Build the reading workspace

**Files:**
- Create: `packages/bootcamp-literature-reader/index.html`
- Create: `packages/bootcamp-literature-reader/styles.css`
- Create: `packages/bootcamp-literature-reader/src/app.js`

**Step 1:** Build an accessible two-column reading workspace with title/abstract inputs, example, clear, analyze, and copy controls.

**Step 2:** Render all terminal-contract fields with safe DOM APIs and visible validation/status feedback.

### Task 4: Serve, build, and verify

**Files:**
- Create: `packages/bootcamp-literature-reader/scripts/dev-server.mjs`
- Create: `packages/bootcamp-literature-reader/scripts/build.mjs`

**Step 1:** Add a localhost-only static development server and deterministic production build.

**Step 2:** Run focused tests, build, HTTP smoke checks, root formatting checks for the changed package, and a browser preview.

**Step 3:** Inspect the diff against every acceptance criterion and confirm no persistent store or runtime configuration was touched.
