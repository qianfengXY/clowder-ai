'use client';

import type {
  DesktopDevelopmentResumePacket,
  DesktopDevelopmentWorkflowNode,
  DesktopDevelopmentWorkflowNodeStatus,
} from '@cat-cafe/shared';

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
  const nodes = work.workflowNodes ?? [];
  if (nodes.length === 0) return null;

  const node = (id: DesktopDevelopmentWorkflowNode['id']) => nodes.find((candidate) => candidate.id === id);
  const current =
    nodes.find((candidate) => candidate.status === 'blocked') ??
    nodes.find((candidate) => candidate.status === 'active');
  const retryable = current?.manualAction === 'wake_desktop' || current?.manualAction === 'replay_review_stage';
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
  const currentLabel = terminalAccepted
    ? '验收通过 · 本轮结束'
    : terminalRejected
      ? '验收未通过 · 等待开启返工轮次'
      : current
        ? `${workflowNodeLabel(current.id)} · 等待${workflowActorLabel(current.actor)}`
        : '正在确认下一节点';

  return (
    <div className="mt-3 rounded-lg bg-[var(--console-card-bg)] p-3" data-testid={`workflow-graph-${work.workId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-xs font-medium text-cafe">完整开发闭环图</div>
            <span className="rounded-full bg-[var(--console-hover-bg)] px-2 py-1 text-micro text-cafe-secondary">
              交付 #{work.deliveryCycleNumber} · 实现 #{work.attemptNumber}
            </span>
            <span className="rounded-full bg-[var(--console-hover-bg)] px-2 py-1 text-micro font-medium text-cafe">
              本轮入口：{entryModeLabel(work.deliveryCycleEntryMode)}
            </span>
          </div>
          <div className="mt-1 text-micro text-cafe-secondary">当前停在：{currentLabel}</div>
        </div>
        {retryable && !terminalAccepted && !terminalRejected && (
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

      <div className="mt-3 px-1" role="img" aria-label={`开发闭环，当前停在${currentLabel}`}>
        <div className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] items-stretch">
          <FlowNode
            id="design-entry"
            title="方案新增 / 方案变更"
            detail="提交方案分支后进入"
            status={work.deliveryCycleEntryMode === 'design_change' ? (designEntry?.status ?? 'pending') : 'inactive'}
          />
          <div className="flex items-center justify-center text-micro text-cafe-secondary" aria-hidden="true">
            或
          </div>
          <FlowNode
            id="acceptance-rework-entry"
            title="验收未通过 / 返工"
            detail="保留证据，重新进入闭环"
            status={
              terminalRejected
                ? 'active'
                : work.deliveryCycleEntryMode === 'acceptance_rework'
                  ? 'completed'
                  : 'inactive'
            }
          />
        </div>

        <VerticalFlowArrow label="任一入口汇入同一个闭环" />
        <FlowNode
          id="implementation"
          title="ChatGPT 实现 / 修复"
          detail={`原 Desktop 窗口 · 实现 #${work.attemptNumber}`}
          status={implementation?.status ?? 'pending'}
          actor={implementation ? workflowActorLabel(implementation.actor) : undefined}
        />

        <VerticalFlowArrow label="提交实现" />
        <div
          className={`rounded-xl border p-3 ${graphContainerClass(reviewStatus)}`}
          data-testid="workflow-review-loop"
        >
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span className="text-xs font-medium text-cafe">Review 循环</span>
            <span className="text-micro text-cafe-secondary">独立检视 → 交叉检视 → 共识整理</span>
          </div>
          <div className="mt-2 grid grid-cols-[minmax(0,1fr)_22px_minmax(0,1fr)_22px_minmax(0,1fr)] items-center">
            <CompactNode node={independentReview} />
            <FlowArrow compact />
            <CompactNode node={crossReview} />
            <FlowArrow compact />
            <CompactNode node={consensus} />
          </div>
        </div>

        <VerticalFlowArrow />
        <FlowNode
          id="review-gate"
          title="检视结果 / 清零门"
          detail={handoffDetail(work)}
          status={handoff?.status ?? 'pending'}
          actor={handoff ? workflowActorLabel(handoff.actor) : undefined}
        />

        <LoopConnector label="仍有检视意见：回到 ChatGPT 修复，再次进入 Review" />
        <VerticalFlowArrow label="检视意见清零" />

        <div className="grid grid-cols-[minmax(0,1fr)_22px_minmax(0,1fr)_22px_minmax(0,1fr)] items-center">
          <FlowNode
            id="merge"
            title="合入 main"
            detail="通过合入门禁"
            status={merge?.status ?? 'pending'}
            actor={merge ? workflowActorLabel(merge.actor) : undefined}
          />
          <FlowArrow compact />
          <FlowNode
            id="acceptance"
            title="最终验收"
            detail="只有你能决定"
            status={acceptance?.status ?? 'pending'}
            actor="你"
          />
          <FlowArrow label="通过" compact />
          <FlowNode
            id="accepted-end"
            title="验收通过 / 结束"
            detail="以后方案变化可再开启"
            status={terminalAccepted ? 'active' : 'pending'}
          />
        </div>

        <AcceptanceReworkConnector active={terminalRejected || work.deliveryCycleEntryMode === 'acceptance_rework'} />
      </div>

      <p className="mt-1 text-micro leading-relaxed text-cafe-secondary">
        高亮节点就是当前执行位置；检视意见未清零会回到同一个 ChatGPT
        窗口继续修复。验收通过后闭环结束，后续方案新增或变更从上方方案入口开启；验收未通过则从返工入口开启。
      </p>
    </div>
  );
}

