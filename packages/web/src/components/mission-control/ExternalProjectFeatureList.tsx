'use client';

import type {
  BacklogItem,
  ExternalProject,
  FeatureWorkspaceThreadCandidatesView,
  FeatureWorkspaceThreadKind,
  FeatureWorkspaceThreadView,
} from '@cat-cafe/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { type Thread, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

type ServerLaunchStatus =
  | 'available'
  | 'ready_for_desktop'
  | 'connected_to_desktop'
  | 'managed_by_catcafe'
  | 'rejected'
  | 'completed';
type LaunchStatus = ServerLaunchStatus | 'checking' | 'starting' | 'error';

interface LaunchState {
  backlogItemId: string;
  featureId: string;
  title: string;
  status: ServerLaunchStatus;
  desktopTask?: { status: 'created'; threadId: string } | { status: 'failed'; error: string };
}

interface ExternalProjectFeatureListProps {
  project: ExternalProject;
  items: BacklogItem[];
}

function featureIdFromItem(item: BacklogItem): string | null {
  const tag = item.tags.find((candidate) => candidate.toLowerCase().startsWith('feature:'));
  const featureId = tag?.slice('feature:'.length).trim();
  return featureId ? featureId.toUpperCase() : null;
}

function launchButtonLabel(status: LaunchStatus, desktopBound: boolean, featureId: string | null): string {
  if (!desktopBound) return '未绑定 Desktop';
  if (!featureId) return '缺少 Feature ID';
  if (status === 'checking') return '检查中...';
  if (status === 'starting') return '启动中...';
  if (status === 'ready_for_desktop') return '已启动 · 等待 Desktop';
  if (status === 'connected_to_desktop') return 'Desktop 执行中';
  if (status === 'managed_by_catcafe') return 'CatCafe 流程处理中';
  if (status === 'rejected') return '验收未通过';
  if (status === 'completed') return '已完成';
  if (status === 'error') return '重试启动';
  return '启动开发闭环';
}

function launchStatusLabel(status: LaunchStatus): string {
  if (status === 'checking') return '读取状态';
  if (status === 'starting') return '启动中';
  if (status === 'available') return '未启动';
  if (status === 'ready_for_desktop') return '等待 Desktop';
  if (status === 'connected_to_desktop') return '开发中';
  if (status === 'managed_by_catcafe') return 'CatCafe 流程中';
  if (status === 'rejected') return '验收未通过';
  if (status === 'completed') return '已验收完成';
  return '状态异常';
}

