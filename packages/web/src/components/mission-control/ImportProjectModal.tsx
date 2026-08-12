'use client';

import { useEffect, useMemo, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { buildDesktopDevelopmentCreateInput } from './desktop-development-form';

interface ImportProjectModalProps {
  onClose: () => void;
  onImported: () => void;
}

export function ImportProjectModal({ onClose, onImported }: ImportProjectModalProps) {
  const [name, setName] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [backlogPath, setBacklogPath] = useState('docs/ROADMAP.md');
  const [description, setDescription] = useState('');
  const [enableDesktopLoop, setEnableDesktopLoop] = useState(false);
  const [repository, setRepository] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  const [allowPush, setAllowPush] = useState(true);
  const [allowPullRequest, setAllowPullRequest] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { cats } = useCatData();
  const reviewableCats = useMemo(() => cats.filter((cat) => cat.roster?.available !== false), [cats]);

  useEffect(() => {
    if (!enableDesktopLoop || reviewerIds.length > 0 || reviewableCats.length < 2) return;
    setReviewerIds(reviewableCats.slice(0, 2).map((cat) => cat.id));
  }, [enableDesktopLoop, reviewerIds.length, reviewableCats]);

  const handleSubmit = async () => {
    if (!name.trim() || !sourcePath.trim()) {
      setError('项目名称和路径不能为空');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const desktopDevelopment = buildDesktopDevelopmentCreateInput({
        enabled: enableDesktopLoop,
        repository,
        defaultBranch,
        reviewerIds,
        allowPush,
        allowPullRequest,
      });
      const res = await apiFetch('/api/external-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          sourcePath: sourcePath.trim(),
          backlogPath,
          description,
          ...(desktopDevelopment ? { desktopDevelopment } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `创建失败: ${res.status}`);
      }
      onImported();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-project-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--console-overlay-backdrop)] backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl bg-[var(--console-card-bg)] p-6 shadow-lg">
        <h2 id="import-project-title" className="mb-4 text-base font-bold text-cafe">
          导入项目
        </h2>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-cafe-secondary">项目名称 *</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. studio-flow"
              className="mt-1 w-full rounded-[10px] border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2 text-sm text-cafe focus:outline-none focus:ring-1 focus:ring-cafe-accent"
            />
          </label>

          <label className="flex items-start gap-2 rounded-[10px] bg-[var(--console-shell-bg)] px-3 py-2">
            <input
              type="checkbox"
              checked={enableDesktopLoop}
              onChange={(event) => setEnableDesktopLoop(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-xs font-medium text-cafe">连接 ChatGPT Desktop 开发闭环</span>
              <span className="block text-micro text-cafe-secondary">同一项目长期复用一个 Review Hub</span>
            </span>
          </label>

          {enableDesktopLoop && (
            <div className="space-y-3 rounded-[10px] bg-[var(--console-shell-bg)] p-3">
              <label className="block">
                <span className="text-xs font-medium text-cafe-secondary">GitHub 仓库 *</span>
                <input
                  type="text"
                  value={repository}
                  onChange={(event) => setRepository(event.target.value)}
                  placeholder="owner/repository"
                  className="mt-1 w-full rounded-[10px] border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2 text-sm text-cafe focus:outline-none focus:ring-1 focus:ring-cafe-accent"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-cafe-secondary">默认分支 *</span>
                <input
                  type="text"
                  value={defaultBranch}
                  onChange={(event) => setDefaultBranch(event.target.value)}
                  className="mt-1 w-full rounded-[10px] border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2 text-sm text-cafe focus:outline-none focus:ring-1 focus:ring-cafe-accent"
                />
              </label>
              <fieldset>
                <legend className="text-xs font-medium text-cafe-secondary">默认 Review 猫猫（至少两只）</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {reviewableCats.map((cat) => {
                    const selected = reviewerIds.includes(cat.id);
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          setReviewerIds((current) =>
                            selected ? current.filter((id) => id !== cat.id) : [...current, cat.id],
                          )
                        }
                        className={`rounded-full px-3 py-1 text-xs font-medium ${
                          selected
                            ? 'bg-[var(--mc-accent)] text-[var(--cafe-surface)]'
                            : 'bg-[var(--console-hover-bg)] text-cafe-secondary'
                        }`}
                      >
                        {cat.displayName}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex items-center gap-2 text-xs text-cafe-secondary">
                  <input
                    type="checkbox"
                    checked={allowPush}
                    onChange={(event) => {
                      setAllowPush(event.target.checked);
                      if (!event.target.checked) setAllowPullRequest(false);
                    }}
                  />
                  允许 Desktop push
                </label>
                <label className="flex items-center gap-2 text-xs text-cafe-secondary">
                  <input
                    type="checkbox"
                    checked={allowPullRequest}
                    disabled={!allowPush}
                    onChange={(event) => setAllowPullRequest(event.target.checked)}
                  />
                  允许 Desktop 创建 PR
                </label>
              </div>
              <p className="text-micro text-cafe-secondary">前两次成功试点仍需在当前 ChatGPT 会话中确认合入。</p>
            </div>
          )}

          <label className="block">
            <span className="text-xs font-medium text-cafe-secondary">项目路径 *</span>
            <input
              type="text"
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              placeholder="/home/user/projects/studio-flow"
              className="mt-1 w-full rounded-[10px] border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2 text-sm text-cafe focus:outline-none focus:ring-1 focus:ring-cafe-accent"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-cafe-secondary">Backlog 路径</span>
            <input
              type="text"
              value={backlogPath}
              onChange={(e) => setBacklogPath(e.target.value)}
              className="mt-1 w-full rounded-[10px] border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2 text-sm text-cafe focus:outline-none focus:ring-1 focus:ring-cafe-accent"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-cafe-secondary">描述</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简要描述"
              className="mt-1 w-full rounded-[10px] border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2 text-sm text-cafe focus:outline-none focus:ring-1 focus:ring-cafe-accent"
            />
          </label>
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text">
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-[var(--console-shell-bg)] px-4 py-1.5 text-xs font-medium text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded-lg bg-[var(--mc-accent)] px-4 py-1.5 text-xs font-medium text-[var(--cafe-surface)] hover:bg-[var(--mc-accent-hover)] disabled:opacity-40"
          >
            {submitting ? '导入中...' : '导入'}
          </button>
        </div>
      </div>
    </div>
  );
}
