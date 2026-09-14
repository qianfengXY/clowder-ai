// @vitest-environment node
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { io, WebSocket } from 'socket.io-client';
import { expect, it } from 'vitest';
import { BoundedPolling, CHAT_SOCKET_TRANSPORTS } from '../socket-polling-transport';

const { Server } = createRequire(new URL('../../../../api/package.json', import.meta.url))('socket.io');

it.each([false, true])('exchanges messages and heartbeats with real Socket.IO; websocket=%s', async (websocket) => {
  const http = createServer();
  const server = new Server(http, {
    transports: websocket ? ['polling', 'websocket'] : ['polling'],
    pingInterval: 50,
    pingTimeout: 300,
  });
  server.on(
    'connection',
    (socket: { on: (name: string, handler: (data: string, ack: (value: string) => void) => void) => void }) => {
      socket.on('fixture:echo', (data, ack) => ack(data));
    },
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address() as { port: number };
  const socket = io(`http://127.0.0.1:${address.port}`, {
    transports: websocket ? [BoundedPolling, WebSocket] : CHAT_SOCKET_TRANSPORTS,
    tryAllTransports: true,
    timeout: 1000,
    reconnection: false,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    await expect(socket.timeout(1000).emitWithAck('fixture:echo', 'hello')).resolves.toBe('hello');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(socket.connected).toBe(true);
    expect(socket.io.engine.transport.name).toBe(websocket ? 'websocket' : 'polling');
    await expect(socket.timeout(1000).emitWithAck('fixture:echo', 'after heartbeat')).resolves.toBe('after heartbeat');
    socket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.engine.clientsCount).toBe(0);
  } finally {
    socket.disconnect();
    await new Promise<void>((resolve) => server.close(resolve));
    http.closeAllConnections();
  }
});
