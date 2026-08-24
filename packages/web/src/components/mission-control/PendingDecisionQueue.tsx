'use client';

import type { DesktopDevelopmentResumePacket } from '@cat-cafe/shared';

export type PendingDecisionKind = 'acceptance' | 'architecture' | 'continuation' | 'consensus';

export interface PendingDecisionItem {
  readonly backlogItemId: string;
  readonly featureId: string;
  readonly title: string;
  readonly kind: PendingDecisionKind;
  readonly work: DesktopDevelopmentResumePacket;
}

function kindLabel(kind: PendingDecisionKind): string {
  switch (kind) {
    case 'acceptance':
      return '等待最终验收';
    case 'architecture':
      return '方案分歧待裁决';
    case 'continuation':
      return 'Review 轮次达上限';
    case 'consensus':
      return 'Review 共识可由你裁决';
  }
}

function kindDetail(item: PendingDecisionItem): string {
  switch (item.kind) {
    case 'acceptance':
      return `交付 #${item.work.deliveryCycleNumber} 已合入，等待你的验收结果`;
    case 'architecture': {
      const count = item.work.openFindings.filter(
        (finding) => finding.scope === 'architecture_decision' && !finding.architectureDecisionRecorded,
      ).length;
      return `${count} 项 Review 与方案分支的分歧需要你拍板`;
    }
    case 'continuation':
      return `已达本组 ${item.work.reviewAttemptLimit} 次 Review 上限，批准后才会继续`;
    case 'consensus':
      return '现有 reviewer 未形成共识，可由你给出最终裁决';
  }
}

/**
 * 方案 A · 批次 3 — "待你处理"队列。
 *
 * 聚合四类必须用户拍板的事项（最终验收 / 架构分歧 / Review 续批 / 共识裁决），
 * 置顶展示；简单二元决策（验收、续批）直接在队列内完成，需要上下文的
 * （分歧、共识）跳转到对应功能卡片处理。
 */
export function PendingDecisionQueue({
  items,
  acceptingWorkId,
  decisionBusy,
  onAccept,
  onApproveContinuation,
  onJump,
}: {
  items: readonly PendingDecisionItem[];
  acceptingWorkId: string | null;
  decisionBusy: boolean;
  onAccept: (work: DesktopDevelopmentResumePacket, accepted: boolean) => void;
  onApproveContinuation: (work: DesktopDevelopmentResumePacket) => void;
  onJump: (backlogItemId: string) => void;
}) {
  if (items.length === 0) {
    return (
      <p className="text-micro text-cafe-secondary" data-testid="pending-decision-empty">
        当前没有需要你处理的事项。
      </p>
    );
  }

  return (
    <section
      className="rounded-xl border border-dashed border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] p-3"
      aria-label="待你处理的事项"
      data-testid="pending-decision-queue"
    >
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold text-cafe">待你处理</h4>
        <span className="rounded-full bg-[var(--semantic-warning)] px-2 py-0.5 text-micro font-semibold text-[var(--cafe-surface)]">
          {items.length}
        </span>
      </div>
      <ul className="mt-2 space-y-2">
        {items.map((item) => (
          <li
            key={`${item.backlogItemId}:${item.kind}`}
            className="rounded-lg bg-[var(--console-card-bg)] px-3 py-2"
            data-testid={`pending-decision-${item.kind}-${item.backlogItemId}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-medium text-cafe">
                  {item.featureId} · {kindLabel(item.kind)}
                </div>
                <div className="mt-0.5 text-micro text-cafe-secondary">{kindDetail(item)}</div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {item.kind === 'acceptance' && (
                  <>
                    <button
                      type="button"
                      onClick={() => onAccept(item.work, true)}
                      disabled={acceptingWorkId === item.work.workId}
                      className="console-button-primary disabled:opacity-40"
                    >
                      验收通过
                    </button>
                    <button
                      type="button"
                      onClick={() => onAccept(item.work, false)}
                      disabled={acceptingWorkId === item.work.workId}
                      className="console-button-secondary disabled:opacity-40"
                    >
                      验收未通过
                    </button>
                  </>
                )}
                {item.kind === 'continuation' && (
                  <button
                    type="button"
                    onClick={() => onApproveContinuation(item.work)}
                    disabled={decisionBusy}
                    className="console-button-primary disabled:opacity-40"
                  >
                    批准继续 Review
                  </button>
                )}
                {(item.kind === 'architecture' || item.kind === 'consensus') && (
                  <button type="button" onClick={() => onJump(item.backlogItemId)} className="console-button-secondary">
                    去处理
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
