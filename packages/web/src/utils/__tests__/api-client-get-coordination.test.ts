import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('apiFetch exact-GET coordination', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('location', {
      hostname: 'localhost',
      port: '3001',
      protocol: 'http:',
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  async function loadApiFetch() {
    const mod = await import('../api-client');
    return mod.apiFetch;
  }

  it('shares one physical GET and gives each caller an independent Response clone', async () => {
    const business = deferred<Response>();
    const mockFetch = vi.fn((url: string) =>
      url.includes('/api/session') ? Promise.resolve(new Response('{}')) : business.promise,
    );
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();

    const first = apiFetch('/api/threads?view=sidebar');
    const second = apiFetch('/api/threads?view=sidebar');
    await vi.waitFor(() =>
      expect(mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/threads'))).toHaveLength(1),
    );

    business.resolve(new Response(JSON.stringify({ generation: 1 }), { status: 200 }));
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(firstResponse).not.toBe(secondResponse);
    await expect(firstResponse.json()).resolves.toEqual({ generation: 1 });
    await expect(secondResponse.json()).resolves.toEqual({ generation: 1 });
  });

  it('does not merge different query strings or request headers', async () => {
    const mockFetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      return Promise.resolve(new Response(String(mockFetch.mock.calls.length)));
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();

    await Promise.all([
      apiFetch('/api/threads?view=sidebar'),
      apiFetch('/api/threads?view=full'),
      apiFetch('/api/threads?view=sidebar', { headers: { authorization: 'Bearer one' } }),
      apiFetch('/api/threads?view=sidebar', { headers: { authorization: 'Bearer two' } }),
    ]);

    expect(mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/threads'))).toHaveLength(4);
  });

  it('lets one caller abort without cancelling the shared physical GET', async () => {
    const business = deferred<Response>();
    let physicalSignal: AbortSignal | null | undefined;
    const mockFetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      physicalSignal = init?.signal;
      return business.promise;
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();
    const controller = new AbortController();

    const aborted = apiFetch('/api/threads', { signal: controller.signal });
    const surviving = apiFetch('/api/threads');
    await vi.waitFor(() =>
      expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/api/threads'))).toHaveLength(1),
    );
    controller.abort();

    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(physicalSignal?.aborted).toBe(false);
    business.resolve(new Response('{}'));
    await expect(surviving).resolves.toMatchObject({ status: 200 });
  });

  it('does not start a physical GET for an already-aborted caller', async () => {
    const mockFetch = vi.fn((url: string) =>
      url.includes('/api/session') ? Promise.resolve(new Response('{}')) : Promise.resolve(new Response('{}')),
    );
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();
    const controller = new AbortController();
    controller.abort();

    await expect(apiFetch('/api/threads', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('aborts the transport when the last caller leaves and does not retry it', async () => {
    let physicalSignal: AbortSignal | null | undefined;
    let businessCalls = 0;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      businessCalls++;
      physicalSignal = init?.signal;
      return new Promise<Response>(() => undefined); // Includes transports ignoring abort.
    }) as typeof fetch;
    const apiFetch = await loadApiFetch();
    const firstController = new AbortController();
    const lastController = new AbortController();
    const first = apiFetch('/api/orphan', { signal: firstController.signal }).catch((e: Error) => e.name);
    const last = apiFetch('/api/orphan', { signal: lastController.signal }).catch((e: Error) => e.name);
    await vi.waitFor(() => expect(businessCalls).toBe(1));
    firstController.abort();
    expect(physicalSignal?.aborted).toBe(false);
    lastController.abort();
    await expect(first).resolves.toBe('AbortError');
    await expect(last).resolves.toBe('AbortError');
    expect(physicalSignal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(businessCalls).toBe(1);
  });

  it('does not send an abandoned GET after shared session bootstrap completes', async () => {
    const session = deferred<Response>();
    const mockFetch = vi.fn((url: string) =>
      url.includes('/api/session') ? session.promise : Promise.resolve(new Response('{}')),
    );
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();
    const controller = new AbortController();
    const abandoned = apiFetch('/api/abandoned', { signal: controller.signal }).catch((e: Error) => e.name);
    const surviving = apiFetch('/api/surviving');
    controller.abort();
    session.resolve(new Response('{}'));
    await expect(abandoned).resolves.toBe('AbortError');
    await surviving;
    expect(mockFetch.mock.calls.some(([url]) => url.endsWith('/api/abandoned'))).toBe(false);
    expect(mockFetch.mock.calls.filter(([url]) => url.includes('/api/session'))).toHaveLength(1);
  });

  it('drops a trailing generation whose callers all cancel before it starts', async () => {
    const business = deferred<Response>();
    let businessCalls = 0;
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      businessCalls++;
      return businessCalls === 1 ? business.promise : Promise.resolve(new Response('unexpected'));
    }) as typeof fetch;
    const apiFetch = await loadApiFetch();
    const current = apiFetch('/api/trailing');
    await vi.waitFor(() => expect(businessCalls).toBe(1));
    const controller = new AbortController();
    const trailing = apiFetch('/api/trailing', { signal: controller.signal }, { afterCurrentGet: true }).catch(
      (e: Error) => e.name,
    );
    controller.abort();
    business.resolve(new Response('current'));
    await current;
    await expect(trailing).resolves.toBe('AbortError');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(businessCalls).toBe(1);
  });

  it('promotes a live trailing generation when the active generation is abandoned', async () => {
    const next = deferred<Response>();
    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      signals.push(init?.signal);
      return signals.length === 1 ? new Promise<Response>(() => undefined) : next.promise;
    }) as typeof fetch;
    const apiFetch = await loadApiFetch();
    const controller = new AbortController();
    const current = apiFetch('/api/promote', { signal: controller.signal }).catch((e: Error) => e.name);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const trailing = apiFetch('/api/promote', undefined, { afterCurrentGet: true });
    controller.abort();
    await expect(current).resolves.toBe('AbortError');
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    next.resolve(new Response('fresh'));
    await expect((await trailing).text()).resolves.toBe('fresh');
  });

  it('a synchronous new caller never joins the abandoned generation or loses its coordination', async () => {
    const next = deferred<Response>();
    let businessCalls = 0;
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      businessCalls++;
      return businessCalls === 1 ? new Promise<Response>(() => undefined) : next.promise;
    }) as typeof fetch;
    const apiFetch = await loadApiFetch();
    const controller = new AbortController();
    const old = apiFetch('/api/rejoin', { signal: controller.signal }).catch((e: Error) => e.name);
    await vi.waitFor(() => expect(businessCalls).toBe(1));
    controller.abort();
    const fresh = apiFetch('/api/rejoin');
    await expect(old).resolves.toBe('AbortError');
    await vi.waitFor(() => expect(businessCalls).toBe(2));
    const peer = apiFetch('/api/rejoin');
    next.resolve(new Response('fresh'));
    await expect((await fresh).text()).resolves.toBe('fresh');
    await expect((await peer).text()).resolves.toBe('fresh');
    expect(businessCalls).toBe(2);
  });

  it('queues exactly one trailing generation for concurrent causal invalidations', async () => {
    const generations = [deferred<Response>(), deferred<Response>()];
    let businessCalls = 0;
    const mockFetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      return generations[businessCalls++]?.promise ?? Promise.reject(new Error('unexpected generation'));
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();

    const current = apiFetch('/api/threads?view=sidebar');
    await vi.waitFor(() => expect(businessCalls).toBe(1));
    const invalidatedOnce = apiFetch('/api/threads?view=sidebar', undefined, { afterCurrentGet: true });
    const invalidatedTwice = apiFetch('/api/threads?view=sidebar', undefined, { afterCurrentGet: true });
    expect(businessCalls).toBe(1);

    generations[0]?.resolve(new Response('current'));
    await vi.waitFor(() => expect(businessCalls).toBe(2));
    generations[1]?.resolve(new Response('trailing'));

    await expect((await current).text()).resolves.toBe('current');
    await expect((await invalidatedOnce).text()).resolves.toBe('trailing');
    await expect((await invalidatedTwice).text()).resolves.toBe('trailing');
    expect(businessCalls).toBe(2);
  });

  it('retains a trailing generation while another caller still needs its validator', async () => {
    const business = deferred<Response>();
    const inits: Array<RequestInit | undefined> = [];
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      inits.push(init);
      return inits.length === 1 ? business.promise : Promise.resolve(new Response(null, { status: 304 }));
    }) as typeof fetch;
    const apiFetch = await loadApiFetch();
    const active = apiFetch('/api/validator');
    await vi.waitFor(() => expect(inits).toHaveLength(1));
    const controller = new AbortController();
    const canceled = apiFetch(
      '/api/validator',
      { signal: controller.signal },
      {
        afterCurrentGet: true,
        ifNoneMatch: '"version-2"',
      },
    ).catch((e: Error) => e.name);
    const survivor = apiFetch('/api/validator', undefined, { afterCurrentGet: true });
    controller.abort();
    business.resolve(new Response('{}'));
    await active;
    await expect(canceled).resolves.toBe('AbortError');
    await expect(survivor).resolves.toMatchObject({ status: 304 });
    expect(inits).toHaveLength(2);
    expect(new Headers(inits[1]?.headers).get('if-none-match')).toBe('"version-2"');
  });

  it('releases an abandoned JSON body reader as well as the physical signal', async () => {
    let physicalSignal: AbortSignal | null | undefined;
    const cancel = vi.fn();
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      physicalSignal = init?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"open":'));
            },
            cancel,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof fetch;
    const apiFetch = await loadApiFetch();
    const controller = new AbortController();
    const abandoned = apiFetch('/api/body', { signal: controller.signal }).catch((e: Error) => e.name);
    await vi.waitFor(() => expect(physicalSignal).toBeDefined());
    controller.abort();
    await expect(abandoned).resolves.toBe('AbortError');
    expect(physicalSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('keeps a successfully delivered non-JSON stream readable after caller cleanup', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let physicalSignal: AbortSignal | null | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      physicalSignal = init?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              streamController = controller;
            },
          }),
          { headers: { 'content-type': 'text/plain' } },
        ),
      );
    }) as typeof fetch;
    const apiFetch = await loadApiFetch();
    const controller = new AbortController();
    const response = await apiFetch('/api/download', { signal: controller.signal });
    controller.abort();
    expect(physicalSignal?.aborted).toBe(false);
    streamController.enqueue(new TextEncoder().encode('download complete'));
    streamController.close();
    await expect(response.text()).resolves.toBe('download complete');
  });

  it('settles each caller on its assigned generation under continuous invalidation', async () => {
    const generations = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    let businessCalls = 0;
    const mockFetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      return generations[businessCalls++]?.promise ?? Promise.reject(new Error('unexpected generation'));
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();

    const current = apiFetch('/api/threads');
    await vi.waitFor(() => expect(businessCalls).toBe(1));
    const firstInvalidation = apiFetch('/api/threads', undefined, { afterCurrentGet: true });
    generations[0]?.resolve(new Response('one'));
    await vi.waitFor(() => expect(businessCalls).toBe(2));

    const secondInvalidation = apiFetch('/api/threads', undefined, { afterCurrentGet: true });
    generations[1]?.resolve(new Response('two'));
    await expect((await firstInvalidation).text()).resolves.toBe('two');
    await vi.waitFor(() => expect(businessCalls).toBe(3));

    generations[2]?.resolve(new Response('three'));
    await expect((await secondInvalidation).text()).resolves.toBe('three');
    await expect((await current).text()).resolves.toBe('one');
  });

  it('never coordinates mutation requests', async () => {
    let postCalls = 0;
    const mockFetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      postCalls += 1;
      return Promise.resolve(new Response('{}'));
    });
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();

    await Promise.all([apiFetch('/api/threads', { method: 'POST' }), apiFetch('/api/threads', { method: 'POST' })]);

    expect(postCalls).toBe(2);
  });

  it('admits thread creation within two seconds during navigation and periodic read pressure', async () => {
    const maxConnections = 6;
    const serviceDelayMs = 250;
    let active = 0;
    let postIngressAt: number | null = null;
    const pending: Array<{
      url: string;
      init?: RequestInit;
      resolve(response: Response): void;
    }> = [];

    const drain = () => {
      while (active < maxConnections && pending.length > 0) {
        const request = pending.shift() as (typeof pending)[number];
        active += 1;
        if (request.init?.method === 'POST') postIngressAt = performance.now();
        const delay = request.url.includes('/api/session') ? 0 : serviceDelayMs;
        setTimeout(() => {
          active -= 1;
          request.resolve(new Response('{}', { status: 200 }));
          drain();
        }, delay);
      }
    };
    const mockFetch = vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          pending.push({ url, init, resolve });
          drain();
        }),
    );
    globalThis.fetch = mockFetch as typeof fetch;
    const apiFetch = await loadApiFetch();
    const clickedAt = performance.now();

    const navigationReads = Array.from({ length: 15 }, (_, index) => apiFetch(`/api/navigation/${index}`));
    const periodicReads = Array.from({ length: 7 }, (_, source) =>
      Array.from({ length: 4 }, () => apiFetch(`/api/poll/${source}`)),
    ).flat();
    const create = apiFetch('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'liveness fixture' }),
    });

    await create;
    expect(postIngressAt).not.toBeNull();
    expect((postIngressAt ?? Number.POSITIVE_INFINITY) - clickedAt).toBeLessThan(2_000);
    expect(
      mockFetch.mock.calls.filter(([url, init]) => !String(url).includes('/api/session') && init?.method !== 'POST'),
    ).toHaveLength(22);
    await Promise.all([...navigationReads, ...periodicReads]);
  }, 5_000);
});
