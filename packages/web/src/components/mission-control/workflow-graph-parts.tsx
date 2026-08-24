'use client';

import type { ReactNode } from 'react';
import {
  type ActorTone,
  actorDotClass,
  type GraphStatus,
  graphStatusLabel,
  statusDotClass,
  type WorkflowInspectionId,
  type WorkflowInspectionSelection,
} from './workflow-graph-support';

/** F289 泳道图（时间轴版）视觉原子 — 站点、入口、Review 阶段、分支胶囊、返工轨道 */

export interface StationInteraction {
  readonly selected: boolean;
  readonly describedBy?: string;
  readonly controls: string;
  readonly onInspect: (selection: WorkflowInspectionSelection, trigger: HTMLButtonElement) => void;
  readonly onPreview: (selection: WorkflowInspectionSelection | null, trigger?: HTMLButtonElement) => void;
}

export function StatusDot({ status }: { status: GraphStatus }) {
  return <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(status)}`} aria-hidden="true" />;
}

export function StatusBadge({ status }: { status: GraphStatus }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--console-shell-bg)] px-2 py-1 text-micro text-cafe-secondary">
      <StatusDot status={status} />
      {graphStatusLabel(status)}
    </span>
  );
}

export function ActiveNodePulse() {
  return (
    <span
      className="pointer-events-none absolute inset-0.5 rounded-[inherit] border-2 border-[var(--mc-accent)] opacity-40 motion-safe:animate-pulse"
      aria-hidden="true"
      data-testid="workflow-active-pulse"
    />
  );
}

export function ActorChip({ tone, label }: { tone: ActorTone; label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--console-shell-bg)] px-2 py-0.5 text-micro text-cafe-secondary">
      <span className={`h-1.5 w-1.5 rounded-full ${actorDotClass(tone)}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function statusTextClass(status: GraphStatus): string {
  switch (status) {
    case 'active':
      return 'text-[var(--mc-accent)] font-semibold';
    case 'blocked':
      return 'text-[var(--semantic-warning)] font-semibold';
    case 'completed':
      return 'text-[var(--semantic-success)] font-medium';
    default:
      return 'text-cafe-muted';
  }
}

export function statusShortText(status: GraphStatus): string {
  switch (status) {
    case 'active':
      return '● 当前';
    case 'blocked':
      return '● 等待处理';
    case 'completed':
      return '✓ 已经过';
    case 'inactive':
      return '本轮未选';
    case 'pending':
      return '未到达';
  }
}

function pinClass(status: GraphStatus): string {
  switch (status) {
    case 'active':
      return 'border-[var(--mc-accent)] bg-[var(--mc-accent)] text-[var(--cafe-surface)] shadow-[0_0_0_4px_color-mix(in_srgb,var(--mc-accent)_20%,transparent)]';
    case 'blocked':
      return 'border-[var(--semantic-warning)] bg-[var(--semantic-warning)] text-[var(--cafe-surface)]';
    case 'completed':
      return 'border-[var(--semantic-success)] bg-[var(--semantic-success)] text-[var(--cafe-surface)]';
    default:
      return 'border-[var(--console-border-strong)] bg-[var(--console-card-bg)] text-cafe-muted';
  }
}

