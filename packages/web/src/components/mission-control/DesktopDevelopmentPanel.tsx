'use client';

import type { DesktopDevelopmentResumePacket, DesktopDevelopmentWorkflowNode, ExternalProject } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useExternalProjectStore } from '@/stores/externalProjectStore';
import { apiFetch } from '@/utils/api-client';
import { buildDesktopAcceptanceRequest, buildDesktopConsensusAuthorizationRequest } from './desktop-development-form';

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
    readonly lifecycle: 'active' | 'accepted' | 'rejected';
  };
  readonly desktopBinding?: {
    readonly chatRef?: string;
    readonly bindingEpoch: number;
    readonly status: DesktopDevelopmentResumePacket['sessionStatus'];
  };
  readonly desktopTask?:
    | { readonly status: 'created'; readonly threadId: string }
    | { readonly status: 'failed'; readonly error: string };
}

export function DesktopDevelopmentPanel({ project }: { project: ExternalProject }) {
  const { projects, setProjects } = useExternalProjectStore();
  const [busy, setBusy] = useState(false);
  const [acceptingWorkId, setAcceptingWorkId] = useState<string | null>(null);
  const [reviewDecisionKey, setReviewDecisionKey] = useState<string | null>(null);
  const [consensusInstructions, setConsensusInstructions] = useState<Record<string, string>>({});
  const [retryingWorkId, setRetryingWorkId] = useState<string | null>(null);
  const [works, setWorks] = useState<readonly DesktopDevelopmentResumePacket[]>([]);
  const [launchStates, setLaunchStates] = useState<readonly ProjectDevelopmentLaunchState[]>([]);
  const [worksLoading, setWorksLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [editingReviewCats, setEditingReviewCats] = useState(false);
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  const [reviewRecorderId, setReviewRecorderId] = useState('');
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
      setStatus(error instanceof Error ? error.message : '无法读取开发轮次');
    } finally {
      setWorksLoading(false);
    }
  }, [project.desktopDevelopment, project.id]);

  useEffect(() => {
    setStatus(null);
    void loadWorks();
  }, [loadWorks]);

  const enableAutomaticMerge = async () => {
    if (!binding) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await apiFetch(`/api/external-projects/${project.id}/development-loop`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: binding.version, mergeMode: 'automatic' }),
      });
      const body = (await response.json()) as { project?: ExternalProject; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error ?? '无法启用自动合入');
      setProjects(projects.map((item) => (item.id === body.project?.id ? body.project : item)));
      setStatus('此项目已启用自动合入；最终验收仍需你确认');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法启用自动合入');
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
      setStatus(validationError);
      return;
    }
    setBusy(true);
    setStatus(null);
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
      setStatus('Review 猫猫配置已保存，将从下一轮检视开始生效');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法保存 Review 猫猫配置');
    } finally {
      setBusy(false);
    }
  };

  const recordAcceptance = async (work: DesktopDevelopmentResumePacket, accepted: boolean) => {
    setAcceptingWorkId(work.workId);
    setStatus(null);
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
      setStatus(
        accepted
          ? '最终验收已通过；本轮交付已闭环'
          : '最终验收未通过；证据已保留，请更新并提交方案分支后开启新交付轮次',
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法记录最终验收');
    } finally {
      setAcceptingWorkId(null);
    }
  };

  const approveReviewContinuation = async (work: DesktopDevelopmentResumePacket) => {
    setReviewDecisionKey(`${work.workId}:continue`);
    setStatus(null);
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
      setStatus(`已批准继续 Review，新的上限为 Attempt #${body.reviewContinuationApprovedThroughAttempt}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法批准继续 Review');
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
    setStatus(null);
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
      setStatus(decision === 'keep_original_plan' ? '已决定保持当前方案分支版本' : '已确认方案分支已更新');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法记录架构决策');
    } finally {
      setReviewDecisionKey(null);
    }
  };

  const retryCurrentStage = async (work: DesktopDevelopmentResumePacket) => {
    setRetryingWorkId(work.workId);
    setStatus(null);
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
      setStatus(
        `已登记并再次触发当前节点（目标：${body.target ?? '当前负责人'}）。节点变为“已完成”才表示服务端确认进入下一步。`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法再次触发当前节点');
    } finally {
      setRetryingWorkId(null);
    }
  };

  const authorizeReviewConsensus = async (work: DesktopDevelopmentResumePacket) => {
    const instruction = consensusInstructions[work.workId] ?? '';
    setReviewDecisionKey(`${work.workId}:consensus`);
    setStatus(null);
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
      setStatus('已授权共识记录猫按你的裁决提交最终检视意见');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法授权提交最终检视意见');
    } finally {
      setReviewDecisionKey(null);
    }
  };

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
  const worksById = new Map(works.map((work) => [work.workId, work]));
  return (
    <section className="space-y-4 rounded-xl bg-[var(--console-card-bg)] p-5">
      <div>
        <h3 className="text-sm font-semibold text-cafe">ChatGPT Desktop 开发闭环</h3>
        <p className="mt-1 text-xs text-cafe-secondary">每个功能使用独立的方案与 Review 会话，互不混淆。</p>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
          <div className="text-xs font-medium text-cafe-secondary">默认 Review 猫猫</div>
          <button
            type="button"
            onClick={toggleReviewCatEditor}
            disabled={busy}
            className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-1.5 text-micro font-medium text-cafe-secondary disabled:opacity-40"
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
          <div className="mt-3 space-y-3 rounded-[10px] bg-[var(--console-shell-bg)] p-3">
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
                className="mt-1 w-full rounded-[10px] border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2 text-sm text-cafe focus:outline-none focus:ring-1 focus:ring-cafe-accent"
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
              className="rounded-lg bg-[var(--mc-accent)] px-4 py-2 text-xs font-medium text-[var(--cafe-surface)] disabled:opacity-40"
            >
              {busy ? '保存中...' : '保存 Review 配置'}
            </button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-medium text-cafe-secondary">开发与验收轮次</div>
          <button
            type="button"
            onClick={() => void loadWorks()}
            disabled={worksLoading}
            className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-1.5 text-micro font-medium text-cafe-secondary disabled:opacity-40"
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
          const work = launchState.managedWork ? worksById.get(launchState.managedWork.workId) : undefined;
          const windowRef =
            launchState.desktopBinding?.chatRef ??
            (launchState.desktopTask?.status === 'created' ? launchState.desktopTask.threadId : undefined);
          return (
            <article key={launchState.backlogItemId} className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-medium text-cafe">
                    {launchState.featureId} · {featureDisplayTitle(launchState.featureId, launchState.title)}
                  </div>
                  <div className="mt-1 text-micro text-cafe-secondary">{describeLaunchStatus(launchState.status)}</div>
                </div>
                {launchState.desktopBinding?.status === 'detached' && (
                  <span className="rounded-full bg-[var(--console-hover-bg)] px-2 py-1 text-micro text-cafe-secondary">
                    等待新 ChatGPT 会话重新绑定
                  </span>
                )}
              </div>
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
                    实现：{work.branch} · {work.currentSha.slice(0, 12)} · {describeWorkState(work)}
                  </div>
                  <div>
                    方案：
                    {work.designBranch && work.designExactSha
                      ? `${work.designBranch}@${work.designExactSha.slice(0, 12)}`
                      : '未配置（请到功能列表绑定本地已提交方案分支）'}
                    {work.reviewDesignExactSha && work.reviewDesignExactSha !== work.designExactSha
                      ? ` · 本轮 Review 基于 ${work.reviewDesignExactSha.slice(0, 12)}`
                      : ''}
                  </div>
                </div>
              )}
              {work && (
                <WorkflowChain
                  work={work}
                  retrying={retryingWorkId === work.workId}
                  onRetry={() => void retryCurrentStage(work)}
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
                      (finding) => finding.scope === 'architecture_decision' && !finding.architectureDecisionRecorded,
                    )
                    .map((finding) => (
                      <div key={finding.findingId} className="space-y-2 border-t border-[var(--console-hover-bg)] pt-2">
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
                            className="rounded-lg bg-[var(--console-hover-bg)] px-3 py-2 text-xs font-medium text-cafe-secondary disabled:opacity-40"
                          >
                            保持当前方案分支
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void recordArchitectureDecision(work, finding.findingId, 'approve_plan_change')
                            }
                            disabled={reviewDecisionKey !== null}
                            className="rounded-lg bg-[var(--mc-accent)] px-3 py-2 text-xs font-medium text-[var(--cafe-surface)] disabled:opacity-40"
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
                    className="mt-2 rounded-lg bg-[var(--mc-accent)] px-3 py-2 text-xs font-medium text-[var(--cafe-surface)] disabled:opacity-40"
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
                          className="mt-1 w-full resize-y rounded-[10px] border-transparent bg-[var(--console-field-bg,var(--console-shell-bg))] px-3 py-2 text-xs text-cafe focus:outline-none focus:ring-1 focus:ring-cafe-accent"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => void authorizeReviewConsensus(work)}
                        disabled={reviewDecisionKey !== null || !(consensusInstructions[work.workId] ?? '').trim()}
                        className="rounded-lg bg-[var(--mc-accent)] px-3 py-2 text-xs font-medium text-[var(--cafe-surface)] disabled:opacity-40"
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
                    className="rounded-lg bg-[var(--mc-accent)] px-3 py-2 text-xs font-medium text-[var(--cafe-surface)] disabled:opacity-40"
                  >
                    验收通过
                  </button>
                  <button
                    type="button"
                    onClick={() => void recordAcceptance(work, false)}
                    disabled={acceptingWorkId === work.workId}
                    className="rounded-lg bg-[var(--console-hover-bg)] px-3 py-2 text-xs font-medium text-cafe-secondary disabled:opacity-40"
                  >
                    验收未通过
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        {pilotCount >= 2 && binding.mergeMode === 'manual_confirm_in_chatgpt' && (
          <button
            type="button"
            onClick={() => void enableAutomaticMerge()}
            disabled={busy}
            className="rounded-lg bg-[var(--console-shell-bg)] px-4 py-2 text-xs font-medium text-cafe-secondary disabled:opacity-40"
          >
            为此项目启用自动合入
          </button>
        )}
      </div>
      {status && <p className="text-xs text-cafe-secondary">{status}</p>}
    </section>
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
    <div className="rounded-lg bg-[var(--console-shell-bg)] px-3 py-2">
      <dt className="text-micro text-cafe-secondary">{label}</dt>
      <dd className="mt-1 break-words text-xs font-medium text-cafe">{value}</dd>
    </div>
  );
}

function WorkflowChain({
  work,
  retrying,
  onRetry,
}: {
  work: DesktopDevelopmentResumePacket;
  retrying: boolean;
  onRetry: () => void;
}) {
  const nodes = work.workflowNodes ?? [];
  if (nodes.length === 0) return null;
  const current = nodes.find((node) => node.status === 'blocked') ?? nodes.find((node) => node.status === 'active');
  const retryable = current?.manualAction === 'wake_desktop' || current?.manualAction === 'replay_review_stage';
  return (
    <div className="mt-3 rounded-lg bg-[var(--console-card-bg)] p-3" data-testid={`workflow-chain-${work.workId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-cafe">完整开发链路 · Attempt #{work.attemptNumber}</div>
          <div className="mt-1 text-micro text-cafe-secondary">
            {current
              ? `当前停在：${workflowNodeLabel(current.id)} · 等待${workflowActorLabel(current.actor)}`
              : '本轮链路已结束'}
          </div>
        </div>
        {retryable && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="rounded-lg bg-[var(--mc-accent)] px-3 py-2 text-xs font-medium text-[var(--cafe-surface)] disabled:opacity-40"
          >
            {retrying ? '触发中...' : workflowActionLabel(current.manualAction)}
          </button>
        )}
      </div>
      <ol className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {nodes.map((node, index) => (
          <li
            key={node.id}
            className={`rounded-lg border px-3 py-2 ${workflowNodeClass(node.status)}`}
            data-testid={`workflow-node-${work.workId}-${node.id}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-cafe">
                {index + 1}. {workflowNodeLabel(node.id)}
              </span>
              <span className="text-micro text-cafe-secondary">{workflowStatusLabel(node.status)}</span>
            </div>
            <div className="mt-1 text-micro text-cafe-secondary">负责人：{workflowActorLabel(node.actor)}</div>
            {node.requiredCount !== undefined && node.requiredCount > 0 && (
              <div className="mt-1 text-micro text-cafe-secondary">
                进度：{node.completedCount ?? 0}/{node.requiredCount}
              </div>
            )}
            {(node.completedAt ?? node.startedAt) && (
              <div className="mt-1 text-micro text-cafe-secondary">
                {node.completedAt ? '完成' : '开始'}：{formatWorkflowTime(node.completedAt ?? node.startedAt)}
              </div>
            )}
            {node.status === 'blocked' && node.manualAction && (
              <div className="mt-1 text-micro font-medium text-cafe">{workflowActionLabel(node.manualAction)}</div>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-micro leading-relaxed text-cafe-secondary">
        节点变为“已完成”才表示服务端已确认进入下一步；“进行中/被阻断”表示球仍在当前负责人手里。重复触发只会重投当前合法动作，不会跳过
        Review 或人工门禁。
      </p>
    </div>
  );
}

function workflowNodeLabel(id: DesktopDevelopmentWorkflowNode['id']): string {
  switch (id) {
    case 'design':
      return '方案分支';
    case 'implementation':
      return 'Desktop 实现与提交';
    case 'independent_review':
      return '独立检视';
    case 'cross_review':
      return '交叉检视';
    case 'consensus':
      return '共识整理';
    case 'handoff':
      return '修复交接 / 合入分流';
    case 'merge':
      return '合入';
    case 'acceptance':
      return '最终验收';
  }
}

function workflowActorLabel(actor: DesktopDevelopmentWorkflowNode['actor']): string {
  switch (actor) {
    case 'chatgpt_desktop':
      return 'ChatGPT Desktop';
    case 'reviewers':
      return 'Review 猫猫';
    case 'review_recorder':
      return '共识记录猫猫';
    case 'catcafe':
      return 'CatCafe 协调器';
    case 'user':
      return '你';
  }
}

function workflowStatusLabel(status: DesktopDevelopmentWorkflowNode['status']): string {
  switch (status) {
    case 'pending':
      return '未开始';
    case 'active':
      return '进行中';
    case 'blocked':
      return '被阻断';
    case 'completed':
      return '已完成';
  }
}

function workflowActionLabel(action: NonNullable<DesktopDevelopmentWorkflowNode['manualAction']>): string {
  switch (action) {
    case 'configure_design_branch':
      return '请到功能列表配置方案分支';
    case 'wake_desktop':
      return '再次触发 ChatGPT';
    case 'replay_review_stage':
      return '再次触发本阶段 Review';
    case 'record_architecture_decision':
      return '请在下方处理方案分歧';
    case 'approve_review_continuation':
      return '请在下方批准继续 Review';
    case 'record_acceptance':
      return '请在下方完成最终验收';
  }
}

function workflowNodeClass(status: DesktopDevelopmentWorkflowNode['status']): string {
  switch (status) {
    case 'active':
      return 'border-[var(--mc-accent)] bg-[var(--console-hover-bg)]';
    case 'blocked':
      return 'border-[var(--mc-accent)] bg-[var(--console-shell-bg)]';
    case 'completed':
      return 'border-[var(--console-hover-bg)] bg-[var(--console-shell-bg)]';
    case 'pending':
      return 'border-transparent bg-[var(--console-shell-bg)] opacity-70';
  }
}

function formatWorkflowTime(value: number | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
