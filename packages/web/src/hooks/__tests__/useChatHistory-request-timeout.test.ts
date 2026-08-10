import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHistoryRequestSignal, HISTORY_REQUEST_TIMEOUT_MS } from '../useChatHistory';

describe('useChatHistory request timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a history request that remains stuck behind a tunnel', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const request = createHistoryRequestSignal(parent.signal);

    vi.advanceTimersByTime(HISTORY_REQUEST_TIMEOUT_MS - 1);
    expect(request.signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(request.signal.aborted).toBe(true);
    request.cleanup();
  });

  it('still aborts immediately when the thread changes', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const request = createHistoryRequestSignal(parent.signal);

    parent.abort();

    expect(request.signal.aborted).toBe(true);
    request.cleanup();
  });

  it('clears the timeout after a completed request', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const request = createHistoryRequestSignal(parent.signal);

    request.cleanup();
    vi.advanceTimersByTime(HISTORY_REQUEST_TIMEOUT_MS);

    expect(request.signal.aborted).toBe(false);
  });
});
