// @ts-check

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { unifiedDriftRoutes } = await import('../dist/routes/drift.js');

describe('/api/drift/check — project initialization metadata', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;
  /** @type {string} */
  let projectRoot;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-drift-check-'));
    app = Fastify({ logger: false });
    await app.register(unifiedDriftRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('marks existing directories without .cat-cafe as uninitialized', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/drift/check',
      headers: { 'x-cat-cafe-user': 'you' },
      payload: { type: 'skill', projectPath: projectRoot },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().result.initialized, false);
  });

  it('marks projects with .cat-cafe as initialized', async () => {
    await mkdir(join(projectRoot, '.cat-cafe'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/drift/check',
      headers: { 'x-cat-cafe-user': 'you' },
      payload: { type: 'skill', projectPath: projectRoot },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().result.initialized, true);
  });
});
