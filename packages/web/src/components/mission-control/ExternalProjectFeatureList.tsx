'use client';

import type {
  BacklogItem,
  ExternalProject,
  FeatureDesignDocumentsView,
  FeatureWorkspaceThreadCandidatesView,
  FeatureWorkspaceThreadKind,
  FeatureWorkspaceThreadView,
  ProjectDesignAuthorityView,
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
  deliveryCycleStarted?: boolean;
  previousLifecycle?: 'accepted' | 'rejected';
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
  if (status === 'rejected') return '开启修复轮次';
  if (status === 'completed') return '发起补充实现';
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
  designAuthority,
  designDocuments,
  onStart,
  onOpenThread,
  onBindThread,
  onEditDesignDocuments,
}: {
  item: BacklogItem;
  status: LaunchStatus;
  error?: string;
  desktopBound: boolean;
  designAuthority?: ProjectDesignAuthorityView;
  designDocuments?: FeatureDesignDocumentsView;
  onStart: (item: BacklogItem) => void;
  onOpenThread: (item: BacklogItem, kind: FeatureWorkspaceThreadKind) => void;
  onBindThread: (item: BacklogItem, kind: FeatureWorkspaceThreadKind) => void;
  onEditDesignDocuments: (item: BacklogItem) => void;
}) {
  const featureId = featureIdFromItem(item);
  const unavailable = !desktopBound || !featureId;
  const designBranchBlocksLaunch =
    designAuthority?.status !== 'ready' &&
    ['available', 'ready_for_desktop', 'rejected', 'completed', 'error'].includes(status);
  const designDocumentsBlockLaunch =
    designDocuments?.status !== 'ready' &&
    ['available', 'ready_for_desktop', 'rejected', 'completed', 'error'].includes(status);
  const disabled =
    unavailable ||
    designAuthority?.status !== 'ready' ||
    designDocuments?.status !== 'ready' ||
    !['available', 'ready_for_desktop', 'rejected', 'completed', 'error'].includes(status);

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
          <span className="text-micro text-cafe-secondary" data-testid={`external-project-design-ref-${item.id}`}>
            设计文档：
            {designDocuments?.status === 'ready'
              ? designDocuments.documents.join('、')
              : designDocuments?.documents.length
                ? `${designDocuments.documents.length} 份（不可用）`
                : '未配置'}
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
            方案讨论
          </button>
          <button
            type="button"
            onClick={() => onEditDesignDocuments(item)}
            disabled={unavailable}
            className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-1.5 text-xs font-medium text-cafe-secondary disabled:opacity-40"
            data-testid={`external-project-design-documents-${item.id}`}
          >
            设计文档
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
            {desktopBound && featureId && designBranchBlocksLaunch
              ? '先配置方案分支'
              : desktopBound && featureId && designDocumentsBlockLaunch
                ? '先配置设计文档'
                : launchButtonLabel(status, desktopBound, featureId)}
          </button>
        </div>
      </div>
      {error && (
        <p className="mt-2 text-xs text-conn-red-text" role="alert">
          {error}
        </p>
      )}
      {designDocuments?.error && <p className="mt-2 text-xs text-conn-red-text">{designDocuments.error}</p>}
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
  const [designAuthority, setDesignAuthority] = useState<ProjectDesignAuthorityView>();
  const [designDocuments, setDesignDocuments] = useState<Record<string, FeatureDesignDocumentsView>>({});
  const [designEditor, setDesignEditor] = useState<{
    kind: 'branch' | 'documents';
    itemId?: string;
    branch: string;
    documents: string;
    saving: boolean;
    error?: string;
  } | null>(null);
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
    void project.id;
    setNotice(null);
    setBindingEditor(null);
    setDesignEditor(null);
  }, [project.id]);

  useEffect(() => {
    void launchRefreshKey;
    let cancelled = false;
    let shouldLoadDesignAuthority = true;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    setLaunchErrors({});
    setDesignAuthority(undefined);
    setDesignDocuments({});
    setLaunchStatuses(Object.fromEntries(items.map((item) => [item.id, 'checking'])));

    const protocolVersion = project.desktopDevelopment?.protocolVersion;
    if (!protocolVersion) return () => undefined;

    const loadLaunchStates = async () => {
      let shouldPoll = false;
      try {
        const designRequest = shouldLoadDesignAuthority
          ? apiFetch(
              `/api/external-projects/${encodeURIComponent(project.id)}/development-loop/design-authority?protocolVersion=${protocolVersion}`,
            )
          : Promise.resolve(null);
        const [response, designResponse] = await Promise.all([
          apiFetch(
            `/api/external-projects/${encodeURIComponent(project.id)}/development-loop/launch-states?protocolVersion=${protocolVersion}`,
          ),
          designRequest,
        ]);
        if (!response.ok) throw new Error(`状态读取失败: ${response.status}`);
        if (designResponse && !designResponse.ok) throw new Error(`方案依据读取失败: ${designResponse.status}`);
        const body = (await response.json()) as { states: LaunchState[] };
        const designBody = designResponse
          ? ((await designResponse.json()) as {
              authority: ProjectDesignAuthorityView;
              features: FeatureDesignDocumentsView[];
            })
          : null;
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
        if (designBody) {
          shouldLoadDesignAuthority = false;
          setDesignAuthority(designBody.authority);
          setDesignDocuments(
            Object.fromEntries(designBody.features.map((feature) => [feature.backlogItemId, feature])),
          );
        }
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

  const saveDesignBranch = async () => {
    if (!designEditor || designEditor.kind !== 'branch' || !project.desktopDevelopment) return;
    setDesignEditor((current) => (current ? { ...current, saving: true, error: undefined } : current));
    try {
      const response = await apiFetch(
        `/api/external-projects/${encodeURIComponent(project.id)}/development-loop/design-branch`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            protocolVersion: project.desktopDevelopment.protocolVersion,
            branch: designEditor.branch,
          }),
        },
      );
      const body = (await response.json()) as { designAuthority?: ProjectDesignAuthorityView; error?: string };
      if (!response.ok || !body.designAuthority) throw new Error(body.error ?? '方案分支保存失败');
      const saved = body.designAuthority;
      setDesignAuthority(saved);
      setNotice(`项目已绑定共用方案分支 ${saved.branch}@${saved.exactSha?.slice(0, 12)}。`);
      setDesignEditor(null);
      setLaunchRefreshKey((current) => current + 1);
    } catch (error) {
      setDesignEditor((current) =>
        current
          ? { ...current, saving: false, error: error instanceof Error ? error.message : '方案分支保存失败' }
          : current,
      );
    }
  };

  const saveDesignDocuments = async () => {
    if (!designEditor || designEditor.kind !== 'documents' || !designEditor.itemId || !project.desktopDevelopment) {
      return;
    }
    setDesignEditor((current) => (current ? { ...current, saving: true, error: undefined } : current));
    try {
      const documents = designEditor.documents
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      const response = await apiFetch(
        `/api/external-projects/${encodeURIComponent(project.id)}/development-loop/features/${encodeURIComponent(designEditor.itemId)}/design-documents`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ protocolVersion: project.desktopDevelopment.protocolVersion, documents }),
        },
      );
      const body = (await response.json()) as { designDocuments?: FeatureDesignDocumentsView; error?: string };
      if (!response.ok || !body.designDocuments) throw new Error(body.error ?? '设计文档保存失败');
      const saved = body.designDocuments;
      setDesignDocuments((current) => ({ ...current, [saved.backlogItemId]: saved }));
      setNotice(`${saved.featureId} 已指定 ${saved.documents.length} 份设计文档。`);
      setDesignEditor(null);
      setLaunchRefreshKey((current) => current + 1);
    } catch (error) {
      setDesignEditor((current) =>
        current
          ? { ...current, saving: false, error: error instanceof Error ? error.message : '设计文档保存失败' }
          : current,
      );
    }
  };

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
        setNotice(
          body.state.deliveryCycleStarted
            ? `${featureId} 已开启新的交付轮次，并已唤醒原 ChatGPT Desktop 开发窗口。`
            : `${featureId} 已进入开发闭环，并已在 ChatGPT Desktop 创建对应开发任务。`,
        );
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
        从这里启动的功能只属于「{project.name}」。每个功能都有独立的方案讨论与 Review 会话；启动开发后，CatCafe
        会创建并连接对应的 ChatGPT Desktop 开发任务。项目共用一个已提交方案分支，每个功能从中指定自己的设计文档。
      </div>
      <div className="rounded-xl border border-[var(--console-border)] bg-[var(--console-card-bg)] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-cafe">项目共用方案分支</p>
            <p className="mt-1 text-micro text-cafe-secondary" data-testid="external-project-design-authority-ref">
              {designAuthority?.status === 'ready'
                ? `${designAuthority.branch}@${designAuthority.exactSha?.slice(0, 12)}`
                : designAuthority?.branch
                  ? `${designAuthority.branch}（不可用）`
                  : '未配置'}
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              setDesignEditor({
                kind: 'branch',
                branch: designAuthority?.branch ?? '',
                documents: '',
                saving: false,
              })
            }
            disabled={!project.desktopDevelopment}
            className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-1.5 text-xs font-medium text-cafe-secondary disabled:opacity-40"
            data-testid="external-project-design-branch"
          >
            配置方案分支
          </button>
        </div>
        {designAuthority?.error && <p className="mt-2 text-xs text-conn-red-text">{designAuthority.error}</p>}
      </div>
      {designEditor?.kind === 'branch' && (
        <div className="rounded-xl border border-[var(--console-border)] bg-[var(--console-shell-bg)] px-4 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-semibold text-cafe">绑定项目共用方案分支</span>
            <button type="button" onClick={() => setDesignEditor(null)} className="text-xs text-cafe-secondary">
              取消
            </button>
          </div>
          <p className="mb-2 text-micro text-cafe-secondary">
            只读取本地已提交分支，不切换工作区。所有功能共用这一分支；开发分支仍可共用或各自创建。
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={designEditor.branch}
              onChange={(event) =>
                setDesignEditor((current) => (current ? { ...current, branch: event.target.value } : current))
              }
              placeholder="design/specs"
              disabled={designEditor.saving}
              className="min-w-72 flex-1 rounded-lg border border-[var(--console-border)] bg-[var(--console-card-bg)] px-3 py-2 text-xs text-cafe disabled:opacity-60"
              data-testid="external-project-design-input"
            />
            <button
              type="button"
              onClick={() => void saveDesignBranch()}
              disabled={designEditor.saving || !designEditor.branch.trim()}
              className="rounded-lg bg-[var(--mc-accent)] px-3 py-2 text-xs font-medium text-[var(--cafe-surface)] disabled:opacity-50"
              data-testid="external-project-design-save"
            >
              {designEditor.saving ? '校验中…' : '校验并保存'}
            </button>
          </div>
          {designEditor.error && <p className="mt-2 text-xs text-conn-red-text">{designEditor.error}</p>}
        </div>
      )}
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
              designAuthority={designAuthority}
              designDocuments={designDocuments[item.id]}
              onStart={(selected) => void startDevelopment(selected)}
              onOpenThread={(selected, kind) => void openFeatureThread(selected, kind)}
              onBindThread={(selected, kind) => void openBindingEditor(selected, kind)}
              onEditDesignDocuments={(selected) =>
                setDesignEditor({
                  kind: 'documents',
                  itemId: selected.id,
                  branch: '',
                  documents: designDocuments[selected.id]?.documents.join('\n') ?? '',
                  saving: false,
                })
              }
            />
            {designEditor?.kind === 'documents' && designEditor.itemId === item.id && (
              <div
                className="rounded-xl border border-[var(--console-border)] bg-[var(--console-shell-bg)] px-4 py-3"
                data-testid={`external-project-design-editor-${item.id}`}
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold text-cafe">指定本功能的设计文档</span>
                  <button type="button" onClick={() => setDesignEditor(null)} className="text-xs text-cafe-secondary">
                    取消
                  </button>
                </div>
                <p className="mb-2 text-micro text-cafe-secondary">
                  每行一个仓库相对路径。Review
                  会冻结共用方案分支的精确提交，并只按这些文档检视本功能；若中英文成对，只选择中文权威文档，不要加入英文翻译件。
                </p>
                <div className="flex flex-wrap items-start gap-2">
                  <textarea
                    value={designEditor.documents}
                    onChange={(event) =>
                      setDesignEditor((current) => (current ? { ...current, documents: event.target.value } : current))
                    }
                    placeholder={'docs/design/feature-a.md\ndocs/adr/012-feature-a.md'}
                    disabled={designEditor.saving}
                    rows={3}
                    className="min-w-72 flex-1 rounded-lg border border-[var(--console-border)] bg-[var(--console-card-bg)] px-3 py-2 text-xs text-cafe disabled:opacity-60"
                    data-testid={`external-project-design-input-${item.id}`}
                  />
                  <button
                    type="button"
                    onClick={() => void saveDesignDocuments()}
                    disabled={designEditor.saving || !designEditor.documents.trim()}
                    className="rounded-lg bg-[var(--mc-accent)] px-3 py-2 text-xs font-medium text-[var(--cafe-surface)] disabled:opacity-50"
                    data-testid={`external-project-design-save-${item.id}`}
                  >
                    {designEditor.saving ? '校验中…' : '校验并保存文档'}
                  </button>
                </div>
                {designEditor.error && <p className="mt-2 text-xs text-conn-red-text">{designEditor.error}</p>}
              </div>
            )}
            {bindingEditor?.itemId === item.id && (
              <div
                className="rounded-xl border border-[var(--console-border)] bg-[var(--console-shell-bg)] px-4 py-3"
                data-testid={`external-project-binding-editor-${item.id}`}
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold text-cafe">
                    绑定{bindingEditor.kind === 'plan' ? '方案讨论' : 'Review'}会话
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
