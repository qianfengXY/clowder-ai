'use client';

import type {
  DesktopDevelopmentDeliveryCycleEntryMode,
  DesktopDevelopmentResumePacket,
  ExternalProject,
  FeatureWorkspaceThreadKind,
  FeatureWorkspaceThreadView,
} from '@cat-cafe/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { type Thread, useChatStore } from '@/stores/chatStore';
import { useExternalProjectStore } from '@/stores/externalProjectStore';
import { apiFetch } from '@/utils/api-client';
import { DesktopDevelopmentWorkflowGraph } from './DesktopDevelopmentWorkflowGraph';
import { buildDesktopAcceptanceRequest, buildDesktopConsensusAuthorizationRequest } from './desktop-development-form';
import { type PendingDecisionItem, PendingDecisionQueue } from './PendingDecisionQueue';
import { WorkflowStepper } from './WorkflowStepper';

type DevelopmentLaunchStatus =
  | 'available'
  | 'ready_for_desktop'
  | 'connected_to_desktop'
  | 'managed_by_catcafe'
  | 'rejected'
  | 'completed';

interface ProjectDevelopmentLaunchState {
  readonly backlogItemId: string;
  readonly featureId: string;
  readonly title: string;
  readonly status: DevelopmentLaunchStatus;
  readonly managedWork?: {
    readonly workId: string;
    readonly attemptId: string;
    readonly attemptNumber: number;
    readonly deliveryCycleNumber: number;
    readonly deliveryCycleEntryMode: DesktopDevelopmentDeliveryCycleEntryMode;
    readonly lifecycle: 'active' | 'accepted' | 'rejected';
  };
  readonly deliveryCycleStarted?: boolean;
  readonly desktopBinding?: {
    readonly chatRef?: string;
    readonly bindingEpoch: number;
    readonly status: DesktopDevelopmentResumePacket['sessionStatus'];
  };
  readonly desktopTask?:
    | { readonly status: 'created'; readonly threadId: string }
    | { readonly status: 'failed'; readonly error: string };
}