/** 时间轴站点：轨道上的编号圆点 + 可点击详情卡 */
export function Station({
  id,
  testid,
  step,
  title,
  actorTone,
  actorLabel,
  status,
  owner,
  interaction,
  children,
}: {
  id: WorkflowInspectionId;
  testid?: string;
  step: string;
  title: string;
  actorTone: ActorTone;
  actorLabel: string;
  status: GraphStatus;
  owner: string;
  interaction: StationInteraction;
  children?: ReactNode;
}) {
  const { selected, describedBy, controls, onInspect, onPreview } = interaction;
  const isCurrent = status === 'active' || status === 'blocked';
  const selection = { id, title, owner, status } satisfies WorkflowInspectionSelection;
  return (
    <div className="relative flex gap-3 py-2">
      <span
        className={`relative z-[1] mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-micro font-bold ${pinClass(status)}`}
        aria-hidden="true"
      >
        {step}
      </span>
      <button
        type="button"
        className={`group relative min-w-0 flex-1 rounded-xl px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mc-accent)] ${
          status === 'active'
            ? 'bg-[color-mix(in_srgb,var(--mc-accent)_7%,var(--console-card-bg))] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--mc-accent)_35%,transparent)]'
            : status === 'blocked'
              ? 'bg-[var(--semantic-warning-surface)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--semantic-warning)_40%,transparent)]'
              : 'hover:bg-[var(--console-hover-bg)]'
        } ${selected ? 'outline outline-2 outline-offset-2 outline-[var(--mc-accent)]' : ''} ${
          status === 'pending' || status === 'inactive' ? 'opacity-75' : ''
        }`}
        data-testid={testid ?? `workflow-graph-node-${id}`}
        data-status={status}
        aria-current={isCurrent ? 'step' : undefined}
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
        {status === 'active' && <ActiveNodePulse />}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-cafe">{title}</span>
          <ActorChip tone={actorTone} label={actorLabel} />
          <span className={`ml-auto text-micro ${statusTextClass(status)}`}>{statusShortText(status)}</span>
        </div>
        {children}
      </button>
    </div>
  );
}

/** 入口胶囊（入口 A / 入口 B），虚线边框，本轮未选时降透明度 */
export function EntryChip({
  id,
  title,
  detail,
  status,
  interaction,
  returnTarget,
}: {
  id: 'design-entry' | 'acceptance-rework-entry';
  title: string;
  detail: string;
  status: GraphStatus;
  interaction: StationInteraction;
  returnTarget?: string;
}) {
  const { selected, describedBy, controls, onInspect, onPreview } = interaction;
  const selection = { id, title, owner: '你', status } satisfies WorkflowInspectionSelection;
  const toneClass =
    status === 'completed'
      ? 'border-[color-mix(in_srgb,var(--semantic-success)_55%,var(--console-border-soft))] bg-[color-mix(in_srgb,var(--semantic-success-surface)_55%,var(--console-card-bg))]'
      : status === 'active'
        ? 'border-[var(--mc-accent)] bg-[color-mix(in_srgb,var(--mc-accent)_7%,var(--console-card-bg))]'
        : status === 'inactive'
          ? 'border-[var(--console-border-soft)] opacity-45'
          : 'border-[var(--console-border-soft)]';
  return (
    <button
      type="button"
      className={`relative rounded-[10px] border-[1.5px] border-dashed px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mc-accent)] ${toneClass} ${
        selected ? 'outline outline-2 outline-offset-2 outline-[var(--mc-accent)]' : ''
      }`}
      data-testid={`workflow-graph-node-${id}`}
      data-status={status}
      data-return-target={returnTarget}
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
      {status === 'active' && <ActiveNodePulse />}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-cafe">{title}</span>
        {status === 'completed' && (
          <span className="text-micro font-bold text-[var(--semantic-success)]">✓ 本轮入口</span>
        )}
        {status === 'active' && <span className="text-micro font-bold text-[var(--mc-accent)]">● 本轮入口</span>}
      </div>
      <div className="mt-0.5 text-micro text-cafe-muted">{detail}</div>
    </button>
  );
}

