'use client';

import type { BacklogItem, ExternalProject } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
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

function ExternalProjectFeatureRow({
  item,
  status,
  error,
  desktopBound,
  onStart,
}: {
  item: BacklogItem;
  status: LaunchStatus;
  error?: string;
  desktopBound: boolean;
  onStart: (item: BacklogItem) => void;
}) {
  const featureId = featureIdFromItem(item);
  const unavailable = !desktopBound || !featureId;
  const disabled = unavailable || !['available', 'error'].includes(status);

  return (
    <div className="rounded-xl bg-[var(--console-card-bg)] px-4 py-3 shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="rounded bg-[var(--console-hover-bg)] px-2 py-0.5 text-micro font-bold text-cafe-secondary">
            {featureId ?? '—'}
          </span>
          <span className="min-w-0 text-sm font-medium text-cafe">{item.title}</span>
          <span className="rounded-full bg-[var(--console-hover-bg)] px-2 py-0.5 text-micro font-medium text-cafe-secondary">
            {item.status}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onStart(item)}
          disabled={disabled}
          className="shrink-0 rounded-lg bg-[var(--mc-accent)] px-3 py-1.5 text-xs font-medium text-[var(--cafe-surface)] disabled:bg-[var(--console-hover-bg)] disabled:text-cafe-secondary disabled:opacity-70"
          data-testid={`external-project-start-${item.id}`}
        >
          {launchButtonLabel(status, desktopBound, featureId)}
        </button>
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
  const [launchStatuses, setLaunchStatuses] = useState<Record<string, LaunchStatus>>({});
  const [launchErrors, setLaunchErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [launchRefreshKey, setLaunchRefreshKey] = useState(0);
  const startingItemsRef = useRef(new Set<string>());

  useEffect(() => setNotice(null), [project.id]);

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
      setLaunchStatuses((current) => ({ ...current, [item.id]: body.state.status }));
      setLaunchRefreshKey((current) => current + 1);
      if (body.state.status === 'ready_for_desktop' || body.state.status === 'connected_to_desktop') {
        setNotice(
          `${featureId} 已进入 Desktop 开发闭环。请在 ChatGPT Desktop 新建或继续一个任务，并输入“连接 ${project.name} ${featureId}”。`,
        );
      } else if (body.state.status === 'managed_by_catcafe') {
        setLaunchErrors((current) => ({ ...current, [item.id]: '该功能已有 CatCafe 执行流程，未改写现有 SOP' }));
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
        从这里启动的功能只属于「{project.name}」。启动后，在 ChatGPT Desktop 新建或继续一个任务并连接该功能； CatCafe
        会保留工作状态和 Review Hub，但不会自动创建 Desktop 窗口。
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
          <ExternalProjectFeatureRow
            key={item.id}
            item={item}
            status={launchStatuses[item.id] ?? 'checking'}
            error={launchErrors[item.id]}
            desktopBound={Boolean(project.desktopDevelopment)}
            onStart={(selected) => void startDevelopment(selected)}
          />
        ))}
      </div>
    </div>
  );
}
