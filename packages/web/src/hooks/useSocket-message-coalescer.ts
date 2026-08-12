/**
 * createAgentMessageCoalescer — clowder-ai#789 + chunked flush fix
 *
 * Coalesces synchronous bursts of agent_message socket events to prevent
 * "Maximum update depth exceeded" under high-frequency streaming.
 *
 * Root cause (original #789): each socket event dispatched synchronously →
 * multiple chatStore.setState per event → useSyncExternalStore bypasses
 * React 18 automatic batching → >50 nested update depth → React throws.
 *
 * Original fix: buffer events from the same macrotask, flush in one microtask.
 *
 * Recurrence root cause: the single-microtask flush processes ALL buffered
 * events synchronously. Each event triggers ~4-8 Zustand set() calls, each
 * of which synchronously fires useSyncExternalStore listeners. When a burst
 * exceeds ~8 events (multi-cat streaming, reconnect gap detection, epoch
 * change), the total set() count within one flush exceeds React's 50 nested
 * update limit → crash recurs.
 *
 * Fix (chunked flush): process at most CHUNK_SIZE events per turn. The first
 * chunk runs in a microtask for normal streaming latency; a backlog continues
 * in timer tasks so the browser gets input/render opportunities between
 * chunks. Each chunk stays below React's nested-update limit without letting
 * a tunnel-delivered burst monopolize the main thread.
 *
 * Design contract:
 *  - Every event is processed; nothing is dropped or merged.
 *  - Push order within a macrotask is preserved (FIFO flush).
 *  - processThreadSeq runs per-event inside the flush loop, unchanged.
 *    Zustand set() is synchronous — each event's store write is visible to
 *    the next event's getState() call inside the same flush chunk.
 *  - Events arriving after a fully drained queue each get their own prompt
 *    microtask flush. At normal streaming pace this adds no timer delay.
 */

type AgentMessageHandler = (msg: unknown) => void;

export interface AgentMessageCoalescer {
  push: (msg: unknown) => void;
  /** Finish queued messages now and cancel any timer-backed continuation. */
  drainPending: () => void;
}

/**
 * Max events processed per flush turn. Each event triggers ~4-8
 * Zustand set() calls; 6 events × 8 set() = 48, safely under React's
 * 50-nested-update limit. Conservative ceiling avoids flirting with the edge.
 */
const CHUNK_SIZE = 6;

export function createAgentMessageCoalescer(handler: AgentMessageHandler): AgentMessageCoalescer {
  const queue: unknown[] = [];
  let flushScheduled = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    // Take at most CHUNK_SIZE events from the front of the queue.
    // Remaining events stay in the queue for the next scheduled turn.
    const chunk = queue.splice(0, CHUNK_SIZE);

    if (queue.length > 0) {
      // More events waiting — continue in a new task. Unlike chained
      // microtasks, this gives the browser a chance to process input and paint
      // before draining the rest of a tunnel-delivered polling burst.
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        flush();
      }, 0);
    } else {
      // Queue fully drained — allow new pushes to schedule a fresh flush.
      flushScheduled = false;
    }

    for (const msg of chunk) {
      handler(msg);
    }
  }

  return {
    push(msg: unknown): void {
      queue.push(msg);
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
    },
    drainPending(): void {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }

      // Cleanup is rare and must establish a hard lifecycle boundary. Finish
      // the queue synchronously instead of leaving stale timer work behind or
      // dropping sequence-bearing messages before durable catch-up can run.
      while (queue.length > 0) {
        const chunk = queue.splice(0, CHUNK_SIZE);
        for (const msg of chunk) {
          handler(msg);
        }
      }
      flushScheduled = false;
    },
  };
}
