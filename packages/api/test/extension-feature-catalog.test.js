import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('extension catalog validates EXT IDs and projects backlog rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-extension-catalog-'));
  const catalogPath = join(root, 'catalog.json');
  try {
    await writeFile(
      catalogPath,
      JSON.stringify({
        schemaVersion: 1,
        extensions: [
          {
            id: 'EXT-001',
            name: 'ChatGPT Desktop Development Loop',
            status: 'implementation',
            owner: 'CodeX',
            specPath: 'docs/extensions/EXT-001-chatgpt-desktop-development-loop.md',
            designPath: 'docs/design/EXT-001-chatgpt-desktop-development-loop.md',
            planPath: 'feature-specs/2026-08-05-chatgpt-desktop-development-loop.md',
            legacyIds: ['F289'],
          },
        ],
      }),
    );
    const { readExtensionFeatureCatalog, readExtensionFeatureRows } = await import(
      '../dist/routes/extension-feature-catalog.js'
    );
    const entries = await readExtensionFeatureCatalog(catalogPath);
    const rows = await readExtensionFeatureRows(catalogPath);

    assert.equal(entries[0].id, 'EXT-001');
    assert.deepEqual(entries[0].legacyIds, ['F289']);
    assert.equal(entries[0].designPath, 'docs/design/EXT-001-chatgpt-desktop-development-loop.md');
    assert.equal(entries[0].planPath, 'feature-specs/2026-08-05-chatgpt-desktop-development-loop.md');
    assert.equal(rows[0].kind, 'extension');
    assert.equal(rows[0].link, 'docs/extensions/EXT-001-chatgpt-desktop-development-loop.md');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extension catalog rejects document paths outside approved repository roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-extension-catalog-path-'));
  const catalogPath = join(root, 'catalog.json');
  try {
    await writeFile(
      catalogPath,
      JSON.stringify({
        schemaVersion: 1,
        extensions: [
          {
            id: 'EXT-001',
            name: 'ChatGPT Desktop Development Loop',
            status: 'implementation',
            owner: 'CodeX',
            specPath: 'docs/extensions/EXT-001-chatgpt-desktop-development-loop.md',
            planPath: '../private-plan.md',
            legacyIds: ['F289'],
          },
        ],
      }),
    );
    const { readExtensionFeatureCatalog } = await import('../dist/routes/extension-feature-catalog.js');
    await assert.rejects(() => readExtensionFeatureCatalog(catalogPath), /repository-relative/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy F289 Desktop loop migrates in place without aliasing upstream F289', async () => {
  const { BacklogStore } = await import('../dist/domains/cats/services/stores/ports/BacklogStore.js');
  const { migrateLegacyExtensionItems } = await import('../dist/routes/extension-feature-migration.js');
  const backlogStore = new BacklogStore();
  const legacy = await backlogStore.create({
    userId: 'owner-1',
    projectId: 'project-traqen',
    title: '[F289] ChatGPT Desktop Development Loop',
    summary: 'legacy extension metadata',
    priority: 'p1',
    tags: ['source:docs-backlog', 'feature:f289', 'status:implementation'],
    createdBy: 'user',
    dependencies: { blockedBy: ['F001'] },
  });
  const upstream = await backlogStore.create({
    userId: 'owner-1',
    projectId: 'project-traqen',
    title: '[F289] Canonical Data Root',
    summary: 'upstream feature metadata',
    priority: 'p1',
    tags: ['source:docs-backlog', 'feature:f289', 'status:in-progress'],
    createdBy: 'user',
  });
  let sop = {
    backlogItemId: legacy.id,
    featureId: 'F289',
    version: 3,
  };
  const workflowSopStore = {
    get: async (itemId) => (itemId === legacy.id ? sop : null),
    upsert: async (itemId, featureId, input) => {
      assert.equal(itemId, legacy.id);
      assert.equal(input.expectedVersion, 3);
      sop = { ...sop, featureId, version: sop.version + 1 };
      return sop;
    },
  };
  const originalRefreshMetadata = backlogStore.refreshMetadata.bind(backlogStore);
  let injectedConcurrentDependencyUpdate = false;
  backlogStore.refreshMetadata = (itemId, input) => {
    if (itemId === legacy.id && !injectedConcurrentDependencyUpdate) {
      injectedConcurrentDependencyUpdate = true;
      const live = backlogStore.get(itemId);
      originalRefreshMetadata(itemId, {
        title: live.title,
        summary: live.summary,
        priority: live.priority,
        tags: live.tags,
        dependencies: { blockedBy: ['F999'] },
        refreshedBy: 'owner-1',
      });
    }
    assert.equal(input.dependencies, undefined, 'legacy migration must preserve live dependency state');
    return originalRefreshMetadata(itemId, input);
  };

  const result = await migrateLegacyExtensionItems({
    items: await backlogStore.listByUser('owner-1'),
    extensionRows: [
      {
        id: 'EXT-001',
        name: 'ChatGPT Desktop Development Loop',
        status: 'implementation',
        owner: 'CodeX',
        link: 'docs/extensions/EXT-001-chatgpt-desktop-development-loop.md',
        kind: 'extension',
        legacyIds: ['F289'],
      },
    ],
    backlogStore,
    workflowSopStore,
    userId: 'owner-1',
  });

  assert.deepEqual(result.migratedItemIds, [legacy.id]);
  const migrated = await backlogStore.get(legacy.id, 'owner-1');
  assert.equal(migrated.id, legacy.id);
  assert.equal(migrated.projectId, 'project-traqen');
  assert.equal(migrated.title, '[EXT-001] ChatGPT Desktop Development Loop');
  assert.ok(migrated.tags.includes('feature:ext-001'));
  assert.ok(migrated.tags.includes('feature-kind:extension'));
  assert.deepEqual(migrated.dependencies, { blockedBy: ['F999'] });
  assert.equal(sop.featureId, 'EXT-001');

  const untouchedUpstream = await backlogStore.get(upstream.id, 'owner-1');
  assert.equal(untouchedUpstream.title, '[F289] Canonical Data Root');
  assert.ok(untouchedUpstream.tags.includes('feature:f289'));
});

test('repository catalog migrates legacy F306 project workspaces without aliasing upstream F306', async () => {
  const { BacklogStore } = await import('../dist/domains/cats/services/stores/ports/BacklogStore.js');
  const { migrateLegacyExtensionItems } = await import('../dist/routes/extension-feature-migration.js');
  const { readExtensionFeatureRows } = await import('../dist/routes/extension-feature-catalog.js');
  const backlogStore = new BacklogStore();
  const legacy = await backlogStore.create({
    userId: 'owner-1',
    title: '[F306] Mission Hub Project Workspaces',
    summary: 'legacy local feature metadata',
    priority: 'p1',
    tags: ['source:docs-backlog', 'feature:f306', 'status:done'],
    createdBy: 'user',
  });
  const upstream = await backlogStore.create({
    userId: 'owner-1',
    title: '[F306] Codex App Capability Parity',
    summary: 'upstream feature metadata',
    priority: 'p1',
    tags: ['source:docs-backlog', 'feature:f306', 'status:in-progress'],
    createdBy: 'user',
  });

  const result = await migrateLegacyExtensionItems({
    items: await backlogStore.listByUser('owner-1'),
    extensionRows: await readExtensionFeatureRows(),
    backlogStore,
    userId: 'owner-1',
  });

  assert.deepEqual(result.migratedItemIds, [legacy.id]);
  const migrated = await backlogStore.get(legacy.id, 'owner-1');
  assert.equal(migrated.title, '[EXT-002] Mission Hub Project Workspaces');
  assert.ok(migrated.tags.includes('feature:ext-002'));
  assert.ok(migrated.tags.includes('feature-kind:extension'));

  const untouchedUpstream = await backlogStore.get(upstream.id, 'owner-1');
  assert.equal(untouchedUpstream.title, '[F306] Codex App Capability Parity');
  assert.ok(untouchedUpstream.tags.includes('feature:f306'));
});

test('missing extension catalog is an empty overlay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-extension-catalog-'));
  try {
    await mkdir(join(root, 'docs'), { recursive: true });
    const { readExtensionFeatureCatalog } = await import('../dist/routes/extension-feature-catalog.js');
    assert.deepEqual(await readExtensionFeatureCatalog(join(root, 'docs', 'extensions', 'catalog.json')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
