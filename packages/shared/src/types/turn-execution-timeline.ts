export const TURN_EXECUTION_TIMELINE_VERSION = 1 as const;

export type TurnExecutionTimelineStatus = 'running' | 'completed' | 'interrupted' | 'failed';

export type TurnExecutionStepKey =
  | 'request_accepted'
  | 'context_prepared'
  | 'provider_setup'
  | 'carrier_acquire_new'
  | 'carrier_acquire_warm'
  | 'child_spawned'
  | 'initialized'
  | 'thread_ready'
  | 'turn_accepted'
  | 'provider_active'
  | 'session_ready'
  | 'first_text'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'closing'
  | 'closed';

export interface TurnExecutionStepV1 {
  key: TurnExecutionStepKey;
  startedAt: number;
  completedAt?: number;
  status: TurnExecutionTimelineStatus;
  attempt?: number;
}

export interface TurnExecutionTimelineV1 {
  v: typeof TURN_EXECUTION_TIMELINE_VERSION;
  startedAt: number;
  completedAt?: number;
  status: TurnExecutionTimelineStatus;
  steps: TurnExecutionStepV1[];
}

export interface TurnExecutionStepSpanV1 {
  key: TurnExecutionStepKey;
  startedAt: number;
  completedAt: number;
  attempt?: number;
}
