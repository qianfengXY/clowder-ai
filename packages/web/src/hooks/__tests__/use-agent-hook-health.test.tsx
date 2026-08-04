import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAgentHookHealthCacheForTests, useAgentHookHealth } from '@/hooks/useAgentHookHealth';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const configuredResponse = {
  status: 'configured',
  targets: [
    {
      name: 'hooks/session-start',
      status: 'configured',
      drifted: false,
      reason: 'configured',
      targetPath: '/home/user/.claude/hooks/session-start-recall.sh',
    },
  ],
};

const staleResponse = {
  status: 'stale',
  targets: [
    {
      name: 'skills',
      status: 'stale',
      drifted: true,
      reason: '1 stale, 196 conflicts',
      targetPath: '',
    },
  ],
};

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function Probe({ onStatus }: { onStatus: (status: string | null) => void }) {
  const { health } = useAgentHookHealth({ enabled: true });
  useEffect(() => {
    onStatus(health?.status ?? null);
  }, [health?.status, onStatus]);
  return null;
}

let latestResult: ReturnType<typeof useAgentHookHealth> | null = null;

function ResultProbe() {
  latestResult = useAgentHookHealth({ enabled: true, projectPath: '/workspace/project' });
  return null;
}

describe('useAgentHookHealth', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    resetAgentHookHealthCacheForTests();
    latestResult = null;
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => configuredResponse,
    } as Response);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('caches status for the browser session instead of refetching per mount', async () => {
    const statuses: Array<string | null> = [];

    await act(async () => {
      root.render(<Probe onStatus={(status) => statuses.push(status)} />);
      await flushPromises();
    });

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    await act(async () => {
      root.render(<Probe onStatus={(status) => statuses.push(status)} />);
      await flushPromises();
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/agent-hooks/status');
    expect(statuses).toContain('configured');
  });

  it('records a partial sync attempt when sync succeeds but drift remains', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => staleResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => staleResponse,
      } as Response);

    await act(async () => {
      root.render(<ResultProbe />);
      await flushPromises();
    });

    await act(async () => {
      await latestResult?.sync();
      await flushPromises();
    });

    expect(latestResult?.health).toEqual(staleResponse);
    expect(latestResult?.synced).toBe(false);
    expect(latestResult?.syncAttempted).toBe(true);
  });

  it('surfaces an uninitialized project as a non-syncable health result', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Project not initialized (missing .cat-cafe/): /workspace/project' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await act(async () => {
      root.render(<ResultProbe />);
      await flushPromises();
    });

    expect(latestResult?.error).toBeNull();
    expect(latestResult?.health).toMatchObject({
      status: 'error',
      targets: [],
      syncAllowed: false,
      message: 'Project not initialized (missing .cat-cafe/): /workspace/project',
    });
  });

  it('surfaces remote host protection as unsupported and non-syncable', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Agent hook health requires an explicit targetRoot or a local API host' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await act(async () => {
      root.render(<ResultProbe />);
      await flushPromises();
    });

    expect(latestResult?.error).toBeNull();
    expect(latestResult?.health).toMatchObject({
      status: 'unsupported',
      targets: [],
      syncAllowed: false,
      message: '为保护本机 Agent 配置，环境检测和一键同步仅支持通过 localhost Hub 操作。',
    });
  });

  it('does not cache transient client errors as permanent health', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Too many requests' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(configuredResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    await act(async () => {
      root.render(<ResultProbe />);
      await flushPromises();
    });

    expect(latestResult?.health).toBeNull();
    expect(latestResult?.error).toBe('Too many requests');

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    await act(async () => {
      root.render(<ResultProbe />);
      await flushPromises();
    });

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(latestResult?.health?.status).toBe('configured');
    expect(latestResult?.error).toBeNull();
  });

  it('forces a fresh status request after setup and ignores the older in-flight result', async () => {
    const beforeSetup = deferred<Response>();
    const afterSetup = deferred<Response>();
    vi.mocked(apiFetch).mockReturnValueOnce(beforeSetup.promise).mockReturnValueOnce(afterSetup.promise);

    await act(async () => {
      root.render(<ResultProbe />);
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenCalledTimes(1);

    const refresh = latestResult?.refresh;
    if (!refresh) throw new Error('Missing hook refresh action');
    let refreshPromise = Promise.resolve();
    act(() => {
      refreshPromise = refresh();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      afterSetup.resolve(
        new Response(JSON.stringify(configuredResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await refreshPromise;
    });
    expect(latestResult?.health?.status).toBe('configured');

    await act(async () => {
      beforeSetup.resolve(
        new Response(JSON.stringify({ error: 'Project not initialized (missing .cat-cafe/)' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await flushPromises();
    });

    expect(latestResult?.health?.status).toBe('configured');
    expect(latestResult?.error).toBeNull();

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(<ResultProbe />);
      await flushPromises();
    });

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(latestResult?.health?.status).toBe('configured');
  });

  it('keeps a successful sync authoritative when an older status request finishes later', async () => {
    const beforeSync = deferred<Response>();
    const syncRequest = deferred<Response>();
    vi.mocked(apiFetch).mockReturnValueOnce(beforeSync.promise).mockReturnValueOnce(syncRequest.promise);

    await act(async () => {
      root.render(<ResultProbe />);
      await Promise.resolve();
    });

    const sync = latestResult?.sync;
    if (!sync) throw new Error('Missing hook sync action');
    let syncPromise = Promise.resolve();
    act(() => {
      syncPromise = sync();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenLastCalledWith('/api/agent-hooks/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: '/workspace/project' }),
    });

    await act(async () => {
      syncRequest.resolve(
        new Response(JSON.stringify(configuredResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await syncPromise;
    });
    expect(latestResult?.health?.status).toBe('configured');
    expect(latestResult?.synced).toBe(true);

    await act(async () => {
      beforeSync.resolve(
        new Response(JSON.stringify({ error: 'Project not initialized (missing .cat-cafe/)' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await flushPromises();
    });

    expect(latestResult?.health?.status).toBe('configured');
    expect(latestResult?.synced).toBe(true);
    expect(latestResult?.error).toBeNull();
  });

  it('rejects malformed optional health metadata', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'configured', targets: [], syncAllowed: 'yes' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await act(async () => {
      root.render(<ResultProbe />);
      await flushPromises();
    });

    expect(latestResult?.health).toBeNull();
    expect(latestResult?.error).toBe('agent hook status response is invalid');
  });
});
