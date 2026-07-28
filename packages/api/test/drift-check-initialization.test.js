// @ts-check

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { unifiedDriftRoutes } = await import('../dist/routes/drift.js');

const AUTH_HEADERS = {
  'x-test-session-user': 'you',
  host: 'localhost:3004',
  origin: 'http://localhost:3003',
};

describe('/api/drift — project initialization boundary', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;
  /** @type {string} */
  let projectRoot;
  let previousOwner;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-drift-check-'));
    previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) {
        request.sessionUserId = raw.trim();
      }
    });
    await app.register(unifiedDriftRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    await rm(projectRoot, { recursive: true, force: true });
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
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

  for (const type of ['skill', 'mcp']) {
    it(`rejects ${type} resolution for an explicit uninitialized project without creating state`, async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/drift/resolve',
        headers: AUTH_HEADERS,
        payload: { type, action: 'sync', projectPath: projectRoot },
      });

      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, /Project not initialized|missing \.cat-cafe/);
      assert.equal(existsSync(join(projectRoot, '.cat-cafe')), false);
      assert.deepEqual(await readdir(projectRoot), []);
    });

    it(`keeps ${type} resolution available for an explicit initialized project`, async () => {
      await mkdir(join(projectRoot, '.cat-cafe'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/drift/resolve',
        headers: AUTH_HEADERS,
        payload: { type, action: 'sync', projectPath: projectRoot },
      });

      assert.equal(response.statusCode, 200);
    });
  }
});
