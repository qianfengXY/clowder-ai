'use client';

import type { DesktopDevelopmentResumePacket, DesktopDevelopmentWorkflowNode } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { WorkflowHoverPreview, WorkflowNodeInspector } from './WorkflowNodeInspector';
import {
  ActorChip,
  BranchChip,
  EntryChip,
  GraphLegend,
  ReturnRail,
  StagePill,
  Station,
  type StationInteraction,
  StatusDot,
  statusShortText,
  statusTextClass,
} from './workflow-graph-parts';
import {
  aggregateStatus,
  entryModeLabel,
  handoffDetail,
  mergeModeLabel,
  shortSha,
  type WorkflowHoverState,
  type WorkflowInspectionSelection,
  workflowActionLabel,
  workflowActorLabel,
  workflowNodeLabel,
} from './workflow-graph-support';

/**
 * F289 完整开发闭环 — 时间轴视图。
 *
 * 垂直主轨 + 编号站点（01 实现 → 02 Review 循环 → 03 清零门 → 04 合入 → 05 验收），
 * 入口 A/B 在轨道顶部汇入；返工回环用右侧纯 CSS 虚线轨道表达（无 DOM 实测）。
 * hover 预览 + 点击固定详情沿用 WorkflowNodeInspector。
 */
export function DesktopDevelopmentWorkflowGraph({
  work,
  retrying,
  onRetry,
  onOpenReview,
  defaultCollapsed = true,
}: {
  work: DesktopDevelopmentResumePacket;
  retrying: boolean;
  onRetry: () => void;
  onOpenReview?: () => void;
  /** 默认收起：概览由 WorkflowStepper 承担，完整时间轴按需展开 */
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const nodes = work.workflowNodes ?? [];
  if (nodes.length === 0) return null;

  const current =
    nodes.find((candidate) => candidate.status === 'blocked') ??
    nodes.find((candidate) => candidate.status === 'active');
  const retryable = current?.manualAction === 'wake_desktop' || current?.manualAction === 'replay_review_stage';
  const terminalAccepted = work.phase === 'accepted';
  const terminalRejected = work.phase === 'rejected';
  const currentLabel = terminalAccepted
    ? '验收通过 · 本轮结束'
    : terminalRejected
      ? '验收未通过 · 等待开启返工轮次'
      : current
        ? `${workflowNodeLabel(current.id)} · 等待${workflowActorLabel(current.actor)}`
        : '正在确认下一节点';

  return (
    <section
      className="mt-3 overflow-hidden rounded-2xl border border-[var(--console-hover-bg)] bg-[var(--console-card-bg)] shadow-sm"
      data-testid={`workflow-graph-${work.workId}`}
    >
      <header className={`p-3 ${collapsed ? '' : 'border-b border-[var(--console-hover-bg)]'}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--console-hover-bg)] text-base text-[var(--mc-accent)]">
              ↻
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-xs font-semibold text-cafe">完整开发闭环</h4>
                <span className="rounded-full border border-[var(--console-hover-bg)] px-2 py-1 text-micro text-cafe-secondary">
                  交付 #{work.deliveryCycleNumber} · 实现 #{work.attemptNumber}
                </span>
                <span className="rounded-full bg-[var(--console-hover-bg)] px-2 py-1 text-micro font-medium text-cafe">
                  本轮入口：{entryModeLabel(work.deliveryCycleEntryMode)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-micro text-cafe-secondary">
                <StatusDot
                  status={
                    terminalAccepted ? 'completed' : terminalRejected ? 'blocked' : (current?.status ?? 'pending')
                  }
                />
                <span>当前停在：{currentLabel}</span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {retryable && !terminalAccepted && !terminalRejected && (
              <button
                type="button"
                onClick={onRetry}
                disabled={retrying}
                className="rounded-xl bg-[var(--mc-accent)] px-3 py-2 text-xs font-medium text-[var(--cafe-surface)] shadow-sm disabled:opacity-40"
              >
                {retrying ? '触发中...' : workflowActionLabel(current.manualAction)}
              </button>
            )}
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-controls={`workflow-graph-body-${work.workId}`}
              onClick={() => setCollapsed((value) => !value)}
              className="flex items-center gap-1 rounded-xl border border-[var(--console-hover-bg)] bg-[var(--console-shell-bg)] px-3 py-2 text-xs font-medium text-cafe-secondary hover:text-cafe"
            >
              {collapsed ? '展开流程' : '收起流程'}
              <span className={`text-sm transition-transform ${collapsed ? '' : 'rotate-180'}`} aria-hidden="true">
                ▾
              </span>
            </button>
          </div>
        </div>
      </header>

      {!collapsed && (
        <div id={`workflow-graph-body-${work.workId}`} data-testid="workflow-graph-body">
          <WorkflowTimeline work={work} currentLabel={currentLabel} onOpenReview={onOpenReview} />
        </div>
      )}
    </section>
  );
}

function WorkflowTimeline({
  work,
  currentLabel,
  onOpenReview,
}: {
  work: DesktopDevelopmentResumePacket;
  currentLabel: string;
  onOpenReview?: () => void;
}) {
  const [inspection, setInspection] = useState<WorkflowInspectionSelection | null>(null);
  const [hovered, setHovered] = useState<WorkflowHoverState | null>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const inspectionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const nodes = work.workflowNodes ?? [];
  const node = (id: DesktopDevelopmentWorkflowNode['id']) => nodes.find((candidate) => candidate.id === id);
  const independentReview = node('independent_review');
  const crossReview = node('cross_review');
  const consensus = node('consensus');
  const handoff = node('handoff');
  const terminalAccepted = work.phase === 'accepted';
  const terminalRejected = work.phase === 'rejected';
  const reviewStatus = aggregateStatus([independentReview, crossReview, consensus]);
  const designEntryStatus =
    work.deliveryCycleEntryMode === 'design_change' ? (node('design')?.status ?? 'pending') : 'inactive';
  const reworkEntryStatus = terminalRejected
    ? 'active'
    : work.deliveryCycleEntryMode === 'acceptance_rework'
      ? 'completed'
      : 'inactive';
  const reviewReturnActive = work.phase === 'fix_required' || handoff?.status === 'blocked';
  const mergeRouteActive =
    work.phase === 'approved_for_merge' || work.merged || work.acceptancePending || work.phase === 'accepted';
  const acceptanceReturnActive = terminalRejected || work.deliveryCycleEntryMode === 'acceptance_rework';
  const safeWorkId = work.workId.replace(/[^a-zA-Z0-9_-]/g, '');
  const inspectorId = `workflow-node-inspector-${safeWorkId}`;
  const tooltipId = `workflow-node-tooltip-${safeWorkId}`;

  const inspect = (selection: WorkflowInspectionSelection, trigger: HTMLButtonElement) => {
    inspectionTriggerRef.current = trigger;
    setInspection((value) => (value?.id === selection.id ? null : selection));
  };
  const preview = (selection: WorkflowInspectionSelection | null, trigger?: HTMLButtonElement) => {
    if (!selection || !trigger || !graphRef.current) {
      setHovered(null);
      return;
    }
    const graphRect = graphRef.current.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const top = Math.max(8, Math.min(triggerRect.top - graphRect.top - 4, Math.max(8, graphRect.height - 150)));
    setHovered({ selection, top });
  };
  const interactionFor = (id: WorkflowInspectionSelection['id']): StationInteraction => ({
    selected: inspection?.id === id,
    describedBy: hovered?.selection.id === id ? tooltipId : undefined,
    controls: inspectorId,
    onInspect: inspect,
    onPreview: preview,
  });

  useEffect(() => {
    if (!inspection) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setInspection(null);
        inspectionTriggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [inspection]);

  const reviewOwner = (candidate: DesktopDevelopmentWorkflowNode | undefined, fallback: string) =>
    candidate ? workflowActorLabel(candidate.actor) : fallback;
  const stageProgress = (candidate: DesktopDevelopmentWorkflowNode | undefined) =>
    candidate?.requiredCount ? `进度 ${candidate.completedCount ?? 0}/${candidate.requiredCount}` : '待进行';

  return (
    <section
      ref={graphRef}
      className="relative bg-[var(--console-shell-bg)]"
      aria-label={`开发闭环时间轴，当前停在${currentLabel}`}
      data-testid="workflow-swimlane-graph"
    >
      {hovered && <WorkflowHoverPreview id={tooltipId} work={work} selection={hovered.selection} top={hovered.top} />}

      {/* 27 寸等宽屏：内容封顶 1080px 并居中；pr-10 是回环轨道的专用天沟 */}
      <div className="px-3 py-4 sm:px-4">
        <div className="relative mx-auto w-full max-w-[1080px] pr-10">
          <div className="relative">
            {/* 返工大回环：验收未通过 → 入口 B。锚定在内容容器上，避免被外层 overflow-hidden 裁剪 */}
            <ReturnRail
              kind="acceptance"
              active={acceptanceReturnActive}
              className="-right-[38px] top-6 bottom-[30px] w-4"
            />

            <div className="grid grid-cols-1 items-stretch gap-2 sm:ml-10 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
              <EntryChip
                id="design-entry"
                title="入口 A · 方案新增 / 方案变更"
                detail={`${work.designBranch ?? '未配置方案分支'} @ ${shortSha(work.designExactSha)}`}
                status={designEntryStatus}
                interaction={interactionFor('design-entry')}
              />
              <span className="justify-self-center self-center text-micro text-cafe-muted" aria-hidden="true">
                或
              </span>
              <EntryChip
                id="acceptance-rework-entry"
                title="入口 B · 验收未通过 / 返工"
                detail={
                  terminalRejected
                    ? `保留交付 #${work.deliveryCycleNumber} 证据，从返工入口开启下一轮`
                    : `保留交付 #${Math.max(1, work.deliveryCycleNumber - 1)} 证据，直接回到实现与 Review`
                }
                status={reworkEntryStatus}
                interaction={interactionFor('acceptance-rework-entry')}
                returnTarget="acceptance"
                activeTone="warning"
                activeHint="● 等待你开启"
              />
            </div>
            <div className="py-1 text-center text-micro text-cafe-muted sm:ml-10">↓ 汇入本轮开发</div>

            <div className="relative">
              <span
                className="absolute left-[13px] top-2 bottom-3 w-0.5 rounded bg-[var(--console-border-soft)]"
                aria-hidden="true"
              />

              <div className="relative">
                {/* 修复小回环：清零门仍有意见 → 回到 01（频段 6..18px，与大回环 22..38px 互不重叠） */}
                <ReturnRail
                  kind="review"
                  active={reviewReturnActive}
                  className="-right-[18px] top-[26px] bottom-[26px] w-3"
                />

                <Station
                  id="implementation"
                  step="01"
                  title="ChatGPT 实现 / 修复"
                  actorTone="desktop"
                  actorLabel="ChatGPT Desktop"
                  status={node('implementation')?.status ?? 'pending'}
                  owner="ChatGPT Desktop"
                  interaction={interactionFor('implementation')}
                >
                  <div className="mt-1 text-micro text-cafe-secondary">
                    实现 #{work.attemptNumber} · <span className="font-mono">{work.branch}</span> @{' '}
                    <span className="font-mono">{shortSha(work.currentSha)}</span> · 原 Desktop 窗口 · 绑定代次{' '}
                    {work.bindingEpoch}
                  </div>
                </Station>

                <div className="relative flex gap-3 py-2">
                  <span
                    className={`relative z-[1] mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-micro font-bold ${
                      reviewStatus === 'completed'
                        ? 'border-[var(--semantic-success)] bg-[var(--semantic-success)] text-[var(--cafe-surface)]'
                        : reviewStatus === 'active'
                          ? 'border-[var(--mc-accent)] bg-[var(--mc-accent)] text-[var(--cafe-surface)]'
                          : reviewStatus === 'blocked'
                            ? 'border-[var(--semantic-warning)] bg-[var(--semantic-warning)] text-[var(--cafe-surface)]'
                            : 'border-[var(--console-border-strong)] bg-[var(--console-card-bg)] text-cafe-muted'
                    }`}
                    aria-hidden="true"
                  >
                    02
                  </span>
                  <div className="min-w-0 flex-1 px-2.5 py-1.5" data-testid="workflow-review-loop">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-cafe">Review 共识循环</span>
                      <ActorChip tone="review" label="Review 猫猫" />
                      <span className={`ml-auto text-micro ${statusTextClass(reviewStatus)}`}>
                        {statusShortText(reviewStatus)}
                      </span>
                    </div>
                    <section
                      className="mt-2 flex snap-x snap-mandatory items-stretch gap-2 overflow-x-auto overscroll-x-contain pb-1 md:pb-0"
                      data-testid="workflow-review-stages"
                      aria-label="Review 三阶段，可横向滚动"
                    >
                      <StagePill
                        id="independent_review"
                        title="独立检视"
                        detail="草稿隔离"
                        progress={stageProgress(independentReview)}
                        status={independentReview?.status ?? 'pending'}
                        owner={reviewOwner(independentReview, 'Review 猫猫')}
                        interaction={interactionFor('independent_review')}
                      />
                      <span className="flex shrink-0 items-center text-micro text-cafe-muted" aria-hidden="true">
                        →
                      </span>
                      <StagePill
                        id="cross_review"
                        title="交叉检视"
                        detail="核验对方意见"
                        progress={stageProgress(crossReview)}
                        status={crossReview?.status ?? 'pending'}
                        owner={reviewOwner(crossReview, 'Review 猫猫')}
                        interaction={interactionFor('cross_review')}
                      />
                      <span className="flex shrink-0 items-center text-micro text-cafe-muted" aria-hidden="true">
                        →
                      </span>
                      <StagePill
                        id="consensus"
                        title="共识整理"
                        detail={`开放意见 ${work.openFindings.length}`}
                        progress={stageProgress(consensus)}
                        status={consensus?.status ?? 'pending'}
                        owner={reviewOwner(consensus, '共识记录猫猫')}
                        interaction={interactionFor('consensus')}
                      />
                    </section>
                  </div>
                </div>

                <Station
                  id="handoff"
                  testid="workflow-graph-node-review-gate"
                  step="03"
                  title="检视清零门"
                  actorTone="catcafe"
                  actorLabel="CatCafe 协调器"
                  status={handoff?.status ?? 'pending'}
                  owner={handoff ? workflowActorLabel(handoff.actor) : 'CatCafe 协调器'}
                  interaction={interactionFor('handoff')}
                >
                  <div className="mt-1 text-micro text-cafe-secondary">{handoffDetail(work)}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <BranchChip
                      tone="warning"
                      active={reviewReturnActive}
                      label="↺ 仍有意见 → 回到 01 修复"
                      returnSource="review"
                    />
                    <BranchChip tone="success" active={mergeRouteActive} label="意见清零 → 进入 04 合入" />
                  </div>
                </Station>
              </div>

              <Station
                id="merge"
                step="04"
                title="合入 main"
                actorTone="desktop"
                actorLabel="ChatGPT Desktop"
                status={node('merge')?.status ?? 'pending'}
                owner="ChatGPT Desktop"
                interaction={interactionFor('merge')}
              >
                <div className="mt-1 text-micro text-cafe-secondary">
                  {work.merged ? '已合入 main' : `通过合入门禁 · ${mergeModeLabel(work.mergeMode)}`}
                </div>
              </Station>

              <Station
                id="acceptance"
                step="05"
                title="最终验收"
                actorTone="user"
                actorLabel="你"
                status={terminalRejected ? 'blocked' : (node('acceptance')?.status ?? 'pending')}
                statusText={terminalRejected ? '✕ 验收未通过' : undefined}
                owner="你"
                interaction={interactionFor('acceptance')}
              >
                <div className="mt-1 text-micro text-cafe-secondary" data-return-source="acceptance">
                  {terminalRejected
                    ? '证据已保留 · 沿右侧轨道返回入口 B 开启返工轮次'
                    : '只有你能决定：通过则本轮闭环结束；未通过则走入口 B 开启返工轮次，本轮证据保留'}
                </div>
              </Station>

              {!terminalRejected && (
                <Station
                  id="accepted-end"
                  step="✓"
                  title="验收通过 · 结束"
                  actorTone="user"
                  actorLabel="你"
                  status={terminalAccepted ? 'active' : 'pending'}
                  owner="你"
                  interaction={interactionFor('accepted-end')}
                >
                  <div className="mt-1 text-micro text-cafe-secondary">
                    本交付轮次终止；后续方案新增或变更从入口 A 再开启
                  </div>
                </Station>
              )}
            </div>
          </div>
        </div>
      </div>

      <GraphLegend />

      {inspection && (
        <WorkflowNodeInspector
          id={inspectorId}
          work={work}
          selection={inspection}
          onClose={() => {
            setInspection(null);
            inspectionTriggerRef.current?.focus();
          }}
          onOpenReview={onOpenReview}
        />
      )}
    </section>
  );
}
