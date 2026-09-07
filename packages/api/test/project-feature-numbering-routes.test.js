import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { BacklogStore } from '../dist/domains/cats/services/stores/ports/BacklogStore.js';
import { ExternalProjectStore } from '../dist/domains/projects/external-project-store.js';
import { NeedAuditFrameStore } from '../dist/domains/projects/need-audit-frame-store.js';
import { externalProjectRoutes } from '../dist/routes/external-projects.js';

const headers = { 'x-cat-cafe-user': 'number-owner' };
const payload = { title: 'Navigation design', summary: 'Keep the plan', priority: 'p0', tags: [] };
let app;
let store;
let directory;
let project;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'project-number-test-'));
  await writeFile(
    join(directory, 'BACKLOG.md'),
    '| ID | Feature | Status | Owner |\n|---|---|---|---|\n| F006 | Settings | spec | TBD |',
  );
  app = Fastify();
  store = new BacklogStore();
  await app.register(externalProjectRoutes, {
    externalProjectStore: new ExternalProjectStore(),
    needAuditFrameStore: new NeedAuditFrameStore(),
    backlogStore: store,
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/external-projects',
    headers,
    payload: { name: 'Numbering project', sourcePath: directory, backlogPath: 'BACKLOG.md' },
  });
  assert.equal(res.statusCode, 201, res.body);
  project = res.json().project;
});
afterEach(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

test('manual project creation allocates against the registered catalog and ignores client sequence/provenance', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/external-projects/${project.id}/backlog/items`,
    headers,
    payload: {
      ...payload,
      projectId: 'foreign',
      projectFeatureNumbering: { reservedFeatureIds: ['F900'] },
      importOrigin: { kind: 'external-project-catalog' },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().title, '[F007] Navigation design');
  assert.deepEqual(res.json().tags, ['feature:f007']);
  assert.equal(res.json().projectId, project.id);
  assert.equal(res.json().importOrigin, undefined);
  const duplicate = await app.inject({
    method: 'POST',
    url: `/api/external-projects/${project.id}/backlog/items`,
    headers,
    payload: { ...payload, title: '[F007] Duplicate', tags: ['feature:f007'] },
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
});

test('manual creation rejects catalog identities without preventing their later import', async () => {
  for (const extra of [
    { title: '[F006] Manual task' },
    { tags: ['feature:f006'] },
    { title: '[f006] Manual task', tags: ['feature:F006'] },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${project.id}/backlog/items`,
      headers,
      payload: { ...payload, ...extra },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'project_feature_number_conflict');
    assert.equal(store.listByUser('number-owner').length, 0);
  }
  const imported = await app.inject({
    method: 'POST',
    url: `/api/external-projects/${project.id}/import-backlog`,
    headers,
  });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json().imported, 1);
  const canonical = store.listByUser('number-owner')[0];
  assert.equal(canonical.title, '[F006] Settings');
  assert.equal(canonical.importOrigin.featureId, 'F006');
  const created = await app.inject({
    method: 'POST',
    url: `/api/external-projects/${project.id}/backlog/items`,
    headers,
    payload,
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().title, '[F007] Navigation design');
});

test('the assignment endpoint changes only number metadata and audits the authenticated owner', async () => {
  const before = store.create({ ...payload, userId: 'number-owner', projectId: project.id, createdBy: 'user' });
  const url = `/api/external-projects/${project.id}/backlog/items/${before.id}/feature-id`;
  const body = { featureId: 'F005', expectedRevision: before.revision, reason: 'operator selected F005' };
  for (const [extra, status] of [
    [{ expectedRevision: 99 }, 409],
    [{ featureId: 'F006' }, 409],
    [{ featureId: 'F000' }, 409],
    [{ status: 'done' }, 400],
    [{ featureId: 'F1000' }, 400],
  ]) {
    const res = await app.inject({ method: 'PATCH', url, headers, payload: { ...body, ...extra } });
    assert.equal(res.statusCode, status, res.body);
    assert.deepEqual(store.get(before.id), before);
  }
  const res = await app.inject({ method: 'PATCH', url, headers, payload: body });
  assert.equal(res.statusCode, 200, res.body);
  const after = res.json().item;
  assert.equal(after.title, '[F005] Navigation design');
  assert.equal(after.audit.at(-1).actor.id, 'number-owner');
  for (const key of Object.keys(before).filter(
    (key) => !['title', 'tags', 'audit', 'revision', 'updatedAt'].includes(key),
  )) {
    assert.deepEqual(after[key], before[key]);
  }
  const retry = await app.inject({
    method: 'PATCH',
    url,
    headers,
    payload: { ...body, expectedRevision: after.revision },
  });
  assert.deepEqual(retry.json().item, after);
});

test('creation and assignment reject missing auth, foreign project and foreign task ownership', async () => {
  const before = store.create({ ...payload, userId: 'foreign', projectId: project.id, createdBy: 'user' });
  const createUrl = `/api/external-projects/${project.id}/backlog/items`;
  const assignUrl = `${createUrl}/${before.id}/feature-id`;
  const assignment = { featureId: 'F005', expectedRevision: before.revision, reason: 'assignment' };
  for (const [h, status] of [
    [{}, 401],
    [{ 'x-cat-cafe-user': 'foreign' }, 404],
  ]) {
    assert.equal((await app.inject({ method: 'POST', url: createUrl, headers: h, payload })).statusCode, status);
    assert.equal(
      (await app.inject({ method: 'PATCH', url: assignUrl, headers: h, payload: assignment })).statusCode,
      status,
    );
  }
  assert.equal((await app.inject({ method: 'PATCH', url: assignUrl, headers, payload: assignment })).statusCode, 404);
  assert.deepEqual(store.get(before.id), before);
});

test('malformed catalogs fail closed while brand-new projects without a catalog can create F001', async () => {
  const url = `/api/external-projects/${project.id}/backlog/items`;
  await writeFile(join(directory, 'BACKLOG.md'), 'broken catalog');
  const invalid = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(invalid.statusCode, 500, invalid.body);
  assert.equal(store.listByUser('number-owner').length, 0);
  await rm(join(directory, 'BACKLOG.md'));
  const fresh = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(fresh.statusCode, 201, fresh.body);
  assert.equal(fresh.json().title, '[F001] Navigation design');
});
