import { mulQty, money, qty, type Money, type Qty } from '@erp/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import averageCases from '../golden/average.json';
import shortfallCases from '../golden/settle-shortfall.json';
import { averageAfterReceipt, settleShortfall } from './cost';
import { runGolden, type GoldenFile } from './testing/golden';
import type { CostState } from './types';

runGolden(
  averageCases as unknown as GoldenFile<{ state: CostState; receipt: { qty: Qty; netUnitCost: Money } }>,
  (i) => averageAfterReceipt(i.state, i.receipt),
);
runGolden(
  shortfallCases as unknown as GoldenFile<{ state: CostState; receipt: { qty: Qty; value: Money } }>,
  (i) => settleShortfall(i.state, i.receipt),
);

// D-124: while stock stays at or below zero, every unit short is valued at the average, so stock that comes in
// settles it exactly: the value stays on-hand × the average (plus whatever rounding residue the stock had when it last
// went below zero, the average's own, as before D-124). Whole units, so a sale's cost is exact.
describe('stock sold before it arrived', () => {
  const step = fc.oneof(
    fc.record({ kind: fc.constant('sale' as const), units: fc.integer({ min: 1, max: 5 }) }),
    fc.record({
      kind: fc.constant('receipt' as const),
      units: fc.integer({ min: 1, max: 5 }),
      value: fc.integer({ min: 0, max: 5_000_000 }),
    }),
  );
  const atAverage = (s: CostState) => (s.avgCost === null ? 0 : mulQty(s.onHand, s.avgCost));
  it('leaves nothing of a shortfall behind, whatever the order of sales and receipts', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
        let state: CostState = { avgCost: null, onHand: qty(0) };
        let value = 0;
        let residue = 0;
        for (const s of steps) {
          const before = state;
          const units = qty(s.units * 1000);
          if (s.kind === 'sale') {
            value -= before.avgCost === null ? 0 : mulQty(units, before.avgCost);
            state = { avgCost: before.avgCost, onHand: qty(before.onHand - units) };
          } else {
            const { after, correction } = settleShortfall(before, { qty: units, value: money(s.value) });
            value += s.value - correction;
            state = after;
          }
          if (state.onHand > 0) continue;
          if (before.onHand > 0) residue = value - atAverage(state);
          else expect(value - atAverage(state)).toBe(residue);
        }
      }),
    );
  });
});
