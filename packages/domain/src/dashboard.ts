import { DomainError } from './errors';
import { divRound } from './exact';
import { dayNumber } from './reports';
import { change } from './sales-reports';
import type { Period } from './statements';

// The owner's dashboard (W2-06 plan; RPT-18; D-118). Pure: the API reads the reports' own figures and hands them here,
// so the screen and the tests agree (rule 1). Money is integer minor units, shares basis points, dates YYYY-MM-DD.

const MS = 86_400_000;
const dateOf = (n: number) => new Date(n * MS).toISOString().slice(0, 10);
/** part ÷ of in basis points, rounded half away from zero; `of` is never 0 here. */
const bp = (part: number, of: number) => Number(divRound(BigInt(part) * 10_000n, BigInt(of)));

// ---- The period and what it is compared with (owner answer 2) ----

export const DASHBOARD_PERIODS = ['today', '7d', '30d'] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

export const isDashboardPeriod = (v: string): v is DashboardPeriod =>
  (DASHBOARD_PERIODS as readonly string[]).includes(v);

export interface DashboardWindows {
  current: Period;
  comparison: Period;
  /** Today only: the comparison day counts up to this minute of its business day (see `businessMinute`). */
  upToMinute: number | null;
  /** The comparison reaches before the shop's first business day (or there is none): show "before go-live". */
  beforeFirstDay: boolean;
}

/**
 * Today against the same weekday last week, up to the same minute of the business day; 7 and 30 days against as many
 * days just before. `minute` is the business minute now; `firstDay` the shop's first business day, if any.
 */
export function dashboardWindows(i: {
  period: DashboardPeriod;
  today: string;
  minute: number;
  firstDay: string | null;
}): DashboardWindows {
  if (!isDashboardPeriod(i.period))
    throw new DomainError('invalid_preset', `unknown period ${String(i.period)}`);
  const t = dayNumber(i.today);
  const days = i.period === 'today' ? 1 : i.period === '7d' ? 7 : 30;
  const current = { from: dateOf(t - days + 1), to: i.today };
  const back = i.period === 'today' ? 7 : days;
  const comparison = { from: dateOf(t - days + 1 - back), to: dateOf(t - back) };
  return {
    current,
    comparison,
    upToMinute: i.period === 'today' ? i.minute : null,
    beforeFirstDay: i.firstDay === null || comparison.from < i.firstDay,
  };
}

/** Minutes since the business day began at the cut-off hour (GLOSSARY): 02:00 with a 04:00 cut-off is minute 1320. */
export function businessMinute(hour: number, minute: number, cutoffHour: number): number {
  return ((hour - cutoffHour + 24) % 24) * 60 + minute;
}

// ---- Key figures' change chips ----

export interface Chip {
  amount: number;
  /** Of the earlier figure's size; null when it was 0. */
  bp: number | null;
  direction: 'up' | 'down' | 'flat';
  /** null when unchanged. */
  good: boolean | null;
}

/** The change against the comparison; up is good for sales, profit and cash, bad for what customers owe. */
export function chipOf(i: { now: number; before: number; goodWhenUp: boolean }): Chip {
  const c = change(i.now, i.before);
  const direction = c.amount > 0 ? 'up' : c.amount < 0 ? 'down' : 'flat';
  return {
    amount: c.amount,
    bp: c.bp,
    direction,
    good: direction === 'flat' ? null : (direction === 'up') === i.goodWhenUp,
  };
}

// ---- Discounts, returns and voids (owner answer 3) ----

/**
 * How many times the comparison a count is, in tenths (25 = 2.5×), when it is unusual: at least 1.5 times and at
 * least 3. null otherwise, and when there is nothing to compare with.
 */
export function unusualTimes(count: number, usual: number): number | null {
  if (count < 3 || usual <= 0 || count * 10 < usual * 15) return null;
  return Number(divRound(BigInt(count) * 10n, BigInt(usual)));
}

// ---- Where the month's gross profit went (owner answer 4) ----

export interface DonutSlice {
  kind: 'net' | 'expense' | 'other';
  /** The expense category's name; null for net profit and other expenses. */
  name: string | null;
  amount: number;
  /** Of the ring's whole (`base`). */
  bp: number;
}

