import { describe, expect, it } from 'vitest';

import abcCases from '../golden/abc-classes.json';
import coverCases from '../golden/days-of-cover.json';
import reorderCases from '../golden/reorder-line.json';
import ageCases from '../golden/stock-age.json';
import groupCases from '../golden/stock-groups.json';
import movementCases from '../golden/stock-movement.json';
import turnoverCases from '../golden/stock-turnover.json';
import {
  abcClasses,
  daysOfCover,
  groupRows,
  reorderLine,
  stockAge,
  stockMovement,
  turnover,
  type GroupedInput,
  type ReorderInput,
  type StockAgeInput,
  type StockMovementInput,
} from './stock-reports';
import { runGolden, type GoldenFile } from './testing/golden';

// The stock reports' rules (W2-02 plan; RPT-08, RPT-12, RPT-13, RPT-14, PUR-07 list; D-116): pure, so the API, its CSV
// and the screens agree (rule 1).

runGolden(movementCases as unknown as GoldenFile<StockMovementInput>, stockMovement);
runGolden(groupCases as unknown as GoldenFile<GroupedInput>, groupRows);
runGolden(reorderCases as unknown as GoldenFile<ReorderInput>, reorderLine);
runGolden(ageCases as unknown as GoldenFile<StockAgeInput>, stockAge);
runGolden(coverCases as unknown as GoldenFile<{ onHand: number; sold: number; days: number }>, (i) =>
  daysOfCover(i.onHand, i.sold, i.days),
);
runGolden(abcCases as unknown as GoldenFile<{ id: string; amount: number }[]>, abcClasses);
runGolden(
  turnoverCases as unknown as GoldenFile<{ costOfSales: number; opening: number; closing: number }>,
  (i) => turnover(i.costOfSales, i.opening, i.closing),
);

describe('the stock movement, whatever the movements', () => {
  // Whatever moves an item, opening + every bucket = closing, in quantity and in value.
  const sources = [
    'opening',
    'goods_receipt',
    'purchase_return',
    'sale',
    'sales_void',
    'stock_adjustment',
    'stock_transfer',
  ];
  const moves = Array.from({ length: 60 }, (_, i) => ({
    source: sources[i % sources.length]!,
    qty: ((i * 7919) % 5001) - 2500,
    value: ((i * 104729) % 50001) - 25000,
  }));

  it('adds up', () => {
    const m = stockMovement({ opening: { qty: 3000, value: 31000 }, moves });
    const b = Object.values(m.buckets);
    expect(m.closing.qty).toBe(3000 + b.reduce((s, x) => s + x.qty, 0));
    expect(m.closing.value).toBe(31000 + b.reduce((s, x) => s + x.value, 0));
  });
});

describe('ABC, whatever the amounts', () => {
  it('ends at 100% and gives A before B before C', () => {
    const rows = abcClasses(
      Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, amount: (i * 7919) % 1000 })),
    );
    const classed = rows.filter((r) => r.class !== null);
    expect(classed.at(-1)!.cumulative).toBe(10000);
    const order = classed.map((r) => r.class).join('');
    expect(order).toMatch(/^A+B*C*$/);
  });
});
