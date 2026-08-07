import { performance } from 'node:perf_hooks';
import { codexFirstVisibleTextDuration } from '../../../../../infrastructure/telemetry/instruments.js';
import type { AgentMessage } from '../../types.js';

export type CodexFirstVisibleTextStatus = 'exec_json_completed' | 'app_server_delta' | 'app_server_completed';

interface HistogramRecorder {
  record(value: number, attributes: { status: CodexFirstVisibleTextStatus }): void;
}

export function classifyCodexFirstVisibleTextStatus(
  event: unknown,
  useAppServer: boolean,
): CodexFirstVisibleTextStatus | null {
  if (!event || typeof event !== 'object') return null;
  const raw = event as Record<string, unknown>;
  if (useAppServer && raw.type === 'item.agent_message.delta') return 'app_server_delta';
  if (raw.type !== 'item.completed') return null;
  const item = raw.item as Record<string, unknown> | undefined;
  if (item?.type !== 'agent_message') return null;
  return useAppServer ? 'app_server_completed' : 'exec_json_completed';
}

export function createCodexFirstVisibleTextRecorder(
  startedAtMs = performance.now(),
  histogram: HistogramRecorder = codexFirstVisibleTextDuration,
  now: () => number = () => performance.now(),
): {
  observe(message: AgentMessage, status: CodexFirstVisibleTextStatus): boolean;
} {
  let recorded = false;
  return {
    observe(message, status) {
      if (
        recorded ||
        message.type !== 'text' ||
        typeof message.content !== 'string' ||
        message.content.trim().length === 0
      ) {
        return false;
      }
      histogram.record(Math.max(0, now() - startedAtMs) / 1_000, { status });
      recorded = true;
      return true;
    },
  };
}
