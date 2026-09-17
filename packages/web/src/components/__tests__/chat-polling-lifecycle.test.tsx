import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('../ThreadIndicator', () => ({ ThreadIndicator: () => null, tailTruncate: (s: string) => s }));
vi.mock('../ThreadCatPill', () => ({ ThreadCatPill: () => null }));

import { ChatContainerHeader } from '../ChatContainerHeader';
import { VoteActiveBar } from '../VoteActiveBar';

describe('chat background reads', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiFetch.mockReset();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  for (const kind of ['vote', 'active-pane']) {
    it(`${kind}: waits for the body, then aborts its subscription and stops polling on unmount`, async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      let finish!: (value: unknown) => void;
      apiFetch.mockResolvedValue({
        ok: true,
        json: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      });
      try {
        await act(async () => {
          root.render(
            kind === 'vote' ? (
              <VoteActiveBar threadId="fixture" onEnd={() => {}} />
            ) : (
              <ChatContainerHeader
                threadId="fixture"
                sidebarOpen={false}
                onToggleSidebar={() => {}}
                viewMode="single"
                onToggleViewMode={() => {}}
                statusPanelOpen={false}
                onToggleStatusPanel={() => {}}
              />
            ),
          );
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
        expect(apiFetch).toHaveBeenCalledTimes(1);
        expect(apiFetch).toHaveBeenCalledWith(`/api/threads/fixture/${kind}`, { signal: expect.any(AbortSignal) });
        await act(async () => {
          root.unmount();
        });
        expect(apiFetch.mock.calls[0][1].signal.aborted).toBe(true);
        await act(async () => {
          finish({ vote: null });
          await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(apiFetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    });
  }
});
