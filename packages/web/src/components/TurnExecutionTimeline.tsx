'use client';

import type { TurnExecutionStepKey, TurnExecutionTimelineV1 } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import type { ToolEvent } from '@/stores/chat-types';

const STEP_LABELS: Record<TurnExecutionStepKey, string> = {
  request_accepted: '收到请求',
  context_prepared: '准备上下文与权限',
  provider_setup: '准备模型服务',
  carrier_acquire_new: '启动 app-server',
  carrier_acquire_warm: '复用 app-server',
  child_spawned: '启动承载进程',
  initialized: '初始化协议',
  thread_ready: '恢复会话',
  turn_accepted: '模型接收本轮',
  provider_active: '模型处理中',
  session_ready: 'CLI 会话就绪',
  first_text: '生成回复',
  completed: '完成并保存',
  interrupted: '已中断',
  failed: '执行失败',
  closing: '关闭承载进程',
  closed: '承载进程已关闭',
};

function formatDuration(durationMs: number): string {
  const safe = Math.max(0, durationMs);
  if (safe < 1_000) return `${Math.round(safe)}ms`;
  if (safe < 60_000) return `${(safe / 1_000).toFixed(1)}s`;
  const roundedSeconds = Math.round(safe / 1_000);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function carrierLabel(timeline: TurnExecutionTimelineV1): string | undefined {
  if (timeline.steps.some((step) => step.key === 'carrier_acquire_warm')) return 'app-server 热复用';
  if (timeline.steps.some((step) => step.key === 'carrier_acquire_new')) return 'app-server 冷启动';
  return undefined;
}

interface ToolDuration {
  id: string;
  name: string;
  startedAt?: number;
  completedAt?: number;
  status?: ToolEvent['status'];
}

function collectToolDurations(events: readonly ToolEvent[]): ToolDuration[] {
  const byId = new Map<string, ToolDuration>();
  for (const event of events) {
    if (!event.toolUseId) continue;
    const name = event.toolName ?? (event.label.replace(/^.*?[→←]\s*/u, '').trim() || 'Tool');
    if (event.type === 'tool_use') {
      byId.set(event.toolUseId, {
        id: event.toolUseId,
        name,
        startedAt: event.startTimeMs,
      });
      continue;
    }
    const existing = byId.get(event.toolUseId);
    if (!existing) continue;
    existing.completedAt = event.endTimeMs;
    existing.status = event.status;
  }
  return [...byId.values()];
}

interface TurnExecutionTimelineProps {
  timeline: TurnExecutionTimelineV1;
  toolEvents?: readonly ToolEvent[];
  /** Deterministic clock for tests and replay surfaces. */
  now?: number;
}

export function TurnExecutionTimeline({ timeline, toolEvents = [], now }: TurnExecutionTimelineProps) {
  const isRunning = timeline.status === 'running';
  const [liveNow, setLiveNow] = useState(() => now ?? Date.now());

  useEffect(() => {
    if (now !== undefined) setLiveNow(now);
  }, [now]);

  useEffect(() => {
    if (!isRunning || now !== undefined) return;
    const timer = window.setInterval(() => setLiveNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [isRunning, now]);

  const endAt = timeline.completedAt ?? liveNow;
  const total = formatDuration(endAt - timeline.startedAt);
  const firstText = timeline.steps.find((step) => step.key === 'first_text');
  const firstTextDuration = firstText ? formatDuration(firstText.startedAt - timeline.startedAt) : undefined;
  const tools = useMemo(() => collectToolDurations(toolEvents), [toolEvents]);
  const carrier = carrierLabel(timeline);

  return (
    <details
      open={isRunning || undefined}
      data-testid="turn-execution-timeline"
      className="mt-3 rounded-lg border border-cafe bg-cafe-surface/55 text-xs text-cafe-secondary"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 select-none">
        <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 fill-none stroke-current">
          <title>展开执行过程</title>
          <path d="M5 3.5 9.5 8 5 12.5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="font-medium text-cafe">执行过程 {total}</span>
        {firstTextDuration ? <span>· 首段文字 {firstTextDuration}</span> : null}
        {carrier ? <span>· {carrier}</span> : null}
        {isRunning ? <span className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
      </summary>
      <div className="border-t border-cafe px-2.5 py-2">
        <ol className="space-y-1.5">
          {timeline.steps.map((step, index) => {
            const stepEnd = step.completedAt ?? (step.status === 'running' ? liveNow : undefined);
            const duration = stepEnd === undefined ? undefined : formatDuration(stepEnd - step.startedAt);
            return (
              <li key={`${step.key}-${step.startedAt}-${index}`} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${step.status === 'failed' ? 'bg-conn-red-text' : 'bg-current'}`}
                />
                <span className="min-w-0 flex-1 truncate">{STEP_LABELS[step.key]}</span>
                {step.attempt !== undefined && step.attempt > 0 ? <span>重试 {step.attempt}</span> : null}
                {duration ? <time className="tabular-nums">{duration}</time> : null}
              </li>
            );
          })}
          {tools.map((tool) => {
            const duration =
              tool.startedAt !== undefined && tool.completedAt !== undefined && tool.completedAt >= tool.startedAt
                ? formatDuration(tool.completedAt - tool.startedAt)
                : undefined;
            return (
              <li key={tool.id} className="flex items-center gap-2" data-tool-status={tool.status ?? 'running'}>
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                <span className="min-w-0 flex-1 truncate">工具 · {tool.name}</span>
                {duration ? <time className="tabular-nums">{duration}</time> : null}
              </li>
            );
          })}
        </ol>
      </div>
    </details>
  );
}
