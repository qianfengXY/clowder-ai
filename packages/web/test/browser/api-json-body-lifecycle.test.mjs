import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';
import ts from 'typescript';

// Real Chromium fetch/ReadableStream over a local, isolated HTTP fixture. No
// Next build, real API, Redis, credentials, or public tunnel is involved.
test('JSON body deadlines release browser connections and preserve shared readers', { timeout: 30_000 }, async () => {
  const modules = new Map();
  for (const name of ['api-client', 'bounded-fetch', 'api-get-generation']) {
    const source = await readFile(new URL(`../../src/utils/${name}.ts`, import.meta.url), 'utf8');
    modules.set(
      `/utils/${name}`,
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      }).outputText,
    );
  }
  modules.set('/stores/toastStore', 'export const useToastStore = { getState: () => ({ addToast() {} }) };');
  let stalledRequests = 0;
  let closedStalled = 0;
  let sharedRequests = 0;
  let finishShared;
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (modules.has(pathname)) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(modules.get(pathname));
    } else if (pathname === '/api/session' || pathname === '/api/healthy') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } else if (pathname === '/api/stalled') {
      stalledRequests++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"ok":');
      res.on('close', () => {
        closedStalled++;
      });
    } else if (pathname === '/api/shared') {
      sharedRequests++;
      res.writeHead(200, { 'content-type': 'application/json', etag: '"shared"' });
      res.write('{"ok":');
      finishShared = () => res.end('true}');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>API lifecycle fixture</title>');
    }
  });
  let browser;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    browser = await chromium.launch({ headless: true, executablePath: process.env.CAT_CAFE_TEST_CHROMIUM_PATH });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      globalThis.process = { env: { NEXT_PUBLIC_API_URL: location.origin } };
      globalThis.api = await import('/utils/api-client');
    });

    const timeoutResult = await page.evaluate(async () => {
      const started = performance.now();
      try {
        await globalThis.api.apiFetch('/api/stalled', { method: 'POST' }, { mutationTimeoutMs: 150 });
        return { outcome: 'unexpected success' };
      } catch (error) {
        return { outcome: error.name, elapsed: performance.now() - started };
      }
    });
    assert.equal(timeoutResult.outcome, 'TimeoutError');
    assert.ok(timeoutResult.elapsed < 2_000);
    assert.equal(stalledRequests, 1, 'a timed-out message must not be replayed');
    await page.waitForFunction(async () => (await globalThis.api.apiFetch('/api/healthy')).ok);
    assert.equal(closedStalled, 1, 'server observes the stalled browser connection closing');

    await page.evaluate(() => {
      const controller = new AbortController();
      globalThis.first = globalThis.api
        .apiFetch('/api/shared', { signal: controller.signal })
        .then((r) => r.json())
        .then(
          () => 'unexpected success',
          (e) => e.name,
        );
      globalThis.peer = globalThis.api.apiFetch('/api/shared').then(async (r) => ({
        body: await r.json(),
        etag: r.headers.get('etag'),
        url: r.url,
      }));
      globalThis.abortFirst = () => controller.abort();
    });
    // Wait for the response headers to arrive, before cancelling the caller.
    await page.waitForFunction(() => performance.getEntriesByType('resource').length > 0);
    const deadline = Date.now() + 2_000;
    while (!finishShared && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(finishShared);
    const aborted = await page.evaluate(async () => {
      globalThis.abortFirst();
      return await globalThis.first;
    });
    assert.equal(aborted, 'AbortError');
    assert.equal(sharedRequests, 1);
    finishShared();
    const peer = await page.evaluate(() => globalThis.peer);
    assert.deepEqual(peer.body, { ok: true });
    assert.equal(peer.etag, '"shared"');
    assert.ok(peer.url.endsWith('/api/shared'));
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
