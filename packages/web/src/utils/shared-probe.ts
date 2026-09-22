/** One polling owner per document, regardless of how many chat surfaces subscribe. */
export function createSharedProbe<T>(probe: (signal: AbortSignal) => Promise<T>, intervalMs: number) {
  const listeners = new Set<(result: T) => void>();
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastStarted = -Infinity;
  let snapshot: { result: T } | undefined;

  const refresh = async () => {
    if (!listeners.size || controller || document.visibilityState === 'hidden') return;
    // Initial subscription and several socket-connect effects can arrive together.
    if (Date.now() - lastStarted < 1_000) return;
    clearTimeout(timer);
    lastStarted = Date.now();
    const current = new AbortController();
    controller = current;
    try {
      const result = await probe(current.signal);
      if (current.signal.aborted) return;
      snapshot = { result };
      for (const listener of listeners) listener(result);
    } catch {
      // Probe implementations represent failures as results; cancellation is quiet.
    } finally {
      if (controller === current) {
        controller = undefined;
        if (listeners.size) timer = setTimeout(() => void refresh(), intervalMs);
      }
    }
  };
  const onVisibility = () => {
    if (document.visibilityState !== 'hidden') void refresh();
  };

  return {
    refresh: () => void refresh(),
    subscribe(listener: (result: T) => void) {
      listeners.add(listener);
      if (snapshot) listener(snapshot.result);
      if (listeners.size === 1) {
        document.addEventListener('visibilitychange', onVisibility);
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        clearTimeout(timer);
        controller?.abort();
        controller = undefined;
        snapshot = undefined;
        lastStarted = -Infinity;
        document.removeEventListener('visibilitychange', onVisibility);
      };
    },
  };
}
