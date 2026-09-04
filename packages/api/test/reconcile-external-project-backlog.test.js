import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseReconcileArguments,
  reconcileExternalProjectBacklog,
} from '../scripts/reconcile-external-project-backlog.mjs';

test('reconcile refreshes first, deletes only allowlisted retired features, and verifies the final set', async () => {
  let items = [
    {
      id: 'item-f001',
      title: '[F001] stale',
      priority: 'p2',
      status: 'open',
      updatedAt: 1,
      revision: 1,
      tags: ['source:docs-backlog', 'feature:f001'],
      audit: [{ id: 'audit-f001-created' }],
    },
    {
      id: 'item-f005',
      title: '[F005] stale',
      priority: 'p2',
      status: 'open',
      updatedAt: 2,
      revision: 1,
      tags: ['source:docs-backlog', 'feature:f005'],
      audit: [{ id: 'audit-f005-created' }],
      importOrigin: {
        kind: 'external-project-catalog',
        projectId: 'traqen-project',
        featureId: 'F005',
        source: 'docs-backlog',
      },
    },
    {
      id: 'item-f007',
      title: '[F007] stale',
      priority: 'p2',
      status: 'open',
      updatedAt: 3,
      revision: 1,
      tags: ['source:docs-backlog', 'feature:f007'],
      audit: [{ id: 'audit-f007-created' }],
      importOrigin: {
        kind: 'external-project-catalog',
        projectId: 'traqen-project',
        featureId: 'F007',
        source: 'docs-backlog',
      },
    },
  ];
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/adopt-import-origin')) {
      const payload = JSON.parse(init.body);
      const index = items.findIndex((candidate) => candidate.id === 'item-f001');
      items[index] = {
        ...items[index],
        updatedAt: 2,
        revision: items[index].revision + 1,
        audit: [...items[index].audit, { id: 'audit-f001-adopted' }],
        importOrigin: {
          kind: 'external-project-catalog',
          projectId: 'traqen-project',
          featureId: payload.expectedFeatureId,
          source: 'docs-backlog',
        },
      };
      return new Response(JSON.stringify({ item: items[index], adopted: true }), { status: 200 });
    }
    if (url.endsWith('/import-backlog')) {
      items[0] = { ...items[0], title: '[F001] Workspace & Source Truth', priority: 'p0', updatedAt: 4 };
      return new Response(JSON.stringify({ imported: 0, refreshed: 1 }), { status: 200 });
    }
    if (init.method === 'DELETE') {
      const itemId = decodeURIComponent(url.split('/').at(-1));
      const payload = JSON.parse(init.body);
      const item = items.find((candidate) => candidate.id === itemId);
      assert.equal(payload.expectedUpdatedAt, item.updatedAt);
      assert.equal(payload.expectedRevision, item.revision);
      items = items.filter((candidate) => candidate.id !== itemId);
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ items }), { status: 200 });
  };

  const result = await reconcileExternalProjectBacklog({
    apiUrl: 'http://127.0.0.1:3004',
    userId: 'default-user',
    projectId: 'traqen-project',
    retireFeatureIds: ['F005', 'F007'],
    expectedActiveFeatureIds: ['F001'],
    operatorConfirmedLegacyAdoptionFeatureIds: ['F001'],
    fetchImpl,
  });

  assert.deepEqual(result.adopted, ['F001']);
  assert.deepEqual(result.removed, ['F005', 'F007']);
  assert.deepEqual(result.finalItems, [
    { id: 'item-f001', featureId: 'F001', title: '[F001] Workspace & Source Truth', priority: 'p0', status: 'open' },
  ]);
  assert.equal(requests[0].url.includes('/api/backlog/items?projectId='), true);
  assert.equal(requests[1].url.endsWith('/adopt-import-origin'), true);
  assert.equal(requests[2].url.endsWith('/import-backlog'), true);
  assert.deepEqual(
    requests
      .filter((request) => request.init.method === 'DELETE')
      .map((request) => JSON.parse(request.init.body).expectedFeatureId),
    ['F005', 'F007'],
  );
});

test('reconcile refuses to retire a manual item that only shares the feature tag', async () => {
  const items = [
    {
      id: 'manual-f007',
      title: '[F007] Manual retrospective',
      priority: 'p2',
      status: 'open',
      updatedAt: 7,
      revision: 1,
      tags: ['source:docs-backlog', 'feature:f007'],
      audit: [{ id: 'audit-legacy-created' }],
    },
  ];
  const fetchImpl = async (url) =>
    url.endsWith('/import-backlog')
      ? new Response(JSON.stringify({ imported: 0, refreshed: 0 }), { status: 200 })
      : new Response(JSON.stringify({ items }), { status: 200 });

  await assert.rejects(
    reconcileExternalProjectBacklog({
      apiUrl: 'http://127.0.0.1:3004',
      userId: 'default-user',
      projectId: 'traqen-project',
      retireFeatureIds: ['F007'],
      expectedActiveFeatureIds: [],
      fetchImpl,
    }),
    /no immutable importer provenance/i,
  );
});

