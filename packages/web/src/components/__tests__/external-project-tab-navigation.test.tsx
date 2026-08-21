import type { BacklogItem, ExternalProject } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useExternalProjectStore } from '@/stores/externalProjectStore';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('../mission-control/DesktopDevelopmentPanel', () => ({
  DesktopDevelopmentPanel: ({ onOpenFeatureConfig }: { onOpenFeatureConfig?: () => void }) => (
    <button type="button" data-testid="mock-open-feature-config" onClick={onOpenFeatureConfig}>
      前往配置方案分支
    </button>
  ),
}));

vi.mock('../mission-control/ExternalProjectFeatureList', () => ({
  ExternalProjectFeatureList: () => (
    <button type="button" data-testid="external-project-design-branch">
      配置方案分支
    </button>
  ),
}));

vi.mock('../mission-control/NeedAuditFrame', () => ({ NeedAuditFrame: () => null }));

const { ExternalProjectTab } = await import('../mission-control/ExternalProjectTab');

const project: ExternalProject = {
  id: 'project-traqen',
  userId: 'owner-1',
  name: 'Traqen',
  description: '',
  sourcePath: '/work/Traqen',
  backlogPath: 'docs/ROADMAP.md',
  createdAt: 1,
  updatedAt: 1,
};

const item: BacklogItem = {
  id: 'item-f006',
  userId: 'owner-1',
  projectId: project.id,
  title: '[F006] Test feature',
  summary: '',
  priority: 'p2',
  tags: ['feature:f006'],
  status: 'open',
  createdBy: 'user',
  createdAt: 1,
  updatedAt: 1,
  audit: [],
};

function response(body: unknown) {
  return { ok: true, json: async () => body };
}

const API_RESPONSES: readonly (readonly [RegExp, unknown])[] = [
  [/\/intent-cards$/, { cards: [] }],
  [/\/frame$/, { frame: null }],
  [/^\/api\/backlog\/items/, { items: [item] }],
  [/^\/api\/execution-digests/, { digests: [] }],
  [/\/resolutions$/, { resolutions: [] }],
  [/\/slices$/, { slices: [] }],
  [/\/reflux-patterns$/, { patterns: [] }],
];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ExternalProjectTab workflow navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    window.localStorage.clear();
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      const match = API_RESPONSES.find(([pattern]) => pattern.test(path));
      if (!match) throw new Error(`Unexpected request: ${path}`);
      return Promise.resolve(response(match[1]));
    });
    useExternalProjectStore.setState({
      intentCards: [],
      auditFrame: null,
      executionDigests: [],
      resolutions: [],
      slices: [],
      refluxPatterns: [],
      loading: false,
    });
    scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('switches from the workflow to the real feature configuration entry and focuses it', async () => {
    await act(async () => root.render(<ExternalProjectTab project={project} />));
    await flush();

    const developmentTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="external-project-sub-tab-development"]',
    );
    await act(async () => developmentTab?.click());
    const openConfig = container.querySelector<HTMLButtonElement>('[data-testid="mock-open-feature-config"]');
    await act(async () => openConfig?.click());

    const configButton = container.querySelector<HTMLButtonElement>('[data-testid="external-project-design-branch"]');
    expect(configButton).not.toBeNull();
    expect(document.activeElement).toBe(configButton);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(window.localStorage.getItem('cat-cafe:mission-hub:project-sub-tab:project-traqen')).toBe('features');
  });

  it('keeps the project tab strip inside a mobile horizontal scroller', async () => {
    await act(async () => root.render(<ExternalProjectTab project={project} />));
    await flush();

    const strip = container.querySelector('[data-testid="external-project-sub-tab-strip"]');
    expect(strip?.className).toContain('min-w-0');
    expect(strip?.className).toContain('overflow-x-auto');
    const featureTab = container.querySelector('[data-testid="external-project-sub-tab-features"]');
    expect(featureTab?.className).toContain('shrink-0');
  });
});
