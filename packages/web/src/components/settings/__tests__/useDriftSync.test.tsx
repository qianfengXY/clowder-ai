import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useDriftSync } from '../useDriftSync';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

let latestResult: ReturnType<typeof useDriftSync> | null = null;

function HookHost({ enabled }: { enabled: boolean }) {
  latestResult = useDriftSync({
    type: 'skill',
    projectPaths: ['/workspace/project'],
    resolvedProjectPath: '/workspace/main',
    enabled,
  });
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function driftResponse(projectPath?: string) {
  return new Response(
    JSON.stringify({
      result: { issues: [], driftHash: projectPath ?? 'global', syncAllowed: true },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('useDriftSync write eligibility', () => {
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
    latestResult = null;
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          result: { issues: [], driftHash: 'global', syncAllowed: true },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('resolves server write eligibility even when full scope reports are disabled', async () => {
    await act(async () => {
      root.render(<HookHost enabled={false} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(latestResult?.canSync).toBe(true);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(apiFetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ type: 'skill' });
  });

  it('ignores an older authority failure after full reports succeed', async () => {
    const olderAuthority = deferred<Response>();
    let globalRequests = 0;
    vi.mocked(apiFetch).mockImplementation((_input, init) => {
      const body = JSON.parse(String(init?.body)) as { projectPath?: string };
      if (!body.projectPath && globalRequests++ === 0) return olderAuthority.promise;
      return Promise.resolve(driftResponse(body.projectPath));
    });

    await act(async () => {
      root.render(<HookHost enabled={false} />);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<HookHost enabled />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(latestResult?.canSync).toBe(true);
    expect(latestResult?.syncAllError).toBeNull();

    await act(async () => {
      olderAuthority.reject(new Error('stale authority request failed'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(latestResult?.canSync).toBe(true);
    expect(latestResult?.syncAllError).toBeNull();
  });
});
