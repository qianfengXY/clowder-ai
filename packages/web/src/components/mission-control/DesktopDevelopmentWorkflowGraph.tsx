'use client';

import type {
  DesktopDevelopmentResumePacket,
  DesktopDevelopmentWorkflowNode,
  DesktopDevelopmentWorkflowNodeStatus,
} from '@cat-cafe/shared';
import { type ReactNode, useState } from 'react';

type GraphStatus = DesktopDevelopmentWorkflowNodeStatus | 'inactive';

export function DesktopDevelopmentWorkflowGraph({
  work,
  retrying,
  onRetry,
}: {
  work: DesktopDevelopmentResumePacket;
  retrying: boolean;
  onRetry: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
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
          <WorkflowSwimlaneGraph work={work} currentLabel={currentLabel} />

          <p className="border-t border-[var(--console-hover-bg)] px-4 py-3 text-micro leading-relaxed text-cafe-secondary">
            高亮节点就是当前执行位置；检视意见未清零会回到同一个 ChatGPT
            窗口继续修复。验收通过后闭环结束，后续方案新增或变更从方案入口开启；验收未通过则从返工入口开启。
          </p>
        </div>
      )}
    </section>
  );
}

type ActorTone = 'entry' | 'desktop' | 'review' | 'catcafe' | 'user';

