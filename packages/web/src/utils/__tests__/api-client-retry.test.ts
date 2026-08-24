import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('apiFetch 401 retry', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  async function loadApiModules() {
    vi.resetModules();
    // Stub location so resolveApiUrl picks a deterministic base
    vi.stubGlobal('location', {
      hostname: 'localhost',
      port: '3001',
      protocol: 'http:',
    });
    const [apiClientMod, toastStoreMod] = await Promise.all([
      import('../api-client'),
      import('../../stores/toastStore'),
    ]);
    toastStoreMod.useToastStore.setState({ toasts: [] });
    return {
      apiFetch: apiClientMod.apiFetch,
      useToastStore: toastStoreMod.useToastStore,
    };
  }

  it('retries once after 401 by re-establishing session', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      // Session endpoint always succeeds
      if (url.includes('/api/session')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      // First data call returns 401, second succeeds
      if (calls.filter((c) => c.includes('/api/messages')).length === 1) {
        return Promise.resolve(new Response('{}', { status: 401 }));
      }
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch } = await loadApiModules();
    const res = await apiFetch('/api/messages');

    expect(res.status).toBe(200);
    // Should have called: session (init), messages (401), session (retry), messages (success)
    const sessionCalls = calls.filter((c) => c.includes('/api/session'));
    const messageCalls = calls.filter((c) => c.includes('/api/messages'));
    expect(sessionCalls.length).toBe(2);
    expect(messageCalls.length).toBe(2);
  });

  it('does not retry on non-401 errors', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      if (url.includes('/api/session')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 500 }));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch } = await loadApiModules();
    const res = await apiFetch('/api/messages');

    expect(res.status).toBe(500);
    const messageCalls = calls.filter((c) => c.includes('/api/messages'));
    expect(messageCalls.length).toBe(1);
  });

  it('passes credentials: include on all requests including retry', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/session')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      // Always 401 to trigger retry path
      return Promise.resolve(new Response('{}', { status: 401 }));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch } = await loadApiModules();
    await apiFetch('/api/test');

    // Every call should have credentials: 'include'
    for (const call of mockFetch.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.credentials).toBe('include');
    }
  });

  it('does not show an error toast when 401 self-heals on retry', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      if (url.includes('/api/session')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (calls.filter((c) => c.includes('/api/messages')).length === 1) {
        return Promise.resolve(new Response('{}', { status: 401 }));
      }
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch, useToastStore } = await loadApiModules();
    const res = await apiFetch('/api/messages');

    expect(res.status).toBe(200);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('shows a visible error toast when 401 persists after retry', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/session')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 401 }));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch, useToastStore } = await loadApiModules();
    const res = await apiFetch('/api/messages');

    expect(res.status).toBe(401);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.type).toBe('error');
    expect(toasts[0]?.title).toContain('会话');
  });

  it('retries session bootstrap within the same call after a network failure', async () => {
    const calls: string[] = [];
    let sessionAttempts = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      if (url.includes('/api/session')) {
        sessionAttempts += 1;
        if (sessionAttempts === 1) {
          return Promise.reject(new Error('offline'));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch } = await loadApiModules();

    const res = await apiFetch('/api/messages');

    expect(res.status).toBe(200);
    const sessionCalls = calls.filter((c) => c.includes('/api/session'));
    const messageCalls = calls.filter((c) => c.includes('/api/messages'));
    expect(sessionCalls.length).toBe(2);
    expect(messageCalls.length).toBe(1);
  });

  it('retries a stuck session bootstrap on a fresh connection after its timeout', async () => {
    vi.useFakeTimers();
    let sessionAttempts = 0;
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/session')) {
        sessionAttempts += 1;
        if (sessionAttempts === 1) {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
              once: true,
            });
          });
        }
        return Promise.resolve({ ok: true, status: 200 });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });
    globalThis.fetch = mockFetch;

    const { apiFetch } = await loadApiModules();
    const response = apiFetch('/api/messages');
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(response).resolves.toMatchObject({ status: 200 });
    expect(sessionAttempts).toBe(2);
    vi.useRealTimers();
  });

  it('retries a timed-out GET once on a fresh connection', async () => {
    vi.useFakeTimers();
    let messageAttempts = 0;
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/session')) return Promise.resolve({ ok: true, status: 200 });
      messageAttempts += 1;
      if (messageAttempts === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });
    globalThis.fetch = mockFetch;

    const { apiFetch } = await loadApiModules();
    const response = apiFetch('/api/audit/thread/t1');
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(response).resolves.toMatchObject({ status: 200 });
    expect(messageAttempts).toBe(2);
    vi.useRealTimers();
  });

  it('does not retry a failed mutation', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve({ ok: true, status: 200 });
      return Promise.reject(new Error('tunnel reset'));
    });
    globalThis.fetch = mockFetch;

    const { apiFetch } = await loadApiModules();
    await expect(apiFetch('/api/messages', { method: 'POST', body: '{}' })).rejects.toThrow('tunnel reset');

    const messageCalls = mockFetch.mock.calls.filter((call) => (call[0] as string).includes('/api/messages'));
    expect(messageCalls).toHaveLength(1);
  });
});
