import { DomainError } from './errors';
import { divRound } from './exact';
import { mulQty, type Money } from './money';
import type { Qty } from './quantity';
import { checkRange, type Period } from './statements';

// The sales and purchase reports' rules (W2-03 plan; RPT-07, RPT-09, RPT-15; D-116). Pure: the API reads the bills,
// their stock movements and the goods receipts, sums them, and hands them here, so the screens, the CSV and the tests
// agree (rule 1). Money is integer minor units, quantities integer thousandths, shares basis points, dates YYYY-MM-DD.

/** part ÷ of in basis points, rounded half away from zero; `of` is never 0 here. */
const bp = (part: number, of: number) => Number(divRound(BigInt(part) * 10_000n, BigInt(of)));

// ---- Sales, cost, profit and discount (owner answers 1 and 6) ----

/** One line's, or many lines' summed: what the customers paid, its cost in the books, and the same at list price. */
export interface SalesSums {
  qty: number;
  /** After the line discount and the bill discount: what the customer paid (a return's is negative). */
  sales: number;
  /** The stock movements' cost: the average when sold (owner answer 1); a return's is negative. */
  cost: number;
  /** List price × quantity; a line with no list price counts at what was paid, so it gives no discount. */
  listSales: number;
}

export interface SalesFigures {
  qty: number;
  sales: number;
  cost: number;
  profit: number;
  /** List − paid (owner answer 6): the line and bill discounts together; above list it is negative. */
  discount: number;
  /** Profit ÷ sales; null when there were no sales (or only returns). */
  marginBp: number | null;
  /** Discount ÷ sales at list; null when nothing sold at list. */
  discountBp: number | null;
}

export function salesFigures(s: SalesSums): SalesFigures {
  const profit = s.sales - s.cost;
  const discount = s.listSales - s.sales;
  return {
    qty: s.qty,
    sales: s.sales,
    cost: s.cost,
    profit,
    discount,
    marginBp: s.sales > 0 ? bp(profit, s.sales) : null,
    discountBp: s.listSales > 0 ? bp(discount, s.listSales) : null,
  };
}

export interface SaleLineInput {
  qty: number;
  listPrice: number | null;
  /** What the customer paid for the line, after both discounts. */
  lineTotal: number;
  cost: number;
}

/** List price × quantity, rounded half away from zero; at what was paid when the line has no list price. */
export function listAmount(qty: number, listPrice: number | null, lineTotal: number): number {
  return listPrice === null ? lineTotal : mulQty(qty as Qty, listPrice as Money);
}

/** One bill line's figures. */
export function saleLineFigures(l: SaleLineInput): SalesFigures {
  return salesFigures({
    qty: l.qty,
    sales: l.lineTotal,
    cost: l.cost,
    listSales: listAmount(l.qty, l.listPrice, l.lineTotal),
  });
}

// ---- Whose figures a return is (owner answer 2) ----

export interface Credit {
  salesmanId: string;
  /** null for a walk-in. */
  customerId: string | null;
}

/**
 * A sold line counts for its own bill's salesman and customer. A returned line counts for the salesman and customer of
 * the bill it returns, when that bill is known; a return with no receipt counts for whoever took it back.
 */
export function creditedTo(i: { qty: number; own: Credit; original: Credit | null }): Credit {
  return i.qty < 0 && i.original !== null ? i.original : i.own;
}

// ---- Comparing with another period ----

export interface Change {
  amount: number;
  /** Of the earlier figure's size; null when it was 0. */
  bp: number | null;
}

export function change(now: number, before: number): Change {
  const amount = now - before;
  return { amount, bp: before === 0 ? null : bp(amount, Math.abs(before)) };
}

// ---- The daily trend (RPT-15, owner answer 5) ----

export type TrendStep = 'day' | 'week' | 'month';

const MS = 86_400_000;
const dayNo = (d: string) => Date.parse(`${d}T00:00:00Z`) / MS;
const dateOf = (n: number) => new Date(n * MS).toISOString().slice(0, 10);

/** By day up to 92 days, by week up to a year, by month beyond. */
export function trendStep(p: Period): TrendStep {
  const days = checkRange(p, Number.MAX_SAFE_INTEGER);
  return days <= 92 ? 'day' : days <= 366 ? 'week' : 'month';
}

/** The range cut into days, weeks (Monday to Sunday) or months, the first and last cut to the range. */
export function periodBuckets(p: Period, step: TrendStep): Period[] {
  checkRange(p, Number.MAX_SAFE_INTEGER);
  const end = dayNo(p.to);
  const out: Period[] = [];
  for (let at = dayNo(p.from); at <= end;) {
    let last: number;
    if (step === 'day') last = at;
    // 1970-01-01 was a Thursday: (n + 3) % 7 is 0 on a Monday.
    else if (step === 'week') last = at + 6 - ((at + 3) % 7);
    else {
      const d = new Date(at * MS);
      last = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0) / MS;
    }
    if (last > end) last = end;
    out.push({ from: dateOf(at), to: dateOf(last) });
    at = last + 1;
  }
  return out;
}