function ExternalProjectFeatureRow({
  item,
  status,
  error,
  desktopBound,
  onStart,
  onOpenThread,
  onBindThread,
}: {
  item: BacklogItem;
  status: LaunchStatus;
  error?: string;
  desktopBound: boolean;
  onStart: (item: BacklogItem) => void;
  onOpenThread: (item: BacklogItem, kind: FeatureWorkspaceThreadKind) => void;
  onBindThread: (item: BacklogItem, kind: FeatureWorkspaceThreadKind) => void;
}) {
  const featureId = featureIdFromItem(item);
  const unavailable = !desktopBound || !featureId;
  const disabled = unavailable || !['available', 'ready_for_desktop', 'error'].includes(status);

  return (
    <div className="rounded-xl bg-[var(--console-card-bg)] px-4 py-3 shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="rounded bg-[var(--console-hover-bg)] px-2 py-0.5 text-micro font-bold text-cafe-secondary">
            {featureId ?? '—'}
          </span>
          <span className="min-w-0 text-sm font-medium text-cafe">{item.title}</span>
          <span className="rounded-full bg-[var(--console-hover-bg)] px-2 py-0.5 text-micro font-medium text-cafe-secondary">
            {launchStatusLabel(status)}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onOpenThread(item, 'plan')}
            disabled={unavailable}
            className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-1.5 text-xs font-medium text-cafe-secondary disabled:opacity-40"
            data-testid={`external-project-plan-${item.id}`}
          >
            方案
          </button>
          <button
            type="button"
            onClick={() => onBindThread(item, 'plan')}
            disabled={unavailable}
            className="rounded-lg px-2 py-1.5 text-micro font-medium text-cafe-secondary underline-offset-2 hover:underline disabled:opacity-40"
            data-testid={`external-project-bind-plan-${item.id}`}
          >
            绑定
          </button>
          <button
            type="button"
            onClick={() => onOpenThread(item, 'review')}
            disabled={unavailable}
            className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-1.5 text-xs font-medium text-cafe-secondary disabled:opacity-40"
            data-testid={`external-project-review-${item.id}`}
          >
            Review
          </button>
          <button
            type="button"
            onClick={() => onBindThread(item, 'review')}
            disabled={unavailable}
            className="rounded-lg px-2 py-1.5 text-micro font-medium text-cafe-secondary underline-offset-2 hover:underline disabled:opacity-40"
            data-testid={`external-project-bind-review-${item.id}`}
          >
            绑定
          </button>
          <button
            type="button"
            onClick={() => onStart(item)}
            disabled={disabled}
            className="rounded-lg bg-[var(--mc-accent)] px-3 py-1.5 text-xs font-medium text-[var(--cafe-surface)] disabled:bg-[var(--console-hover-bg)] disabled:text-cafe-secondary disabled:opacity-70"
            data-testid={`external-project-start-${item.id}`}
          >
            {launchButtonLabel(status, desktopBound, featureId)}
          </button>
        </div>
      </div>
      {error && (
        <p className="mt-2 text-xs text-conn-red-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function ExternalProjectFeatureList({ project, items }: ExternalProjectFeatureListProps) {
  const router = useRouter();
  const setCurrentThread = useChatStore((state) => state.setCurrentThread);
  const setCurrentProject = useChatStore((state) => state.setCurrentProject);
  const setThreads = useChatStore((state) => state.setThreads);
  const [launchStatuses, setLaunchStatuses] = useState<Record<string, LaunchStatus>>({});
  const [launchErrors, setLaunchErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [launchRefreshKey, setLaunchRefreshKey] = useState(0);
  const [bindingEditor, setBindingEditor] = useState<{
    itemId: string;
    kind: FeatureWorkspaceThreadKind;
    data?: FeatureWorkspaceThreadCandidatesView;
    selectedThreadId: string;
    loading: boolean;
    saving: boolean;
    error?: string;
  } | null>(null);
  const startingItemsRef = useRef(new Set<string>());

  useEffect(() => {
    setNotice(null);
    setBindingEditor(null);
  }, [project.id]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    setLaunchErrors({});
    setLaunchStatuses(Object.fromEntries(items.map((item) => [item.id, 'checking'])));

    const protocolVersion = project.desktopDevelopment?.protocolVersion;
    if (!protocolVersion) return () => undefined;

    const loadLaunchStates = async () => {
      let shouldPoll = false;
      try {
        const response = await apiFetch(
          `/api/external-projects/${encodeURIComponent(project.id)}/development-loop/launch-states?protocolVersion=${protocolVersion}`,
        );
        if (!response.ok) throw new Error(`状态读取失败: ${response.status}`);
        const body = (await response.json()) as { states: LaunchState[] };
        if (cancelled) return;
        shouldPoll = body.states.some(
          (state) => state.status === 'ready_for_desktop' || state.status === 'connected_to_desktop',
        );
        const byItem = new Map(body.states.map((state) => [state.backlogItemId, state.status]));
        setLaunchStatuses(
          Object.fromEntries(
            items.map((item) => [
              item.id,
              startingItemsRef.current.has(item.id) ? 'starting' : (byItem.get(item.id) ?? 'available'),
            ]),
          ),
        );
        setLaunchErrors({});
      } catch (error) {
        if (cancelled) return;
        setLaunchStatuses(
          Object.fromEntries(
            items.map((item) => [item.id, startingItemsRef.current.has(item.id) ? 'starting' : 'error']),
          ),
        );
        setLaunchErrors(
          Object.fromEntries(
            items.map((item) => [item.id, error instanceof Error ? error.message : '无法读取启动状态']),
          ),
        );
      } finally {
        if (!cancelled && shouldPoll) pollTimer = setTimeout(() => void loadLaunchStates(), 30_000);
      }
    };

    void loadLaunchStates();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [items, launchRefreshKey, project.desktopDevelopment?.protocolVersion, project.id]);

  const startDevelopment = async (item: BacklogItem) => {
    const featureId = featureIdFromItem(item);
    if (!featureId) {
      setLaunchStatuses((current) => ({ ...current, [item.id]: 'error' }));
      setLaunchErrors((current) => ({ ...current, [item.id]: '该功能缺少 feature 标签，无法启动' }));
      return;
    }

    startingItemsRef.current.add(item.id);
    setLaunchStatuses((current) => ({ ...current, [item.id]: 'starting' }));
    setLaunchErrors((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    try {
      const response = await apiFetch(
        `/api/external-projects/${encodeURIComponent(project.id)}/development-loop/features/${encodeURIComponent(item.id)}/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            protocolVersion: project.desktopDevelopment?.protocolVersion,
          }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `启动失败: ${response.status}`);
      }
      const body = (await response.json()) as { state: LaunchState };
      startingItemsRef.current.delete(item.id);
      if (body.state.desktopTask?.status === 'created') {
        setLaunchStatuses((current) => ({ ...current, [item.id]: body.state.status }));
        setLaunchRefreshKey((current) => current + 1);
        setNotice(`${featureId} 已进入开发闭环，并已在 ChatGPT Desktop 创建对应开发任务。`);
      } else if (body.state.desktopTask?.status === 'failed') {
        setLaunchStatuses((current) => ({ ...current, [item.id]: 'error' }));
        setNotice(`${featureId} 已进入开发闭环；Desktop 任务自动创建失败，可稍后重试：${body.state.desktopTask.error}`);
      } else if (body.state.status === 'ready_for_desktop' || body.state.status === 'connected_to_desktop') {
        setLaunchStatuses((current) => ({ ...current, [item.id]: body.state.status }));
        setLaunchRefreshKey((current) => current + 1);
        setNotice(`${featureId} 已进入 Desktop 开发闭环。`);
      } else if (body.state.status === 'managed_by_catcafe') {
        setLaunchStatuses((current) => ({ ...current, [item.id]: body.state.status }));
        setLaunchErrors((current) => ({ ...current, [item.id]: '该功能已有 CatCafe 执行流程，未改写现有 SOP' }));
      } else {
        setLaunchStatuses((current) => ({ ...current, [item.id]: body.state.status }));
      }
    } catch (error) {
      startingItemsRef.current.delete(item.id);
      setLaunchStatuses((current) => ({ ...current, [item.id]: 'error' }));
      setLaunchErrors((current) => ({
        ...current,
        [item.id]: error instanceof Error ? error.message : '启动失败',
      }));
    }
  };

  const openFeatureThread = async (item: BacklogItem, kind: FeatureWorkspaceThreadKind) => {
    try {
      const response = await apiFetch(
        `/api/external-projects/${encodeURIComponent(project.id)}/development-loop/features/${encodeURIComponent(item.id)}/threads/${kind}`,
        { method: 'POST' },
      );
      const body = (await response.json()) as { thread?: FeatureWorkspaceThreadView; error?: string };
      if (!response.ok || !body.thread) throw new Error(body.error ?? '无法打开功能会话');
      const threadResponse = await apiFetch('/api/threads');
      if (threadResponse.ok) {
        const threadBody = (await threadResponse.json()) as { threads?: Thread[] };
        if (threadBody.threads) setThreads(threadBody.threads);
      }
      setCurrentProject(project.sourcePath);
      setCurrentThread(body.thread.threadId);
      router.push(`/thread/${encodeURIComponent(body.thread.threadId)}`);
    } catch (error) {
      setLaunchErrors((current) => ({
        ...current,
        [item.id]: error instanceof Error ? error.message : '无法打开功能会话',
      }));
    }
  };

  const openBindingEditor = async (item: BacklogItem, kind: FeatureWorkspaceThreadKind) => {
    setBindingEditor({ itemId: item.id, kind, selectedThreadId: '', loading: true, saving: false });
    try {
      const response = await apiFetch(
        `/api/external-projects/${encodeURIComponent(project.id)}/development-loop/features/${encodeURIComponent(item.id)}/threads/${kind}/candidates`,
      );
      const body = (await response.json()) as { binding?: FeatureWorkspaceThreadCandidatesView; error?: string };
      if (!response.ok || !body.binding) throw new Error(body.error ?? '无法读取可绑定会话');
      setBindingEditor({
        itemId: item.id,
        kind,
        data: body.binding,
        selectedThreadId: body.binding.binding === 'manual' ? body.binding.selectedThreadId : '',
        loading: false,
        saving: false,
      });
    } catch (error) {
      setBindingEditor({
        itemId: item.id,
        kind,
        selectedThreadId: '',
        loading: false,
        saving: false,
        error: error instanceof Error ? error.message : '无法读取可绑定会话',
      });
    }
  };

  const saveBinding = async () => {
    if (!bindingEditor?.data || bindingEditor.data.locked) return;
    setBindingEditor((current) => (current ? { ...current, saving: true, error: undefined } : current));
    try {
      const response = await apiFetch(
        `/api/external-projects/${encodeURIComponent(project.id)}/development-loop/features/${encodeURIComponent(bindingEditor.itemId)}/threads/${bindingEditor.kind}/binding`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId: bindingEditor.selectedThreadId || null }),
        },
      );
      const body = (await response.json()) as { thread?: FeatureWorkspaceThreadView; error?: string };
      if (!response.ok || !body.thread) throw new Error(body.error ?? '绑定失败');
      const label = bindingEditor.kind === 'plan' ? '方案' : 'Review';
      setNotice(
        body.thread.binding === 'manual'
          ? `${bindingEditor.data.featureId} 的${label}已绑定到所选会话。`
          : `${bindingEditor.data.featureId} 的${label}已恢复为自动会话。`,
      );
      setBindingEditor(null);
    } catch (error) {
      setBindingEditor((current) =>
        current ? { ...current, saving: false, error: error instanceof Error ? error.message : '绑定失败' } : current,
      );
    }
  };

  if (items.length === 0) {
    return (
      <div className="rounded-lg bg-[var(--console-shell-bg)] p-8 text-center text-sm text-cafe-secondary">
        暂无功能 — 使用上方「导入 Backlog」按钮从项目导入
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="external-project-feature-list">
      <div className="rounded-xl bg-[var(--console-shell-bg)] px-4 py-3 text-xs leading-relaxed text-cafe-secondary">
        从这里启动的功能只属于「{project.name}」。每个功能都有独立的方案与 Review 会话；启动开发后，CatCafe
        会创建并连接对应的 ChatGPT Desktop 开发任务。
      </div>
      {notice && (
        <output
          className="rounded-xl bg-[var(--semantic-success-surface)] px-4 py-3 text-xs text-[var(--semantic-success-text)]"
          data-testid="external-project-launch-notice"
        >
          {notice}
        </output>
      )}
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="space-y-2">
            <ExternalProjectFeatureRow
              item={item}
              status={launchStatuses[item.id] ?? 'checking'}
              error={launchErrors[item.id]}
              desktopBound={Boolean(project.desktopDevelopment)}
              onStart={(selected) => void startDevelopment(selected)}
              onOpenThread={(selected, kind) => void openFeatureThread(selected, kind)}
              onBindThread={(selected, kind) => void openBindingEditor(selected, kind)}
            />
            {bindingEditor?.itemId === item.id && (
              <div
                className="rounded-xl border border-[var(--console-border)] bg-[var(--console-shell-bg)] px-4 py-3"
                data-testid={`external-project-binding-editor-${item.id}`}
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold text-cafe">
                    绑定{bindingEditor.kind === 'plan' ? '方案' : 'Review'}会话
                  </span>
                  <button type="button" onClick={() => setBindingEditor(null)} className="text-xs text-cafe-secondary">
                    取消
                  </button>
                </div>
                {bindingEditor.loading ? (
                  <p className="text-xs text-cafe-secondary">正在读取同项目会话…</p>
                ) : bindingEditor.data ? (
                  <div className="space-y-2">
                    <select
                      value={bindingEditor.selectedThreadId}
                      onChange={(event) =>
                        setBindingEditor((current) =>
                          current ? { ...current, selectedThreadId: event.target.value } : current,
                        )
                      }
                      disabled={bindingEditor.data.locked || bindingEditor.saving}
                      className="w-full rounded-lg border border-[var(--console-border)] bg-[var(--console-card-bg)] px-3 py-2 text-xs text-cafe disabled:opacity-60"
                      data-testid={`external-project-binding-select-${item.id}`}
                    >
                      <option value="">自动会话（功能专属）</option>
                      {bindingEditor.data.candidates.map((candidate) => (
                        <option key={candidate.threadId} value={candidate.threadId}>
                          {candidate.title}
                        </option>
                      ))}
                    </select>
                    {bindingEditor.data.locked && (
                      <p className="text-xs text-cafe-secondary">
                        开发闭环正在进行，结束当前流程后才能更换 Review 绑定。
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => void saveBinding()}
                      disabled={bindingEditor.data.locked || bindingEditor.saving}
                      className="rounded-lg bg-[var(--mc-accent)] px-3 py-1.5 text-xs font-medium text-[var(--cafe-surface)] disabled:opacity-50"
                      data-testid={`external-project-binding-save-${item.id}`}
                    >
                      {bindingEditor.saving ? '保存中…' : '保存绑定'}
                    </button>
                  </div>
                ) : null}
                {bindingEditor.error && <p className="mt-2 text-xs text-conn-red-text">{bindingEditor.error}</p>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
