/**
 * clowder-ai#789 — React "Maximum update depth exceeded" under 200+ agent_message burst
 *
 * Root cause: useSocket dispatches each socket event synchronously → processThreadSeq
 * calls multiple chatStore.setState → useSyncExternalStore bypasses React 18 automatic
 * batching → >50 nested updates → crash.
 *
 * Fix: createAgentMessageCoalescer buffers synchronous pushes and flushes them
 * in chunked turns (CHUNK_SIZE events per turn). The first chunk is prompt;
 * backlog chunks use timer tasks so React stays under the 50-update limit and
 * the browser can process input/rendering between chunks.
 *
 * These tests verify the coalescer's correctness contract:
 *  1. 200 synchronous pushes → handler called 200× after queued-work drain (not zero, not partial)
 *  2. Push order is preserved through the flush
 *  3. Events arriving across macrotask boundaries flush independently (no cross-batch merging)
 *  4. Only one flush chain is scheduled per burst (flushScheduled guard)
 *  5. Chunking: each turn processes at most CHUNK_SIZE events
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentMessageCoalescer } from '../useSocket-message-coalescer';

/**
 * Drain the prompt microtask plus all timer-backed backlog chunks.
 */
async function drainQueuedWork(): Promise<void> {
  await Promise.resolve();
  await vi.runAllTimersAsync();
}

describe('createAgentMessageCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('200 synchronous pushes → handler called exactly 200× after queued-work drain', async () => {
    const handler = vi.fn();
    const coalescer = createAgentMessageCoalescer(handler);

    // Simulate burst: 200 socket events arriving in the same macrotask
    for (let i = 0; i < 200; i++) {
      coalescer.push({ type: 'text', seq: i + 1, threadId: 'thread-burst' });
    }

    // Handler must NOT have been called yet — still inside the macrotask
    expect(handler).not.toHaveBeenCalled();

    // Drain the prompt chunk and timer-backed backlog (200 / 6 = 34 turns).
    await drainQueuedWork();

    // All 200 events must be processed: no drops, no duplicates
    expect(handler).toHaveBeenCalledTimes(200);
  });

  it('preserves push order through the chunked flush (seq routing depends on this)', async () => {
    const received: number[] = [];
    const coalescer = createAgentMessageCoalescer((msg: unknown) => {
      received.push((msg as { seq: number }).seq);
    });

    for (let i = 1; i <= 50; i++) {
      coalescer.push({ seq: i });
    }

    await drainQueuedWork();

    expect(received).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('events arriving across macrotask boundaries flush independently (normal streaming pace)', async () => {
    const handler = vi.fn();
    const coalescer = createAgentMessageCoalescer(handler);

    // Burst 1 — synchronous (2 events fit in one chunk)
    coalescer.push({ seq: 1 });
    coalescer.push({ seq: 2 });
    await drainQueuedWork();

    expect(handler).toHaveBeenCalledTimes(2);

    // Burst 2 — arrives after macrotask boundary
    coalescer.push({ seq: 3 });
    await drainQueuedWork();

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('only one flush chain is scheduled per burst (flushScheduled guard)', async () => {
    // Verify the guard resets correctly after a full drain, allowing
    // subsequent bursts to coalesce independently.
    const handler = vi.fn();
    const coalescer = createAgentMessageCoalescer(handler);

    // First burst
    for (let i = 0; i < 10; i++) coalescer.push({ seq: i });
    await drainQueuedWork();
    expect(handler).toHaveBeenCalledTimes(10);

    handler.mockClear();

    // Second burst — guard must have been reset after first drain
    for (let i = 0; i < 10; i++) coalescer.push({ seq: i + 10 });
    // Before flush, nothing called
    expect(handler).not.toHaveBeenCalled();
    await drainQueuedWork();
    // After flush, all 10 called
    expect(handler).toHaveBeenCalledTimes(10);
  });

  it('chunks events to stay under React nested update limit', async () => {
    // With CHUNK_SIZE=6, a burst of 20 events should be processed in
    // ceil(20/6) = 4 event-loop turns. After the prompt turn, only 6
    // should have been handled.
    const handler = vi.fn();
    const coalescer = createAgentMessageCoalescer(handler);

    for (let i = 0; i < 20; i++) {
      coalescer.push({ seq: i + 1 });
    }

    // First microtask: exactly one prompt chunk.
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(6);

    // Each following timer task handles one backlog chunk.
    await vi.advanceTimersToNextTimerAsync();
    expect(handler).toHaveBeenCalledTimes(12);

    await vi.advanceTimersToNextTimerAsync();
    expect(handler).toHaveBeenCalledTimes(18);

    await vi.advanceTimersToNextTimerAsync();
    expect(handler).toHaveBeenCalledTimes(20);
  });

  it('yields to the event loop between chunks so a long burst cannot monopolize the browser', async () => {
    const handler = vi.fn();
    const coalescer = createAgentMessageCoalescer(handler);

    for (let i = 0; i < 20; i++) {
      coalescer.push({ seq: i + 1 });
    }

    // The first chunk stays prompt, but additional Promise turns must not
    // drain the whole burst before the browser gets a task/render boundary.
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(6);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(6);

    await vi.advanceTimersToNextTimerAsync();
    expect(handler).toHaveBeenCalledTimes(12);
  });

  it('processes full 200-event burst without dropping events (coalescer correctness)', async () => {
    const handler = vi.fn();
    const coalescer = createAgentMessageCoalescer(handler);

    expect(() => {
      for (let i = 0; i < 200; i++) {
        coalescer.push({ type: 'text', seq: i + 1, threadId: 'thread-burst' });
      }
    }).not.toThrow();

    await drainQueuedWork();

    expect(handler).toHaveBeenCalledTimes(200);
  });

  it('new events pushed during flush are processed in subsequent chunks', async () => {
    const received: number[] = [];
    const coalescer = createAgentMessageCoalescer((msg: unknown) => {
      const seq = (msg as { seq: number }).seq;
      received.push(seq);
      // Simulate: processing event 3 pushes a new event
      if (seq === 3) {
        coalescer.push({ seq: 99 });
      }
    });

    for (let i = 1; i <= 5; i++) {
      coalescer.push({ seq: i });
    }

    await drainQueuedWork();

    // Original 5 events + 1 injected during processing
    expect(received).toHaveLength(6);
    // Event 99 should appear after event 5 (processed in a later chunk)
    expect(received).toContain(99);
    const idx99 = received.indexOf(99);
    expect(idx99).toBeGreaterThan(received.indexOf(3));
  });
});
