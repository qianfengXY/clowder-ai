'use client';

import type { ProjectWorkspaceRef, ProjectWorkspaceView } from './project-workspace';

interface ProjectWorkspaceNavProps {
  workspaces: readonly ProjectWorkspaceRef[];
  activeProjectKey: string;
  activeView: ProjectWorkspaceView;
  onSelectProject: (project: ProjectWorkspaceRef) => void;
  onSelectView: (view: ProjectWorkspaceView) => void;
}

const ACTIVE_CLASS = 'rounded-lg bg-[var(--console-active-bg)] text-cafe';
const INACTIVE_CLASS = 'text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-secondary';

export function ProjectWorkspaceNav({
  workspaces,
  activeProjectKey,
  activeView,
  onSelectProject,
  onSelectView,
}: ProjectWorkspaceNavProps) {
  return (
    <div className="mt-4 space-y-2 console-divider-b pb-2">
      <nav aria-label="Mission Hub 项目" className="flex items-center gap-1 overflow-x-auto pb-1">
        <span className="mr-2 shrink-0 text-micro font-semibold uppercase tracking-wider text-cafe-muted">项目</span>
        {workspaces.map((project) => {
          const active = project.key === activeProjectKey;
          return (
            <button
              key={project.key}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelectProject(project)}
              data-testid={project.kind === 'home' ? 'mc-project-home' : `mc-project-${project.id}`}
              className={`shrink-0 px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent ${
                active ? ACTIVE_CLASS : INACTIVE_CLASS
              }`}
            >
              {project.name}
            </button>
          );
        })}
      </nav>

      <nav aria-label="当前项目视图" className="flex items-center gap-1">
        <span className="mr-2 shrink-0 text-micro font-semibold uppercase tracking-wider text-cafe-muted">视图</span>
        <button
          type="button"
          aria-pressed={activeView === 'features'}
          onClick={() => onSelectView('features')}
          data-testid="mc-tab-features"
          className={`px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent ${
            activeView === 'features' ? ACTIVE_CLASS : INACTIVE_CLASS
          }`}
        >
          功能列表
        </button>
        <button
          type="button"
          aria-pressed={activeView === 'dependencies'}
          onClick={() => onSelectView('dependencies')}
          data-testid="mc-tab-dependencies"
          className={`px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent ${
            activeView === 'dependencies' ? ACTIVE_CLASS : INACTIVE_CLASS
          }`}
        >
          依赖全景
        </button>
      </nav>
    </div>
  );
}
