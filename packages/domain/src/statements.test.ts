import { describe, expect, it } from 'vitest';

import balanceSheetCases from '../golden/balance-sheet.json';
import cashBookCases from '../golden/cash-book.json';
import compareCases from '../golden/period-compare.json';
import monthsCases from '../golden/period-months.json';
import presetCases from '../golden/period-presets.json';
import rangeCases from '../golden/period-range.json';
import profitCases from '../golden/profit-and-loss.json';
import changeCases from '../golden/statement-change.json';
import stockCases from '../golden/stock-and-purchases.json';
import trialCases from '../golden/trial-balance.json';
import {
  balanceSheet,
  cashBook,
  changeOf,
  checkRange,
  lastYearPeriod,
  monthsOf,
  periodOf,
  previousPeriod,
  profitAndLoss,
  stockAndPurchases,
  trialBalance,
  type BalanceSheetInput,
  type CashBookInput,
  type PeriodPreset,
  type ProfitAndLossInput,
  type StockAndPurchasesInput,
  type TrialBalanceInput,
} from './statements';
import { runGolden, type GoldenFile } from './testing/golden';

// The financial statements' arithmetic and the report periods (W2-01 plan; ACC-07, RPT-11; D-116): pure, so the API,
// its CSV and the screens agree to the paisa (rule 1).

runGolden(trialCases as unknown as GoldenFile<TrialBalanceInput>, trialBalance);
runGolden(profitCases as unknown as GoldenFile<ProfitAndLossInput>, profitAndLoss);
runGolden(changeCases as unknown as GoldenFile<{ current: number; previous: number }>, (i) =>
  changeOf(i.current, i.previous),
);
runGolden(balanceSheetCases as unknown as GoldenFile<BalanceSheetInput>, balanceSheet);
runGolden(stockCases as unknown as GoldenFile<StockAndPurchasesInput>, stockAndPurchases);
runGolden(cashBookCases as unknown as GoldenFile<CashBookInput>, cashBook);
runGolden(
  presetCases as unknown as GoldenFile<{ preset: PeriodPreset; today: string; fiscalYearStartMonth: number }>,
  (i) => periodOf(i.preset, i.today, i.fiscalYearStartMonth),
);
runGolden(
  compareCases as unknown as GoldenFile<{ kind: 'previous' | 'lastYear'; from: string; to: string }>,
  (i) => (i.kind === 'previous' ? previousPeriod : lastYearPeriod)({ from: i.from, to: i.to }),
);
runGolden(monthsCases as unknown as GoldenFile<{ from: string; to: string }>, monthsOf);
runGolden(rangeCases as unknown as GoldenFile<{ from: string; to: string; maxDays: number }>, (i) =>
  checkRange({ from: i.from, to: i.to }, i.maxDays),
);

describe('the statements, whatever the postings', () => {
  // Every posting balances, so any set of balanced entries must give a balanced trial balance and a balance sheet
  // where assets = liabilities + equity, with the P&L's net profit equal to the profit for the year.
  const chart = trialCases.cases[0]!.input.accounts as TrialBalanceInput['accounts'];
  const postable = chart.filter((a) => a.postable).map((a) => a.id);
  const entries = Array.from({ length: 40 }, (_, i) => {
    const amount = ((i * 7919) % 100000) + 1;
    return {
      debit: postable[(i * 3) % postable.length]!,
      credit: postable[(i * 5 + 1) % postable.length]!,
      amount,
    };
  });
  const net = new Map<string, number>();
  for (const e of entries) {
    net.set(e.debit, (net.get(e.debit) ?? 0) + e.amount);
    net.set(e.credit, (net.get(e.credit) ?? 0) - e.amount);
  }
  const balances = [...net].map(([accountId, balance]) => ({ accountId, balance }));
  const pl = new Set(chart.filter((a) => a.type === 'income' || a.type === 'expense').map((a) => a.id));

  it('balance the trial balance', () => {
    const tb = trialBalance({
      accounts: chart,
      sums: balances.map((b) => ({
        accountId: b.accountId,
        opening: 0,
        debit: Math.max(b.balance, 0),
        credit: Math.max(-b.balance, 0),
      })),
      level: 'accounts',
      showEmpty: false,
    });
    expect(tb.balanced).toBe(true);
  });

  it('balance the balance sheet, with the profit and loss as its profit for the year', () => {
    const bs = balanceSheet({
      accounts: chart,
      columns: [{ at: '2027-11-30', balances, year: balances.filter((b) => pl.has(b.accountId)) }],
    });
    expect(bs.difference).toEqual([0]);
    const p = profitAndLoss({
      accounts: chart,
      periods: [
        {
          from: '2027-01-01',
          to: '2027-11-30',
          sums: balances.map((b) => ({
            accountId: b.accountId,
            debit: Math.max(b.balance, 0),
            credit: Math.max(-b.balance, 0),
          })),
        },
      ],
    });
    expect(p.netProfit).toEqual(bs.profitForYear);
  });
});
