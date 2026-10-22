import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import allocateCases from '../golden/allocate.json';
import { allocate } from './allocate';
import { money } from './money';
import { runGolden, type GoldenFile } from './testing/golden';

runGolden(allocateCases as GoldenFile<{ total: number; weights: number[] }>, (i) =>
  allocate(money(i.total), i.weights),
);

describe('allocation properties', () => {
  const weights = fc
    .array(fc.integer({ min: 0, max: 10_000_000 }), { minLength: 1, maxLength: 30 })
    .filter((w) => w.some((x) => x > 0));
  const total = fc.integer({ min: -10_000_000_000, max: 10_000_000_000 });

  it('always sums exactly to the total', () => {
    fc.assert(
      fc.property(total, weights, (t, w) => {
        expect(allocate(money(t), w).reduce((s, x) => s + x, 0)).toBe(t);
      }),
    );
  });

  it('keeps each line less than 1 paisa from its exact share, and gives zero weights nothing', () => {
    fc.assert(
      fc.property(total, weights, (t, w) => {
        const sumW = w.reduce((s, x) => s + BigInt(x), 0n);
        allocate(money(t), w).forEach((part, i) => {
          const diff = BigInt(part) * sumW - BigInt(t) * BigInt(w[i]);
          expect(diff < 0n ? -diff : diff).toBeLessThan(sumW);
          if (w[i] === 0) expect(part).toBe(0);
        });
      }),
    );
  });

  it('splits a refund as the exact mirror of the sale', () => {
    fc.assert(
      fc.property(total, weights, (t, w) => {
        expect(allocate(money(-t), w)).toStrictEqual(allocate(money(t), w).map((x) => -x || 0));
      }),
    );
  });
});
