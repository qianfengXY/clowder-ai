import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import {
  mockAgentHookRefresh,
  mockGovRefetch,
  mockUseAgentHookHealth,
  renderChatContainer,
  resetChatContainerMocks,
  setMockGovernanceStatus,
  staleAgentHookHealth,
  storeState,
} from './chat-container-test-helpers';

describe('ChatContainer governance refetch', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    resetChatContainerMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('does not refetch governance status when switching threads within the same project', async () => {
    await act(async () => {
      root.render(renderChatContainer('thread-a'));
    });

    expect(mockGovRefetch).not.toHaveBeenCalled();

    await act(async () => {
      root.render(renderChatContainer('thread-b'));
    });

    expect(mockGovRefetch).not.toHaveBeenCalled();
  });

  it('does not render stale agent hook health outside project threads', async () => {
    mockUseAgentHookHealth.mockReturnValue({
      health: staleAgentHookHealth,
      error: null,
      syncing: false,
      synced: false,
      syncAttempted: false,
      sync: vi.fn(),
      refresh: mockAgentHookRefresh,
    });

    await act(async () => {
      root.render(renderChatContainer('thread-a'));
    });

    expect(container.textContent).toContain('Agent 运行环境需要同步');

    storeState.currentProjectPath = 'default';
    await act(async () => {
      root.render(renderChatContainer('thread-b'));
    });

    expect(mockUseAgentHookHealth).toHaveBeenCalledWith({ enabled: false, projectPath: 'default' });
    expect(container.textContent).not.toContain('Agent 运行环境需要同步');
  });

  it('refreshes governance and agent-hook health after project setup completes', async () => {
    setMockGovernanceStatus({ isEmptyDir: true, isGitRepo: false, gitAvailable: true });

    await act(async () => {
      root.render(renderChatContainer('thread-a'));
    });

    const complete = container.querySelector<HTMLButtonElement>('[data-testid="project-setup-complete"]');
    expect(complete).not.toBeNull();

    await act(async () => {
      complete?.click();
    });

    expect(mockGovRefetch).toHaveBeenCalledTimes(1);
    expect(mockAgentHookRefresh).toHaveBeenCalledTimes(1);
  });
  it('rebinds the active project when thread detail has a newer projectPath than the cached thread list', async () => {
    const reboundProjectPath = '/tmp/rebound-project';
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        ({
          ok: true,
          json: async () =>
            path === '/api/threads/thread-a' ? { id: 'thread-a', projectPath: reboundProjectPath } : { threads: [] },
        }) as Response,
    );

    await act(async () => {
      root.render(renderChatContainer('thread-a'));
    });

    expect(storeState.setCurrentProject).toHaveBeenCalledWith(reboundProjectPath);
    expect(storeState.threads.find((thread) => thread.id === 'thread-a')?.projectPath).toBe(reboundProjectPath);
  });

  it('ignores an older thread detail response after a newer reconciliation succeeds', async () => {
    type ThreadPayload = { id: string; projectPath: string };
    let resolveOlder!: (value: ThreadPayload) => void;
    let resolveNewer!: (value: ThreadPayload) => void;
    const older = new Promise<ThreadPayload>((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise<ThreadPayload>((resolve) => {
      resolveNewer = resolve;
    });
    let threadReads = 0;
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        ({
          ok: true,
          json: () => {
            if (path !== '/api/threads/thread-a') return Promise.resolve({ threads: [] });
            threadReads += 1;
            return threadReads === 1 ? older : newer;
          },
        }) as Response,
    );

    await act(async () => {
      root.render(renderChatContainer('thread-a'));
    });
    storeState.hasActiveInvocation = true;
    await act(async () => {
      root.render(renderChatContainer('thread-a'));
    });
    storeState.hasActiveInvocation = false;
    await act(async () => {
      root.render(renderChatContainer('thread-a'));
    });

    await act(async () => {
      resolveNewer({ id: 'thread-a', projectPath: '/tmp/newer-project' });
      await newer;
    });
    expect(storeState.threads.find((thread) => thread.id === 'thread-a')?.projectPath).toBe('/tmp/newer-project');

    await act(async () => {
      resolveOlder({ id: 'thread-a', projectPath: '/tmp/older-project' });
      await older;
    });

    expect(storeState.threads.find((thread) => thread.id === 'thread-a')?.projectPath).toBe('/tmp/newer-project');
    expect(storeState.setCurrentProject).not.toHaveBeenCalledWith('/tmp/older-project');
  });
});
