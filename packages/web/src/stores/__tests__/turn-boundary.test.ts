import { describe, expect, it } from 'vitest';
import { crossesUserTurnBoundary } from '../turn-boundary';

describe('crossesUserTurnBoundary', () => {
  const left = { type: 'assistant', timestamp: 1000 };
  const right = { type: 'assistant', timestamp: 3000 };

  it('keeps trusted review orchestration as a turn boundary while presenting it as system', () => {
    expect(
      crossesUserTurnBoundary(
        [left, { type: 'system', timestamp: 2000, extra: { systemKind: 'review_orchestration' } }, right],
        left,
        right,
      ),
    ).toBe(true);
  });

  it('does not treat ordinary system notices as user turn boundaries', () => {
    expect(crossesUserTurnBoundary([left, { type: 'system', timestamp: 2000 }, right], left, right)).toBe(false);
  });
});
