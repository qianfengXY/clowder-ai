'use client';

import type {
  DesktopDevelopmentManualAction,
  DesktopDevelopmentResumePacket,
  DesktopDevelopmentWorkflowNode,
  DesktopDevelopmentWorkflowNodeStatus,
} from '@cat-cafe/shared';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

type GraphStatus = DesktopDevelopmentWorkflowNodeStatus | 'available' | 'inactive';
type DirectManualAction = Extract<DesktopDevelopmentManualAction, 'wake_desktop' | 'replay_review_stage'>;
type GuidedManualAction = Exclude<DesktopDevelopmentManualAction, DirectManualAction>;

type WorkflowNodeCommandModel =
  | {
      readonly kind: 'direct';
      readonly nodeId: DesktopDevelopmentWorkflowNode['id'];
      readonly action: DirectManualAction;
      readonly reason: string;
    }
  | {
      readonly kind: 'entry';
      readonly entryId: 'design-entry' | 'acceptance-rework-entry';
      readonly reason: string;
    }
  | {
      readonly kind: 'guided';
      readonly nodeId: DesktopDevelopmentWorkflowNode['id'];
      readonly action: GuidedManualAction;
      readonly reason: string;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };
type WorkflowInspectionId =
  | 'design-entry'
  | 'acceptance-rework-entry'
  | 'implementation'
  | 'independent_review'
  | 'cross_review'
  | 'consensus'
  | 'handoff'
  | 'merge'
  | 'acceptance'
  | 'accepted-end';

interface WorkflowInspectionSelection {
  readonly id: WorkflowInspectionId;
  readonly title: string;
  readonly owner: string;
  readonly status: GraphStatus;
}

interface WorkflowHoverState {
  readonly selection: WorkflowInspectionSelection;
  readonly top: number;
}