function WorkflowSwimlaneGraph({ work, currentLabel }: { work: DesktopDevelopmentResumePacket; currentLabel: string }) {
  const nodes = work.workflowNodes ?? [];
  const node = (id: DesktopDevelopmentWorkflowNode['id']) => nodes.find((candidate) => candidate.id === id);
  const designEntry = node('design');
  const implementation = node('implementation');
  const independentReview = node('independent_review');
  const crossReview = node('cross_review');
  const consensus = node('consensus');
  const handoff = node('handoff');
  const merge = node('merge');
  const acceptance = node('acceptance');
  const terminalAccepted = work.phase === 'accepted';
  const terminalRejected = work.phase === 'rejected';
  const reviewStatus = aggregateStatus([independentReview, crossReview, consensus]);
  const designEntryStatus =
    work.deliveryCycleEntryMode === 'design_change' ? (designEntry?.status ?? 'pending') : 'inactive';
  const reworkEntryStatus = terminalRejected
    ? 'active'
    : work.deliveryCycleEntryMode === 'acceptance_rework'
      ? 'completed'
      : 'inactive';
  const reviewReturnActive = work.phase === 'fix_required' || handoff?.status === 'blocked';
  const mergeRouteActive =
    work.phase === 'approved_for_merge' || work.merged || work.acceptancePending || work.phase === 'accepted';

  return (
    <div
      className="relative m-3 overflow-hidden rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-shell-bg)] pr-7"
      role="img"
      aria-label={`开发闭环泳道图，当前停在${currentLabel}`}
      data-testid="workflow-swimlane-graph"
    >
      <WorkflowReturnRails
        workId={work.workId}
        reviewActive={reviewReturnActive}
        acceptanceActive={terminalRejected || work.deliveryCycleEntryMode === 'acceptance_rework'}
      />

      <WorkflowLane tone="entry" label="进入" caption="两种入口">
        <div className="grid grid-cols-1 items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] sm:gap-0">
          <LaneNode
            id="design-entry"
            tone="user"
            step="入口 A"
            title="方案新增 / 方案变更"
            detail={`${work.designBranch}@${shortSha(work.designExactSha)}`}
            meta="方案提交后开启新交付轮次"
            status={designEntryStatus}
            dashed
          />
          <LaneOr />
          <LaneNode
            id="acceptance-rework-entry"
            tone="user"
            step="入口 B"
            title="验收未通过 / 返工"
            detail={`保留交付 #${Math.max(1, work.deliveryCycleNumber - 1)} 证据`}
            meta="直接回到实现与 Review 循环"
            status={reworkEntryStatus}
            dashed
          />
        </div>
      </WorkflowLane>

      <LaneTransition label="任一入口汇入本轮开发" />

      <WorkflowLane tone="desktop" label="Desktop" caption="ChatGPT 持球">
        <LaneNode
          id="implementation"
          tone="desktop"
          step="01"
          title="ChatGPT 实现 / 修复"
          detail={`实现 #${work.attemptNumber} · ${shortSha(work.currentSha)}`}
          meta={`原 Desktop 窗口 · 绑定代次 ${work.bindingEpoch}`}
          status={implementation?.status ?? 'pending'}
        />
      </WorkflowLane>

      <LaneTransition label="提交精确 commit" strong />

      <WorkflowLane tone="review" label="Review" caption="多猫检视">
        <div
          className={`relative overflow-hidden rounded-2xl border border-l-4 p-3 ${actorBorderClass('review')} ${graphContainerClass(reviewStatus)}`}
          data-testid="workflow-review-loop"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StepBadge label="02" />
              <div>
                <div className="text-xs font-semibold text-cafe">Review 共识循环</div>
                <div className="mt-0.5 text-micro text-cafe-secondary">先独立、再交叉、最后只发布一份共识</div>
              </div>
            </div>
            <StatusBadge status={reviewStatus} />
          </div>
          <div className="mt-3 grid grid-cols-1 items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_22px_minmax(0,1fr)_22px_minmax(0,1fr)] sm:gap-0">
            <ReviewStageNode node={independentReview} title="独立检视" detail="草稿隔离" />
            <LaneArrow />
            <ReviewStageNode node={crossReview} title="交叉检视" detail="核验对方意见" />
            <LaneArrow />
            <ReviewStageNode node={consensus} title="共识整理" detail={`${work.openFindings.length} 项开放意见`} />
          </div>
        </div>
      </WorkflowLane>

      <LaneTransition label="共识 verdict" strong />

      <WorkflowLane tone="catcafe" label="CatCafe" caption="协调与门控">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1.05fr)_minmax(150px,0.75fr)]">
          <DecisionNode work={work} node={handoff} />
          <fieldset className="flex flex-col justify-center gap-2">
            <legend className="sr-only">清零门分支</legend>
            <RouteCard
              tone="warning"
              active={reviewReturnActive}
              symbol="↺"
              title="仍有检视意见："
              detail="回到 ChatGPT 修复，再次进入 Review"
            />
            <RouteCard
              tone="success"
              active={mergeRouteActive}
              symbol="↓"
              title="检视意见清零"
              detail="进入 04 · 合入 main"
            />
          </fieldset>
        </div>
      </WorkflowLane>

      <LaneTransition label="清零后放行" />

      <WorkflowLane tone="user" label="交付" caption="合入与验收">
        <div className="grid grid-cols-1 items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_22px_minmax(0,1fr)_22px_minmax(0,1fr)] sm:gap-0">
          <LaneNode
            id="merge"
            tone="desktop"
            step="04"
            title="合入 main"
            detail="通过合入门禁"
            meta={work.mergeMode === 'manual_confirm_in_chatgpt' ? 'ChatGPT 窗口人工确认' : work.mergeMode}
            status={merge?.status ?? 'pending'}
          />
          <LaneArrow />
          <LaneNode
            id="acceptance"
            tone="user"
            step="05"
            title="最终验收"
            detail="只有你能决定"
            meta={work.acceptancePending ? '等待你的验收结果' : '尚未进入验收'}
            status={acceptance?.status ?? 'pending'}
          />
          <LaneArrow label="通过" />
          <LaneNode
            id="accepted-end"
            tone="user"
            step="完成"
            title="验收通过 / 结束"
            detail="本交付轮次终止"
            meta="后续方案变化从入口 A 再开启"
            status={terminalAccepted ? 'active' : 'pending'}
          />
        </div>
        <div
          className={`mt-3 flex items-center rounded-xl border border-dashed border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] px-3 py-2 ${terminalRejected || work.deliveryCycleEntryMode === 'acceptance_rework' ? '' : 'opacity-50'}`}
          role="note"
          aria-label="验收未通过返工路径"
        >
          <span className="mr-2 text-base text-[var(--semantic-warning)]">↶</span>
          <span className="text-micro font-medium text-cafe-secondary">
            验收未通过：返回入口 B，保留本轮证据并开启下一交付轮次
          </span>
        </div>
      </WorkflowLane>
    </div>
  );
}

function WorkflowLane({
  tone,
  label,
  caption,
  children,
}: {
  tone: ActorTone;
  label: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] border-b border-[var(--console-border-soft)] last:border-b-0">
      <div className="relative flex flex-col justify-center border-r border-[var(--console-border-soft)] px-2 py-4">
        <span className={`absolute inset-y-0 left-0 w-1 ${actorBarClass(tone)}`} aria-hidden="true" />
        <div className={`text-micro font-bold ${actorTextClass(tone)}`}>{label}</div>
        <div className="mt-1 text-micro leading-tight text-cafe-secondary">{caption}</div>
      </div>
      <div className="min-w-0 p-3">{children}</div>
    </div>
  );
}

