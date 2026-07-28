import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AllProjectsSyncBanner } from '../settings/AllProjectsSyncBanner';
import { isDirectLocalHubHostname } from '../settings/useDriftSync';

describe('isDirectLocalHubHostname', () => {
  it.each(['localhost', '127.0.0.1', '127.2.3.4', '::1', '[::1]'])('accepts direct loopback host %s', (hostname) => {
    expect(isDirectLocalHubHostname(hostname)).toBe(true);
  });

  it.each(['skycat.cpolar.top', '192.168.1.10', 'localhost.example.com'])('rejects remote host %s', (hostname) => {
    expect(isDirectLocalHubHostname(hostname)).toBe(false);
  });
});

describe('AllProjectsSyncBanner', () => {
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders remote capability drift as read-only without write controls', async () => {
    const scope = {
      key: '/workspace/traqen',
      label: 'Traqen',
      path: '/workspace/traqen',
      issues: [{ id: 'browser-preview', issueType: 'conflict', message: '存在冲突' }],
    };

    await act(async () => {
      root.render(
        <AllProjectsSyncBanner
          type="skill"
          scopes={[scope]}
          scopesWithIssues={[scope]}
          syncing={false}
          error={null}
          canSync={false}
          onSyncAll={() => undefined}
          onSyncScope={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain('远程访问仅支持查看');

    await act(async () => {
      const detail = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('查看详情'),
      );
      detail?.click();
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Traqen');
    expect(dialog?.textContent).not.toContain('同步全部');
    expect(Array.from(dialog?.querySelectorAll('button') ?? []).some((button) => button.textContent === '同步')).toBe(
      false,
    );
  });
});
