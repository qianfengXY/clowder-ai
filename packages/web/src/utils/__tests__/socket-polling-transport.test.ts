import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedPolling, SOCKET_POLL_TIMEOUT_MS } from '../socket-polling-transport';

function transport(extra = {}) {
  return new BoundedPolling({
    hostname: 'localhost',
    port: '3004',
    path: '/socket.io/',
    secure: false,
    query: { EIO: '4', transport: 'polling' },
    socket: { binaryType: 'arraybuffer' },
    ...extra,
  });
}

function hangingFetch() {
  const calls: Array<{ signal: AbortSignal; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal!;
          calls.push({ signal, init });
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    ),
  );
  return calls;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Socket polling HTTP request ownership', () => {
  it('aborts both GET and POST when closing an unfinished handshake', async () => {
    const calls = hangingFetch();
    const poll = transport().open();
    const written = vi.fn();
    poll.doWrite('40', written);
    expect(calls).toHaveLength(2);
    poll.close();
    expect(calls.every(({ signal }) => signal.aborted)).toBe(true);
    await Promise.resolve();
    expect(written).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('also aborts requests while pausing for a WebSocket upgrade', () => {
    const calls = hangingFetch();
    const poll = transport().open();
    poll.onData('0{"sid":"test","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
    poll.pause(vi.fn());
    poll.close();
    expect(calls.every(({ signal }) => signal.aborted)).toBe(true);
  });

  it('keeps a healthy quiet poll alive past API deadlines, then aborts at its own deadline', async () => {
    vi.useFakeTimers();
    const calls = hangingFetch();
    const poll = transport().open();
    const error = vi.fn();
    poll.on('error', error);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(calls[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(SOCKET_POLL_TIMEOUT_MS - 25_000);
    expect(calls[0].signal.aborted).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    poll.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds POST through its response body and never acknowledges headers alone', async () => {
    vi.useFakeTimers();
    let requestSignal!: AbortSignal;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        requestSignal = init.signal;
        return {
          ok: true,
          text: () =>
            new Promise((_resolve, reject) => {
              requestSignal.addEventListener('abort', () => reject(requestSignal.reason));
            }),
        };
      }),
    );
    const poll = transport({ requestTimeout: 100 });
    const written = vi.fn();
    const error = vi.fn();
    poll.on('error', error);
    poll.doWrite('40', written);
    await vi.advanceTimersByTimeAsync(101);
    expect(requestSignal.aborted).toBe(true);
    expect(written).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores responses arriving after close even if the transport ignores abort', async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const poll = transport().open();
    const packet = vi.fn();
    poll.on('packet', packet);
    poll.close();
    finish(new Response('0{"sid":"late","upgrades":[]}'));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(packet).not.toHaveBeenCalled();
  });

  it('limits the best-effort close POST to two seconds', async () => {
    vi.useFakeTimers();
    const calls = hangingFetch();
    const poll = transport().open();
    poll.onData('0{"sid":"test","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
    poll.query.sid = 'test';
    poll.close();
    const close = calls.find(({ init }) => init.body === '1');
    expect(close).toBeDefined();
    expect(calls.filter((call) => call !== close).every(({ signal }) => signal.aborted)).toBe(true);
    expect(close!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(close!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('server close cancels a concurrent POST without acknowledging it', async () => {
    const calls = hangingFetch();
    const poll = transport().open();
    const written = vi.fn();
    poll.doWrite('40', written);
    poll.onData('1');
    expect(calls.every(({ signal }) => signal.aborted)).toBe(true);
    await Promise.resolve();
    expect(written).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves XHR cookie semantics with withCredentials=%s', async (withCredentials) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok')),
    );
    const done = vi.fn();
    transport({ withCredentials }).doWrite('40', done);
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        credentials: withCredentials ? 'include' : 'same-origin',
        method: 'POST',
        body: '40',
      }),
    );
  });
});
