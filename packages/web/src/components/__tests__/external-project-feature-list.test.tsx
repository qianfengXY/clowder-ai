import type { BacklogItem, CatId, ExternalProject } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
const routerPushMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPushMock }) }));

vi.mock('../../utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const { ExternalProjectFeatureList } = await import('../mission-control/ExternalProjectFeatureList');

function project(name = 'Example Project'): ExternalProject {
  return {
    id: `project-${name}`,
    userId: 'owner-1',
    name,
    description: '',
    sourcePath: `/work/${name}`,
    backlogPath: 'docs/ROADMAP.md',
    desktopDevelopment: {
      protocolVersion: 1,
      repository: { host: 'github.com', owner: 'owner', name: 'repo', fullName: 'owner/repo' },
      defaultBranch: 'main',
      developmentActor: 'chatgpt-desktop-dev',
      defaultReviewers: ['cat-reviewer-1' as CatId, 'cat-reviewer-2' as CatId],
      mergeMode: 'manual_confirm_in_chatgpt',
      successfulManualPilotCount: 0,
      successfulManualPilotWorkIds: [],
      allowPush: true,
      allowPullRequest: true,
      requireFinalAcceptance: true,
      version: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function item(featureId = 'F006'): BacklogItem {
  return {
    id: `item-${featureId}`,
    userId: 'owner-1',
    projectId: 'project-example',
    title: `[${featureId}] Workspace capability settings`,
    summary: 'Project-scoped feature',
    priority: 'p2',
    tags: ['source:docs-backlog', `feature:${featureId.toLowerCase()}`],
    status: 'open',
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 1,
    audit: [],
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ExternalProjectFeatureList', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    routerPushMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('starts a project-scoped feature and reports the automatically created Desktop task', async () => {
    let launched = false;
    apiFetchMock.mockImplementation(async (_path: string, init?: RequestInit) => {
      if (!init) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            states: [
              {
                backlogItemId: 'item-F006',
                featureId: 'F006',
                title: '[F006] Workspace capability settings',
                status: launched ? 'ready_for_desktop' : 'available',
              },
            ],
          }),
        };
      }
      launched = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: {
            backlogItemId: 'item-F006',
            featureId: 'F006',
            title: '[F006] Workspace capability settings',
            status: 'ready_for_desktop',
            desktopTask: { status: 'created', threadId: 'codex-thread-f006' },
          },
        }),
      };
    });

    await act(async () => {
      root.render(React.createElement(ExternalProjectFeatureList, { project: project('Traqen'), items: [item()] }));
    });
    await flush();

    const button = container.querySelector('[data-testid="external-project-start-item-F006"]') as HTMLButtonElement;
    expect(button.textContent).toContain('启动开发闭环');

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();

    const postCall = apiFetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(postCall?.[0]).toBe('/api/external-projects/project-Traqen/development-loop/features/item-F006/start');
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({ protocolVersion: 1 });
    expect(button.textContent).toContain('已启动');
    expect(container.textContent).toContain('已在 ChatGPT Desktop 创建对应开发任务');
  });

  it('opens feature-scoped plan and Review conversations', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/threads') return { ok: true, json: async () => ({ threads: [] }) };
      if (init?.method === 'POST' && path.endsWith('/threads/review')) {
        return {
          ok: true,
          json: async () => ({
            thread: {
              threadId: 'project-feature-review:project-Traqen:item-F006',
              projectId: 'project-Traqen',
              backlogItemId: 'item-F006',
              featureId: 'F006',
              kind: 'review',
              status: 'active',
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          states: [{ backlogItemId: 'item-F006', featureId: 'F006', title: 'Feature', status: 'available' }],
        }),
      };
    });
    await act(async () => {
      root.render(React.createElement(ExternalProjectFeatureList, { project: project('Traqen'), items: [item()] }));
    });
    await flush();
    const review = container.querySelector('[data-testid="external-project-review-item-F006"]') as HTMLButtonElement;
    await act(async () => {
      review.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/external-projects/project-Traqen/development-loop/features/item-F006/threads/review',
      { method: 'POST' },
    );
    expect(routerPushMock).toHaveBeenCalledWith('/thread/project-feature-review%3Aproject-Traqen%3Aitem-F006');
  });

  it('binds an existing project conversation to a feature workspace', async () => {
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/threads/plan/candidates')) {
        return {
          ok: true,
          json: async () => ({
            binding: {
              projectId: 'project-Traqen',
              backlogItemId: 'item-F006',
              featureId: 'F006',
              kind: 'plan',
              automaticThreadId: 'project-feature-plan:project-Traqen:item-F006',
              selectedThreadId: 'project-feature-plan:project-Traqen:item-F006',
              binding: 'automatic',
              locked: false,
              candidates: [
                { threadId: 'existing-thread', title: 'Existing architecture chat', lastActiveAt: 10, selected: false },
              ],
            },
          }),
        };
      }
      if (init?.method === 'PUT') {
        return {
          ok: true,
          json: async () => ({
            thread: {
              threadId: 'existing-thread',
              projectId: 'project-Traqen',
              backlogItemId: 'item-F006',
              featureId: 'F006',
              kind: 'plan',
              status: 'active',
              binding: 'manual',
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          states: [{ backlogItemId: 'item-F006', featureId: 'F006', title: 'Feature', status: 'available' }],
        }),
      };
    });
    await act(async () => {
      root.render(React.createElement(ExternalProjectFeatureList, { project: project('Traqen'), items: [item()] }));
    });
    await flush();

    const bind = container.querySelector('[data-testid="external-project-bind-plan-item-F006"]') as HTMLButtonElement;
    await act(async () => {
      bind.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();

    const select = container.querySelector(
      '[data-testid="external-project-binding-select-item-F006"]',
    ) as HTMLSelectElement;
    await act(async () => {
      select.value = 'existing-thread';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const save = container.querySelector(
      '[data-testid="external-project-binding-save-item-F006"]',
    ) as HTMLButtonElement;
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();

    const putCall = apiFetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    expect(putCall?.[0]).toContain('/threads/plan/binding');
    expect(JSON.parse((putCall?.[1] as RequestInit).body as string)).toEqual({ threadId: 'existing-thread' });
    expect(container.textContent).toContain('F006 的方案已绑定到所选会话');
  });

  it('keeps automatic Desktop launch failures retryable', async () => {
    apiFetchMock.mockImplementation(async (_path: string, init?: RequestInit) => {
      if (!init) {
        return {
          ok: true,
          json: async () => ({
            states: [{ backlogItemId: 'item-F006', featureId: 'F006', title: 'Feature', status: 'available' }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          state: {
            backlogItemId: 'item-F006',
            featureId: 'F006',
            title: 'Feature',
            status: 'ready_for_desktop',
            desktopTask: { status: 'failed', error: 'Desktop unavailable' },
          },
        }),
      };
    });
    await act(async () => {
      root.render(React.createElement(ExternalProjectFeatureList, { project: project('Traqen'), items: [item()] }));
    });
    await flush();
    const button = container.querySelector('[data-testid="external-project-start-item-F006"]') as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('重试启动');
    expect(container.textContent).toContain('Desktop unavailable');
  });

  it('works for any bound external project and allows a detached launch to reconnect', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        states: [
          {
            backlogItemId: 'item-F120',
            featureId: 'F120',
            title: '[F120] Workspace capability settings',
            status: 'ready_for_desktop',
          },
        ],
      }),
    });

    await act(async () => {
      root.render(
        React.createElement(ExternalProjectFeatureList, {
          project: project('Another Repo'),
          items: [item('F120')],
        }),
      );
    });
    await flush();

    const button = container.querySelector('[data-testid="external-project-start-item-F120"]') as HTMLButtonElement;
    expect(container.textContent).toContain('只属于「Another Repo」');
    expect(button.textContent).toContain('已启动');
    expect(button.disabled).toBe(false);
    expect(apiFetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'POST')).toBe(
      true,
    );
  });

  it('distinguishes a cat-owned workflow from a Desktop launch', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        states: [
          {
            backlogItemId: 'item-F006',
            featureId: 'F006',
            title: '[F006] Workspace capability settings',
            status: 'managed_by_catcafe',
          },
        ],
      }),
    });

    await act(async () => {
      root.render(React.createElement(ExternalProjectFeatureList, { project: project('Traqen'), items: [item()] }));
    });
    await flush();

    const button = container.querySelector('[data-testid="external-project-start-item-F006"]') as HTMLButtonElement;
    expect(button.textContent).toContain('CatCafe 流程处理中');
    expect(button.disabled).toBe(true);
  });

  it('shows rejected work without calling it completed', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        states: [
          {
            backlogItemId: 'item-F006',
            featureId: 'F006',
            title: '[F006] Workspace capability settings',
            status: 'rejected',
          },
        ],
      }),
    });

    await act(async () => {
      root.render(React.createElement(ExternalProjectFeatureList, { project: project('Traqen'), items: [item()] }));
    });
    await flush();

    const button = container.querySelector('[data-testid="external-project-start-item-F006"]') as HTMLButtonElement;
    expect(button.textContent).toContain('验收未通过');
    expect(button.textContent).not.toContain('已完成');
    expect(button.disabled).toBe(true);
  });

  it('does not offer a launch when the external project has no Desktop binding', async () => {
    const unboundProject = { ...project('Unbound'), desktopDevelopment: undefined };

    await act(async () => {
      root.render(React.createElement(ExternalProjectFeatureList, { project: unboundProject, items: [item()] }));
    });
    await flush();

    const button = container.querySelector('[data-testid="external-project-start-item-F006"]') as HTMLButtonElement;
    expect(button.textContent).toContain('未绑定 Desktop');
    expect(button.disabled).toBe(true);
  });
});