export function DesktopDevelopmentWorkflowGraph({
  work,
  retrying,
  onTriggerNode,
  onOpenReview,
  startingDeliveryCycle = false,
  onStartDeliveryCycle,
  onFocusManualAction,
  feedback,
}: {
  work: DesktopDevelopmentResumePacket;
  retrying: boolean;
  onTriggerNode: (nodeId: DesktopDevelopmentWorkflowNode['id']) => void;
  onOpenReview?: () => void;
  startingDeliveryCycle?: boolean;
  onStartDeliveryCycle?: () => void;
  onFocusManualAction?: (action: DesktopDevelopmentManualAction) => void;
  feedback?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const nodes = work.workflowNodes ?? [];
  if (nodes.length === 0) return null;

  const current = firstCurrentWorkflowNode(nodes);
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
          <WorkflowSwimlaneGraph
            work={work}
            currentLabel={currentLabel}
            retrying={retrying}
            onTriggerNode={onTriggerNode}
            onOpenReview={onOpenReview}
            startingDeliveryCycle={startingDeliveryCycle}
            onStartDeliveryCycle={onStartDeliveryCycle}
            onFocusManualAction={onFocusManualAction}
          />

          {feedback && (
            <output
              className="mx-3 mb-3 block rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-shell-bg)] px-3 py-2 text-micro leading-relaxed text-cafe-secondary"
              aria-live="polite"
              data-testid={`workflow-node-feedback-${work.workId}`}
            >
              {feedback}
            </output>
          )}

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

function WorkflowSwimlaneGraph({
  work,
  currentLabel,
  retrying,
  onTriggerNode,
  onOpenReview,
  startingDeliveryCycle,
  onStartDeliveryCycle,
  onFocusManualAction,
}: {
  work: DesktopDevelopmentResumePacket;
  currentLabel: string;
  retrying: boolean;
  onTriggerNode: (nodeId: DesktopDevelopmentWorkflowNode['id']) => void;
  onOpenReview?: () => void;
  startingDeliveryCycle: boolean;
  onStartDeliveryCycle?: () => void;
  onFocusManualAction?: (action: DesktopDevelopmentManualAction) => void;
}) {
  const [inspection, setInspection] = useState<WorkflowInspectionSelection | null>(null);
  const [hovered, setHovered] = useState<WorkflowHoverState | null>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const inspectionTriggerRef = useRef<HTMLButtonElement | null>(null);
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
  const currentNodeId = firstCurrentWorkflowNode(nodes)?.id;
  const designEntryStatus = terminalAccepted
    ? 'available'
    : work.deliveryCycleEntryMode === 'design_change'
      ? (designEntry?.status ?? 'pending')
      : 'inactive';
  const reworkEntryStatus = terminalRejected
    ? 'active'
    : work.deliveryCycleEntryMode === 'acceptance_rework'
      ? 'completed'
      : 'inactive';
  const reviewReturnActive = work.phase === 'fix_required' || handoff?.status === 'blocked';
  const mergeRouteActive =
    work.phase === 'approved_for_merge' || work.merged || work.acceptancePending || work.phase === 'accepted';
  const safeWorkId = work.workId.replace(/[^a-zA-Z0-9_-]/g, '');
  const inspectorId = `workflow-node-inspector-${safeWorkId}`;
  const tooltipId = `workflow-node-tooltip-${safeWorkId}`;
  const inspectionEpoch = [
    work.attemptId,
    work.managedWorkVersion,
    work.phase,
    work.reviewRoundVersion ?? 0,
    work.sessionVersion,
  ].join(':');
  const closeInspection = () => {
    setInspection(null);
    inspectionTriggerRef.current?.focus();
  };
  const guideManualAction = (action: DesktopDevelopmentManualAction) => {
    setInspection(null);
    setHovered(null);
    inspectionTriggerRef.current = null;
    onFocusManualAction?.(action);
  };
  const inspect = (selection: WorkflowInspectionSelection, trigger: HTMLButtonElement) => {
    inspectionTriggerRef.current = trigger;
    setInspection((current) => (current?.id === selection.id ? null : selection));
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

  useEffect(() => {
    void inspectionEpoch;
    setInspection(null);
    setHovered(null);
    inspectionTriggerRef.current = null;
  }, [inspectionEpoch]);

  return (
    <section
      ref={graphRef}
      className="relative m-1 overflow-hidden rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-shell-bg)] pr-1 sm:m-3 sm:pr-7"
      aria-label={`开发闭环泳道图，当前停在${currentLabel}`}
      data-testid="workflow-swimlane-graph"
    >
      <WorkflowReturnRails
        workId={work.workId}
        reviewActive={reviewReturnActive}
        acceptanceActive={terminalRejected || work.deliveryCycleEntryMode === 'acceptance_rework'}
      />
      {hovered && <WorkflowHoverPreview id={tooltipId} work={work} selection={hovered.selection} top={hovered.top} />}

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
            current={currentNodeId === 'design'}
            owner="你"
            selected={inspection?.id === 'design-entry'}
            onInspect={inspect}
            onPreview={preview}
            describedBy={hovered?.selection.id === 'design-entry' ? tooltipId : undefined}
            controls={inspectorId}
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
            current={terminalRejected}
            owner="你"
            selected={inspection?.id === 'acceptance-rework-entry'}
            onInspect={inspect}
            onPreview={preview}
            describedBy={hovered?.selection.id === 'acceptance-rework-entry' ? tooltipId : undefined}
            controls={inspectorId}
            returnTarget="acceptance"
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
          current={currentNodeId === 'implementation'}
          owner="ChatGPT Desktop"
          selected={inspection?.id === 'implementation'}
          onInspect={inspect}
          onPreview={preview}
          describedBy={hovered?.selection.id === 'implementation' ? tooltipId : undefined}
          controls={inspectorId}
          returnTarget="review"
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
          <section
            className="mt-3 flex snap-x snap-mandatory items-stretch gap-2 overflow-x-auto overscroll-x-contain pb-2 md:grid md:grid-cols-[minmax(0,1fr)_22px_minmax(0,1fr)_22px_minmax(0,1fr)] md:gap-0 md:overflow-visible md:pb-0"
            data-testid="workflow-review-stages"
            aria-label="Review 三阶段，可横向滚动"
          >
            <ReviewStageNode
              id="independent_review"
              node={independentReview}
              title="独立检视"
              detail="草稿隔离"
              current={currentNodeId === 'independent_review'}
              selected={inspection?.id === 'independent_review'}
              onInspect={inspect}
              onPreview={preview}
              describedBy={hovered?.selection.id === 'independent_review' ? tooltipId : undefined}
              controls={inspectorId}
            />
            <ReviewLaneArrow />
            <ReviewStageNode
              id="cross_review"
              node={crossReview}
              title="交叉检视"
              detail="核验对方意见"
              current={currentNodeId === 'cross_review'}
              selected={inspection?.id === 'cross_review'}
              onInspect={inspect}
              onPreview={preview}
              describedBy={hovered?.selection.id === 'cross_review' ? tooltipId : undefined}
              controls={inspectorId}
            />
            <ReviewLaneArrow />
            <ReviewStageNode
              id="consensus"
              node={consensus}
              title="共识整理"
              detail="发布唯一共识"
              findingCount={work.openFindings.length}
              current={currentNodeId === 'consensus'}
              selected={inspection?.id === 'consensus'}
              onInspect={inspect}
              onPreview={preview}
              describedBy={hovered?.selection.id === 'consensus' ? tooltipId : undefined}
              controls={inspectorId}
            />
          </section>
        </div>
      </WorkflowLane>

      <LaneTransition label="共识 verdict" strong />

      <WorkflowLane tone="catcafe" label="CatCafe" caption="协调与门控">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1.05fr)_minmax(150px,0.75fr)]">
          <DecisionNode
            work={work}
            node={handoff}
            current={currentNodeId === 'handoff'}
            selected={inspection?.id === 'handoff'}
            onInspect={inspect}
            onPreview={preview}
            describedBy={hovered?.selection.id === 'handoff' ? tooltipId : undefined}
            controls={inspectorId}
          />
          <ul className="flex flex-col justify-center gap-2" aria-label="清零门分支">
            <RouteCard
              tone="warning"
              active={reviewReturnActive}
              symbol="↺"
              title="仍有检视意见："
              detail="回到 ChatGPT 修复，再次进入 Review"
              returnSource="review"
            />
            <RouteCard
              tone="success"
              active={mergeRouteActive}
              symbol="↓"
              title="检视意见清零"
              detail="进入 04 · 合入 main"
            />
          </ul>
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
            current={currentNodeId === 'merge'}
            owner="ChatGPT Desktop"
            selected={inspection?.id === 'merge'}
            onInspect={inspect}
            onPreview={preview}
            describedBy={hovered?.selection.id === 'merge' ? tooltipId : undefined}
            controls={inspectorId}
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
            current={currentNodeId === 'acceptance'}
            owner="你"
            selected={inspection?.id === 'acceptance'}
            onInspect={inspect}
            onPreview={preview}
            describedBy={hovered?.selection.id === 'acceptance' ? tooltipId : undefined}
            controls={inspectorId}
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
            current={terminalAccepted}
            owner="你"
            selected={inspection?.id === 'accepted-end'}
            onInspect={inspect}
            onPreview={preview}
            describedBy={hovered?.selection.id === 'accepted-end' ? tooltipId : undefined}
            controls={inspectorId}
          />
        </div>
        <div
          className={`mt-3 flex items-center rounded-xl border border-dashed border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] px-3 py-2 ${terminalRejected || work.deliveryCycleEntryMode === 'acceptance_rework' ? '' : 'opacity-50'}`}
          role="note"
          aria-label="验收未通过返工路径"
          data-return-source="acceptance"
        >
          <span className="mr-2 text-base text-[var(--semantic-warning)]">↶</span>
          <span className="text-micro font-medium text-cafe-secondary">
            验收未通过：返回入口 B，保留本轮证据并开启下一交付轮次
          </span>
        </div>
      </WorkflowLane>

      {inspection && (
        <WorkflowNodeInspector
          id={inspectorId}
          work={work}
          selection={inspection}
          onClose={closeInspection}
          retrying={retrying}
          onTriggerNode={onTriggerNode}
          startingDeliveryCycle={startingDeliveryCycle}
          onStartDeliveryCycle={onStartDeliveryCycle}
          onFocusManualAction={guideManualAction}
          onOpenReview={onOpenReview}
        />
      )}
    </section>
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
    <div className="grid grid-cols-1 border-b border-[var(--console-border-soft)] last:border-b-0 sm:grid-cols-[72px_minmax(0,1fr)]">
      <div className="relative flex flex-row items-center gap-2 border-b border-[var(--console-border-soft)] px-3 py-2 sm:flex-col sm:items-start sm:justify-center sm:gap-0 sm:border-r sm:border-b-0 sm:px-2 sm:py-4">
        <span className={`absolute inset-y-0 left-0 w-1 ${actorBarClass(tone)}`} aria-hidden="true" />
        <div className={`text-micro font-bold ${actorTextClass(tone)}`}>{label}</div>
        <div className="text-micro leading-tight text-cafe-secondary sm:mt-1">{caption}</div>
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
  current,
  owner,
  selected,
  onInspect,
  onPreview,
  describedBy,
  controls,
  returnTarget,
  dashed = false,
}: {
  id: WorkflowInspectionId;
  tone: ActorTone;
  step: string;
  title: string;
  detail: string;
  meta: string;
  status: GraphStatus;
  current: boolean;
  owner: string;
  selected: boolean;
  onInspect: (selection: WorkflowInspectionSelection, trigger: HTMLButtonElement) => void;
  onPreview: (selection: WorkflowInspectionSelection | null, trigger?: HTMLButtonElement) => void;
  describedBy?: string;
  controls: string;
  returnTarget?: 'review' | 'acceptance';
  dashed?: boolean;
}) {
  const selection = { id, title, owner, status } satisfies WorkflowInspectionSelection;
  return (
    <button
      type="button"
      className={`group relative min-h-[98px] w-full overflow-hidden rounded-2xl border border-l-4 p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mc-accent)] ${actorBorderClass(tone)} ${graphNodeClass(status)} ${dashed ? 'border-dashed' : ''} ${selected ? 'outline outline-2 outline-offset-2 outline-[var(--mc-accent)]' : ''}`}
      data-testid={`workflow-graph-node-${id}`}
      data-status={status}
      data-return-target={returnTarget}
      aria-current={current ? 'step' : undefined}
      aria-haspopup="dialog"
      aria-expanded={selected}
      aria-controls={controls}
      aria-describedby={describedBy}
      aria-label={`${title}，${graphStatusLabel(status)}。点击查看节点详情`}
      onMouseEnter={(event) => onPreview(selection, event.currentTarget)}
      onMouseLeave={() => onPreview(null)}
      onFocus={(event) => onPreview(selection, event.currentTarget)}
      onBlur={() => onPreview(null)}
      onClick={(event) => onInspect(selection, event.currentTarget)}
    >
      {current && status === 'active' && <ActiveNodePulse />}
      <div className="flex items-center justify-between gap-2">
        <StepBadge label={step} />
        <StatusBadge status={status} />
      </div>
      <div className="mt-2 text-xs font-semibold text-cafe">{title}</div>
      <div className="mt-1 text-micro text-cafe-secondary">{detail}</div>
      <div className="mt-1 text-micro leading-relaxed text-cafe-secondary opacity-80">{meta}</div>
    </button>
  );
}

function ReviewStageNode({
  id,
  node,
  title,
  detail,
  findingCount,
  current,
  selected,
  onInspect,
  onPreview,
  describedBy,
  controls,
}: {
  id: 'independent_review' | 'cross_review' | 'consensus';
  node: DesktopDevelopmentWorkflowNode | undefined;
  title: string;
  detail: string;
  findingCount?: number;
  current: boolean;
  selected: boolean;
  onInspect: (selection: WorkflowInspectionSelection, trigger: HTMLButtonElement) => void;
  onPreview: (selection: WorkflowInspectionSelection | null, trigger?: HTMLButtonElement) => void;
  describedBy?: string;
  controls: string;
}) {
  const status = node?.status ?? 'pending';
  const hasProgress = Boolean(node?.requiredCount);
  const progress = hasProgress ? `${node?.completedCount ?? 0}/${node?.requiredCount}` : graphStatusLabel(status);
  const owner = node ? workflowActorLabel(node.actor) : id === 'consensus' ? '共识记录猫猫' : 'Review 猫猫';
  const selection = { id, title, owner, status } satisfies WorkflowInspectionSelection;
  return (
    <button
      type="button"
      className={`group relative min-h-[94px] w-[148px] shrink-0 snap-start rounded-xl border border-l-4 p-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mc-accent)] md:w-auto md:min-w-0 ${actorBorderClass('review')} ${graphNodeClass(status)} ${selected ? 'outline outline-2 outline-offset-2 outline-[var(--mc-accent)]' : ''}`}
      data-testid={`workflow-graph-node-${id}`}
      data-status={status}
      aria-current={current ? 'step' : undefined}
      aria-haspopup="dialog"
      aria-expanded={selected}
      aria-controls={controls}
      aria-describedby={describedBy}
      aria-label={`${title}，${graphStatusLabel(status)}。点击查看 Review 详情`}
      onMouseEnter={(event) => onPreview(selection, event.currentTarget)}
      onMouseLeave={() => onPreview(null)}
      onFocus={(event) => onPreview(selection, event.currentTarget)}
      onBlur={() => onPreview(null)}
      onClick={(event) => onInspect(selection, event.currentTarget)}
    >
      {current && status === 'active' && <ActiveNodePulse />}
      <div className="flex items-start justify-between gap-1">
        <div className="text-micro font-semibold text-cafe">{title}</div>
        <StatusDot status={status} />
      </div>
      <div className="mt-1 text-micro text-cafe-secondary">{detail}</div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro font-semibold text-cafe">
        <span>{hasProgress ? `进度 ${progress}` : progress}</span>
        {findingCount !== undefined && <span>开放意见 {findingCount}</span>}
      </div>
    </button>
  );
}

function DecisionNode({
  work,
  node,
  current,
  selected,
  onInspect,
  onPreview,
  describedBy,
  controls,
}: {
  work: DesktopDevelopmentResumePacket;
  node: DesktopDevelopmentWorkflowNode | undefined;
  current: boolean;
  selected: boolean;
  onInspect: (selection: WorkflowInspectionSelection, trigger: HTMLButtonElement) => void;
  onPreview: (selection: WorkflowInspectionSelection | null, trigger?: HTMLButtonElement) => void;
  describedBy?: string;
  controls: string;
}) {
  const status = node?.status ?? 'pending';
  const owner = node ? workflowActorLabel(node.actor) : 'CatCafe 协调器';
  const selection = { id: 'handoff', title: '检视清零门', owner, status } satisfies WorkflowInspectionSelection;
  return (
    <button
      type="button"
      className={`group relative flex min-h-[120px] w-full items-center gap-4 overflow-hidden rounded-2xl border border-l-4 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mc-accent)] ${actorBorderClass('catcafe')} ${graphNodeClass(status)} ${selected ? 'outline outline-2 outline-offset-2 outline-[var(--mc-accent)]' : ''}`}
      data-testid="workflow-graph-node-review-gate"
      data-status={status}
      aria-current={current ? 'step' : undefined}
      aria-haspopup="dialog"
      aria-expanded={selected}
      aria-controls={controls}
      aria-describedby={describedBy}
      aria-label={`检视清零门，${graphStatusLabel(status)}。点击查看门控详情`}
      onMouseEnter={(event) => onPreview(selection, event.currentTarget)}
      onMouseLeave={() => onPreview(null)}
      onFocus={(event) => onPreview(selection, event.currentTarget)}
      onBlur={() => onPreview(null)}
      onClick={(event) => onInspect(selection, event.currentTarget)}
    >
      {current && status === 'active' && <ActiveNodePulse />}
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
    </button>
  );
}

function ActiveNodePulse() {
  return (
    <span
      className="pointer-events-none absolute inset-1 rounded-[inherit] border-2 border-[var(--mc-accent)] opacity-50 motion-safe:animate-pulse"
      aria-hidden="true"
      data-testid="workflow-active-pulse"
    />
  );
}

function WorkflowHoverPreview({
  id,
  work,
  selection,
  top,
}: {
  id: string;
  work: DesktopDevelopmentResumePacket;
  selection: WorkflowInspectionSelection;
  top: number;
}) {
  return (
    <div
      id={id}
      role="tooltip"
      className="pointer-events-none absolute right-9 z-30 w-[min(250px,calc(100%-7rem))] rounded-xl border border-[var(--console-border-strong)] bg-[var(--console-card-bg)] p-3 shadow-lg"
      style={{ top }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-cafe">{selection.title}</span>
        <StatusBadge status={selection.status} />
      </div>
      <div className="mt-2 space-y-1 text-micro text-cafe-secondary">
        <div>负责人：{selection.owner}</div>
        <div className="break-all">{inspectionShaLine(work, selection.id)}</div>
        <div>{inspectionDetailLine(work, selection.id)}</div>
      </div>
      <div className="mt-2 text-micro font-medium text-[var(--mc-accent)]">点击固定详情</div>
    </div>
  );
}

function WorkflowNodeInspector({
  id,
  work,
  selection,
  onClose,
  retrying,
  onTriggerNode,
  startingDeliveryCycle,
  onStartDeliveryCycle,
  onFocusManualAction,
  onOpenReview,
}: {
  id: string;
  work: DesktopDevelopmentResumePacket;
  selection: WorkflowInspectionSelection;
  onClose: () => void;
  retrying: boolean;
  onTriggerNode: (nodeId: DesktopDevelopmentWorkflowNode['id']) => void;
  startingDeliveryCycle: boolean;
  onStartDeliveryCycle?: () => void;
  onFocusManualAction?: (action: DesktopDevelopmentManualAction) => void;
  onOpenReview?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const node = workflowNodeForInspection(work, selection.id);
  const reviewInspection = isReviewInspection(selection.id);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div
      ref={dialogRef}
      id={id}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-title`}
      tabIndex={-1}
      className="relative border-t border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-4 focus:outline-none"
      data-testid="workflow-node-inspector"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h5 id={`${id}-title`} className="text-xs font-semibold text-cafe">
              {selection.title} · 节点详情
            </h5>
            <StatusBadge status={selection.status} />
          </div>
          <p className="mt-1 text-micro text-cafe-secondary">负责人：{selection.owner}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-[var(--console-border-soft)] px-2 py-1 text-micro text-cafe-secondary hover:text-cafe"
          aria-label="关闭节点详情"
        >
          关闭
        </button>
      </div>

      <dl className="mt-3 grid gap-2 text-micro sm:grid-cols-2">
        <InspectorFact label="精确版本" value={inspectionShaLine(work, selection.id)} mono />
        <InspectorFact label="当前上下文" value={inspectionDetailLine(work, selection.id)} />
        <InspectorFact label="开始时间" value={formatWorkflowTime(node?.startedAt)} />
        <InspectorFact label="完成时间" value={formatWorkflowTime(node?.completedAt)} />
      </dl>

      {node?.requiredCount ? (
        <div className="mt-3 rounded-xl bg-[var(--console-shell-bg)] px-3 py-2 text-micro text-cafe-secondary">
          阶段进度：{node.completedCount ?? 0}/{node.requiredCount}
        </div>
      ) : null}

      <div className="mt-3">
        <div className="text-micro font-semibold text-cafe">下一合法动作</div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {work.nextLegalActions.length > 0 ? (
            work.nextLegalActions.map((action) => (
              <span
                key={action}
                className="rounded-full border border-[var(--console-border-soft)] bg-[var(--console-shell-bg)] px-2 py-1 text-micro text-cafe-secondary"
              >
                {legalActionLabel(action)}
              </span>
            ))
          ) : (
            <span className="text-micro text-cafe-secondary">当前没有需要执行的动作</span>
          )}
        </div>
      </div>

      <WorkflowNodeCommand
        work={work}
        selection={selection}
        node={node}
        retrying={retrying}
        onTriggerNode={onTriggerNode}
        startingDeliveryCycle={startingDeliveryCycle}
        onStartDeliveryCycle={onStartDeliveryCycle}
        onFocusManualAction={onFocusManualAction}
      />

      {reviewInspection && (
        <div className="mt-3 rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-shell-bg)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-micro font-semibold text-cafe">开放检视意见 {work.openFindings.length} 项</div>
              <div className="mt-0.5 text-micro text-cafe-secondary">
                ReviewRound：{work.reviewRoundId ?? '尚未创建'}
              </div>
            </div>
            {onOpenReview && (
              <button
                type="button"
                onClick={onOpenReview}
                className="rounded-lg bg-[var(--mc-accent)] px-3 py-2 text-micro font-medium text-[var(--cafe-surface)]"
              >
                打开 Review 会话
              </button>
            )}
          </div>
          {work.openFindings.length > 0 && (
            <ul className="mt-2 max-h-40 space-y-2 overflow-y-auto" aria-label="开放检视意见">
              {work.openFindings.map((finding) => (
                <li
                  key={finding.findingId}
                  className="rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-2.5 py-2"
                >
                  <div className="flex items-start gap-2">
                    <span className="rounded-md bg-[var(--semantic-warning-surface)] px-1.5 py-0.5 text-micro font-semibold text-[var(--semantic-warning)]">
                      {finding.severity}
                    </span>
                    <div className="min-w-0">
                      <div className="text-micro font-medium text-cafe">{finding.summary}</div>
                      <div className="mt-1 text-micro text-cafe-secondary">
                        {findingScopeLabel(finding.scope)} · 设计引用 {finding.designRefs.length} · 证据{' '}
                        {finding.evidenceRefs.length}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function WorkflowNodeCommand({
  work,
  selection,
  node,
  retrying,
  onTriggerNode,
  startingDeliveryCycle,
  onStartDeliveryCycle,
  onFocusManualAction,
}: {
  work: DesktopDevelopmentResumePacket;
  selection: WorkflowInspectionSelection;
  node: DesktopDevelopmentWorkflowNode | undefined;
  retrying: boolean;
  onTriggerNode: (nodeId: DesktopDevelopmentWorkflowNode['id']) => void;
  startingDeliveryCycle: boolean;
  onStartDeliveryCycle?: () => void;
  onFocusManualAction?: (action: DesktopDevelopmentManualAction) => void;
}) {
  const command = deriveWorkflowNodeCommand(work, selection, node);
  const reasonId = `workflow-node-command-reason-${encodeURIComponent(work.workId)}-${selection.id}`;

  return (
    <div
      className="mt-3 rounded-xl border border-[var(--console-border-strong)] bg-[var(--console-shell-bg)] p-3"
      data-testid="workflow-node-command"
    >
      <div className="text-micro font-semibold text-cafe">从此节点操作</div>
      <WorkflowNodeCommandButton
        command={command}
        reasonId={reasonId}
        retrying={retrying}
        onTriggerNode={onTriggerNode}
        startingDeliveryCycle={startingDeliveryCycle}
        onStartDeliveryCycle={onStartDeliveryCycle}
        onFocusManualAction={onFocusManualAction}
      />
      <p id={reasonId} className="mt-2 text-micro leading-relaxed text-cafe-secondary">
        {command.reason}
      </p>
    </div>
  );
}

function WorkflowNodeCommandButton({
  command,
  reasonId,
  retrying,
  onTriggerNode,
  startingDeliveryCycle,
  onStartDeliveryCycle,
  onFocusManualAction,
}: {
  command: WorkflowNodeCommandModel;
  reasonId: string;
  retrying: boolean;
  onTriggerNode: (nodeId: DesktopDevelopmentWorkflowNode['id']) => void;
  startingDeliveryCycle: boolean;
  onStartDeliveryCycle?: () => void;
  onFocusManualAction?: (action: DesktopDevelopmentManualAction) => void;
}) {
  if (command.kind === 'direct') {
    return (
      <WorkflowCommandButton
        label={retrying ? '触发中...' : directNodeActionLabel(command.action)}
        testId={`workflow-trigger-node-${command.nodeId}`}
        describedBy={reasonId}
        disabled={retrying}
        onClick={() => onTriggerNode(command.nodeId)}
      />
    );
  }
  if (command.kind === 'entry' && onStartDeliveryCycle) {
    return (
      <WorkflowCommandButton
        label={startingDeliveryCycle ? '开启中...' : entryNodeActionLabel(command.entryId)}
        testId={`workflow-trigger-node-${command.entryId}`}
        describedBy={reasonId}
        disabled={startingDeliveryCycle}
        onClick={onStartDeliveryCycle}
      />
    );
  }
  if (command.kind === 'guided' && onFocusManualAction) {
    return (
      <WorkflowCommandButton
        label={guidedNodeActionLabel(command.action)}
        testId={`workflow-guide-node-${command.nodeId}`}
        describedBy={reasonId}
        onClick={() => onFocusManualAction(command.action)}
      />
    );
  }
  return (
    <button
      type="button"
      aria-disabled="true"
      aria-describedby={reasonId}
      onClick={(event) => event.preventDefault()}
      className="mt-2 cursor-not-allowed rounded-lg border border-[var(--console-border-soft)] px-3 py-2 text-micro font-medium text-cafe-secondary"
    >
      当前不可触发
    </button>
  );
}

function WorkflowCommandButton({
  label,
  testId,
  describedBy,
  disabled = false,
  onClick,
}: {
  label: string;
  testId: string;
  describedBy: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-describedby={describedBy}
      className="mt-2 rounded-lg bg-[var(--mc-accent)] px-3 py-2 text-micro font-medium text-[var(--cafe-surface)] disabled:opacity-40"
      data-testid={testId}
    >
      {label}
    </button>
  );
}

function InspectorFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl bg-[var(--console-shell-bg)] px-3 py-2">
      <dt className="text-cafe-secondary">{label}</dt>
      <dd className={`mt-1 break-all text-cafe ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

function RouteCard({
  tone,
  active,
  symbol,
  title,
  detail,
  returnSource,
}: {
  tone: 'warning' | 'success';
  active: boolean;
  symbol: string;
  title: string;
  detail: string;
  returnSource?: 'review';
}) {
  const activeClass =
    tone === 'warning'
      ? 'border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] text-[var(--semantic-warning)]'
      : 'border-[var(--semantic-success)] bg-[var(--semantic-success-surface)] text-[var(--semantic-success)]';
  const inactiveClass = 'border-[var(--console-border-soft)] bg-[var(--console-card-bg)] text-cafe-secondary';
  return (
    <li
      className={`rounded-xl border border-dashed p-2.5 ${active ? `${activeClass} shadow-sm` : inactiveClass}`}
      data-active={active}
      data-return-source={returnSource}
    >
      <div className="flex items-center gap-2">
        <span className="text-base font-bold">{symbol}</span>
        <div>
          <div className="text-micro font-semibold">{title}</div>
          <div className="mt-0.5 text-micro text-cafe-secondary">{detail}</div>
        </div>
      </div>
    </li>
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
  const svgRef = useRef<SVGSVGElement>(null);
  const [geometry, setGeometry] = useState<ReturnRailGeometry | null>(null);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    const graph = svg?.parentElement;
    if (!svg || !graph) return;

    const measure = () => {
      const graphRect = graph.getBoundingClientRect();
      if (graphRect.width <= 0 || graphRect.height <= 0) return;

      const buildRail = (
        sourceName: 'review' | 'acceptance',
        targetName: 'review' | 'acceptance',
        railInset: number,
      ): ReturnRailPath | null => {
        const source = graph.querySelector<HTMLElement>(`[data-return-source="${sourceName}"]`);
        const target = graph.querySelector<HTMLElement>(`[data-return-target="${targetName}"]`);
        if (!source || !target) return null;
        const sourceRect = source.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        return {
          startX: sourceRect.right - graphRect.left + 3,
          startY: sourceRect.top - graphRect.top + sourceRect.height / 2,
          railX: graphRect.width - railInset,
          endX: targetRect.right - graphRect.left + 3,
          endY: targetRect.top - graphRect.top + targetRect.height / 2,
        };
      };

      const next = {
        review: buildRail('review', 'review', 12),
        acceptance: buildRail('acceptance', 'acceptance', 4),
      } satisfies ReturnRailGeometry;
      setGeometry((current) => (sameReturnRailGeometry(current, next) ? current : next));
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(graph);
    for (const element of graph.querySelectorAll<HTMLElement>('[data-return-source], [data-return-target]')) {
      observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <svg
      ref={svgRef}
      className="pointer-events-none absolute inset-0 z-10 hidden h-full w-full sm:block"
      width="100%"
      height="100%"
      aria-hidden="true"
      focusable="false"
      data-testid="workflow-return-rails"
    >
      <defs>
        <marker
          id={markerId}
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,0 L6,3 L0,6 Z" fill="var(--semantic-warning)" />
        </marker>
      </defs>
      {geometry?.review && (
        <ReturnRailPathElement path={geometry.review} markerId={markerId} active={reviewActive} dash="5 4" />
      )}
      {geometry?.acceptance && (
        <ReturnRailPathElement path={geometry.acceptance} markerId={markerId} active={acceptanceActive} dash="3 4" />
      )}
    </svg>
  );
}

interface ReturnRailPath {
  readonly startX: number;
  readonly startY: number;
  readonly railX: number;
  readonly endX: number;
  readonly endY: number;
}

interface ReturnRailGeometry {
  readonly review: ReturnRailPath | null;
  readonly acceptance: ReturnRailPath | null;
}

function ReturnRailPathElement({
  path,
  markerId,
  active,
  dash,
}: {
  path: ReturnRailPath;
  markerId: string;
  active: boolean;
  dash: string;
}) {
  return (
    <>
      <circle
        cx={path.startX}
        cy={path.startY}
        r={active ? 2.5 : 2}
        fill="var(--semantic-warning)"
        opacity={active ? 1 : 0.3}
      />
      <path
        d={`M ${path.startX} ${path.startY} H ${path.railX} V ${path.endY} H ${path.endX}`}
        fill="none"
        stroke="var(--semantic-warning)"
        strokeWidth={active ? 2 : 1}
        strokeDasharray={dash}
        opacity={active ? 1 : 0.28}
        markerEnd={`url(#${markerId})`}
        vectorEffect="non-scaling-stroke"
      />
    </>
  );
}

function sameReturnRailGeometry(current: ReturnRailGeometry | null, next: ReturnRailGeometry): boolean {
  return (
    sameReturnRail(current?.review ?? null, next.review) && sameReturnRail(current?.acceptance ?? null, next.acceptance)
  );
}

function sameReturnRail(current: ReturnRailPath | null, next: ReturnRailPath | null): boolean {
  if (!current || !next) return current === next;
  return (
    current.startX === next.startX &&
    current.startY === next.startY &&
    current.railX === next.railX &&
    current.endX === next.endX &&
    current.endY === next.endY
  );
}

function LaneTransition({ label, strong = false }: { label: string; strong?: boolean }) {
  const lineClass = strong ? 'bg-[var(--mc-accent)]' : 'bg-[var(--console-border-strong)]';
  const arrowClass = strong ? 'border-t-[var(--mc-accent)]' : 'border-t-[var(--console-border-strong)]';
  return (
    <div className="grid h-8 grid-cols-1 sm:grid-cols-[72px_minmax(0,1fr)]">
      <div className="hidden border-r border-[var(--console-border-soft)] sm:block" aria-hidden="true" />
      <div className="relative flex items-center justify-center">
        <span className={`absolute inset-y-0 left-1/2 w-px ${lineClass}`} aria-hidden="true" />
        <span
          className={`absolute top-0 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full ${lineClass}`}
          aria-hidden="true"
        />
        <span className="relative rounded-full bg-[var(--console-shell-bg)] px-2 py-0.5 text-micro font-medium text-cafe-secondary">
          <span className="sr-only">流程转移：</span>
          {label}
        </span>
        <span
          className={`absolute bottom-0 left-1/2 h-0 w-0 -translate-x-[3px] border-x-[4px] border-t-[6px] border-x-transparent ${arrowClass}`}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

function ReviewLaneArrow() {
  return (
    <div className="flex w-6 shrink-0 items-center justify-center px-1 md:w-auto" aria-hidden="true">
      <span className="h-px flex-1 bg-[var(--mc-slice-hardening)]" />
      <span className="h-0 w-0 border-y-[4px] border-l-[6px] border-y-transparent border-l-[var(--mc-slice-hardening)]" />
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

function workflowNodeForInspection(
  work: DesktopDevelopmentResumePacket,
  id: WorkflowInspectionId,
): DesktopDevelopmentWorkflowNode | undefined {
  const nodeId =
    id === 'design-entry' ? 'design' : id === 'acceptance-rework-entry' || id === 'accepted-end' ? null : id;
  return nodeId ? work.workflowNodes.find((node) => node.id === nodeId) : undefined;
}

function inspectionShaLine(work: DesktopDevelopmentResumePacket, id: WorkflowInspectionId): string {
  if (id === 'design-entry') {
    return `方案 ${work.designBranch ?? '未配置'}@${shortSha(work.designExactSha)}`;
  }
  if (isReviewInspection(id) && work.reviewDesignExactSha) {
    return `实现 ${shortSha(work.currentSha)} · 方案 ${shortSha(work.reviewDesignExactSha)}`;
  }
  return `实现 ${work.branch}@${shortSha(work.currentSha)}`;
}

function inspectionDetailLine(work: DesktopDevelopmentResumePacket, id: WorkflowInspectionId): string {
  switch (id) {
    case 'design-entry':
      return work.designDocuments.length > 0 ? `${work.designDocuments.length} 份中文设计文档` : '尚未选择设计文档';
    case 'acceptance-rework-entry':
      return `交付 #${work.deliveryCycleNumber} · 验收返工入口`;
    case 'implementation':
      return `实现 #${work.attemptNumber} · 绑定代次 ${work.bindingEpoch} · ${work.sessionStatus}`;
    case 'independent_review':
    case 'cross_review':
    case 'consensus':
      return `Review ${work.reviewPhase ?? '未开始'} · 开放意见 ${work.openFindings.length}`;
    case 'handoff':
      return `${handoffDetail(work)} · 开放意见 ${work.openFindings.length}`;
    case 'merge':
      return work.merged ? '已经合入 main' : `合入方式：${mergeModeLabel(work.mergeMode)}`;
    case 'acceptance':
      return work.acceptancePending ? '等待你的最终体验验收' : '尚未进入最终验收';
    case 'accepted-end':
      return work.phase === 'accepted' ? '本交付轮次已经结束' : '验收通过后结束本交付轮次';
  }
}

function isReviewInspection(id: WorkflowInspectionId): boolean {
  return id === 'independent_review' || id === 'cross_review' || id === 'consensus' || id === 'handoff';
}

function formatWorkflowTime(value: number | null | undefined): string {
  if (!value) return '暂无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function mergeModeLabel(mode: DesktopDevelopmentResumePacket['mergeMode']): string {
  return mode === 'manual_confirm_in_chatgpt' ? 'ChatGPT 窗口人工确认' : '自动合入';
}

function findingScopeLabel(scope: DesktopDevelopmentResumePacket['openFindings'][number]['scope']): string {
  return scope === 'architecture_decision' ? '架构决策' : '方案符合性';
}

function legalActionLabel(action: string): string {
  switch (action) {
    case 'configure_design_branch':
      return '配置方案分支';
    case 'rebind_session':
      return '重新绑定 Desktop 窗口';
    case 'rebuild_worktree_from_last_committed_sha':
      return '从最后提交恢复工作区';
    case 'commit_changes_before_report':
      return '先提交当前改动';
    case 'implement_and_report_committed_sha':
      return '实现并报告精确提交';
    case 'report_new_committed_sha':
      return '报告新的精确提交';
    case 'fix_open_findings':
      return '修复开放检视意见';
    case 'wait_for_independent_review':
      return '等待独立检视';
    case 'wait_for_cross_review':
      return '等待交叉检视';
    case 'wait_for_review_evidence':
      return '等待检视证据';
    case 'wait_for_consensus':
      return '等待形成共识';
    case 'authorize_review_consensus':
      return '授权提交最终共识';
    case 'wait_for_authorized_consensus':
      return '等待已授权共识';
    case 'start_fix_attempt':
      return '开启下一次修复';
    case 'request_user_architecture_decision':
      return '请求你的架构决策';
    case 'request_review_continuation_approval':
      return '请求继续 Review';
    case 'request_merge_confirmation':
      return '请求合入确认';
    case 'merge_with_native_git':
      return '使用原生 Git 合入';
    case 'wait_for_final_acceptance':
      return '等待最终体验验收';
    default:
      return action;
  }
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

function isDirectManualAction(action: DesktopDevelopmentManualAction): action is DirectManualAction {
  return action === 'wake_desktop' || action === 'replay_review_stage';
}

function directNodeActionLabel(action: DirectManualAction): string {
  return action === 'wake_desktop' ? '从此节点触发 ChatGPT' : '从此节点重触发 Review';
}

function entryNodeActionLabel(entryId: 'design-entry' | 'acceptance-rework-entry'): string {
  return entryId === 'design-entry' ? '从方案变更入口开启' : '从返工入口开启';
}

function guidedNodeActionLabel(action: GuidedManualAction) {
  switch (action) {
    case 'configure_design_branch':
      return '前往配置方案分支';
    case 'record_architecture_decision':
      return '前往处理方案分歧';
    case 'approve_review_continuation':
      return '前往批准继续 Review';
    case 'record_acceptance':
      return '前往最终验收';
  }
}

function deriveWorkflowNodeCommand(
  work: DesktopDevelopmentResumePacket,
  selection: WorkflowInspectionSelection,
  node: DesktopDevelopmentWorkflowNode | undefined,
): WorkflowNodeCommandModel {
  const manualAction = node?.manualAction;
  const currentNode = firstCurrentWorkflowNode(work.workflowNodes);
  const selectedCurrentNode = Boolean(node && currentNode?.id === node.id);
  if (node && selectedCurrentNode && manualAction && isDirectManualAction(manualAction)) {
    return {
      kind: 'direct',
      nodeId: node.id,
      action: manualAction,
      reason: '只会重触发这个当前节点；服务端会再次校验节点、实现轮次和状态版本，不会跳过前后门禁。',
    };
  }
  if (selection.id === 'design-entry' && work.phase === 'accepted') {
    return {
      kind: 'entry',
      entryId: selection.id,
      reason: '将保留上一交付轮次证据，并从当前方案分支开启新的方案变更轮次。',
    };
  }
  if (selection.id === 'acceptance-rework-entry' && work.phase === 'rejected') {
    return {
      kind: 'entry',
      entryId: selection.id,
      reason: '将保留验收失败证据，并从返工入口开启新的实现与 Review 循环。',
    };
  }
  if (node && selectedCurrentNode && manualAction && !isDirectManualAction(manualAction)) {
    return {
      kind: 'guided',
      nodeId: node.id,
      action: manualAction,
      reason: `${workflowActionLabel(manualAction)}；该节点需要你的明确选择，不能用无参数重触发代替。`,
    };
  }
  return { kind: 'unavailable', reason: unavailableNodeCommandReason(work, selection) };
}

function unavailableNodeCommandReason(
  work: DesktopDevelopmentResumePacket,
  selection: WorkflowInspectionSelection,
): string {
  const recoveryReason = unavailableImplementationRecoveryReason(work, selection);
  if (recoveryReason) return recoveryReason;
  if (selection.id === 'accepted-end') {
    return work.phase === 'accepted'
      ? '本轮已经结束；如方案有新增或变更，请选择入口 A 开启新交付轮次。'
      : '结束节点只展示结果，验收通过后由系统自动到达。';
  }
  if (selection.id === 'design-entry') {
    return work.phase === 'rejected'
      ? '本轮验收未通过，请从入口 B 开启返工；如果方案也有变化，请先提交方案分支。'
      : '当前交付仍在进行，不能同时开启另一交付轮次。';
  }
  if (selection.id === 'acceptance-rework-entry') {
    return '只有最终验收未通过后，才允许从返工入口开启下一交付轮次。';
  }
  if (selection.status === 'completed') return '本节点已经完成；为避免重复投递，历史节点不能直接重放。';
  if (selection.status === 'pending') return '前置节点尚未完成，不能越过当前门禁提前触发。';
  if (selection.status === 'blocked') return '另一个前置门禁仍在阻塞；请先处理流程中最靠前的阻塞节点。';
  if (selection.status === 'available') return '这个入口已经可以开启下一交付轮次。';
  if (selection.status === 'inactive') return '本轮没有选择这个入口。';
  return '该节点由服务端状态推进，当前没有可执行的人工动作。';
}

function unavailableImplementationRecoveryReason(
  work: DesktopDevelopmentResumePacket,
  selection: WorkflowInspectionSelection,
): string | null {
  if (selection.id !== 'implementation') return null;
  if (work.nextLegalActions.includes('rebind_session')) {
    return '需先重新绑定 ChatGPT Desktop 会话；绑定恢复前不能直接触发实现节点。';
  }
  if (work.nextLegalActions.includes('rebuild_worktree_from_last_committed_sha')) {
    return '需先从最后提交恢复永久 worktree；工作区恢复前不能直接触发实现节点。';
  }
  return null;
}

function firstCurrentWorkflowNode(
  nodes: readonly DesktopDevelopmentWorkflowNode[],
): DesktopDevelopmentWorkflowNode | undefined {
  return nodes.find((candidate) => candidate.status === 'active' || candidate.status === 'blocked');
}

function graphStatusLabel(status: GraphStatus): string {
  switch (status) {
    case 'pending':
      return '未到达';
    case 'inactive':
      return '本轮未选';
    case 'available':
      return '可开启';
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
    case 'available':
      return 'border-[var(--mc-accent)] bg-[var(--console-card-bg)] shadow-sm';
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
    case 'available':
      return 'bg-[var(--mc-accent)]';
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
    case 'available':
      return 'border-[var(--mc-accent)] bg-[var(--console-card-bg)]';
  }
}
