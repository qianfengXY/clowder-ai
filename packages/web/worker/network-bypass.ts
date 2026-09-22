/** Keep request ownership with the page: NetworkOnly still creates a second
 * fetch whose lifetime can outlive the page's AbortSignal. This listener runs
 * before Workbox registers its fetch handler (custom worker importScripts).
 * Leaving the event unanswered lets the browser perform the original request.
 */
self.addEventListener('fetch', (event: FetchEvent) => {
  const { pathname } = new URL(event.request.url);
  if (pathname.startsWith('/api/') || pathname === '/socket.io' || pathname.startsWith('/socket.io/')) {
    event.stopImmediatePropagation();
  }
});
export {};
declare const self: ServiceWorkerGlobalScope;
