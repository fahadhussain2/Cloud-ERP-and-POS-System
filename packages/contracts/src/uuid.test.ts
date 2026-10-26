import { describe, expect, it } from 'vitest';

import { uuidv7 } from './uuid';

describe('uuidv7 (rule 7)', () => {
  it('has the version 7 and variant bits and the millisecond time up front', () => {
    const id = uuidv7(0x0190a0b0c0d0, new Uint8Array(10).fill(0xff));
    expect(id).toBe('0190a0b0-c0d0-7fff-bfff-ffffffffffff');
  });

  it('sorts by creation time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
  });

  it('is random within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuidv7(1_700_000_000_000)));
    expect(ids.size).toBe(100);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
