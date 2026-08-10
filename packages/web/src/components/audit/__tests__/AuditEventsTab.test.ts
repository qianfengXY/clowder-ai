import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

/* ── mock apiFetch ────────────────────────────────── */
const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

const sampleEvents = [
  { id: 'e1', type: 'debate_winner', timestamp: Date.now() - 60_000, threadId: 't1', data: { winner: 'opus' } },
  { id: 'e2', type: 'phase_completed', timestamp: Date.now() - 120_000, threadId: 't1', data: { phase: 'red' } },
  { id: 'e3', type: 'invocation_error', timestamp: Date.now() - 180_000, threadId: 't1', data: { error: 'timeout' } },
];

describe('AuditEventsTab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.apiFetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderTab(threadId = 't1') {
    const { AuditEventsTab } = await import('../AuditEventsTab');
    await act(async () => {
      root.render(React.createElement(AuditEventsTab, { threadId }));
    });
    // flush async fetch
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }

  it('renders audit events from API', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ events: sampleEvents, logPath: null, logFiles: [] }),
    });

    await renderTab();

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/audit/thread/t1?limit=100');
    expect(container.textContent).toContain('debate_winner');
    expect(container.textContent).toContain('phase_completed');
    expect(container.textContent).toContain('invocation_error');
  });

  it('shows empty state when no events', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ events: [], logPath: null, logFiles: [] }),
    });

    await renderTab();

    expect(container.textContent).toContain('最近 7 天无审计事件');
  });

  it('shows error state on fetch failure', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await renderTab();

    expect(container.textContent).toContain('加载失败');
  });

  it('expands event data on click', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ events: [sampleEvents[0]], logPath: null, logFiles: [] }),
    });

    await renderTab();

    const row = container.querySelector('[data-testid="audit-event-row"]');
    expect(row).toBeTruthy();
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Expanded data should show full JSON
    expect(container.textContent).toContain('"winner"');
    expect(container.textContent).toContain('"opus"');
  });
});