/** 批次 4 · A6 — 操作反馈带 severity，替代原先无区分的底部单行文本 */
interface PanelNotice {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

function workspaceThreadLabel(kind: FeatureWorkspaceThreadKind): string {
  return kind === 'plan' ? '方案讨论' : 'Review';
}

export function DesktopDevelopmentPanel({ project }: { project: ExternalProject }) {
  const router = useRouter();
  const { projects, setProjects } = useExternalProjectStore();
  const setCurrentProject = useChatStore((state) => state.setCurrentProject);
  const setCurrentThread = useChatStore((state) => state.setCurrentThread);
  const setThreads = useChatStore((state) => state.setThreads);
  const [busy, setBusy] = useState(false);
  const [acceptingWorkId, setAcceptingWorkId] = useState<string | null>(null);
  const [reviewDecisionKey, setReviewDecisionKey] = useState<string | null>(null);
  const [consensusInstructions, setConsensusInstructions] = useState<Record<string, string>>({});
  const [retryingWorkId, setRetryingWorkId] = useState<string | null>(null);
  const [startingDeliveryItemId, setStartingDeliveryItemId] = useState<string | null>(null);
  const [works, setWorks] = useState<readonly DesktopDevelopmentResumePacket[]>([]);
  const [launchStates, setLaunchStates] = useState<readonly ProjectDevelopmentLaunchState[]>([]);
  const [worksLoading, setWorksLoading] = useState(false);
  const [notice, setNotice] = useState<PanelNotice | null>(null);
  const notifySuccess = useCallback((text: string) => setNotice({ kind: 'success', text }), []);
  const notifyError = useCallback((text: string) => setNotice({ kind: 'error', text }), []);
  const [editingReviewCats, setEditingReviewCats] = useState(false);
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  const [reviewRecorderId, setReviewRecorderId] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const binding = project.desktopDevelopment;
  const { cats } = useCatData();
  const catNames = useMemo(() => new Map(cats.map((cat) => [cat.id, cat.displayName])), [cats]);
  const configurableReviewCats = useMemo(
    () => cats.filter((cat) => cat.roster?.available !== false || reviewerIds.includes(cat.id)),
    [cats, reviewerIds],
  );
  const missingReviewerIds = useMemo(
    () => reviewerIds.filter((reviewerId) => !catNames.has(reviewerId)),
    [catNames, reviewerIds],
  );

  useEffect(() => {
    if (!binding) return;
    setReviewerIds([...binding.defaultReviewers]);
    setReviewRecorderId(binding.defaultReviewRecorder ?? binding.defaultReviewers[0] ?? '');
  }, [binding]);

  const loadWorks = useCallback(async () => {
    if (!project.desktopDevelopment) {
      setWorks([]);
      setLaunchStates([]);
      return;
    }
    setWorksLoading(true);
    try {
      const protocolVersion = project.desktopDevelopment.protocolVersion;
      const [worksResponse, statesResponse] = await Promise.all([
        apiFetch(`/api/external-projects/${project.id}/development-loop/works?protocolVersion=${protocolVersion}`),
        apiFetch(
          `/api/external-projects/${project.id}/development-loop/launch-states?protocolVersion=${protocolVersion}`,
        ),
      ]);
      const worksBody = (await worksResponse.json()) as {
        works?: DesktopDevelopmentResumePacket[];
        error?: string;
      };
      const statesBody = (await statesResponse.json()) as {
        states?: ProjectDevelopmentLaunchState[];
        error?: string;
      };
      if (!worksResponse.ok || !worksBody.works) throw new Error(worksBody.error ?? '无法读取开发轮次');
      if (!statesResponse.ok || !statesBody.states) throw new Error(statesBody.error ?? '无法读取功能绑定');
      setWorks(worksBody.works);
      setLaunchStates(statesBody.states);
    } catch (error) {
      setWorks([]);
      setLaunchStates([]);
      notifyError(error instanceof Error ? error.message : '无法读取开发轮次');
    } finally {
      setWorksLoading(false);
    }
  }, [notifyError, project.desktopDevelopment, project.id]);

  useEffect(() => {
    setNotice(null);
    void loadWorks();
  }, [loadWorks]);

  const openFeatureThread = useCallback(
    async (backlogItemId: string, kind: FeatureWorkspaceThreadKind) => {
      const label = workspaceThreadLabel(kind);
      try {
        const response = await apiFetch(
          `/api/external-projects/${encodeURIComponent(project.id)}/development-loop/features/${encodeURIComponent(backlogItemId)}/threads/${kind}`,
          { method: 'POST' },
        );
        const body = (await response.json()) as { thread?: FeatureWorkspaceThreadView; error?: string };
        if (!response.ok || !body.thread) throw new Error(body.error ?? `无法打开${label}会话`);
        const threadResponse = await apiFetch('/api/threads');
        if (threadResponse.ok) {
          const threadBody = (await threadResponse.json()) as { threads?: Thread[] };
          if (threadBody.threads) setThreads(threadBody.threads);
        }
        setCurrentProject(project.sourcePath);
        setCurrentThread(body.thread.threadId);
        router.push(`/thread/${encodeURIComponent(body.thread.threadId)}`);
      } catch (error) {
        notifyError(error instanceof Error ? error.message : `无法打开${label}会话`);
      }
    },
    [notifyError, project.id, project.sourcePath, router, setCurrentProject, setCurrentThread, setThreads],
  );

  const enableAutomaticMerge = async () => {
    if (!binding) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await apiFetch(`/api/external-projects/${project.id}/development-loop`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: binding.version, mergeMode: 'automatic' }),
      });
      const body = (await response.json()) as { project?: ExternalProject; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error ?? '无法启用自动合入');
      setProjects(projects.map((item) => (item.id === body.project?.id ? body.project : item)));
      notifySuccess('此项目已启用自动合入；最终验收仍需你确认');
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '无法启用自动合入');
    } finally {
      setBusy(false);
    }
  };

  const toggleReviewer = (catId: string) => {
    setReviewerIds((current) => {
      const next = current.includes(catId) ? current.filter((id) => id !== catId) : [...current, catId];
      if (!next.includes(reviewRecorderId)) setReviewRecorderId(next[0] ?? '');
      return next;
    });
  };

  const toggleReviewCatEditor = () => {
    if (editingReviewCats && binding) {
      setReviewerIds([...binding.defaultReviewers]);
      setReviewRecorderId(binding.defaultReviewRecorder ?? binding.defaultReviewers[0] ?? '');
    }
    setEditingReviewCats((current) => !current);
  };

  const saveReviewCats = async () => {
    if (!binding) return;
    const uniqueReviewers = [...new Set(reviewerIds)];
    const validationError = validateReviewCatSelection(uniqueReviewers, reviewRecorderId);
    if (validationError) {
      notifyError(validationError);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await apiFetch(`/api/external-projects/${project.id}/development-loop`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: binding.version,
          defaultReviewers: uniqueReviewers,
          defaultReviewRecorder: reviewRecorderId,
        }),
      });
      const body = (await response.json()) as { project?: ExternalProject; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error ?? '无法保存 Review 猫猫配置');
      setProjects(projects.map((item) => (item.id === body.project?.id ? body.project : item)));
      setEditingReviewCats(false);
      notifySuccess('Review 猫猫配置已保存，将从下一轮检视开始生效');
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '无法保存 Review 猫猫配置');
    } finally {
      setBusy(false);
    }
  };

  const recordAcceptance = async (work: DesktopDevelopmentResumePacket, accepted: boolean) => {
    setAcceptingWorkId(work.workId);
    setNotice(null);
    try {
      const response = await apiFetch(
        `/api/external-projects/${project.id}/development-loop/works/${work.workId}/acceptance`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildDesktopAcceptanceRequest(work, accepted)),
        },
      );
      const body = (await response.json()) as DesktopDevelopmentResumePacket & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? '无法记录最终验收');
      setWorks((current) => current.map((item) => (item.workId === body.workId ? body : item)));
      notifySuccess(
        accepted
          ? '最终验收已通过；本轮交付已闭环'
          : '最终验收未通过；证据已保留。可直接点击“从返工入口开启”；如果方案也需调整，请先提交方案分支。',
      );
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '无法记录最终验收');
    } finally {
      setAcceptingWorkId(null);
    }
  };

  const startNextDeliveryCycle = async (launchState: ProjectDevelopmentLaunchState) => {
    if (!binding) return;
    setStartingDeliveryItemId(launchState.backlogItemId);
    setNotice(null);
    try {
      const response = await apiFetch(
        `/api/external-projects/${encodeURIComponent(project.id)}/development-loop/features/${encodeURIComponent(launchState.backlogItemId)}/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ protocolVersion: binding.protocolVersion }),
        },
      );
      const body = (await response.json()) as { state?: ProjectDevelopmentLaunchState; error?: string };
      if (!response.ok || !body.state) throw new Error(body.error ?? '无法开启新交付轮次');
      if (body.state.desktopTask?.status === 'failed') {
        notifyError(`新交付轮次已开启，但唤醒 Desktop 失败：${body.state.desktopTask.error}`);
      } else {
        notifySuccess(
          `${launchState.featureId} 已开启新交付轮次；历史证据保留，原 ChatGPT Desktop 窗口已收到继续任务。`,
        );
      }
      await loadWorks();
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '无法开启新交付轮次');
    } finally {
      setStartingDeliveryItemId(null);
    }
  };

  const approveReviewContinuation = async (work: DesktopDevelopmentResumePacket) => {
    setReviewDecisionKey(`${work.workId}:continue`);
    setNotice(null);
    try {
      const response = await apiFetch(
        `/api/external-projects/${project.id}/development-loop/works/${work.workId}/review-continuation`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            protocolVersion: work.protocolVersion,
            attemptId: work.attemptId,
            expectedManagedWorkVersion: work.managedWorkVersion,
            idempotencyKey: `review-continuation-${work.attemptId}`,
          }),
        },
      );
      const body = (await response.json()) as DesktopDevelopmentResumePacket & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? '无法批准继续 Review');
      setWorks((current) => current.map((item) => (item.workId === body.workId ? body : item)));
      notifySuccess(`已批准继续 Review，新的上限为 Attempt #${body.reviewContinuationApprovedThroughAttempt}`);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '无法批准继续 Review');
    } finally {
      setReviewDecisionKey(null);
    }
  };

  const recordArchitectureDecision = async (
    work: DesktopDevelopmentResumePacket,
    findingId: string,
    decision: 'keep_original_plan' | 'approve_plan_change',
  ) => {
    setReviewDecisionKey(`${work.workId}:${findingId}`);
    setNotice(null);
    try {
      const response = await apiFetch(
        `/api/external-projects/${project.id}/development-loop/works/${work.workId}/architecture-decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            protocolVersion: work.protocolVersion,
            attemptId: work.attemptId,
            expectedManagedWorkVersion: work.managedWorkVersion,
            findingId,
            decision,
            idempotencyKey: `architecture-decision-${work.attemptId}-${findingId}`,
          }),
        },
      );
      const body = (await response.json()) as DesktopDevelopmentResumePacket & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? '无法记录架构决策');
      setWorks((current) => current.map((item) => (item.workId === body.workId ? body : item)));
      notifySuccess(decision === 'keep_original_plan' ? '已决定保持当前方案分支版本' : '已确认方案分支已更新');
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '无法记录架构决策');
    } finally {
      setReviewDecisionKey(null);
    }
  };

  const retryCurrentStage = async (work: DesktopDevelopmentResumePacket) => {
    setRetryingWorkId(work.workId);
    setNotice(null);
    try {
      const response = await apiFetch(
        `/api/external-projects/${project.id}/development-loop/works/${work.workId}/retry-current-stage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            protocolVersion: work.protocolVersion,
            attemptId: work.attemptId,
            expectedManagedWorkVersion: work.managedWorkVersion,
            idempotencyKey: `manual-stage-retry-${work.attemptId}-${Date.now()}`,
          }),
        },
      );
      const body = (await response.json()) as {
        work?: DesktopDevelopmentResumePacket;
        action?: 'wake_desktop' | 'replay_review_stage';
        target?: string;
        error?: string;
      };
      if (!response.ok || !body.work) throw new Error(body.error ?? '无法再次触发当前节点');
      setWorks((current) => current.map((item) => (item.workId === body.work?.workId ? body.work : item)));
      notifySuccess(
        `已登记并再次触发当前节点（目标：${body.target ?? '当前负责人'}）。节点变为“已完成”才表示服务端确认进入下一步。`,
      );
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '无法再次触发当前节点');
    } finally {
      setRetryingWorkId(null);
    }
  };

  const authorizeReviewConsensus = async (work: DesktopDevelopmentResumePacket) => {
    const instruction = consensusInstructions[work.workId] ?? '';
    setReviewDecisionKey(`${work.workId}:consensus`);
    setNotice(null);
    try {
      const response = await apiFetch(
        `/api/external-projects/${project.id}/development-loop/works/${work.workId}/consensus-authorization`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildDesktopConsensusAuthorizationRequest(work, instruction)),
        },
      );
      const body = (await response.json()) as DesktopDevelopmentResumePacket & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? '无法授权提交最终检视意见');
      setWorks((current) => current.map((item) => (item.workId === body.workId ? body : item)));
      setConsensusInstructions((current) => ({ ...current, [work.workId]: '' }));
      notifySuccess('已授权共识记录猫按你的裁决提交最终检视意见');
    } catch (error) {
      notifyError(error instanceof Error ? error.message : '无法授权提交最终检视意见');
    } finally {
      setReviewDecisionKey(null);
    }
  };

  const worksById = useMemo(() => new Map(works.map((work) => [work.workId, work])), [works]);

  /** 批次 3 — 聚合四类必须用户拍板的事项，置顶为"待你处理"队列 */
  const pendingDecisions = useMemo<PendingDecisionItem[]>(() => {
    const result: PendingDecisionItem[] = [];
    for (const launchState of launchStates) {
      const candidate = launchState.managedWork ? worksById.get(launchState.managedWork.workId) : undefined;
      const work = candidate?.attemptId === launchState.managedWork?.attemptId ? candidate : undefined;
      if (!work) continue;
      const base = {
        backlogItemId: launchState.backlogItemId,
        featureId: launchState.featureId,
        title: launchState.title,
        work,
      };
      if (work.acceptancePending) result.push({ ...base, kind: 'acceptance' });
      if (work.architectureDecisionPending) result.push({ ...base, kind: 'architecture' });
      if (work.reviewContinuationPending) result.push({ ...base, kind: 'continuation' });
      if (work.reviewPhase === 'consensus_ready' && !work.consensusAuthorization) {
        result.push({ ...base, kind: 'consensus' });
      }
    }
    return result;
  }, [launchStates, worksById]);

  /** 批次 4 — 功能卡片默认折叠；队列跳转时先展开再滚动定位 */
  const [expandedFeatures, setExpandedFeatures] = useState<ReadonlySet<string>>(new Set());

  const toggleFeature = useCallback((backlogItemId: string) => {
    setExpandedFeatures((current) => {
      const next = new Set(current);
      if (next.has(backlogItemId)) {
        next.delete(backlogItemId);
      } else {
        next.add(backlogItemId);
      }
      return next;
    });
  }, []);

  const jumpToFeature = useCallback((backlogItemId: string) => {
    setExpandedFeatures((current) => {
      if (current.has(backlogItemId)) return current;
      const next = new Set(current);
      next.add(backlogItemId);
      return next;
    });
    window.setTimeout(() => {
      document
        .getElementById(`dev-loop-feature-${backlogItemId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
  }, []);

  if (!binding) {
    return (
      <section className="rounded-xl bg-[var(--console-card-bg)] p-5">
        <h3 className="text-sm font-semibold text-cafe">ChatGPT Desktop 开发闭环</h3>
        <p className="mt-2 text-xs leading-relaxed text-cafe-secondary">
          此项目尚未绑定开发闭环。重新导入或通过项目配置绑定 GitHub 仓库后，才能为每个功能创建方案与 Review 会话。
        </p>
      </section>
    );
  }

  const pilotCount = binding.successfulManualPilotCount;
  return (
    <section className="space-y-4 rounded-xl bg-[var(--console-card-bg)] p-3 sm:p-5">
      {/* 批次 2 — 绑定摘要条：默认一行摘要，完整绑定信息与配置折叠到"绑定与设置" */}
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-cafe">ChatGPT Desktop 开发闭环</h3>
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-cafe-secondary">
              <span className="break-all font-medium text-cafe">{binding.repository.fullName}</span>
              <span aria-hidden="true">·</span>
              <span>{binding.defaultBranch}</span>
              <span aria-hidden="true">·</span>
              <span>{binding.mergeMode === 'automatic' ? '自动合入' : '人工确认合入'}</span>
              <span aria-hidden="true">·</span>
              <span>
                Review：{binding.defaultReviewers.map((reviewer) => catNames.get(reviewer) ?? reviewer).join('、')}
              </span>
            </p>
          </div>
          <button
            type="button"
            aria-expanded={showSettings}
            onClick={() => setShowSettings((value) => !value)}
            className="console-button-secondary shrink-0"
            data-testid="desktop-binding-settings-toggle"
          >
            {showSettings ? '收起设置' : '绑定与设置'}
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="space-y-4 rounded-lg bg-[var(--console-shell-bg)] p-3">
          <p className="text-xs text-cafe-secondary">每个功能使用独立的方案与 Review 会话，互不混淆。</p>

          <dl className="console-data-grid">
            <Info label="Cat Café 项目 ID" value={project.id} />
            <Info label="GitHub 仓库" value={binding.repository.fullName} />
            <Info label="默认分支" value={binding.defaultBranch} />
            <Info label="合入方式" value={binding.mergeMode === 'automatic' ? '自动合入' : 'ChatGPT 会话中人工确认'} />
            <Info label="人工试点" value={`${pilotCount}/2 次成功`} />
            <Info
              label="Push / PR"
              value={`${binding.allowPush ? '允许' : '禁止'} / ${binding.allowPullRequest ? '允许' : '禁止'}`}
            />
            <Info label="协议" value={`v${binding.protocolVersion} · policy ${binding.version}`} />
          </dl>

          <div>
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-semibold text-cafe">默认 Review 猫猫</div>
              <button
                type="button"
                onClick={toggleReviewCatEditor}
                disabled={busy}
                className="console-button-secondary disabled:opacity-40"
              >
                {editingReviewCats ? '取消配置' : '配置'}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {binding.defaultReviewers.map((reviewer) => (
                <span key={reviewer} className="rounded-full bg-[var(--console-hover-bg)] px-3 py-1 text-xs text-cafe">
                  {catNames.get(reviewer) ?? reviewer}
                </span>
              ))}
            </div>
            <p className="mt-2 text-xs text-cafe-secondary">
              达成共识后，由{' '}
              <span className="font-medium text-cafe">
                {catNames.get(binding.defaultReviewRecorder ?? binding.defaultReviewers[0] ?? '') ??
                  binding.defaultReviewRecorder ??
                  binding.defaultReviewers[0]}
              </span>{' '}
              提交最终检视意见。
            </p>
            {editingReviewCats && (
              <div className="mt-3 space-y-3 rounded-lg bg-[var(--console-card-bg)] p-3">
                <fieldset>
                  <legend className="text-xs font-medium text-cafe-secondary">参与 Review（至少两只）</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {configurableReviewCats.map((cat) => {
                      const selected = reviewerIds.includes(cat.id);
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => toggleReviewer(cat.id)}
                          className={`rounded-full px-3 py-1 text-xs font-medium ${
                            selected
                              ? 'bg-[var(--mc-accent)] text-[var(--cafe-surface)]'
                              : 'bg-[var(--console-hover-bg)] text-cafe-secondary'
                          }`}
                        >
                          {cat.displayName}
                          {cat.roster?.available === false ? '（当前不可用）' : ''}
                        </button>
                      );
                    })}
                    {missingReviewerIds.map((reviewerId) => (
                      <button
                        key={reviewerId}
                        type="button"
                        aria-pressed="true"
                        onClick={() => toggleReviewer(reviewerId)}
                        className="rounded-full bg-[var(--mc-accent)] px-3 py-1 text-xs font-medium text-[var(--cafe-surface)]"
                      >
                        {reviewerId}（当前不可用）
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label className="block">
                  <span className="text-xs font-medium text-cafe-secondary">默认提交检视意见猫猫</span>
                  <select
                    value={reviewRecorderId}
                    onChange={(event) => setReviewRecorderId(event.target.value)}
                    className="mt-1 w-full rounded-lg border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2 text-sm text-cafe focus:outline-none focus:ring-1 focus:ring-cafe-accent"
                  >
                    {reviewerIds.map((reviewerId) => (
                      <option key={reviewerId} value={reviewerId}>
                        {catNames.get(reviewerId) ?? reviewerId}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-micro text-cafe-secondary">
                    这只猫猫也必须参与 Review，才能依据完整讨论提交共识。
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => void saveReviewCats()}
                  disabled={busy || reviewerIds.length < 2 || !reviewerIds.includes(reviewRecorderId)}
                  className="console-button-primary disabled:opacity-40"
                >
                  {busy ? '保存中...' : '保存 Review 配置'}
                </button>
              </div>
            )}
          </div>

          {pilotCount >= 2 && binding.mergeMode === 'manual_confirm_in_chatgpt' && (
            <button
              type="button"
              onClick={() => void enableAutomaticMerge()}
              disabled={busy}
              className="console-button-secondary disabled:opacity-40"
            >
              为此项目启用自动合入
            </button>
          )}
        </div>
      )}

      {!worksLoading && (
        <PendingDecisionQueue
          items={pendingDecisions}
          acceptingWorkId={acceptingWorkId}
          decisionBusy={reviewDecisionKey !== null}
          onAccept={(work, accepted) => void recordAcceptance(work, accepted)}
          onApproveContinuation={(work) => void approveReviewContinuation(work)}
          onJump={jumpToFeature}
        />
      )}

      {notice && <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-semibold text-cafe">开发与验收轮次</div>
          <button
            type="button"
            onClick={() => void loadWorks()}
            disabled={worksLoading}
            className="console-button-secondary disabled:opacity-40"
          >
            {worksLoading ? '刷新中...' : '刷新状态'}
          </button>
        </div>
        <p className="text-micro leading-relaxed text-cafe-secondary">
          每个功能独立对应一个 ChatGPT Desktop 窗口；“已完成”只以你在本页做出的最终验收为准。
        </p>
        {!worksLoading && launchStates.length === 0 && (
          <p className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-3 text-xs text-cafe-secondary">
            此项目尚无可展示的功能。请先在“功能列表”导入 Backlog。
          </p>
        )}
        {launchStates.map((launchState) => {
          const candidateWork = launchState.managedWork ? worksById.get(launchState.managedWork.workId) : undefined;
          const work = candidateWork?.attemptId === launchState.managedWork?.attemptId ? candidateWork : undefined;
          const windowRef =
            launchState.desktopBinding?.chatRef ??
            (launchState.desktopTask?.status === 'created' ? launchState.desktopTask.threadId : undefined);
          const expanded = expandedFeatures.has(launchState.backlogItemId);
          const needsAction = Boolean(
            work &&
              (work.acceptancePending ||
                work.architectureDecisionPending ||
                work.reviewContinuationPending ||
                (work.reviewPhase === 'consensus_ready' && !work.consensusAuthorization)),
          );
          return (
            <article
              key={launchState.backlogItemId}
              id={`dev-loop-feature-${launchState.backlogItemId}`}
              className="rounded-lg bg-[var(--console-shell-bg)] px-2 py-2 sm:px-3"
            >
              {/* 批次 4 — 折叠行头部：标题 + 状态 + Stepper 概览，点击展开完整详情 */}
              <button
                type="button"
                onClick={() => toggleFeature(launchState.backlogItemId)}
                aria-expanded={expanded}
                className="block w-full rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mc-accent)]"
                data-testid={`desktop-feature-toggle-${launchState.backlogItemId}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-cafe">
                      {launchState.featureId} · {featureDisplayTitle(launchState.featureId, launchState.title)}
                    </div>
                    <div className="mt-1 text-micro text-cafe-secondary">
                      {describeLaunchStatus(launchState.status)}
                      {work ? ` · 交付 #${work.deliveryCycleNumber} · 实现 #${work.attemptNumber}` : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {needsAction && (
                      <span className="rounded-full bg-[var(--semantic-warning-surface)] px-2 py-0.5 text-micro font-semibold text-[var(--semantic-warning)]">
                        需处理
                      </span>
                    )}
                    {launchState.desktopBinding?.status === 'detached' && (
                      <span className="rounded-full bg-[var(--console-hover-bg)] px-2 py-0.5 text-micro text-cafe-secondary">
                        等待重绑
                      </span>
                    )}
                    <span
                      className={`text-sm text-cafe-secondary transition-transform ${expanded ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    >
                      ▾
                    </span>
                  </div>
                </div>
                {work && (
                  <div className="mt-2">
                    <WorkflowStepper work={work} />
                  </div>
                )}
              </button>
              {expanded && (
                <div className="mt-1 space-y-1">
                  <div
                    className="mt-2 rounded-lg bg-[var(--console-card-bg)] px-3 py-2"
                    data-testid={`desktop-window-binding-${launchState.backlogItemId}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-micro text-cafe-secondary">绑定的 ChatGPT Desktop 窗口</span>
                      <span className="rounded-full bg-[var(--console-hover-bg)] px-2 py-1 text-micro text-cafe-secondary">
                        {launchState.desktopBinding
                          ? `${describeSessionStatus(launchState.desktopBinding.status)} · 绑定代次 ${launchState.desktopBinding.bindingEpoch}`
                          : launchState.desktopTask?.status === 'created'
                            ? '窗口已创建 · 等待绑定'
                            : '未绑定'}
                      </span>
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-cafe" title={windowRef}>
                      {windowRef ?? '启动该功能后，将创建或绑定它自己的 Desktop 窗口'}
                    </div>
                  </div>
                  {work && (
                    <div className="mt-2 space-y-1 text-micro text-cafe-secondary">
                      <div>
                        交付 #{work.deliveryCycleNumber} · 实现 #{work.attemptNumber}：{work.branch} ·{' '}
                        {work.currentSha.slice(0, 12)} · {describeWorkState(work)}
                      </div>
                      <div>
                        方案：
                        {work.designBranch && work.designExactSha
                          ? `${work.designBranch}@${work.designExactSha.slice(0, 12)}`
                          : '未配置（请到功能列表绑定项目共用方案分支）'}
                        {work.reviewDesignExactSha && work.reviewDesignExactSha !== work.designExactSha
                          ? ` · 本轮 Review 基于 ${work.reviewDesignExactSha.slice(0, 12)}`
                          : ''}
                      </div>
                      <div>
                        设计文档：{work.designDocuments.length > 0 ? work.designDocuments.join('、') : '未指定'}
                      </div>
                    </div>
                  )}
                  {work && (
                    <DesktopDevelopmentWorkflowGraph
                      work={work}
                      retrying={retryingWorkId === work.workId}
                      onRetry={() => void retryCurrentStage(work)}
                      onOpenPlan={() => void openFeatureThread(launchState.backlogItemId, 'plan')}
                      onOpenReview={() => void openFeatureThread(launchState.backlogItemId, 'review')}
                      defaultCollapsed={false}
                    />
                  )}
                  {work && work.openFindings.length > 0 && (
                    <p className="mt-2 text-xs text-cafe-secondary">待修复 findings：{work.openFindings.length}</p>
                  )}
                  {work?.architectureDecisionPending && (
                    <div className="mt-3 space-y-2 rounded-lg bg-[var(--console-card-bg)] p-3">
                      <p className="text-xs font-medium text-cafe">Review 与方案分支出现重大分歧，需要你的决策</p>
                      {work.openFindings
                        .filter(
                          (finding) =>
                            finding.scope === 'architecture_decision' && !finding.architectureDecisionRecorded,
                        )
                        .map((finding) => (
                          <div
                            key={finding.findingId}
                            className="space-y-2 border-t border-[var(--console-hover-bg)] pt-2"
                          >
                            <p className="text-xs text-cafe-secondary">
                              {finding.severity} · {finding.summary}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  void recordArchitectureDecision(work, finding.findingId, 'keep_original_plan')
                                }
                                disabled={reviewDecisionKey !== null}
                                className="console-button-secondary disabled:opacity-40"
                              >
                                保持当前方案分支
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void recordArchitectureDecision(work, finding.findingId, 'approve_plan_change')
                                }
                                disabled={reviewDecisionKey !== null}
                                className="console-button-primary disabled:opacity-40"
                              >
                                方案分支已更新，继续
                              </button>
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                  {work?.reviewContinuationPending && (
                    <div className="mt-3 rounded-lg bg-[var(--console-card-bg)] p-3">
                      <p className="text-xs text-cafe-secondary">
                        已达到本组 {work.reviewAttemptLimit} 次 Review 上限。只有你批准后，才会继续下一组 Review。
                      </p>
                      <button
                        type="button"
                        onClick={() => void approveReviewContinuation(work)}
                        disabled={reviewDecisionKey !== null}
                        className="console-button-primary mt-2 disabled:opacity-40"
                      >
                        批准继续 Review
                      </button>
                    </div>
                  )}
                  {work?.reviewPhase === 'consensus_ready' && (
                    <div className="mt-3 space-y-2 rounded-lg bg-[var(--console-card-bg)] p-3">
                      <p className="text-xs font-medium text-cafe">Review 共识需要时可由你裁决</p>
                      {work.consensusAuthorization ? (
                        <>
                          <p className="text-xs text-cafe-secondary">
                            你已介入并授权，当前正在等待原共识记录猫提交最终检视意见；不会新增 reviewer。
                          </p>
                          <div className="whitespace-pre-wrap rounded-lg bg-[var(--console-shell-bg)] px-3 py-2 text-xs text-cafe">
                            {work.consensusAuthorization.instruction}
                          </div>
                        </>
                      ) : (
                        <>
                          <p className="text-xs leading-relaxed text-cafe-secondary">
                            仅在现有 reviewer 无法形成共识时使用。你的意见将成为本轮最终裁决，并绑定当前 Review Round
                            与精确提交；不会绕过后续合入确认和最终验收。
                          </p>
                          <label className="block">
                            <span className="text-micro font-medium text-cafe-secondary">你的最终裁决意见</span>
                            <textarea
                              value={consensusInstructions[work.workId] ?? ''}
                              onChange={(event) =>
                                setConsensusInstructions((current) => ({
                                  ...current,
                                  [work.workId]: event.target.value,
                                }))
                              }
                              maxLength={2000}
                              rows={4}
                              placeholder="例如：采纳 GPT 的第 2–5 项；驳回 Kimi 的第 1 项，理由是……"
                              className="mt-1 w-full resize-y rounded-lg border-transparent bg-[var(--console-field-bg,var(--console-shell-bg))] px-3 py-2 text-xs text-cafe focus:outline-none focus:ring-1 focus:ring-cafe-accent"
                            />
                          </label>
                          <button
                            type="button"
                            onClick={() => void authorizeReviewConsensus(work)}
                            disabled={reviewDecisionKey !== null || !(consensusInstructions[work.workId] ?? '').trim()}
                            className="console-button-primary disabled:opacity-40"
                          >
                            授权记录猫按此提交
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {work?.acceptancePending && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void recordAcceptance(work, true)}
                        disabled={acceptingWorkId === work.workId}
                        className="console-button-primary disabled:opacity-40"
                      >
                        验收通过
                      </button>
                      <button
                        type="button"
                        onClick={() => void recordAcceptance(work, false)}
                        disabled={acceptingWorkId === work.workId}
                        className="console-button-secondary disabled:opacity-40"
                      >
                        验收未通过
                      </button>
                    </div>
                  )}
                  {(launchState.status === 'rejected' || launchState.status === 'completed') && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void startNextDeliveryCycle(launchState)}
                        disabled={startingDeliveryItemId === launchState.backlogItemId}
                        className="console-button-primary disabled:opacity-40"
                        data-testid={`desktop-next-delivery-${launchState.backlogItemId}`}
                      >
                        {startingDeliveryItemId === launchState.backlogItemId
                          ? '开启中...'
                          : launchState.status === 'rejected'
                            ? '从返工入口开启'
                            : '从方案变更入口开启'}
                      </button>
                      <span className="text-micro text-cafe-secondary">
                        复用本功能的方案、Review 与 Desktop 窗口；上一轮证据不会被覆盖。
                      </span>
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function NoticeBanner({ notice, onDismiss }: { notice: PanelNotice; onDismiss: () => void }) {
  const toneClass =
    notice.kind === 'error'
      ? 'bg-[var(--semantic-critical-surface)] text-[var(--semantic-error-text)]'
      : 'bg-[var(--semantic-success-surface)] text-[var(--semantic-success-text)]';
  return (
    <div
      role={notice.kind === 'error' ? 'alert' : 'status'}
      className={`flex items-start justify-between gap-3 rounded-lg px-3 py-2 text-xs ${toneClass}`}
      data-testid={`desktop-dev-notice-${notice.kind}`}
    >
      <span className="min-w-0 leading-relaxed">{notice.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭提示"
        className="shrink-0 font-semibold opacity-70 hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}

function validateReviewCatSelection(reviewers: readonly string[], recorderId: string): string | null {
  if (reviewers.length < 2) return '请至少选择两只不同的 Review 猫猫';
  if (!reviewers.includes(recorderId)) return '提交检视意见猫猫必须是参与本轮 Review 的猫猫';
  return null;
}

function describeWorkState(work: DesktopDevelopmentResumePacket): string {
  switch (work.phase) {
    case 'accepted':
      return '已验收';
    case 'rejected':
      return '验收未通过';
    case 'acceptance_pending':
      return '等待最终验收';
    case 'approved_for_merge':
      return 'Review 已通过';
    case 'awaiting_manual_merge_confirmation':
      return '等待合入确认';
    case 'auto_merge_ready':
      return '可以合入';
    case 'fix_required':
      return '等待修复';
    case 'awaiting_review_continuation':
      return '已达 15 轮上限，等待你批准继续';
    case 'awaiting_architecture_decision':
      return '方案分歧，等待你处理';
    case 'awaiting_design_branch':
      return '等待配置已提交的方案分支';
    case 'cross_review':
      return work.reviewPhase === 'consensus_ready'
        ? work.consensusAuthorization
          ? '已授权，等待共识提交'
          : '等待共识，可由你裁决'
        : '交叉检视中';
    case 'independent_review':
      return '独立检视中';
    case 'ready_for_desktop':
      return '等待 Desktop 恢复';
    case 'implementation_ready':
      return '等待提交 Review';
    case 'implementing':
      return '实现中';
  }
}

function describeSessionStatus(status: DesktopDevelopmentResumePacket['sessionStatus']): string {
  switch (status) {
    case 'active':
      return '已绑定';
    case 'detached':
      return '等待重绑';
    case 'superseded':
      return '已被替代';
  }
}

function describeLaunchStatus(status: DevelopmentLaunchStatus): string {
  switch (status) {
    case 'available':
      return '尚未启动';
    case 'ready_for_desktop':
      return '已启动，等待 Desktop 连接';
    case 'connected_to_desktop':
      return 'Desktop 开发中';
    case 'managed_by_catcafe':
      return 'CatCafe 流程处理中';
    case 'rejected':
      return '验收未通过';
    case 'completed':
      return '已由你验收完成';
  }
}

function featureDisplayTitle(featureId: string, title: string): string {
  const escapedFeatureId = featureId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title
    .replace(new RegExp(`^\\[${escapedFeatureId}\\]\\s*`, 'i'), '')
    .replace(new RegExp(`^${escapedFeatureId}\\s*[-—:：·]?\\s*`, 'i'), '')
    .trim();
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="console-data-tile">
      <dt className="console-data-tile-label">{label}</dt>
      <dd className="console-data-tile-value break-words">{value}</dd>
    </div>
  );
}
