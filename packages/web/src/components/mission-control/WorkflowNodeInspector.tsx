'use client';

import type { DesktopDevelopmentResumePacket } from '@cat-cafe/shared';
import { useEffect, useRef } from 'react';
import { InspectorFact, StatusBadge } from './workflow-graph-parts';
import {
  findingScopeLabel,
  formatWorkflowTime,
  inspectionDetailLine,
  inspectionShaLine,
  isReviewInspection,
  legalActionLabel,
  type WorkflowInspectionSelection,
  workflowNodeForInspection,
} from './workflow-graph-support';

/** EXT-001 泳道图（时间轴版）详情层 — hover 浮层与点击固定的节点详情 */

export function WorkflowHoverPreview({
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
      className="pointer-events-none absolute right-12 z-30 w-[min(250px,calc(100%-7rem))] rounded-xl border border-[var(--console-border-strong)] bg-[var(--console-card-bg)] p-3 shadow-lg"
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

export function WorkflowNodeInspector({
  id,
  work,
  selection,
  onClose,
  onOpenReview,
}: {
  id: string;
  work: DesktopDevelopmentResumePacket;
  selection: WorkflowInspectionSelection;
  onClose: () => void;
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
