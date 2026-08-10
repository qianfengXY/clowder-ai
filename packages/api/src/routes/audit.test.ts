import { describe, expect, it } from 'vitest';
import { canReadThreadAudit } from './audit.js';

describe('canReadThreadAudit', () => {
  it('allows an authenticated user to read their own thread audit', () => {
    expect(canReadThreadAudit({ id: 'thread-1', createdBy: 'user-1' }, 'user-1')).toBe(true);
  });

  it('allows the shared system-owned default lobby', () => {
    expect(canReadThreadAudit({ id: 'default', createdBy: 'system' }, 'user-1')).toBe(true);
  });

  it('does not expose other users or arbitrary system threads', () => {
    expect(canReadThreadAudit({ id: 'thread-2', createdBy: 'user-2' }, 'user-1')).toBe(false);
    expect(canReadThreadAudit({ id: 'system-anchor', createdBy: 'system' }, 'user-1')).toBe(false);
  });
});
