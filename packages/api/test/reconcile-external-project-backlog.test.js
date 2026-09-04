import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseReconcileArguments,
  reconcileExternalProjectBacklog,
} from '../scripts/reconcile-external-project-backlog.mjs';

test('reconcile refreshes first, deletes only allowlisted retired features, and verifies the final set', async () => {
  let items = [
    { id: 'item-f001', title: '[F001] stale', priority: 'p2', status: 'open', updatedAt: 1, tags: ['feature:f001'] },
    {
      id: 'item-f005',
      title: '[F005] stale',
      priority: 'p2',
      status: 'open',
      updatedAt: 2,
      tags: ['source:docs-backlog', 'feature:f005'],
    },
    {
      id: 'item-f007',
      title: '[F007] stale',
      priority: 'p2',
      status: 'open',
      updatedAt: 3,
      tags: ['source:docs-backlog', 'feature:f007'],
    },
  ];
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/import-backlog')) {
      items[0] = { ...items[0], title: '[F001] Workspace & Source Truth', priority: 'p0', updatedAt: 4 };
      return new Response(JSON.stringify({ imported: 0, refreshed: 1 }), { status: 200 });
    }
    if (init.method === 'DELETE') {
      const itemId = decodeURIComponent(url.split('/').at(-1));
      const payload = JSON.parse(init.body);
      const item = items.find((candidate) => candidate.id === itemId);
      assert.equal(payload.expectedUpdatedAt, item.updatedAt);
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
    fetchImpl,
  });

  assert.deepEqual(result.removed, ['F005', 'F007']);
  assert.deepEqual(result.finalItems, [
    { id: 'item-f001', featureId: 'F001', title: '[F001] Workspace & Source Truth', priority: 'p0', status: 'open' },
  ]);
  assert.equal(requests[0].url.endsWith('/import-backlog'), true);
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
      tags: ['feature:f007'],
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
    /not importer-managed/i,
  );
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
    ]),
    {
      apiUrl: 'http://127.0.0.1:3004',
      userId: 'default-user',
      projectId: 'traqen-project',
      retireFeatureIds: ['F005', 'F007'],
      expectedActiveFeatureIds: ['F001', 'F002'],
    },
  );
});