function LaneNode({
  id,
  tone,
  step,
  title,
  detail,
  meta,
  status,
  dashed = false,
}: {
  id: string;
  tone: ActorTone;
  step: string;
  title: string;
  detail: string;
  meta: string;
  status: GraphStatus;
  dashed?: boolean;
}) {
  const isCurrent = status === 'active' || status === 'blocked';
  return (
    <div
      className={`relative min-h-[98px] overflow-hidden rounded-2xl border border-l-4 p-3 transition-colors ${actorBorderClass(tone)} ${graphNodeClass(status)} ${dashed ? 'border-dashed' : ''}`}
      data-testid={`workflow-graph-node-${id}`}
      data-status={status}
      aria-current={isCurrent ? 'step' : undefined}
      title={`${title}\n${detail}\n${meta}\n状态：${graphStatusLabel(status)}`}
    >
      <div className="flex items-center justify-between gap-2">
        <StepBadge label={step} />
        <StatusBadge status={status} />
      </div>
      <div className="mt-2 text-xs font-semibold text-cafe">{title}</div>
      <div className="mt-1 text-micro text-cafe-secondary">{detail}</div>
      <div className="mt-1 text-micro leading-relaxed text-cafe-secondary opacity-80">{meta}</div>
    </div>
  );
}

function ReviewStageNode({
  node,
  title,
  detail,
}: {
  node: DesktopDevelopmentWorkflowNode | undefined;
  title: string;
  detail: string;
}) {
  const status = node?.status ?? 'pending';
  const progress = node?.requiredCount ? `${node.completedCount ?? 0}/${node.requiredCount}` : graphStatusLabel(status);
  return (
    <div
      className={`min-h-[86px] rounded-xl border border-l-4 p-2.5 ${actorBorderClass('review')} ${graphNodeClass(status)}`}
      data-testid={`workflow-graph-node-${node?.id ?? 'unknown-review'}`}
      data-status={status}
      aria-current={status === 'active' || status === 'blocked' ? 'step' : undefined}
      title={`${title}\n${detail}\n${progress}`}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="text-micro font-semibold text-cafe">{title}</div>
        <StatusDot status={status} />
      </div>
      <div className="mt-1 text-micro text-cafe-secondary">{detail}</div>
      <div className="mt-2 text-xs font-semibold text-cafe">{progress}</div>
    </div>
  );
}

function DecisionNode({
  work,
  node,
}: {
  work: DesktopDevelopmentResumePacket;
  node: DesktopDevelopmentWorkflowNode | undefined;
}) {
  const status = node?.status ?? 'pending';
  return (
    <div
      className={`relative flex min-h-[120px] items-center gap-4 overflow-hidden rounded-2xl border border-l-4 p-3 ${actorBorderClass('catcafe')} ${graphNodeClass(status)}`}
      data-testid="workflow-graph-node-review-gate"
      data-status={status}
      aria-current={status === 'active' || status === 'blocked' ? 'step' : undefined}
      title={`检视清零门\n${handoffDetail(work)}\n开放意见：${work.openFindings.length}`}
    >
      <div className="flex h-14 w-14 shrink-0 rotate-45 items-center justify-center rounded-xl border-2 border-[var(--semantic-warning)] bg-[var(--console-card-bg)]">
        <span className="-rotate-45 text-xs font-bold text-[var(--semantic-warning)]">03</span>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs font-semibold text-cafe">检视清零门</div>
          <StatusBadge status={status} />
        </div>
        <div className="mt-1 text-micro text-cafe-secondary">{handoffDetail(work)}</div>
        <div className="mt-2 text-micro font-medium text-cafe">开放意见：{work.openFindings.length}</div>
      </div>
    </div>
  );
}

function RouteCard({
  tone,
  active,
  symbol,
  title,
  detail,
}: {
  tone: 'warning' | 'success';
  active: boolean;
  symbol: string;
  title: string;
  detail: string;
}) {
  const className =
    tone === 'warning'
      ? 'border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] text-[var(--semantic-warning)]'
      : 'border-[var(--semantic-success)] bg-[var(--semantic-success-surface)] text-[var(--semantic-success)]';
  return (
    <div className={`rounded-xl border border-dashed p-2.5 ${className} ${active ? 'shadow-sm' : 'opacity-55'}`}>
      <div className="flex items-center gap-2">
        <span className="text-base font-bold">{symbol}</span>
        <div>
          <div className="text-micro font-semibold">{title}</div>
          <div className="mt-0.5 text-micro text-cafe-secondary">{detail}</div>
        </div>
      </div>
    </div>
  );
}

