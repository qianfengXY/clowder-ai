import type { BacklogItem, CatId, ExternalProject } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import {
  buildProjectWorkspaces,
  getProjectBacklogCreatePath,
  getProjectBacklogImportPath,
  getProjectBacklogItemsPath,
  isCanonicalProjectItem,
  resolveProjectPreference,
} from '../project-workspace';

const projects: ExternalProject[] = [
  {
    id: 'project-traqen',
    userId: 'user-1',
    name: 'Traqen',
    description: 'Evidence-first product discovery',
    sourcePath: '/work/Traqen',
    backlogPath: 'docs/ROADMAP.md',
    createdAt: 1,
    updatedAt: 2,
    desktopDevelopment: {
      protocolVersion: 1,
      version: 1,
      repository: { host: 'github.com', owner: 'owner', name: 'traqen', fullName: 'owner/traqen' },
      defaultBranch: 'main',
      developmentActor: 'chatgpt-desktop-dev',
      defaultReviewers: ['cat-a' as CatId, 'cat-b' as CatId],
      defaultReviewRecorder: 'cat-a' as CatId,
      allowPush: true,
      allowPullRequest: true,
      mergeMode: 'manual_confirm_in_chatgpt',
      successfulManualPilotCount: 0,
      successfulManualPilotWorkIds: [],
      requireFinalAcceptance: true,
    },
  },
];

describe('Mission Hub project workspace projection', () => {
  it('always places Cat Café first and does not project EXT/Desktop policy', () => {
    const workspaces = buildProjectWorkspaces(projects);

    expect(workspaces.map((project) => [project.key, project.name])).toEqual([
      ['home', 'Cat Café'],
      ['external:project-traqen', 'Traqen'],
    ]);
    expect(workspaces[1]).toEqual({
      kind: 'external',
      key: 'external:project-traqen',
      id: 'project-traqen',
      name: 'Traqen',
    });
    expect(workspaces[1]).not.toHaveProperty('desktopDevelopment');
  });

  it('falls back to Cat Café and migrates valid legacy tabs without preferring Traqen', () => {
    expect(resolveProjectPreference(projects, null, null)).toMatchObject({ key: 'home' });
    expect(resolveProjectPreference(projects, null, 'features')).toMatchObject({ key: 'home' });
    expect(resolveProjectPreference(projects, null, 'dependencies')).toMatchObject({ key: 'home' });
    expect(resolveProjectPreference(projects, null, 'project-traqen')).toMatchObject({
      key: 'external:project-traqen',
    });
    expect(resolveProjectPreference(projects, 'external:missing', 'project-traqen')).toMatchObject({ key: 'home' });
  });

  it('derives list/create/import endpoints from one project scope', () => {
    const [home, traqen] = buildProjectWorkspaces(projects);
    expect(home).toBeDefined();
    expect(traqen).toBeDefined();
    if (!home || !traqen) return;

    expect(getProjectBacklogItemsPath(home)).toBe('/api/backlog/items');
    expect(getProjectBacklogCreatePath(home)).toBe('/api/backlog/items');
    expect(getProjectBacklogImportPath(home)).toBe('/api/backlog/import-active-features');

    expect(getProjectBacklogItemsPath(traqen)).toBe('/api/backlog/items?projectId=project-traqen');
    expect(getProjectBacklogCreatePath(traqen)).toBe('/api/external-projects/project-traqen/backlog/items');
    expect(getProjectBacklogImportPath(traqen)).toBe('/api/external-projects/project-traqen/import-backlog');
  });

  it('excludes extension catalog items without mutating historical records', () => {
    const item = {
      id: 'legacy-ext',
      userId: 'user-1',
      title: '[EXT-001] ChatGPT Desktop loop',
      summary: 'legacy',
      priority: 'p2',
      tags: ['feature:ext-001', 'feature-kind:extension'],
      status: 'done',
      createdBy: 'user',
      createdAt: 1,
      updatedAt: 1,
      audit: [],
    } satisfies BacklogItem;

    expect(isCanonicalProjectItem(item)).toBe(false);
    expect(item.tags).toContain('feature-kind:extension');
    expect(isCanonicalProjectItem({ ...item, title: '[F306] Project workspaces', tags: ['feature:f306'] })).toBe(true);
  });
});
