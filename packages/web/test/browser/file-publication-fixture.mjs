import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild-wasm';
import postcss from 'postcss';
import tailwind from 'tailwindcss';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const apiRequire = createRequire(path.join(webRoot, '../api/package.json'));
const Fastify = apiRequire('fastify');
const { Server } = apiRequire('socket.io');
const webRequire = createRequire(path.join(webRoot, 'package.json'));
export const fixtureBytes = Buffer.from('Synthetic browser publication — no corporate content.\n');
export const fixturePayload = {
  fileName: 'synthetic-browser.txt',
  mimeType: 'text/plain',
  dataBase64: fixtureBytes.toString('base64'),
  sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
};

// Only isolated identity/session bootstrapping is synthetic. The publication
// route, auth hooks, memory store, Socket.IO, receiver and ChatMessage are real.
export async function startFilePublicationFixture(port = 0) {
  const dir = await mkdtemp(path.join(tmpdir(), 'file-publication-browser-'));
  process.env.NODE_ENV = 'test';
  process.env.LOG_DIR = path.join(dir, 'logs');
  const { InvocationRegistry } = await import(
    '../../../api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts'
  );
  const { MessageStore } = await import('../../../api/src/domains/cats/services/stores/ports/MessageStore.ts');
  const { registerCallbackAuthHook } = await import('../../../api/src/routes/callback-auth-prehandler.ts');
  const { registerCallbackFilePublication } = await import('../../../api/src/routes/callback-file-publication.ts');
  const { uploadsRoutes } = await import('../../../api/src/routes/uploads.ts');
  const registry = new InvocationRegistry();
  const messageStore = new MessageStore();
  const threadId = 'synthetic-file-preview';
  const auth = await registry.create('synthetic-owner', 'codex', threadId);
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const app = Fastify();
  const io = new Server(app.server);
  let joined = false;
  io.on('connection', (socket) => {
    socket.on('join_room', async (room, ack) => {
      await socket.join(room);
      if (room === `thread:${threadId}`) joined = true;
      ack?.({ ok: true, room });
    });
  });
  registerCallbackAuthHook(app, registry);
  registerCallbackFilePublication(app, {
    registry,
    messageStore,
    uploadDir: path.join(dir, 'uploads'),
    socketManager: { broadcastToRoom: (rooms, event, payload) => io.to(rooms).emit(event, payload) },
  });
  await app.register(uploadsRoutes, { uploadDir: path.join(dir, 'uploads') });
  let bundle = '';
  let css = '';
  let historyReads = 0;
  app.get('/app.js', (_, reply) => reply.type('text/javascript').send(bundle));
  app.get('/app.css', (_, reply) => reply.type('text/css').send(css));
  app.get('/', (_, reply) =>
    reply
      .type('text/html')
      .send(
        '<!doctype html><html><head><meta charset="utf-8"><title>Synthetic file publication</title><link rel="stylesheet" href="/app.css"></head><body><main id="root" style="max-width:900px;margin:32px auto"></main><script type="module" src="/app.js"></script></body></html>',
      ),
  );
  // Test button can publish only these fixed, synthetic bytes. Never a path or
  // payload supplied by a visitor, and never credentials from the real host.
  app.post('/fixture/publish', async (_, reply) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/publish-file',
      headers,
      payload: fixturePayload,
    });
    return reply.code(response.statusCode).send(response.json());
  });
  app.get('/api/session', async () => ({ userId: 'synthetic-owner' }));
  app.get('/api/config', async () => ({ config: {} }));
  app.get('/api/messages', async () => {
    historyReads++;
    return { messages: [] };
  });
  app.get('/api/*', async () => ({}));
  const url = await app.listen({ host: '127.0.0.1', port });
  try {
    const config = webRequire('./tailwind.config.js');
    const styles = await readFile(path.join(webRoot, 'src/app/globals.css'), 'utf8');
    const tokens = await readFile(path.join(webRoot, 'src/app/theme-tokens.css'), 'utf8');
    css =
      tokens +
      (
        await postcss([tailwind({ ...config, content: [path.join(webRoot, 'src/**/*.{ts,tsx}')] })]).process(styles, {
          from: path.join(webRoot, 'src/app/globals.css'),
        })
      ).css;
    const result = await build({
      stdin: {
        contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { useSocket } from './src/hooks/useSocket';
        import { useChatStore } from './src/stores/chatStore';
        import { ChatMessage } from './src/components/ChatMessage';
        useChatStore.setState({currentThreadId:${JSON.stringify(threadId)},messages:[],threadStates:{},activeInvocations:{}});
        const callbacks = {onMessage:()=>{}};
        window.readPublishedMessages = () => useChatStore.getState().messages;
        function App() {
          useSocket(callbacks, ${JSON.stringify(threadId)});
          const messages = useChatStore(s=>s.messages);
          return <><h1 className="text-2xl font-bold">合成附件实时发布验证</h1><p className="my-4">此页面仅使用测试数据。收到实时事件后显示文件卡，不加载历史消息。</p><button className="rounded border px-4 py-2 mb-4" onClick={()=>fetch('/fixture/publish',{method:'POST'})}>发布合成附件</button>{messages.map(message=><ChatMessage key={message.id} message={message} getCatById={()=>undefined}/>)}</>;
        }
        createRoot(document.getElementById('root')).render(<App/>);`,
        loader: 'tsx',
        resolveDir: webRoot,
      },
      tsconfig: path.join(webRoot, 'tsconfig.json'),
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
  } catch (error) {
    await new Promise((resolve) => io.close(resolve));
    await app.close();
    throw error;
  }
  return {
    url,
    dir,
    threadId,
    messageStore,
    joined: () => joined,
    historyReads: () => historyReads,
    headers,
    close: async () => {
      await new Promise((resolve) => io.close(resolve));
      await app.close();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startFilePublicationFixture(Number(process.argv[2]));
  console.log(`Synthetic publication preview: ${fixture.url}`);
  process.once('SIGTERM', () => void fixture.close());
  process.once('SIGINT', () => void fixture.close());
}
