import { describe, expect, it } from 'vitest';

// Deliberately failing: proves a broken integration test turns CI red (W0-02). Never merged.
describe('CI red check (integration)', () => {
  it('fails on purpose', () => {
    expect('xid8').toBe('bigint');
  });
});
