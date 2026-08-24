'use client';

import type { DesktopDevelopmentResumePacket, DesktopDevelopmentWorkflowNode } from '@cat-cafe/shared';

type StepStatus = DesktopDevelopmentWorkflowNode['status'] | 'inactive';

interface StepDescriptor {
  readonly key: string;
  readonly label: string;
  readonly status: StepStatus;
}

function nodeStatus(
  nodes: readonly DesktopDevelopmentWorkflowNode[],
  id: DesktopDevelopmentWorkflowNode['id'],
): StepStatus {
  return nodes.find((node) => node.id === id)?.status ?? 'pending';
}

function aggregateReviewStatus(nodes: readonly DesktopDevelopmentWorkflowNode[]): StepStatus {
  const reviewNodes = nodes.filter(
    (node) => node.id === 'independent_review' || node.id === 'cross_review' || node.id === 'consensus',
  );
  if (reviewNodes.some((node) => node.status === 'blocked')) return 'blocked';
  if (reviewNodes.some((node) => node.status === 'active')) return 'active';
  if (reviewNodes.length > 0 && reviewNodes.every((node) => node.status === 'completed')) return 'completed';
  return 'pending';
}

function deriveSteps(work: DesktopDevelopmentResumePacket): StepDescriptor[] {
  const nodes = work.workflowNodes ?? [];
  const rework = work.deliveryCycleEntryMode === 'acceptance_rework';
  const entryStatus: StepStatus = rework ? 'completed' : nodeStatus(nodes, 'design');
  const acceptanceStatus: StepStatus =
    work.phase === 'accepted' ? 'completed' : work.phase === 'rejected' ? 'blocked' : nodeStatus(nodes, 'acceptance');
  return [
    { key: 'entry', label: rework ? '入口 B' : '入口 A', status: entryStatus },
    { key: 'implementation', label: '实现', status: nodeStatus(nodes, 'implementation') },
    { key: 'review', label: 'Review', status: aggregateReviewStatus(nodes) },
    { key: 'handoff', label: '清零门', status: nodeStatus(nodes, 'handoff') },
    { key: 'merge', label: '合入', status: nodeStatus(nodes, 'merge') },
    { key: 'acceptance', label: '验收', status: acceptanceStatus },
  ];
}

function stepDotClass(status: StepStatus): string {
  switch (status) {
    case 'active':
      return 'bg-[var(--mc-accent)]';
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

function stepLabelClass(status: StepStatus): string {
  switch (status) {
    case 'active':
      return 'font-semibold text-cafe';
    case 'blocked':
      return 'font-semibold text-[var(--semantic-warning)]';
    case 'completed':
      return 'text-cafe-secondary';
    default:
      return 'text-cafe-secondary opacity-70';
  }
}

/**
 * 方案 A · 批次 4 — 开发闭环横向 Stepper。
 *
 * 功能卡片折叠态的一行式流程概览：入口 → 实现 → Review → 清零门 → 合入 → 验收。
 * 完整泳道图在卡片展开后由 DesktopDevelopmentWorkflowGraph 呈现。
 */
export function WorkflowStepper({ work }: { work: DesktopDevelopmentResumePacket }) {
  const steps = deriveSteps(work);
  const current = steps.find((step) => step.status === 'blocked') ?? steps.find((step) => step.status === 'active');
  return (
    <section
      className="flex items-center gap-1 overflow-x-auto"
      data-testid="workflow-stepper"
      aria-label={current ? `开发闭环进度，当前停在${current.label}` : '开发闭环进度'}
    >
      {steps.map((step, index) => (
        <div key={step.key} className="flex shrink-0 items-center gap-1">
          {index > 0 && (
            <span
              className={`h-px w-3 sm:w-5 ${
                step.status === 'completed' ? 'bg-[var(--semantic-success)]' : 'bg-[var(--console-border-soft)]'
              }`}
              aria-hidden="true"
            />
          )}
          <span
            className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 ${
              step.status === 'active' || step.status === 'blocked' ? 'bg-[var(--console-active-bg)]' : ''
            }`}
            data-status={step.status}
            data-testid={`workflow-stepper-step-${step.key}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${stepDotClass(step.status)}`} aria-hidden="true" />
            <span className={`whitespace-nowrap text-micro ${stepLabelClass(step.status)}`}>{step.label}</span>
          </span>
        </div>
      ))}
    </section>
  );
}
