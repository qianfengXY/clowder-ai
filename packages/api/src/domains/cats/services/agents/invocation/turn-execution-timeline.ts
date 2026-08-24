import {
  TURN_EXECUTION_TIMELINE_VERSION,
  type TurnExecutionStepKey,
  type TurnExecutionStepV1,
  type TurnExecutionTimelineStatus,
  type TurnExecutionTimelineV1,
} from '@cat-cafe/shared';

const TERMINAL_KEYS = new Set<TurnExecutionStepKey>(['completed', 'interrupted', 'failed']);

function isTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function boundedAttempt(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value !== undefined && value >= 0 && value <= 99 ? value : undefined;
}

function cloneStep(step: TurnExecutionStepV1): TurnExecutionStepV1 {
  return { ...step };
}

/**
 * Purely observational per-turn timeline collector.
 *
 * Every accepted boundary must carry a provider/runtime timestamp. Invalid or
 * backward time is rejected so callers cannot accidentally manufacture a
 * duration while repairing incomplete legacy data.
 */
export class TurnExecutionTimelineCollector {
  readonly #timeline: TurnExecutionTimelineV1;
  #lastObservedAt: number;
  #firstTextObserved = false;

  constructor(startedAt: number) {
    if (!isTimestamp(startedAt)) throw new TypeError('Turn execution timeline requires a finite startedAt');
    this.#lastObservedAt = startedAt;
    this.#timeline = {
      v: TURN_EXECUTION_TIMELINE_VERSION,
      startedAt,
      status: 'running',
      steps: [{ key: 'request_accepted', startedAt, status: 'running' }],
    };
  }

  transition(key: TurnExecutionStepKey, at: number, attempt?: number): boolean {
    if (this.#timeline.status !== 'running' || TERMINAL_KEYS.has(key)) return false;
    if (!isTimestamp(at) || at < this.#lastObservedAt) return false;
    if (this.#timeline.steps.at(-1)?.key === key) return false;
    if (key === 'first_text') {
      if (this.#firstTextObserved) return false;
      this.#firstTextObserved = true;
    }

    this.#closeRunning(at, 'completed');
    const safeAttempt = boundedAttempt(attempt);
    this.#timeline.steps.push({
      key,
      startedAt: at,
      status: 'running',
      ...(safeAttempt !== undefined ? { attempt: safeAttempt } : {}),
    });
    this.#lastObservedAt = at;
    return true;
  }

  recordSpan(key: TurnExecutionStepKey, startedAt: number, completedAt: number, attempt?: number): boolean {
    if (this.#timeline.status !== 'running' || TERMINAL_KEYS.has(key)) return false;
    if (!isTimestamp(startedAt) || !isTimestamp(completedAt)) return false;
    if (startedAt < this.#lastObservedAt || completedAt < startedAt) return false;

    this.#closeRunning(startedAt, 'completed');
    const safeAttempt = boundedAttempt(attempt);
    this.#timeline.steps.push({
      key,
      startedAt,
      completedAt,
      status: 'completed',
      ...(safeAttempt !== undefined ? { attempt: safeAttempt } : {}),
    });
    this.#lastObservedAt = completedAt;
    return true;
  }

  finish(status: Exclude<TurnExecutionTimelineStatus, 'running'>, at: number): boolean {
    if (this.#timeline.status !== 'running') return false;
    if (!isTimestamp(at) || at < this.#lastObservedAt) return false;

    this.#closeRunning(at, status);
    this.#timeline.status = status;
    this.#timeline.completedAt = at;
    this.#timeline.steps.push({ key: status, startedAt: at, completedAt: at, status });
    this.#lastObservedAt = at;
    return true;
  }

  snapshot(): TurnExecutionTimelineV1 {
    return {
      ...this.#timeline,
      steps: this.#timeline.steps.map(cloneStep),
    };
  }

  #closeRunning(at: number, status: TurnExecutionTimelineStatus): void {
    const current = this.#timeline.steps.at(-1);
    if (!current || current.status !== 'running') return;
    current.completedAt = at;
    current.status = status;
  }
}
