import EventEmitter from 'node:events';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatMessage } from '@/components/ChatMessage';
import { useChatStore } from '@/stores/chatStore';
import { useSocket } from '../useSocket';

const { socket } = vi.hoisted(() => ({ socket: { current: null as unknown as EventEmitter } }));
vi.mock('socket.io-client', async (load) => ({
  ...(await load<typeof import('socket.io-client')>()),
  io: () => socket.current,
}));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3198',
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ useCoCreatorConfig: () => ({ name: 'Test owner' }) }));
vi.mock('@/hooks/useTts', () => ({ useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }) }));

let container: HTMLDivElement;
let root: Root;
const callbacks = { onMessage: () => {} };
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
function LiveChat() {
  useSocket(callbacks, 'thread-live');
  const messages = useChatStore((s) => s.messages);
  return (
    <>
      {messages.map((message) => (
        <ChatMessage key={message.id} message={message} getCatById={() => undefined} />
      ))}
    </>
  );
}
const file = {
  id: 'file-test',
  kind: 'file',
  v: 1,
  url: '/uploads/synthetic.txt',
  fileName: 'synthetic.txt',
  mimeType: 'text/plain',
  fileSize: 3,
};
const published = {
  id: 'durable-file',
  type: 'cat',
  catId: 'codex',
  origin: 'callback',
  content: 'synthetic.txt',
  timestamp: 123,
  extra: { isExplicitPost: true, rich: { v: 1, blocks: [file] } },
};
function receive(message = published, threadId = 'thread-live') {
  act(() => {
    EventEmitter.prototype.emit.call(socket.current, 'connector_message', { threadId, message });
  });
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  socket.current = Object.assign(new EventEmitter(), {
    id: 'synthetic-socket',
    connected: true,
    disconnect: vi.fn(),
    emit: vi.fn(),
    io: { engine: { transport: { name: 'websocket' }, on: vi.fn() }, on: vi.fn() },
  });
  useChatStore.setState({ currentThreadId: 'thread-live', messages: [], threadStates: {}, activeInvocations: {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<LiveChat />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

it('renders a durable cat file card from a live socket event without reloading history', () => {
  expect(container.querySelector('a[download]')).toBeNull();
  receive();
  const stored = useChatStore.getState().messages[0];
  expect(stored).toMatchObject({
    id: 'durable-file',
    type: 'assistant',
    catId: 'codex',
    origin: 'callback',
    extra: published.extra,
  });
  const link = container.querySelector('a[download]');
  expect(link?.getAttribute('href')).toContain('/uploads/synthetic.txt');
  expect(link?.getAttribute('download')).toBe('synthetic.txt');
  receive();
  expect(useChatStore.getState().messages).toHaveLength(1);
  expect(container.querySelectorAll('a[download]')).toHaveLength(1);
});

it('keeps background cat messages scoped and rejects a cat envelope without an author', () => {
  receive(published, 'thread-background');
  expect(useChatStore.getState().messages).toHaveLength(0);
  expect(useChatStore.getState().getThreadState('thread-background').messages[0]).toMatchObject({
    type: 'assistant',
    catId: 'codex',
  });
  receive({ ...published, catId: '' });
  expect(useChatStore.getState().messages).toHaveLength(0);
});
