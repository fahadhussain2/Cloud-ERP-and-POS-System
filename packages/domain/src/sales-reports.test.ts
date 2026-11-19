import { describe, expect, it } from 'vitest';

import changeCases from '../golden/sales-change.json';
import creditCases from '../golden/sale-credit.json';
import figureCases from '../golden/sales-figures.json';
import gridCases from '../golden/hour-grid.json';
import bucketCases from '../golden/period-buckets.json';
import spreadCases from '../golden/rate-spread.json';
import rateCases from '../golden/rate-stats.json';
import lineCases from '../golden/sale-line-figures.json';
import trendCases from '../golden/sales-trend.json';
import stepCases from '../golden/trend-step.json';
import topCases from '../golden/top-and-bottom.json';
import {
  change,
  creditedTo,
  hourGrid,
  periodBuckets,
  rateStats,
  saleLineFigures,
  salesFigures,
  spread,
  topAndBottom,
  trendSeries,
  trendStep,
  type Credit,
  type Ranked,
  type Ranking,
  type RateLine,
  type SaleLineInput,
  type SalesSums,
  type TrendDay,
  type TrendStep,
} from './sales-reports';
import type { Period } from './statements';
import { runGolden, type GoldenFile } from './testing/golden';

// The sales and purchase reports' rules (W2-03 plan; RPT-07, RPT-09, RPT-15; D-116): pure, so the API, its CSV and the
// screens agree (rule 1).

runGolden(lineCases as unknown as GoldenFile<SaleLineInput>, saleLineFigures);
runGolden(figureCases as unknown as GoldenFile<SalesSums>, salesFigures);
runGolden(
  creditCases as unknown as GoldenFile<{ qty: number; own: Credit; original: Credit | null }>,
  creditedTo,
);
runGolden(changeCases as unknown as GoldenFile<{ now: number; before: number }>, (i) =>
  change(i.now, i.before),
);
runGolden(stepCases as unknown as GoldenFile<Period>, trendStep);
runGolden(bucketCases as unknown as GoldenFile<{ period: Period; step: TrendStep }>, (i) =>
  periodBuckets(i.period, i.step),
);
runGolden(
  trendCases as unknown as GoldenFile<{ period: Period; step: TrendStep; days: TrendDay[] }>,
  trendSeries,
);
runGolden(gridCases as unknown as GoldenFile<{ date: string; hour: number; sales: number }[]>, hourGrid);
runGolden(topCases as unknown as GoldenFile<{ items: Ranked[]; by: Ranking; n: number }>, (i) =>
  topAndBottom(i.items, i.by, i.n),
);
runGolden(rateCases as unknown as GoldenFile<RateLine[]>, rateStats);
runGolden(spreadCases as unknown as GoldenFile<{ sale: number | null; purchase: number | null }>, (i) =>
  spread(i.sale, i.purchase),
);

describe('sales figures, whatever the lines', () => {
  // A group's figures from its sums equal the sums of its lines' sales, cost, profit and discount.
  const lines: SaleLineInput[] = Array.from({ length: 40 }, (_, i) => ({
    qty: (((i * 7919) % 9) - 2) * 1000 || 1000,
    listPrice: i % 5 === 0 ? null : 1000 + ((i * 104729) % 90000),
    lineTotal: ((i * 15485863) % 200000) - 40000,
    cost: (i * 32452843) % 150000,
  }));

  it('adds up', () => {
    const each = lines.map(saleLineFigures);
    const sums = salesFigures({
      qty: each.reduce((s, x) => s + x.qty, 0),
      sales: each.reduce((s, x) => s + x.sales, 0),
      cost: each.reduce((s, x) => s + x.cost, 0),
      listSales: each.reduce((s, x) => s + x.sales + x.discount, 0),
    });
    expect(sums.profit).toBe(each.reduce((s, x) => s + x.profit, 0));
    expect(sums.discount).toBe(each.reduce((s, x) => s + x.discount, 0));
  });
});

describe('the busy-hours grid, whatever the bills', () => {
  it('counts every bill once', () => {
    const bills = Array.from({ length: 100 }, (_, i) => ({
      date: `2027-01-${String((i % 28) + 1).padStart(2, '0')}`,
      hour: (i * 7) % 24,
      sales: i * 100,
    }));
    const g = hourGrid(bills);
    expect(g.bills.flat().reduce((s, x) => s + x, 0)).toBe(100);
    expect(g.sales.flat().reduce((s, x) => s + x, 0)).toBe(bills.reduce((s, b) => s + b.sales, 0));
  });
});