export interface TrendDay {
  date: string;
  bills: number;
  sales: number;
  profit: number;
}

export interface TrendPoint extends Period {
  bills: number;
  sales: number;
  profit: number;
}

/** The days' figures added up into the range's buckets; a bucket with nothing sold is 0, never missing. */
export function trendSeries(i: { period: Period; step: TrendStep; days: TrendDay[] }): TrendPoint[] {
  const points = periodBuckets(i.period, i.step).map((b) => ({ ...b, bills: 0, sales: 0, profit: 0 }));
  for (const d of i.days) {
    const point = points.find((b) => b.from <= d.date && d.date <= b.to);
    if (!point)
      throw new DomainError('invalid_range', `${d.date} is outside ${i.period.from} to ${i.period.to}`);
    point.bills += d.bills;
    point.sales += d.sales;
    point.profit += d.profit;
  }
  return points;
}

// ---- Busy hours (RPT-15, owner answer 5) ----

export interface HourGrid {
  /** [weekday][hour], Monday first; each bill once. */
  bills: number[][];
  sales: number[][];
  /** The first and last hour any bill was made in, or null when there were none. */
  hours: { first: number; last: number } | null;
}

/**
 * Bills by the weekday of their business date and the hour on the counter's clock. A bill at 03:30 is on the previous
 * business day (the 04:00 cut-off), so it counts on that day's weekday, at hour 3.
 */
export function hourGrid(bills: readonly { date: string; hour: number; sales: number }[]): HourGrid {
  const grid = () => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const out: HourGrid = { bills: grid(), sales: grid(), hours: null };
  for (const b of bills) {
    if (!Number.isInteger(b.hour) || b.hour < 0 || b.hour > 23)
      throw new DomainError('invalid_hour', `not an hour: ${b.hour}`);
    const weekday = (dayNo(b.date) + 3) % 7;
    out.bills[weekday]![b.hour]! += 1;
    out.sales[weekday]![b.hour]! += b.sales;
    out.hours = {
      first: Math.min(out.hours?.first ?? b.hour, b.hour),
      last: Math.max(out.hours?.last ?? b.hour, b.hour),
    };
  }
  return out;
}

// ---- Top and bottom items (RPT-15, owner answer 5) ----

export const RANKINGS = ['sales', 'profit', 'qty'] as const;
export type Ranking = (typeof RANKINGS)[number];

export interface Ranked {
  id: string;
  qty: number;
  sales: number;
  profit: number;
}

/**
 * The top `n` by the measure (only those above 0), and the bottom `n`: the items that sold (net quantity above 0) with
 * the least of it, losses first, leaving out any already in the top. Ties by id.
 */
export function topAndBottom<T extends Ranked>(
  items: readonly T[],
  by: Ranking,
  n: number,
): { top: T[]; bottom: T[] } {
  const byId = (a: T, b: T) => Number(a.id > b.id) - Number(a.id < b.id);
  const top = items
    .filter((x) => x[by] > 0)
    .sort((a, b) => b[by] - a[by] || byId(a, b))
    .slice(0, n);
  const inTop = new Set(top.map((x) => x.id));
  const bottom = items
    .filter((x) => x.qty > 0 && !inTop.has(x.id))
    .sort((a, b) => a[by] - b[by] || byId(a, b))
    .slice(0, n);
  return { top, bottom };
}

// ---- Purchase and sale rates (RPT-09, owner answer 4) ----

export interface RateLine {
  qty: number;
  /** The line's net value: after the line and bill discounts. */
  value: number;
}

export interface RateStats {
  count: number;
  qty: number;
  value: number;
  /** Per unit, in minor units: total value ÷ total quantity, never an average of rates. */
  average: number | null;
  lowest: number | null;
  highest: number | null;
  /** The last line's rate, the lines being in date order. */
  last: number | null;
}

/** A line's net rate per unit, rounded half away from zero; quantity above 0. */
export const rateOf = (l: RateLine) => Number(divRound(BigInt(l.value) * 1000n, BigInt(l.qty)));

/** The rates of the lines (in date order) bought or sold; lines with no quantity above 0 are left out. */
export function rateStats(lines: readonly RateLine[]): RateStats {
  const kept = lines.filter((l) => l.qty > 0);
  const rates = kept.map(rateOf);
  const qty = kept.reduce((s, l) => s + l.qty, 0);
  const value = kept.reduce((s, l) => s + l.value, 0);
  return {
    count: kept.length,
    qty,
    value,
    average: qty > 0 ? rateOf({ qty, value }) : null,
    lowest: rates.length ? Math.min(...rates) : null,
    highest: rates.length ? Math.max(...rates) : null,
    last: rates.at(-1) ?? null,
  };
}

/** Average sale rate − average purchase rate, and as a share of the sale rate; null without both. */
export function spread(
  sale: number | null,
  purchase: number | null,
): { amount: number; marginBp: number | null } | null {
  if (sale === null || purchase === null) return null;
  const amount = sale - purchase;
  return { amount, marginBp: sale > 0 ? bp(amount, sale) : null };
}
