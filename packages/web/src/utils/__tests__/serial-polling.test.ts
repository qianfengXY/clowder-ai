import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSerialPolling } from '../serial-polling';

describe('serial foreground polling', () => {
  const pollers: ReturnType<typeof startSerialPolling>[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const poller of pollers.splice(0)) poller.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  function start(poll: (signal: AbortSignal) => Promise<boolean>) {
    const poller = startSerialPolling(poll, 5_000);
    pollers.push(poller);
    return poller;
  }

  it('waits for full completion before scheduling another poll and coalesces refresh events', async () => {
    let finish!: () => void;
    const poll = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = () => resolve(true);
        }),
    );
    const poller = start(poll);
    await vi.advanceTimersByTimeAsync(20_000);
    poller.refresh();
    window.dispatchEvent(new Event('online'));
    expect(poll).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    finish();
  });

  it('backs off failures, caps the delay, and restores normal cadence after recovery', async () => {
    const poll = vi
      .fn<(_: AbortSignal) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(false);
    start(poll);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(poll).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(poll).toHaveBeenCalledTimes(4);
    poll.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(6);
  });

  it('pauses hidden/offline pages, resumes on availability, and aborts on disposal', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const poll = vi.fn(async (signal: AbortSignal) => !signal.aborted);
    const poller = start(poll);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    online.mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
    poller.stop();
    expect(poll.mock.calls[0][0].aborted).toBe(true);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
