/**
 * Unified API client for Clowder AI frontend.
 *
 * - Auto-prepends NEXT_PUBLIC_API_URL
 * - Identity via HttpOnly session cookie (F156 D-1), not header self-reporting
 * - First call lazily establishes session, subsequent calls reuse the cookie
 */

import { useToastStore } from '../stores/toastStore';

function getBrowserLocation(): Location | null {
  if (typeof globalThis !== 'object' || globalThis === null) return null;
  const candidate = (globalThis as { location?: Location }).location;
  return candidate ?? null;
}

/** @internal Exported for testing — prefer using `API_URL` constant. */
export function resolveApiUrl(): string {
  const location = getBrowserLocation();

  // Cloudflare Tunnel: API 走 api.clowder-ai.com，Access cookie 在 .clowder-ai.com 上共享
  if (location?.hostname === 'cafe.clowder-ai.com') {
    return 'https://api.clowder-ai.com';
  }
  const envUrl = process.env.NEXT_PUBLIC_API_URL;
  if (envUrl) {
    const isLocalhostDefault = /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(envUrl);
    const isLocalAccess = location != null && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
    const isRemoteAccess = location != null && !isLocalAccess;
    // Skip envUrl when it mismatches actual access origin:
    //   - localhost env + remote browser → reverse-proxy users would hit dev's loopback
    //   - cloud env + local browser → would force a Cloudflare Tunnel round-trip for nothing
    const mismatch = (isLocalhostDefault && isRemoteAccess) || (!isLocalhostDefault && isLocalAccess);
    if (!mismatch) return envUrl;
  }
  if (typeof window === 'undefined') return 'http://localhost:3004';
  const protocol = location?.protocol ?? 'http:';
  const hostname = location?.hostname ?? 'localhost';
  const port = Number(location?.port ?? '') || 0;
  // Behind reverse proxy (default port 80/443 → port is empty string):
  // API lives at the same origin, proxied via /api/ and /socket.io/ paths.
  if (!port) return `${protocol}//${hostname}`;
  // Direct access with explicit port: convention frontendPort + 1 = apiPort
  // (runtime: 3001→3002, alpha: 3011→3012).
  return `${protocol}//${hostname}:${port + 1}`;
}
export const API_URL = resolveApiUrl();

let sessionGate: Promise<void> | null = null;
let lastSessionFailureToastAt = 0;
export const SESSION_BOOTSTRAP_TIMEOUT_MS = 5_000;
export const SESSION_BOOTSTRAP_ATTEMPTS = 3;
export const READ_REQUEST_TIMEOUT_MS = 8_000;

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  if (!timeoutMs) return fetch(url, init);

  const controller = new AbortController();
  const parentSignal = init.signal;
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  });
}

function notifySessionFailure() {
  const now = Date.now();
  if (now - lastSessionFailureToastAt < 3000) return;
  lastSessionFailureToastAt = now;
  useToastStore.getState().addToast({
    type: 'error',
    title: '会话恢复失败',
    message: '登录态没有自动恢复成功。请稍后重试；如果仍无响应，再刷新页面。',
    duration: 6000,
  });
}

async function establishSession(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < SESSION_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetchWithTimeout(
        `${API_URL}/api/session`,
        { credentials: 'include' },
        SESSION_BOOTSTRAP_TIMEOUT_MS,
      );
      if (!res.ok) {
        throw new Error(`session bootstrap failed (${res.status})`);
      }
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export function ensureApiSession(): Promise<void> {
  if (sessionGate) return sessionGate;
  sessionGate = establishSession().catch((err) => {
    sessionGate = null;
    notifySessionFailure();
    throw err;
  });
  return sessionGate;
}

/**
 * Ensure mutating requests (POST/PUT/PATCH/DELETE) carry a Content-Type
 * header and body. Bare POSTs with no body receive 415 Unsupported Media
 * Type through reverse proxies (Cloudflare Tunnel → Fastify).
 *
 * Callers that already set a body (including FormData) are left untouched.
 */
function ensureBodyForMutation(init?: RequestInit): RequestInit | undefined {
  if (!init?.method) return init;
  const method = init.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return init;
  if (init.body != null) return init;
  return {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    body: '{}',
  };
}

/**
 * Fetch wrapper with session-cookie identity.
 *
 * On 401, re-establishes the session cookie and retries once.
 * This handles API restarts (in-memory session store cleared)
 * without requiring a manual page refresh.
 *
 * @param path - API path starting with '/' (e.g. '/api/messages')
 * @param init - Standard RequestInit options
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  await ensureApiSession();
  const normalized = ensureBodyForMutation(init);
  const method = normalized?.method?.toUpperCase() ?? 'GET';
  const isReadRequest = method === 'GET' || method === 'HEAD';
  const request = () =>
    fetchWithTimeout(
      `${API_URL}${path}`,
      {
        ...normalized,
        credentials: 'include',
      },
      isReadRequest ? READ_REQUEST_TIMEOUT_MS : undefined,
    );

  let res: Response;
  try {
    res = await request();
  } catch (err) {
    // A cpolar data connection can remain half-open indefinitely. Retrying a
    // read is safe and opens a fresh proxy connection; never replay mutations.
    if (!isReadRequest || normalized?.signal?.aborted) throw err;
    res = await request();
  }
  if (res.status === 401) {
    // Session expired (API restart, cookie cleared). Re-establish and retry once.
    sessionGate = null;
    await ensureApiSession();
    const retryRes = await request();
    if (retryRes.status === 401) {
      notifySessionFailure();
    }
    return retryRes;
  }
  return res;
}
