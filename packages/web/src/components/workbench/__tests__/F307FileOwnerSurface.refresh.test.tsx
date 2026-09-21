import { act, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFileViewerProps } from '@/components/workspace/WorkspaceFileViewer.types';
import { apiFetch } from '@/utils/api-client';
import { F307FileOwnerSurface } from '../F307FileOwnerSurface';
import { createFileSurface } from '../real-surface-adapters';

const sockets = vi.hoisted(() => ({
  listeners: new Map<string, (payload?: unknown) => void>(),
  emit: vi.fn(),
  disconnect: vi.fn(),
  connect: vi.fn(),
}));
vi.mock('socket.io-client', () => ({
  WebSocket: class {},
  Fetch: class {},
  io: vi.fn(() => ({
    ...sockets,
    connected: true,
    on: (event: string, listener: (payload?: unknown) => void) => sockets.listeners.set(event, listener),
  })),
}));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://localhost:3192', apiFetch: vi.fn() }));
// Keep the real file owner and editing hook. A small editor leaf exposes draft
// survival in jsdom; the browser test additionally exercises real CodeMirror.
vi.mock('@/components/workspace/WorkspaceFileViewer', () => ({
  WorkspaceFileViewer: (props: WorkspaceFileViewerProps) => {
    const [draft, setDraft] = useState(props.file.content);
    const dirtyCallback = useRef(props.onDirtyChange);
    dirtyCallback.current = props.onDirtyChange;
    useEffect(() => {
      setDraft(props.file.content);
      dirtyCallback.current?.(false);
    }, [props.file.content]);
    return (
      <div>
        <pre>{props.file.content}</pre>
        <input
          aria-label="draft"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            props.onDirtyChange?.(true);
          }}
        />
        <button
          type="button"
          onClick={() => {
            setDraft('my unsaved draft');
            props.onDirtyChange?.(true);
          }}
        >
          edit draft
        </button>
        <button type="button" onClick={() => props.setOpenFile(props.file.path)}>
          reopen
        </button>
        {props.pendingExternalSha && (
          <div>
            文件已被外部修改
            <button type="button" onClick={props.onApplyExternalChange}>
              reload
            </button>
            <button type="button" onClick={props.onDismissExternalChange}>
              ignore
            </button>
          </div>
        )}
      </div>
    );
  },
}));

const surface = () => createFileSurface({ worktreeId: 'owner-wt', path: 'README.md' });
const data = (content: string, path = 'README.md') => ({
  path,
  content,
  sha256: content,
  size: content.length,
  mime: 'text/markdown',
  truncated: false,
});
const response = (content: string, path?: string) => ({ ok: true, json: async () => data(content, path) }) as Response;
async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

describe('visible Workspace file owner freshness', () => {
  let container: HTMLDivElement;
  let root: Root;
  let disk: string;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    sockets.listeners.clear();
    vi.clearAllMocks();
    vi.mocked(apiFetch).mockReset();
    disk = 'version-1';
    vi.mocked(apiFetch).mockImplementation(async () => response(disk));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  async function render(next = surface()) {
    await act(async () => root.render(<F307FileOwnerSurface surface={next} onRequestDetach={() => {}} />));
    await flush();
  }
  async function event(name: string, payload?: unknown) {
    await act(async () => sockets.listeners.get(name)?.(payload));
    await flush();
  }
  async function change(content: string) {
    disk = content;
    await event('workspace:file-changed', { worktreeId: 'owner-wt', path: 'README.md', sha256: content });
  }
  async function click(label: string) {
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === label)?.click(),
    );
    await flush();
  }
  const body = () => container.querySelector('pre')?.textContent;
  const draft = () => container.querySelector('input')?.value;

  it('updates the displayed body on an external change without switching files', async () => {
    await render();
    expect(body()).toBe('version-1');
    await change('version-2');
    expect(body()).toBe('version-2');
    await change('version-3');
    expect(body()).toBe('version-3');
  });
  it('revalidates when the same path is explicitly opened again', async () => {
    await render();
    disk = 'reopened-version';
    await render();
    expect(body()).toBe(disk);
    disk = 'tab-version';
    await click('reopen');
    expect(body()).toBe(disk);
  });
  it('subscribes with the displayed sha on reconnect and repairs a missed event', async () => {
    await render();
    disk = 'while-disconnected';
    await event('connect');
    expect(sockets.emit).toHaveBeenCalledWith(
      'workspace:watch-file',
      expect.objectContaining({ worktreeId: 'owner-wt', path: 'README.md', sha256: 'version-1' }),
    );
    expect(body()).toBe(disk);
  });
  it('repairs missed notifications when the browser returns online', async () => {
    await render();
    disk = 'online-version';
    await act(async () => window.dispatchEvent(new Event('online')));
    await flush();
    expect(body()).toBe(disk);
  });
  it('preserves draft and base sha across notification, reconnect and explicit reopen', async () => {
    await render();
    await click('edit draft');
    await change('external-version');
    await event('connect');
    await render();
    expect(body()).toBe('version-1');
    expect(draft()).toBe('my unsaved draft');
    expect(container.textContent).toContain('文件已被外部修改');
    await click('ignore');
    expect(draft()).toBe('my unsaved draft');
    await change('newer-external');
    await click('reload');
    expect(body()).toBe('newer-external');
    expect(draft()).toBe('newer-external');
  });
  it('ignores unrelated owner notifications', async () => {
    await render();
    disk = 'wrong';
    await event('workspace:file-changed', { worktreeId: 'other', path: 'README.md', sha256: disk });
    expect(body()).toBe('version-1');
  });
  it('keeps the editor mounted when a recovery read fails', async () => {
    await render();
    await click('edit draft');
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline'));
    await event('connect');
    expect(body()).toBe('version-1');
    expect(draft()).toBe('my unsaved draft');
  });
  it('explicit reload discards a draft even if disk has returned to the original content', async () => {
    await render();
    await click('edit draft');
    await change('temporary-external-version');
    disk = 'version-1';
    await click('reload');
    expect(draft()).toBe('version-1');
  });
  it('isolates an old response after switching the descriptor owner', async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(apiFetch).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    disk = 'other-owner-version';
    await render(createFileSurface({ worktreeId: 'other-owner', path: 'README.md' }));
    await act(async () => resolve(response('old-owner-version')));
    await flush();
    expect(body()).toBe('other-owner-version');
  });
  it('does not overwrite edits started during a background read', async () => {
    await render();
    let resolve!: (value: Response) => void;
    vi.mocked(apiFetch).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await change('external-version');
    await click('edit draft');
    await act(async () => resolve(response('external-version')));
    await flush();
    expect(draft()).toBe('my unsaved draft');
    expect(body()).toBe('version-1');
    expect(container.textContent).toContain('文件已被外部修改');
  });
  it('does not let an older initial response replace refreshed content', async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(apiFetch).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    await change('newest-version');
    await act(async () => resolve(response('stale-version')));
    await flush();
    expect(body()).toBe('newest-version');
  });
  it('requests a trailing GET after invalidation instead of joining a stale in-flight GET', async () => {
    await render();
    await change('newest-version');
    expect(apiFetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/api/workspace/file?'),
      expect.anything(),
      expect.objectContaining({ afterCurrentGet: true }),
    );
  });
});
