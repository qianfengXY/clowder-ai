import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function stalledJson(init?: ResponseInit) {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
        controller.enqueue(new TextEncoder().encode('{"ok":'));
      },
      cancel,
    }),
    { headers: { 'content-type': 'application/json' }, ...init },
  );
  return {
    response,
    cancel,
    finish: () => {
      body.enqueue(new TextEncoder().encode('true}'));
      body.close();
    },
  };
}

describe('finite API response lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('location', { hostname: 'localhost', port: '3003', protocol: 'http:' });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    'text/html',
    'text/plain',
    null,
  ])('releases a stalled non-success body with content type %s before it can occupy an HTTP/1.1 slot forever', async (contentType) => {
    const stalled = stalledJson({
      status: 502,
      headers: contentType ? { 'content-type': contentType } : {},
    });
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        signal = init?.signal;
        return stalled.response;
      }),
    );
    const { boundedFetch } = await import('../bounded-fetch');
    let outcome = 'pending';
    const request = boundedFetch('/api/threads', {}, 500).then(
      () => {
        outcome = 'resolved';
      },
      (error) => {
        outcome = error.name;
      },
    );
    await vi.advanceTimersByTimeAsync(501);
    await request;
    expect(outcome).toBe('TimeoutError');
    expect(signal?.aborted).toBe(true);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the status and readable body of a completed HTML error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<h1>Bad Gateway</h1>', {
            status: 502,
            headers: { 'content-type': 'text/html', 'x-proxy-error': 'gateway' },
          }),
      ),
    );
    const { boundedFetch } = await import('../bounded-fetch');
    const response = await boundedFetch('/api/threads', {}, 500);
    expect(response.status).toBe(502);
    expect(response.headers.get('x-proxy-error')).toBe('gateway');
    expect(await response.text()).toBe('<h1>Bad Gateway</h1>');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds stalled JSON bodies even if the transport ignores abort, without replaying a mutation', async () => {
    const stalled = stalledJson();
    let signal: AbortSignal | undefined | null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/session')) return new Response('{}');
      signal = init?.signal;
      return stalled.response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = await import('../api-client');
    let outcome = 'pending';
    const completed = apiFetch('/api/messages', { method: 'POST', body: '{}' })
      .then((r) => r.json())
      .then(
        () => {
          outcome = 'resolved';
        },
        (e) => {
          outcome = e.name;
        },
      );
    await vi.advanceTimersByTimeAsync(30_001);
    expect(outcome).toBe('TimeoutError');
    expect(signal?.aborted).toBe(true);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/api/messages'))).toHaveLength(1);
    await completed;
  });

  it('shares a GET until its entire body arrives and defers causal invalidation until then', async () => {
    const stalled = stalledJson();
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/session')) return new Response('{}');
        return ++calls === 1 ? stalled.response : Response.json({ generation: 2 });
      }),
    );
    const { apiFetch } = await import('../api-client');
    const first = apiFetch('/api/threads');
    await vi.advanceTimersByTimeAsync(1);
    const peer = apiFetch('/api/threads');
    const trailing = apiFetch('/api/threads', undefined, { afterCurrentGet: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(1);
    stalled.finish();
    const responses = await Promise.all([first, peer, trailing]);
    expect(await Promise.all(responses.map((r) => r.json()))).toEqual([{ ok: true }, { ok: true }, { generation: 2 }]);
    expect(calls).toBe(2);
  });

  it('honors one caller abort during shared body reading without cancelling its peer', async () => {
    const stalled = stalledJson();
    let physicalSignal: AbortSignal | undefined | null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/session')) return new Response('{}');
        physicalSignal = init?.signal;
        return stalled.response;
      }),
    );
    const { apiFetch } = await import('../api-client');
    const controller = new AbortController();
    let outcome = 'pending';
    const first = apiFetch('/api/threads', { signal: controller.signal })
      .then((r) => r.json())
      .then(
        () => {
          outcome = 'resolved';
        },
        (e) => {
          outcome = e.name;
        },
      );
    const peer = apiFetch('/api/threads');
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('AbortError');
    expect(physicalSignal?.aborted).toBe(false);
    stalled.finish();
    expect(await (await peer).json()).toEqual({ ok: true });
    await first;
  });

  it('still delivers SSE immediately without applying the JSON body deadline', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: hello\n\n'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/api/session')
          ? new Response('{}')
          : new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      ),
    );
    const { apiFetch } = await import('../api-client');
    const response = await apiFetch('/api/tts/stream', { method: 'POST' });
    if (!response.body) throw new Error('Expected streaming body');
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: hello\n\n');
    await vi.advanceTimersByTimeAsync(30_001);
    await reader.cancel();
  });

  it('bounds both GET body attempts, cancels abandoned readers, and permits a fresh read', async () => {
    const bodies = [stalledJson(), stalledJson()];
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/session')) return new Response('{}');
        return bodies[calls++]?.response ?? Response.json({ recovered: true });
      }),
    );
    const { apiFetch } = await import('../api-client');
    let outcome = 'pending';
    const request = apiFetch('/api/vote').then(
      () => {
        outcome = 'resolved';
      },
      (e) => {
        outcome = e.name;
      },
    );
    await vi.advanceTimersByTimeAsync(16_001);
    expect(outcome).toBe('TimeoutError');
    expect(calls).toBe(2);
    expect(bodies.every((body) => body.cancel.mock.calls.length === 1)).toBe(true);
    expect(await (await apiFetch('/api/vote')).json()).toEqual({ recovered: true });
    await request;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leave a JSON session bootstrap waiting on an unconsumed body', async () => {
    const bodies = [stalledJson(), stalledJson(), stalledJson()];
    let sessions = 0;
    let business = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/session')) {
          const body = bodies[sessions++];
          if (!body) throw new Error('Unexpected bootstrap retry');
          return body.response;
        }
        business++;
        return Response.json({ ok: true });
      }),
    );
    const { apiFetch } = await import('../api-client');
    let outcome = 'pending';
    const request = apiFetch('/api/threads').catch((e) => {
      outcome = e.name;
    });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(outcome).toBe('TimeoutError');
    expect(sessions).toBe(3);
    expect(business).toBe(0);
    await request;
  });

  it('keeps JSON status, headers and independent unread clones, including empty 304s', async () => {
    const { boundedFetch } = await import('../bounded-fetch');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"error":"conflict"}', {
            status: 409,
            statusText: 'Conflict',
            headers: { 'content-type': 'application/problem+json; charset=utf-8', etag: '"v1"' },
          }),
      ),
    );
    const response = await boundedFetch('/fixture', {}, 100);
    expect(response.status).toBe(409);
    expect(response.statusText).toBe('Conflict');
    expect(response.headers.get('etag')).toBe('"v1"');
    expect(response.bodyUsed).toBe(false);
    expect(await response.clone().json()).toEqual({ error: 'conflict' });
    expect(await response.json()).toEqual({ error: 'conflict' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 304, headers: { etag: '"v1"' } })),
    );
    expect((await boundedFetch('/fixture', {}, 100)).status).toBe(304);
    expect(vi.getTimerCount()).toBe(0);
  });
});
