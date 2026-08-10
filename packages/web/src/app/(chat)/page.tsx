// The HTML shell points at build-specific chunks and must never be cached
// across deployments by a tunnel, CDN, or browser intermediary.
export const dynamic = 'force-dynamic';

/** Root page — ChatContainer is rendered by the (chat) layout. */
export default function Home() {
  return <span hidden aria-hidden="true" data-thread-route="default" />;
}
