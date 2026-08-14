'use client';

import type { DesktopDevelopmentResumePacket, ExternalProject } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useExternalProjectStore } from '@/stores/externalProjectStore';
import { apiFetch } from '@/utils/api-client';
import { buildDesktopAcceptanceRequest } from './desktop-development-form';

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
        accepted ? '最终验收已通过；本轮交付已闭环' : '最终验收未通过；证据已保留，请回到方案会话开启新交付轮次',
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法记录最终验收');
    } finally {
      setAcceptingWorkId(null);
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
                <div className="mt-2 text-micro text-cafe-secondary">
                  {work.branch} · {work.currentSha.slice(0, 12)} · {describeWorkState(work)}
                </div>
              )}
              {work && work.openFindings.length > 0 && (
                <p className="mt-2 text-xs text-cafe-secondary">待修复 findings：{work.openFindings.length}</p>
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
    case 'cross_review':
      return work.reviewPhase === 'consensus_ready' ? '等待共识' : '交叉检视中';
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
