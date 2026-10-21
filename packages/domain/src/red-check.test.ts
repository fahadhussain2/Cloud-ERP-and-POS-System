import { describe, expect, it } from 'vitest';

// Deliberately failing: proves a broken unit test turns CI red (W0-02). Never merged.
describe('CI red check (unit)', () => {
  it('fails on purpose', () => {
    expect(1 + 1).toBe(3);
  });
});
