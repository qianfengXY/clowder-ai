function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function timeoutError(): Error {
  const error = new Error('网络请求超时，请重试。');
  error.name = 'TimeoutError';
  return error;
}

/**
 * Bound fetch AND JSON/error body delivery, including transports that ignore
 * AbortSignal. Buffering JSON before returning also keeps exact-GET coordination
 * alive until the complete representation is available. Successful streaming
 * and download responses retain their existing headers-only boundary.
 */
export async function boundedFetch(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const callerSignal = init.signal;
  if (callerSignal?.aborted) throw abortReason(callerSignal);

  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let buffered: Response | undefined;
  const cancelBodies = (reason: unknown) => {
    // A tee's cancel promise waits for both branches. Never await one branch
    // before cancelling the other, or a broken transport could block cleanup.
    void reader?.cancel(reason).catch(() => undefined);
    void buffered?.body?.cancel(reason).catch(() => undefined);
  };
  let rejectBoundary!: (reason: unknown) => void;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const abortFromCaller = () => {
    const reason = callerSignal
      ? abortReason(callerSignal)
      : new DOMException('The operation was aborted.', 'AbortError');
    controller.abort(reason);
    cancelBodies(reason);
    rejectBoundary(reason);
  };
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    const error = timeoutError();
    controller.abort(error);
    cancelBodies(error);
    rejectBoundary(error);
  }, timeoutMs);

  try {
    return await Promise.race([
      fetch(input, {
        ...init,
        signal: controller.signal,
      }).then(async (response) => {
        if (controller.signal.aborted) {
          void response.body?.cancel(controller.signal.reason).catch(() => undefined);
          throw abortReason(controller.signal);
        }
        if (!response.body) return response;
        const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (response.ok && (!mediaType || !/^application\/(?:json|[\w.+-]+\+json)$/.test(mediaType))) {
          return response;
        }
        // Gateways may send an HTML/plain-text error and then leave its body
        // open. Callers often inspect only the status: returning at headers
        // would abandon the timeout while that body occupies an HTTP/1.1 slot.
        // Keep the native Response metadata (URL, redirect, status, headers)
        // and a fresh unread body; do not reconstruct a synthetic response.
        buffered = response.clone();
        reader = response.body.getReader();
        try {
          while (!(await reader.read()).done) {
            // The clone queues the finite representation for the caller.
          }
          return buffered;
        } catch (error) {
          cancelBodies(error);
          throw error;
        } finally {
          reader.releaseLock();
          reader = undefined;
        }
      }),
      boundary,
    ]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

/** Wait on shared work without allowing one caller's abort to cancel it for peers. */
export function waitForPromiseWithSignal<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
