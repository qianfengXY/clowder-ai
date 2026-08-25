import type { BacklogItem, ExternalProject } from '@cat-cafe/shared';

export type ProjectWorkspaceRef =
  | {
      readonly kind: 'home';
      readonly key: 'home';
      readonly id: null;
      readonly name: 'Cat Café';
    }
  | {
      readonly kind: 'external';
      readonly key: `external:${string}`;
      readonly id: string;
      readonly name: string;
    };

export type ProjectWorkspaceView = 'features' | 'dependencies';

export const HOME_PROJECT_WORKSPACE: ProjectWorkspaceRef = {
  kind: 'home',
  key: 'home',
  id: null,
  name: 'Cat Café',
};

export const MISSION_HUB_ACTIVE_PROJECT_KEY = 'cat-cafe:mission-hub:active-project';
export const LEGACY_MISSION_HUB_ACTIVE_TAB_KEY = 'cat-cafe:mission-hub:active-tab';

export function projectViewPreferenceKey(projectKey: string): string {
  return `cat-cafe:mission-hub:project-view:${projectKey}`;
}

export function buildProjectWorkspaces(projects: readonly ExternalProject[]): ProjectWorkspaceRef[] {
  return [
    HOME_PROJECT_WORKSPACE,
    ...projects.map(
      (project): ProjectWorkspaceRef => ({
        kind: 'external',
        key: `external:${project.id}`,
        id: project.id,
        name: project.name,
      }),
    ),
  ];
}

export function resolveProjectPreference(
  projects: readonly ExternalProject[],
  savedProjectKey: string | null,
  legacyActiveTab: string | null,
): ProjectWorkspaceRef {
  const workspaces = buildProjectWorkspaces(projects);
  if (savedProjectKey) {
    return workspaces.find((project) => project.key === savedProjectKey) ?? HOME_PROJECT_WORKSPACE;
  }
  if (legacyActiveTab && legacyActiveTab !== 'features' && legacyActiveTab !== 'dependencies') {
    return (
      workspaces.find((project) => project.kind === 'external' && project.id === legacyActiveTab) ??
      HOME_PROJECT_WORKSPACE
    );
  }
  return HOME_PROJECT_WORKSPACE;
}

export function resolveProjectViewPreference(
  savedView: string | null,
  legacyActiveTab: string | null,
): ProjectWorkspaceView {
  if (savedView === 'dependencies' || savedView === 'features') return savedView;
  if (legacyActiveTab === 'dependencies') return 'dependencies';
  return 'features';
}

export function getProjectBacklogItemsPath(project: ProjectWorkspaceRef): string {
  if (project.kind === 'home') return '/api/backlog/items';
  return `/api/backlog/items?projectId=${encodeURIComponent(project.id)}`;
}

export function getProjectBacklogCreatePath(project: ProjectWorkspaceRef): string {
  if (project.kind === 'home') return '/api/backlog/items';
  return `/api/external-projects/${encodeURIComponent(project.id)}/backlog/items`;
}

export function getProjectBacklogImportPath(project: ProjectWorkspaceRef): string {
  if (project.kind === 'home') return '/api/backlog/import-active-features';
  return `/api/external-projects/${encodeURIComponent(project.id)}/import-backlog`;
}

export function isCanonicalProjectItem(item: BacklogItem): boolean {
  if (item.tags.some((tag) => tag.toLowerCase() === 'feature-kind:extension')) return false;
  if (item.tags.some((tag) => tag.toLowerCase().startsWith('feature:ext-'))) return false;
  return !/^\[EXT-\d+\]/i.test(item.title.trim());
}
