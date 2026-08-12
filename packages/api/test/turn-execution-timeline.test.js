import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnExecutionTimelineCollector } from '../dist/domains/cats/services/agents/invocation/turn-execution-timeline.js';

test('collector closes verified phases and records first text exactly once', () => {
  const collector = new TurnExecutionTimelineCollector(1_000);

  assert.equal(collector.transition('context_prepared', 1_010), true);
  assert.equal(collector.recordSpan('provider_setup', 1_100, 1_125), true);
  assert.equal(collector.recordSpan('carrier_acquire_warm', 1_125, 1_150), true);
  assert.equal(collector.transition('turn_accepted', 1_175), true);
  assert.equal(collector.transition('first_text', 1_400), true);
  assert.equal(collector.transition('first_text', 1_450), false);
  assert.equal(collector.finish('completed', 1_700), true);

  assert.deepEqual(collector.snapshot(), {
    v: 1,
    startedAt: 1_000,
    completedAt: 1_700,
    status: 'completed',
    steps: [
      { key: 'request_accepted', startedAt: 1_000, completedAt: 1_010, status: 'completed' },
      { key: 'context_prepared', startedAt: 1_010, completedAt: 1_100, status: 'completed' },
      { key: 'provider_setup', startedAt: 1_100, completedAt: 1_125, status: 'completed' },
      { key: 'carrier_acquire_warm', startedAt: 1_125, completedAt: 1_150, status: 'completed' },
      { key: 'turn_accepted', startedAt: 1_175, completedAt: 1_400, status: 'completed' },
      { key: 'first_text', startedAt: 1_400, completedAt: 1_700, status: 'completed' },
      { key: 'completed', startedAt: 1_700, completedAt: 1_700, status: 'completed' },
    ],
  });
});

test('collector omits backward or malformed boundaries instead of inventing duration', () => {
  const collector = new TurnExecutionTimelineCollector(2_000);

  assert.equal(collector.transition('session_ready', 1_999), false);
  assert.equal(collector.recordSpan('provider_setup', Number.NaN, 2_100), false);
  assert.equal(collector.recordSpan('carrier_acquire_new', 2_100, 2_090), false);
  assert.equal(collector.transition('session_ready', 2_050), true);
  assert.equal(collector.finish('failed', 2_040), false);
  assert.equal(collector.finish('failed', 2_075), true);

  assert.deepEqual(collector.snapshot(), {
    v: 1,
    startedAt: 2_000,
    completedAt: 2_075,
    status: 'failed',
    steps: [
      { key: 'request_accepted', startedAt: 2_000, completedAt: 2_050, status: 'completed' },
      { key: 'session_ready', startedAt: 2_050, completedAt: 2_075, status: 'failed' },
      { key: 'failed', startedAt: 2_075, completedAt: 2_075, status: 'failed' },
    ],
  });
});

test('collector preserves bounded recovery attempt on lifecycle steps', () => {
  const collector = new TurnExecutionTimelineCollector(3_000);

  assert.equal(collector.transition('child_spawned', 3_050, 1), true);
  assert.equal(collector.transition('initialized', 3_075, 1), true);
  assert.equal(collector.finish('interrupted', 3_100), true);

  assert.deepEqual(collector.snapshot().steps.slice(1), [
    { key: 'child_spawned', startedAt: 3_050, completedAt: 3_075, status: 'completed', attempt: 1 },
    { key: 'initialized', startedAt: 3_075, completedAt: 3_100, status: 'interrupted', attempt: 1 },
    { key: 'interrupted', startedAt: 3_100, completedAt: 3_100, status: 'interrupted' },
  ]);
});
