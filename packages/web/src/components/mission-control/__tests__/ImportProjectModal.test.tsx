import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, mockResponse, setNativeValue } from '../../__tests__/mission-control-page.test-helpers';
import { ImportProjectModal } from '../ImportProjectModal';

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

describe('ImportProjectModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue(mockResponse(201, { project: { id: 'project-traqen' } }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('registers only canonical project fields and exposes no EXT/Desktop setup', async () => {
    const onClose = vi.fn();
    const onImported = vi.fn();
    await act(async () => root.render(<ImportProjectModal onClose={onClose} onImported={onImported} />));

    expect(container.textContent).not.toContain('ChatGPT Desktop');
    expect(container.textContent).not.toContain('Review 猫猫');
    expect(container.textContent).not.toContain('允许 Desktop push');
    expect(container.querySelector('input[placeholder="owner/repository"]')).toBeNull();

    const name = container.querySelector('input[placeholder="e.g. studio-flow"]') as HTMLInputElement;
    const sourcePath = container.querySelector(
      'input[placeholder="/home/user/projects/studio-flow"]',
    ) as HTMLInputElement;
    await act(async () => {
      setNativeValue(name, 'Traqen');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      setNativeValue(sourcePath, '/Volumes/WorkSSD/projects/Traqen');
      sourcePath.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '导入');
    expect(submit).toBeDefined();
    await act(async () => submit?.click());
    await flush(act);

    expect(mockApiFetch).toHaveBeenCalledWith('/api/external-projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Traqen',
        sourcePath: '/Volumes/WorkSSD/projects/Traqen',
        backlogPath: 'docs/ROADMAP.md',
        description: '',
      }),
    });
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
