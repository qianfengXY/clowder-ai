/** Poll finite resources without overlapping work or accumulating timers.
 * Return false (or throw) on failure to back off; true restores the cadence.
 */
export function startSerialPolling(poll: (signal: AbortSignal) => Promise<boolean>, intervalMs: number) {
  const controller = new AbortController();
  let running = false;
  let delay = intervalMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const available = () => document.visibilityState !== 'hidden' && navigator.onLine !== false;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const refresh = async () => {
    if (controller.signal.aborted || running || !available()) return;
    clearTimer();
    running = true;
    let succeeded = false;
    try {
      succeeded = await poll(controller.signal);
    } catch {
      // The caller owns user-facing errors and the last good snapshot.
    } finally {
      running = false;
      delay = succeeded ? intervalMs : Math.min(delay * 2, Math.max(intervalMs, 60_000));
      if (!controller.signal.aborted && available()) timer = setTimeout(() => void refresh(), delay);
    }
  };
  const onAvailability = () => {
    clearTimer();
    if (available()) void refresh();
  };
  document.addEventListener('visibilitychange', onAvailability);
  window.addEventListener('online', onAvailability);
  window.addEventListener('offline', onAvailability);
  void refresh();
  return {
    refresh: () => void refresh(),
    stop: () => {
      controller.abort();
      clearTimer();
      document.removeEventListener('visibilitychange', onAvailability);
      window.removeEventListener('online', onAvailability);
      window.removeEventListener('offline', onAvailability);
    },
  };
}
