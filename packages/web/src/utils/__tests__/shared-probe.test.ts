import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSharedProbe } from '../shared-probe';

describe('document-wide connection probes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });
  afterEach(() => vi.useRealTimers());

  it('shares initial, periodic and reconnect probes across chat surfaces', async () => {
    const probe = vi.fn(async () => 'online');
    const shared = createSharedProbe(probe, 15_000);
    const a = vi.fn();
    const b = vi.fn();
    const stopA = shared.subscribe(a);
    const stopB = shared.subscribe(b);
    shared.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith('online');
    expect(b).toHaveBeenCalledWith('online');
    shared.refresh();
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledTimes(2);
    stopA();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledTimes(3);
    stopB();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('does not overlap slow requests; the last subscriber cancels the whole batch', async () => {
    let signal: AbortSignal | undefined;
    let finish!: (value: string) => void;
    const probe = vi.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const shared = createSharedProbe(probe, 15_000);
    const listener = vi.fn();
    const stopA = shared.subscribe(listener);
    const stopB = shared.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(60_000);
    shared.refresh();
    expect(probe).toHaveBeenCalledTimes(1);
    stopA();
    expect(signal?.aborted).toBe(false);
    stopB();
    expect(signal?.aborted).toBe(true);
    finish('late');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listener).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('pauses hidden pages and resumes once, with a fresh owner after unmount', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const probe = vi.fn(async () => 'online');
    const shared = createSharedProbe(probe, 15_000);
    const stop = shared.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(probe).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    stop();
    const stopNew = shared.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(2);
    stopNew();
  });

  it('ignores an old aborted batch after a new surface mounts', async () => {
    const pending: Array<(value: string) => void> = [];
    const shared = createSharedProbe(() => new Promise<string>((resolve) => pending.push(resolve)), 15_000);
    const stopOld = shared.subscribe(vi.fn());
    stopOld();
    const listener = vi.fn();
    const stopNew = shared.subscribe(listener);
    pending[0]('obsolete');
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).not.toHaveBeenCalled();
    pending[1]('fresh');
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledExactlyOnceWith('fresh');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pending).toHaveLength(3);
    stopNew();
  });
});