export interface GpDonut {
  /** Expenses are more than the gross profit. */
  loss: boolean;
  /** Gross profit − expenses. */
  net: number;
  /** The ring's whole: the gross profit, or in a loss month the expenses. */
  base: number;
  /** Net profit's share of the gross profit; null in a loss month or with nothing yet. */
  keptBp: number | null;
  slices: DonutSlice[];
}

const byAmountThenName = <T extends { name: string; amount: number }>(a: T, b: T) =>
  b.amount - a.amount || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Net profit, the two biggest expense categories by name, and the rest as other; never more than four slices. */
export function gpDonut(i: {
  grossProfit: number;
  expenses: readonly { name: string; amount: number }[];
}): GpDonut {
  const totalExpenses = i.expenses.reduce((t, e) => t + e.amount, 0);
  const net = i.grossProfit - totalExpenses;
  const loss = net < 0;
  const base = loss ? totalExpenses : Math.max(i.grossProfit, 0);
  if (base <= 0) return { loss, net, base: Math.max(base, 0), keptBp: null, slices: [] };
  const top = i.expenses
    .filter((e) => e.amount > 0)
    .slice()
    .sort(byAmountThenName)
    .slice(0, 2);
  const other = totalExpenses - top.reduce((t, e) => t + e.amount, 0);
  const slices: DonutSlice[] = [];
  if (!loss && net > 0) slices.push({ kind: 'net', name: null, amount: net, bp: bp(net, base) });
  for (const e of top)
    slices.push({ kind: 'expense', name: e.name, amount: e.amount, bp: bp(e.amount, base) });
  if (other > 0) slices.push({ kind: 'other', name: null, amount: other, bp: bp(other, base) });
  return { loss, net, base, keptBp: loss ? null : bp(net, base), slices };
}

// ---- What customers owe us ----

export interface Balance {
  id: string;
  name: string;
  amount: number;
}

export interface BiggestBalances {
  /** Every balance, credit balances included (as the books). */
  total: number;
  /** How many owe us something. */
  count: number;
  top: Balance[];
  /** Everyone else: those who owe us, and the credit balances' amount. */
  rest: { count: number; amount: number };
}

/** The n biggest balances owed to us (largest first, ties by name) and the rest. */
export function biggestBalances(balances: readonly Balance[], n: number): BiggestBalances {
  const total = balances.reduce((t, b) => t + b.amount, 0);
  const owing = balances.filter((b) => b.amount > 0).sort(byAmountThenName);
  const top = owing.slice(0, n);
  return {
    total,
    count: owing.length,
    top,
    rest: { count: owing.length - top.length, amount: total - top.reduce((t, b) => t + b.amount, 0) },
  };
}

// ---- What needs attention (owner answer 5) ----

export interface AttentionInput {
  highExceptions: number;
  negativeStock: number;
  /** Counters not seen for 10 minutes while their cash session is open (the API decides which). */
  unseenCounters: readonly { name: string; minutes: number }[];
  atMinimum: number;
  overLimit: number;
  openSessions: number;
}

export type AttentionKind =
  'exceptions' | 'negativeStock' | 'counterUnseen' | 'atMinimum' | 'overLimit' | 'openSessions';

export interface AttentionItem {
  kind: AttentionKind;
  tone: 'bad' | 'warn' | 'info';
  count: number;
  /** The counter's name, for an unseen counter. */
  name: string | null;
  /** How long an unseen counter hasn't been seen. */
  minutes: number | null;
}

export const ATTENTION_LINES = 6;

/** Up to six lines, the most serious first; nothing to report leaves a line out. */
export function attentionList(i: AttentionInput): AttentionItem[] {
  const line = (kind: AttentionKind, tone: AttentionItem['tone'], count: number): AttentionItem[] =>
    count > 0 ? [{ kind, tone, count, name: null, minutes: null }] : [];
  const counters = i.unseenCounters
    .slice()
    .sort((a, b) => b.minutes - a.minutes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((c): AttentionItem => ({
      kind: 'counterUnseen',
      tone: 'warn',
      count: 1,
      name: c.name,
      minutes: c.minutes,
    }));
  return [
    ...line('exceptions', 'bad', i.highExceptions),
    ...line('negativeStock', 'bad', i.negativeStock),
    ...counters,
    ...line('atMinimum', 'warn', i.atMinimum),
    ...line('overLimit', 'warn', i.overLimit),
    ...line('openSessions', 'info', i.openSessions),
  ].slice(0, ATTENTION_LINES);
}