/** Review 三阶段迷你卡：移动端横向滚动，桌面端等分 */
export function StagePill({
  id,
  title,
  detail,
  progress,
  status,
  owner,
  interaction,
}: {
  id: 'independent_review' | 'cross_review' | 'consensus';
  title: string;
  detail: string;
  progress: string;
  status: GraphStatus;
  owner: string;
  interaction: StationInteraction;
}) {
  const { selected, describedBy, controls, onInspect, onPreview } = interaction;
  const selection = { id, title, owner, status } satisfies WorkflowInspectionSelection;
  const toneClass =
    status === 'completed'
      ? 'bg-[color-mix(in_srgb,var(--semantic-success-surface)_70%,var(--console-card-bg))]'
      : status === 'active'
        ? 'bg-[color-mix(in_srgb,var(--mc-accent)_9%,var(--console-card-bg))] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--mc-accent)_40%,transparent)]'
        : status === 'blocked'
          ? 'bg-[var(--semantic-warning-surface)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--semantic-warning)_40%,transparent)]'
          : 'bg-[var(--console-shell-bg)] opacity-80';
  return (
    <button
      type="button"
      className={`relative w-[148px] shrink-0 snap-start rounded-lg p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mc-accent)] md:w-auto md:min-w-0 md:flex-1 ${toneClass} ${
        selected ? 'outline outline-2 outline-offset-2 outline-[var(--mc-accent)]' : ''
      }`}
      data-testid={`workflow-graph-node-${id}`}
      data-status={status}
      aria-current={status === 'active' || status === 'blocked' ? 'step' : undefined}
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
      {status === 'active' && <ActiveNodePulse />}
      <div className="text-xs font-semibold text-cafe">
        {title}
        {status === 'completed' && <span className="text-[var(--semantic-success)]"> ✓</span>}
      </div>
      <div className="mt-0.5 text-micro text-cafe-secondary">
        {progress} · {detail}
      </div>
    </button>
  );
}

/** 清零门分支胶囊 */
export function BranchChip({
  tone,
  active,
  label,
  returnSource,
}: {
  tone: 'warning' | 'success';
  active: boolean;
  label: string;
  returnSource?: string;
}) {
  const activeClass =
    tone === 'warning'
      ? 'border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] text-[var(--semantic-warning)] font-semibold'
      : 'border-[var(--semantic-success)] bg-[var(--semantic-success-surface)] text-[var(--semantic-success)] font-semibold';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-micro ${
        active ? activeClass : 'border-[var(--console-border-soft)] text-cafe-muted'
      }`}
      data-active={active}
      data-return-source={returnSource}
    >
      {label}
    </span>
  );
}

/** 右侧返工轨道：纯 CSS 的 ⊐ 形虚线，由包裹容器锚定，无需实测 DOM */
export function ReturnRail({
  kind,
  active,
  className,
}: {
  kind: 'review' | 'acceptance';
  active: boolean;
  className: string;
}) {
  return (
    <span
      className={`pointer-events-none absolute rounded-r-xl border-[1.5px] border-l-0 border-dashed border-[var(--semantic-warning)] ${
        active ? '' : 'opacity-25'
      } ${className}`}
      aria-hidden="true"
      data-testid={`workflow-return-rail-${kind}`}
      data-active={active}
    >
      <span className="absolute -left-[7px] -top-[5px] h-0 w-0 border-y-[5px] border-y-transparent border-r-[7px] border-r-[var(--semantic-warning)]" />
    </span>
  );
}

export function GraphLegend() {
  const items: readonly { status: GraphStatus; label: string }[] = [
    { status: 'completed', label: '已经过' },
    { status: 'active', label: '当前' },
    { status: 'blocked', label: '等待处理' },
    { status: 'pending', label: '未到达' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--console-hover-bg)] px-4 py-2.5 text-micro text-cafe-secondary">
      {items.map((item) => (
        <span key={item.status} className="inline-flex items-center gap-1.5">
          <StatusDot status={item.status} />
          {item.label}
        </span>
      ))}
      <span className="ml-auto">点击节点查看详情</span>
    </div>
  );
}

export function InspectorFact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl bg-[var(--console-shell-bg)] px-3 py-2">
      <dt className="text-cafe-secondary">{label}</dt>
      <dd className={`mt-1 break-all text-cafe ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
