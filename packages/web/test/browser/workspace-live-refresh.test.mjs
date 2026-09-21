import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild-wasm';
import { chromium } from 'playwright';
import { readWorkspaceFilePreview } from '../../../api/src/domains/workspace/workspace-file-read.ts';
import { registerWorktrees } from '../../../api/src/domains/workspace/workspace-security.ts';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const apiRequire = createRequire(path.join(webRoot, '../api/package.json'));
const { Server } = apiRequire('socket.io');

// Real file owner + renderer + CodeMirror + apiFetch + Socket.IO + filesystem
// watcher. Only session/edit-token bootstrapping is a fixture; no production API,
// data store, runtime checkout, or user document is contacted or modified.
test('visible Workspace body follows disk, reconnects, reopen and dirty editing', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workspace-live-refresh-'));
  process.env.NODE_ENV = 'test';
  process.env.LOG_DIR = path.join(dir, 'logs');
  const { setupWorkspaceFileWatcher } = await import('../../../api/src/domains/workspace/workspace-file-watcher.ts');
  const filePath = path.join(dir, 'README.md');
  await writeFile(filePath, '# version-1\n');
  registerWorktrees([{ id: 'refresh-fixture', root: dir, branch: 'main', head: 'fixture' }]);
  let bundle = '';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    response.setHeader('cache-control', 'no-store');
    const json = (body) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/session') return json({ userId: 'test-user' });
    if (url.pathname === '/api/workspace/edit-session') return json({ token: 'fixture-token', expiresIn: 3600 });
    if (url.pathname === '/api/workspace/file') {
      assert.equal(url.searchParams.get('worktreeId'), 'refresh-fixture');
      assert.equal(url.searchParams.get('path'), 'README.md');
      return json({ path: 'README.md', ...(await readWorkspaceFilePreview(filePath)) });
    }
    if (url.pathname === '/app.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(bundle);
      return;
    }
    if (url.pathname === '/') {
      response.setHeader('content-type', 'text/html');
      response.end('<html><body><main id="root"></main><script type="module" src="/app.js"></script></body></html>');
      return;
    }
    response.statusCode = 404;
    json({ error: 'fixture has no such endpoint' });
  });
  const io = new Server(server);
  setupWorkspaceFileWatcher(io);
  let connections = 0;
  let pauseNotifications = false;
  io.on('connection', (socket) => {
    connections++;
    const emit = socket.emit.bind(socket);
    socket.emit = (event, ...args) =>
      event === 'workspace:file-changed' && pauseNotifications ? false : emit(event, ...args);
  });
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const result = await build({
      stdin: {
        contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { F307FileOwnerSurface } from './src/components/workbench/F307FileOwnerSurface';
        import { createFileSurface } from './src/components/workbench/real-surface-adapters';
        const descriptor = () => createFileSurface({worktreeId:'refresh-fixture',path:'README.md'});
        function App() {
          const [surface,setSurface] = useState(descriptor);
          return <><button onClick={() => setSurface(descriptor())}>Reopen same file</button><button onClick={() => setSurface(createFileSurface({worktreeId:'refresh-fixture',path:'README.md',scrollToLine:2}))}>Reopen at line</button><F307FileOwnerSurface surface={surface} onRequestDetach={() => {}} /></>;
        }
        createRoot(document.getElementById('root')).render(<App/>);
      `,
        loader: 'tsx',
        resolveDir: webRoot,
      },
      tsconfig: path.join(webRoot, 'tsconfig.json'),
      // This is a behavior test; mathematical font assets are unrelated to
      // document freshness. The real Markdown renderer and editor stay bundled.
      loader: { '.css': 'empty' },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      jsx: 'automatic',
      define: {
        'process.env.NODE_ENV': '"test"',
        'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(url),
        'process.env': '{}',
      },
      logLevel: 'silent',
    });
    bundle = result.outputFiles[0].text;
    browser = await chromium.launch({ headless: true, executablePath: process.env.CAT_CAFE_TEST_CHROMIUM_PATH });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    const heading = page.locator('[data-testid="workspace-file-viewer"] h1');
    const expectVersion = async (version) => {
      await page.waitForFunction(
        (text) => document.querySelector('[data-testid="workspace-file-viewer"] h1')?.textContent === text,
        version,
      );
      assert.equal(await heading.textContent(), (await readFile(filePath, 'utf8')).trim().replace(/^# /, ''));
    };
    await expectVersion('version-1');
    await writeFile(filePath, '# version-2\n');
    await expectVersion('version-2');
    await writeFile(`${filePath}.tmp`, '# atomic-version-3\n');
    await rename(`${filePath}.tmp`, filePath);
    await expectVersion('atomic-version-3');
    await writeFile(filePath, '# after-rename-version-4\n');
    await expectVersion('after-rename-version-4');

    // Sever transport and stop events while offline, then require a new watch.
    const beforeReconnect = connections;
    const reconnected = once(io, 'connection', { signal: AbortSignal.timeout(10_000) });
    await context.setOffline(true);
    for (const socket of io.sockets.sockets.values()) socket.conn.close();
    await writeFile(filePath, '# offline-version-5\n');
    await context.setOffline(false);
    await expectVersion('offline-version-5');
    await reconnected;
    assert.ok(connections > beforeReconnect, 'reconnected the actual file watch');

    // Pause notifications to prove explicit same-path open itself revalidates.
    pauseNotifications = true;
    await writeFile(filePath, '# reopen-version-6\n');
    await page.getByRole('button', { name: 'Reopen same file', exact: true }).click();
    await expectVersion('reopen-version-6');
    pauseNotifications = false;

    await page.getByTitle('编辑文件', { exact: true }).click();
    const editor = page.locator('.cm-content[contenteditable="true"]');
    await editor.fill('my unsaved draft');
    await writeFile(filePath, '# external-while-dirty\n');
    await page.getByText('文件已被外部修改', { exact: true }).waitFor();
    assert.equal(await editor.innerText(), 'my unsaved draft');
    await page.getByRole('button', { name: 'Reopen same file', exact: true }).click();
    assert.equal(await editor.innerText(), 'my unsaved draft');
    await page.getByRole('button', { name: 'Reopen at line', exact: true }).click();
    assert.equal(await editor.innerText(), 'my unsaved draft');
    await page.getByRole('button', { name: '忽略', exact: true }).click();
    assert.equal(await editor.innerText(), 'my unsaved draft');
    await writeFile(filePath, '# newest-while-dirty\n');
    await page.getByText('文件已被外部修改', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('.cm-content')?.textContent?.includes('newest-while-dirty'),
    );
    assert.equal((await editor.innerText()).trim(), (await readFile(filePath, 'utf8')).trim());
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        url,
        versions: 8,
        atomicRename: true,
        reconnect: true,
        samePathReopen: true,
        dirtyDraftPreserved: true,
        bodyEqualsDisk: true,
      }),
    );
  } finally {
    await browser?.close();
    await new Promise((resolve) => io.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