function WorkflowReturnRails({
  workId,
  reviewActive,
  acceptanceActive,
}: {
  workId: string;
  reviewActive: boolean;
  acceptanceActive: boolean;
}) {
  const markerId = `workflow-return-${workId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg
      className="pointer-events-none absolute inset-y-0 right-0 z-10 h-full w-7"
      viewBox="0 0 28 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <marker id={markerId} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
          <path d="M0,0 L5,2.5 L0,5 Z" fill="var(--semantic-warning)" />
        </marker>
      </defs>
      <path
        d="M 3 69 H 21 V 27 H 7"
        fill="none"
        stroke="var(--semantic-warning)"
        strokeWidth={reviewActive ? 1.8 : 1}
        strokeDasharray="3 2"
        opacity={reviewActive ? 1 : 0.35}
        markerEnd={`url(#${markerId})`}
      />
      <path
        d="M 5 93 H 26 V 9 H 9"
        fill="none"
        stroke="var(--semantic-warning)"
        strokeWidth={acceptanceActive ? 1.8 : 1}
        strokeDasharray="2 2"
        opacity={acceptanceActive ? 1 : 0.22}
        markerEnd={`url(#${markerId})`}
      />
    </svg>
  );
}

function LaneTransition({ label, strong = false }: { label: string; strong?: boolean }) {
  return (
    <div className="grid h-8 grid-cols-[72px_minmax(0,1fr)]" aria-hidden="true">
      <div className="border-r border-[var(--console-border-soft)]" />
      <div className="relative flex items-center justify-center">
        <span
          className={`absolute inset-y-0 left-1/2 w-px ${strong ? 'bg-[var(--mc-accent)]' : 'bg-[var(--console-border-strong)]'}`}
        />
        <span className="relative rounded-full bg-[var(--console-shell-bg)] px-2 py-0.5 text-micro font-medium text-cafe-secondary">
          {label}
        </span>
        <span className="absolute bottom-0 left-1/2 h-0 w-0 -translate-x-[3px] border-x-[4px] border-t-[6px] border-x-transparent border-t-[var(--mc-accent)]" />
      </div>
    </div>
  );
}

function LaneOr() {
  return (
    <div className="flex items-center justify-center" aria-hidden="true">
      <span className="rounded-full bg-[var(--console-shell-bg)] px-1.5 py-1 text-micro text-cafe-secondary">或</span>
    </div>
  );
}

function LaneArrow({ label }: { label?: string }) {
  return (
    <div className="hidden flex-col items-center justify-center px-1 sm:flex" aria-hidden="true">
      {label && <span className="mb-1 whitespace-nowrap text-micro text-cafe-secondary">{label}</span>}
      <div className="flex w-full items-center">
        <span className="h-px flex-1 bg-[var(--mc-accent)]" />
        <span className="h-0 w-0 border-y-[4px] border-l-[6px] border-y-transparent border-l-[var(--mc-accent)]" />
      </div>
    </div>
  );
}

function StepBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex min-w-7 items-center justify-center rounded-lg bg-[var(--console-hover-bg)] px-2 py-1 text-micro font-semibold text-cafe-secondary">
      {label}
    </span>
  );
}

