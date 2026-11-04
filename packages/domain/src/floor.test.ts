import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import costFloorCases from '../golden/cost-floor.json';
import { costFloor } from './floor';
import { money } from './money';
import { runGolden, type GoldenFile } from './testing/golden';

// The floor from cost (CAT-06, PRD Q2, D-092, W1-14): the server sends it to the counters as `item_floors`.

runGolden(costFloorCases as GoldenFile<{ avgCost: number | null; marginBp: number | null }>, (i) =>
  costFloor(i.avgCost === null ? null : money(i.avgCost), i.marginBp),
);

describe('cost floor properties', () => {
  it('is never below the cost, and never more than half a paisa above cost × (1 + margin)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (c, bp) => {
          const f = costFloor(money(c), bp)!;
          expect(f).toBeGreaterThanOrEqual(c);
          expect(Math.abs(f * 10_000 - c * (10_000 + bp))).toBeLessThanOrEqual(5_000);
        },
      ),
    );
  });
});
