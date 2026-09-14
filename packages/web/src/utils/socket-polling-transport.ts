import { Fetch, WebSocket } from 'socket.io-client';

// A quiet poll normally waits for the server's 25-second heartbeat. API read
// deadlines (8s) would disconnect healthy sockets, so use a separate bound.
export const SOCKET_POLL_TIMEOUT_MS = 45_000;
const CLOSE_REQUEST_TIMEOUT_MS = 2_000;

/**
 * Engine.IO 6.6's XHR transport leaves in-flight GET/POST requests alive when
 * closing. Each reconnect can therefore strand another HTTP/1.1 connection.
 * Keep its public polling codec/upgrade protocol, but own the HTTP lifetimes.
 */
export class BoundedPolling extends Fetch {
  private pending = new Set<AbortController>();
  private stopped = false;

  private cancelPending() {
    this.stopped = true;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }

  private async requestText(data?: string, closing = false): Promise<string> {
    const controller = new AbortController();
    if (!closing) this.pending.add(controller);
    const timer = setTimeout(
      () => controller.abort(new DOMException('Socket polling request timed out', 'TimeoutError')),
      closing ? CLOSE_REQUEST_TIMEOUT_MS : this.opts.requestTimeout || SOCKET_POLL_TIMEOUT_MS,
    );
    try {
      const headers = new Headers(this.opts.extraHeaders as HeadersInit | undefined);
      if (data !== undefined) headers.set('content-type', 'text/plain;charset=UTF-8');
      const response = await fetch(this.uri(), {
        method: data === undefined ? 'GET' : 'POST',
        headers,
        body: data,
        // Match browser XHR: same-origin cookies are sent even when
        // withCredentials is false; cross-origin cookies require opting in.
        credentials: this.opts.withCredentials ? 'include' : 'same-origin',
        signal: controller.signal,
      });
      // Retain ownership through the complete body, including proxy errors.
      const text = await response.text();
      if (!response.ok) throw new Error(`Socket polling HTTP ${response.status}`);
      return text;
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
    }
  }

  protected override onError(reason: string, description: unknown, context?: unknown): this {
    this.cancelPending();
    return super.onError(reason, description, context);
  }

  override doPoll(): void {
    if (this.stopped) return;
    void this.requestText().then(
      (data) => {
        if (!this.stopped) this.onData(data);
      },
      (error: unknown) => {
        if (!this.stopped) this.onError('fetch read error', error);
      },
    );
  }

  override doWrite(data: string, callback: () => void): void {
    if (this.stopped) return;
    void this.requestText(data).then(
      () => {
        if (!this.stopped) callback();
      },
      (error: unknown) => {
        if (!this.stopped) this.onError('fetch write error', error);
      },
    );
  }

  override doClose(): void {
    this.cancelPending();
    // Best-effort Engine.IO close packet has its own short deadline. Never
    // wait for an unfinished handshake or carry old polls into a reconnect.
    if (this.readyState === 'open' && this.query.sid) {
      void this.requestText('1', true).catch(() => {});
    }
  }

  override close(): this {
    this.cancelPending();
    // The base close skips pausing/paused transports, which can still own
    // requests while a WebSocket upgrade is in progress.
    if (this.readyState === 'pausing' || this.readyState === 'paused') {
      this.onClose();
      return this;
    }
    return super.close();
  }

  protected override onClose(details?: { description: string; context?: unknown }): void {
    this.cancelPending();
    super.onClose(details);
  }
}

export const CHAT_SOCKET_TRANSPORTS = [WebSocket, BoundedPolling];