test('CLI reconciles an explicitly empty active catalog and retires only operator-confirmed legacy rows', async () => {
  let items = [
    {
      id: 'legacy-f007',
      title: '[F007] legacy imported row',
      priority: 'p2',
      status: 'open',
      updatedAt: 7,
      revision: 1,
      tags: ['source:docs-backlog', 'feature:f007'],
    },
  ];
  let deletePayload;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/import-backlog')) {
      return new Response(JSON.stringify({ imported: 0, refreshed: 0 }), { status: 200 });
    }
    if (init.method === 'DELETE') {
      deletePayload = JSON.parse(init.body);
      items = [];
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ items }), { status: 200 });
  };

  const parsed = parseReconcileArguments([
    '--api-url',
    'http://127.0.0.1:3004',
    '--user-id',
    'default-user',
    '--project-id',
    'traqen-project',
    '--retire',
    'F007',
    '--expect-active',
    'none',
    '--confirm-legacy-retire',
    'F007',
  ]);
  assert.deepEqual(parsed.expectedActiveFeatureIds, []);
  const result = await reconcileExternalProjectBacklog({ ...parsed, fetchImpl });

  assert.deepEqual(result.removed, ['F007']);
  assert.deepEqual(deletePayload, {
    expectedFeatureId: 'F007',
    expectedUpdatedAt: 7,
    expectedRevision: 1,
    reason: 'Explicit post-deploy retirement reconciliation for F007',
    mode: 'operator-confirmed',
    confirmation: 'PERMANENTLY DELETE F007 legacy-f007',
  });
});

test('reconcile fails closed when the final feature set does not match expectation', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/import-backlog')
      ? new Response(JSON.stringify({ imported: 0, refreshed: 0 }), { status: 200 })
      : new Response(JSON.stringify({ items: [{ id: 'unexpected', tags: ['feature:f009'] }] }), { status: 200 });

  await assert.rejects(
    reconcileExternalProjectBacklog({
      apiUrl: 'http://127.0.0.1:3004',
      userId: 'default-user',
      projectId: 'traqen-project',
      retireFeatureIds: ['F005'],
      expectedActiveFeatureIds: ['F001'],
      fetchImpl,
    }),
    /Final feature set mismatch/,
  );
});

test('CLI parser requires explicit retirement and expected-active allowlists', () => {
  assert.deepEqual(
    parseReconcileArguments([
      '--api-url',
      'http://127.0.0.1:3004/',
      '--user-id',
      'default-user',
      '--project-id',
      'traqen-project',
      '--retire',
      'f005,F007',
      '--expect-active',
      'F001,F002',
      '--confirm-legacy-retire',
      'F005,F007',
      '--confirm-legacy-adopt',
      'F001,F002',
    ]),
    {
      apiUrl: 'http://127.0.0.1:3004',
      userId: 'default-user',
      projectId: 'traqen-project',
      retireFeatureIds: ['F005', 'F007'],
      expectedActiveFeatureIds: ['F001', 'F002'],
      operatorConfirmedLegacyFeatureIds: ['F005', 'F007'],
      operatorConfirmedLegacyAdoptionFeatureIds: ['F001', 'F002'],
    },
  );
});

test('CLI parser rejects legacy adoption outside the expected-active allowlist', () => {
  assert.throws(
    () =>
      parseReconcileArguments([
        '--api-url',
        'http://127.0.0.1:3004',
        '--user-id',
        'default-user',
        '--project-id',
        'traqen-project',
        '--retire',
        'F005',
        '--expect-active',
        'F001',
        '--confirm-legacy-adopt',
        'F002',
      ]),
    /subset of --expect-active/,
  );
});

test('CLI parser rejects legacy confirmation outside the retirement allowlist', () => {
  assert.throws(
    () =>
      parseReconcileArguments([
        '--api-url',
        'http://127.0.0.1:3004',
        '--user-id',
        'default-user',
        '--project-id',
        'traqen-project',
        '--retire',
        'F005',
        '--expect-active',
        'F001',
        '--confirm-legacy-retire',
        'F007',
      ]),
    /subset of --retire/,
  );
});
