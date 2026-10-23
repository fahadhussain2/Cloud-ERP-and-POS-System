import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import roundCashCases from '../golden/round-cash.json';
import { money } from './money';
import { roundCash } from './rounding';
import { runGolden, type GoldenFile } from './testing/golden';

runGolden(roundCashCases as GoldenFile<{ amount: number; increment: number }>, (i) =>
  roundCash(money(i.amount), money(i.increment)),
);

describe('cash rounding properties', () => {
  it('rounds to a multiple of the increment, moves at most half of it, and mirrors refunds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.constantFrom(1, 50, 100, 500, 1000),
        (a, inc) => {
          const r = roundCash(money(a), money(inc));
          expect(Math.abs(r.rounded) % inc).toBe(0);
          expect(r.rounded - a).toBe(r.adjustment);
          expect(Math.abs(r.adjustment) * 2).toBeLessThanOrEqual(inc);
          expect(roundCash(money(-a), money(inc)).rounded).toBe(-(r.rounded as number) || 0);
        },
      ),
    );
  });
});