function StatusDot({ status }: { status: GraphStatus }) {
  return <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(status)}`} aria-hidden="true" />;
}

function StatusBadge({ status }: { status: GraphStatus }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--console-shell-bg)] px-2 py-1 text-micro text-cafe-secondary">
      <StatusDot status={status} />
      {graphStatusLabel(status)}
    </span>
  );
}

function aggregateStatus(nodes: readonly (DesktopDevelopmentWorkflowNode | undefined)[]): GraphStatus {
  if (nodes.some((node) => node?.status === 'blocked')) return 'blocked';
  if (nodes.some((node) => node?.status === 'active')) return 'active';
  if (nodes.length > 0 && nodes.every((node) => node?.status === 'completed')) return 'completed';
  return 'pending';
}

function handoffDetail(work: DesktopDevelopmentResumePacket): string {
  if (work.architectureDecisionPending) return '方案分歧，等待你的决策';
  if (work.reviewContinuationPending) return `达到 ${work.reviewAttemptLimit} 次上限，等待批准`;
  if (work.phase === 'fix_required') return `${work.openFindings.length} 项意见待修复`;
  if (work.phase === 'approved_for_merge' || work.merged || work.acceptancePending) return '检视意见已清零';
  return '判断返工或进入合入';
}

function entryModeLabel(mode: DesktopDevelopmentResumePacket['deliveryCycleEntryMode']): string {
  return mode === 'acceptance_rework' ? '验收未通过返工' : '方案新增 / 变更';
}

function workflowNodeLabel(id: DesktopDevelopmentWorkflowNode['id']): string {
  switch (id) {
    case 'design':
      return '方案分支';
    case 'implementation':
      return 'ChatGPT 实现 / 修复';
    case 'independent_review':
      return '独立检视';
    case 'cross_review':
      return '交叉检视';
    case 'consensus':
      return '共识整理';
    case 'handoff':
      return '检视结果 / 清零门';
    case 'merge':
      return '合入 main';
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

function graphStatusLabel(status: GraphStatus): string {
  switch (status) {
    case 'pending':
      return '未到达';
    case 'inactive':
      return '本轮未选';
    case 'active':
      return '当前';
    case 'blocked':
      return '等待处理';
    case 'completed':
      return '已经过';
  }
}

function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 8) : '等待 commit';
}

function actorBarClass(tone: ActorTone): string {
  switch (tone) {
    case 'entry':
      return 'bg-[var(--console-border-strong)]';
    case 'desktop':
      return 'bg-[var(--semantic-info)]';
    case 'review':
      return 'bg-[var(--mc-slice-hardening)]';
    case 'catcafe':
      return 'bg-[var(--semantic-warning)]';
    case 'user':
      return 'bg-[var(--semantic-success)]';
  }
}

function actorTextClass(tone: ActorTone): string {
  switch (tone) {
    case 'entry':
      return 'text-cafe-secondary';
    case 'desktop':
      return 'text-[var(--semantic-info)]';
    case 'review':
      return 'text-[var(--mc-slice-hardening)]';
    case 'catcafe':
      return 'text-[var(--semantic-warning)]';
    case 'user':
      return 'text-[var(--semantic-success)]';
  }
}

function actorBorderClass(tone: ActorTone): string {
  switch (tone) {
    case 'entry':
      return 'border-l-[var(--console-border-strong)]';
    case 'desktop':
      return 'border-l-[var(--semantic-info)]';
    case 'review':
      return 'border-l-[var(--mc-slice-hardening)]';
    case 'catcafe':
      return 'border-l-[var(--semantic-warning)]';
    case 'user':
      return 'border-l-[var(--semantic-success)]';
  }
}

function graphNodeClass(status: GraphStatus): string {
  switch (status) {
    case 'active':
      return 'border-[var(--mc-accent)] bg-[var(--console-hover-bg)] ring-2 ring-[var(--mc-accent)] shadow-sm';
    case 'blocked':
      return 'border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] ring-1 ring-[var(--semantic-warning)]';
    case 'completed':
      return 'border-[var(--semantic-success)] bg-[var(--semantic-success-surface)]';
    case 'pending':
      return 'border-[var(--console-border-soft)] bg-[var(--console-card-bg)] opacity-70';
    case 'inactive':
      return 'border-[var(--console-border-soft)] bg-[var(--console-card-bg)] opacity-45';
  }
}

function statusDotClass(status: GraphStatus): string {
  switch (status) {
    case 'active':
      return 'bg-[var(--mc-accent)] ring-2 ring-[var(--console-card-bg)]';
    case 'blocked':
      return 'bg-[var(--semantic-warning)]';
    case 'completed':
      return 'bg-[var(--semantic-success)]';
    case 'pending':
      return 'bg-[var(--console-border-strong)]';
    case 'inactive':
      return 'bg-[var(--console-border-soft)]';
  }
}

function graphContainerClass(status: GraphStatus): string {
  switch (status) {
    case 'active':
      return 'border-[var(--mc-accent)] bg-[var(--console-hover-bg)] shadow-sm';
    case 'blocked':
      return 'border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)]';
    case 'completed':
      return 'border-[var(--semantic-success)] bg-[var(--semantic-success-surface)]';
    case 'pending':
      return 'border-[var(--console-border-soft)] bg-[var(--console-card-bg)] opacity-80';
    case 'inactive':
      return 'border-[var(--console-border-soft)] bg-[var(--console-card-bg)] opacity-50';
  }
}