function FlowNode({
  id,
  title,
  detail,
  status,
  actor,
}: {
  id: string;
  title: string;
  detail: string;
  status: GraphStatus;
  actor?: string;
}) {
  const isCurrent = status === 'active' || status === 'blocked';
  return (
    <div
      className={`min-h-[82px] rounded-xl border px-3 py-2 ${graphNodeClass(status)}`}
      data-testid={`workflow-graph-node-${id}`}
      data-status={status}
      aria-current={isCurrent ? 'step' : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-cafe">{title}</span>
        <span className="shrink-0 text-micro text-cafe-secondary">{graphStatusLabel(status)}</span>
      </div>
      <div className="mt-1 text-micro leading-relaxed text-cafe-secondary">{detail}</div>
      {actor && <div className="mt-1 text-micro text-cafe-secondary">负责人：{actor}</div>}
    </div>
  );
}

function CompactNode({ node }: { node: DesktopDevelopmentWorkflowNode | undefined }) {
  const status = node?.status ?? 'pending';
  return (
    <div
      className={`min-h-[68px] rounded-lg border px-2 py-2 ${graphNodeClass(status)}`}
      data-testid={`workflow-graph-node-${node?.id ?? 'unknown-review'}`}
      data-status={status}
      aria-current={status === 'active' || status === 'blocked' ? 'step' : undefined}
    >
      <div className="text-micro font-medium text-cafe">{node ? workflowNodeLabel(node.id) : '等待 Review'}</div>
      <div className="mt-1 text-micro text-cafe-secondary">{graphStatusLabel(status)}</div>
      {node?.requiredCount !== undefined && node.requiredCount > 0 && (
        <div className="mt-1 text-micro text-cafe-secondary">
          {node.completedCount ?? 0}/{node.requiredCount}
        </div>
      )}
    </div>
  );
}

function FlowArrow({ label, compact = false }: { label?: string; compact?: boolean }) {
  return (
    <div
      className={`flex shrink-0 flex-col items-center justify-center px-1 ${compact ? 'w-[22px]' : 'w-9'}`}
      aria-hidden="true"
    >
      {label && <span className="mb-1 whitespace-nowrap text-micro text-cafe-secondary">{label}</span>}
      <div className="flex w-full items-center">
        <span className="h-px flex-1 bg-[var(--mc-accent)]" />
        <span className="h-0 w-0 border-y-[4px] border-l-[6px] border-y-transparent border-l-[var(--mc-accent)]" />
      </div>
    </div>
  );
}

function VerticalFlowArrow({ label }: { label?: string }) {
  return (
    <div className="flex min-h-10 flex-col items-center justify-center py-1" aria-hidden="true">
      {label && <span className="mb-1 text-center text-micro font-medium text-cafe-secondary">{label}</span>}
      <span className="h-4 w-px bg-[var(--mc-accent)]" />
      <span className="h-0 w-0 border-x-[4px] border-t-[6px] border-x-transparent border-t-[var(--mc-accent)]" />
    </div>
  );
}

function LoopConnector({ label }: { label: string }) {
  return (
    <div className="mt-2 px-4" aria-hidden="true">
      <div className="flex min-h-9 items-center rounded-lg border border-dashed border-[var(--mc-accent)] px-3 py-1.5">
        <span className="mr-2 text-sm text-[var(--mc-accent)]">↶</span>
        <span className="text-micro font-medium leading-relaxed text-cafe-secondary">{label}</span>
      </div>
    </div>
  );
}

function AcceptanceReworkConnector({ active }: { active: boolean }) {
  return (
    <div className={`mt-2 px-4 ${active ? '' : 'opacity-60'}`} aria-hidden="true">
      <div className="flex min-h-9 items-center justify-center rounded-lg border border-dashed border-[var(--mc-accent)] px-3 py-1.5 text-center">
        <span className="mr-2 text-sm text-[var(--mc-accent)]">↶</span>
        <span className="text-micro font-medium leading-relaxed text-cafe-secondary">
          验收未通过：保留本轮证据，从返工入口重新进入实现与 Review 循环
        </span>
      </div>
    </div>
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

function graphNodeClass(status: GraphStatus): string {
  switch (status) {
    case 'active':
      return 'border-[var(--mc-accent)] bg-[var(--console-hover-bg)] ring-1 ring-[var(--mc-accent)]';
    case 'blocked':
      return 'border-[var(--mc-accent)] bg-[var(--console-shell-bg)] ring-1 ring-[var(--mc-accent)]';
    case 'completed':
      return 'border-[var(--console-hover-bg)] bg-[var(--console-shell-bg)]';
    case 'pending':
    case 'inactive':
      return 'border-transparent bg-[var(--console-shell-bg)] opacity-60';
  }
}

function graphContainerClass(status: GraphStatus): string {
  switch (status) {
    case 'active':
    case 'blocked':
      return 'border-[var(--mc-accent)] bg-[var(--console-hover-bg)]';
    case 'completed':
      return 'border-[var(--console-hover-bg)] bg-[var(--console-shell-bg)]';
    case 'pending':
    case 'inactive':
      return 'border-transparent bg-[var(--console-shell-bg)] opacity-70';
  }
}
