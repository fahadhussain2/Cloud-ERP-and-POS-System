import { fiscalYearOf } from './accounting';
import type { AccountType } from './accounts';
import { DomainError } from './errors';

// The financial statements and the report periods (W2-01 plan; ACC-07, RPT-11; D-110, D-116). Pure: the API reads the
// journal's sums and hands them here, so the screens, the CSV and the tests agree to the paisa (rule 1). Dates are
// YYYY-MM-DD. Nothing here reads the clock: "today" is passed in.

/** An account as the statements need it: the chart's tree gives every section and subtotal (no codes are assumed). */
export interface StatementAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  postable: boolean;
  role: string | null;
}

export interface Sides {
  debit: number;
  credit: number;
}

// ---- The chart's tree ----

interface Node {
  account: StatementAccount;
  children: Node[];
}

// Codes are unique in a chart (ACC-01), so two nodes never tie.
const byCode = (a: Node, b: Node) =>
  Number(a.account.code > b.account.code) - Number(a.account.code < b.account.code);

/** The chart as a tree, each level by code; an account whose parent is missing sits at the top. */
function treeOf(accounts: readonly StatementAccount[]): Node[] {
  const nodes = new Map(accounts.map((a) => [a.id, { account: a, children: [] as Node[] }]));
  const roots: Node[] = [];
  for (const n of nodes.values()) {
    const parent = n.account.parentId === null ? undefined : nodes.get(n.account.parentId);
    (parent ? parent.children : roots).push(n);
  }
  for (const n of nodes.values()) n.children.sort(byCode);
  return roots.sort(byCode);
}

/** A map of accountId → value, refusing an account the chart doesn't have. */
function known<E extends { accountId: string }, T>(
  accounts: readonly StatementAccount[],
  entries: readonly E[],
  value: (e: E) => T,
): Map<string, T> {
  const ids = new Set(accounts.map((a) => a.id));
  const out = new Map<string, T>();
  for (const e of entries) {
    if (!ids.has(e.accountId)) throw new DomainError('unknown_account', `not in the chart: ${e.accountId}`);
    out.set(e.accountId, value(e));
  }
  return out;
}

/** −x without a negative zero, which a strict comparison tells apart from 0. */
const neg = (x: number) => 0 - x;

const side = (net: number): Sides => (net >= 0 ? { debit: net, credit: 0 } : { debit: 0, credit: -net });
const add = (a: Sides, b: Sides): Sides => ({ debit: a.debit + b.debit, credit: a.credit + b.credit });
const ZERO: Sides = { debit: 0, credit: 0 };

/** Basis points of `of`, rounded half away from zero (a percentage is not money, but stays exact). */
const bp = (part: number, of: number) => Math.sign(part) * Math.round((Math.abs(part) * 10000) / of);

// ---- Trial balance ----

export interface TrialBalanceInput {
  accounts: StatementAccount[];
  /** Per account: debits − credits before the period, and the period's debits and credits. */
  sums: { accountId: string; opening: number; debit: number; credit: number }[];
  level: 'accounts' | 'groups';
  showEmpty: boolean;
}

export interface TrialBalanceRow {
  id: string;
  code: string;
  name: string;
  depth: number;
  group: boolean;
  opening: Sides;
  movement: Sides;
  closing: Sides;
}

export interface TrialBalanceTotals {
  opening: Sides;
  movement: Sides;
  closing: Sides;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totals: TrialBalanceTotals;
  balanced: boolean;
}

/** The trial balance (ACC-07, owner answer 4): a group is the column sums of its rows, so every level balances. */
export function trialBalance(input: TrialBalanceInput): TrialBalance {
  const sums = known(input.accounts, input.sums, (e) => e);
  const rows: TrialBalanceRow[] = [];

  /** Adds a node's rows (after its own, so the group row comes first) and gives its totals and whether it shows. */
  const walk = (n: Node, depth: number): { totals: TrialBalanceTotals; shown: boolean } => {
    const a = n.account;
    const at = rows.length;
    const own = sums.get(a.id);
    let totals: TrialBalanceTotals = own
      ? {
          opening: side(own.opening),
          movement: { debit: own.debit, credit: own.credit },
          closing: side(own.opening + own.debit - own.credit),
        }
      : { opening: ZERO, movement: ZERO, closing: ZERO };
    let shown = own !== undefined && (own.opening !== 0 || own.debit !== 0 || own.credit !== 0);
    for (const ch of n.children) {
      const c = walk(ch, depth + 1);
      totals = {
        opening: add(totals.opening, c.totals.opening),
        movement: add(totals.movement, c.totals.movement),
        closing: add(totals.closing, c.totals.closing),
      };
      shown ||= c.shown;
    }
    const group = !a.postable;
    const listed = input.level === 'accounts' || group || depth === 0;
    if (listed && (shown || input.showEmpty))
      rows.splice(at, 0, { id: a.id, code: a.code, name: a.name, depth, group, ...totals });
    return { totals, shown };
  };

  let totals: TrialBalanceTotals = { opening: ZERO, movement: ZERO, closing: ZERO };
  for (const root of treeOf(input.accounts)) {
    const t = walk(root, 0).totals;
    totals = {
      opening: add(totals.opening, t.opening),
      movement: add(totals.movement, t.movement),
      closing: add(totals.closing, t.closing),
    };
  }
  const even = (s: Sides) => s.debit === s.credit;
  return { rows, totals, balanced: even(totals.opening) && even(totals.movement) && even(totals.closing) };
}

// ---- Sections of the profit and loss and the balance sheet ----

export interface StatementRow {
  id: string;
  code: string;
  name: string;
  depth: number;
  group: boolean;
  role: string | null;
  /** One amount per column, in the section's own sign (income and liabilities as positives). */
  amounts: number[];
}

export interface StatementSection {
  rows: StatementRow[];
  total: number[];
}

/**
 * A section's rows from its top-level groups: a lone group's children, or the groups themselves when there are
 * several. `amount(id, column)` is an account's own amount; a group's is the sum of its rows. Rows at zero in every
 * column are left out.
 */
function section(
  roots: readonly Node[],
  columns: number,
  amount: (id: string, column: number) => number,
): StatementSection {
  const rows: StatementRow[] = [];
  const walk = (n: Node, depth: number): number[] => {
    const at = rows.length;
    const amounts = Array.from({ length: columns }, (_, i) => amount(n.account.id, i));
    for (const ch of n.children) {
      const sub = walk(ch, depth + 1);
      for (let i = 0; i < columns; i += 1) amounts[i]! += sub[i]!;
    }
    const a = n.account;
    if (amounts.some((v) => v !== 0))
      rows.splice(at, 0, {
        id: a.id,
        code: a.code,
        name: a.name,
        depth,
        group: !a.postable,
        role: a.role,
        amounts,
      });
    return amounts;
  };
  const total = Array.from({ length: columns }, () => 0);
  // Groups aren't postable (ACC-01), so skipping a lone group's own row loses nothing.
  const tops = roots.length === 1 && roots[0]!.children.length > 0 ? roots[0]!.children : roots;
  for (const n of tops) {
    const sub = walk(n, 0);
    for (let i = 0; i < columns; i += 1) total[i]! += sub[i]!;
  }
  return { rows, total };
}

const zeros = (n: number) => Array.from({ length: n }, () => 0);

// ---- Profit and loss ----

export interface ProfitAndLossInput {
  accounts: StatementAccount[];
  /** The periods side by side: the first is the report's, the others its comparison or the months. */
  periods: { from: string; to: string; sums: { accountId: string; debit: number; credit: number }[] }[];
}

export interface ProfitAndLoss {
  periods: { from: string; to: string }[];
  revenue: StatementSection;
  costOfSales: StatementSection;
  grossProfit: number[];
  /** Basis points of revenue; null without revenue. */
  grossMargin: (number | null)[];
  expenses: StatementSection;
  netProfit: number[];
  netMargin: (number | null)[];
}

/** The multi-step profit and loss (ACC-07, owner answer 2): revenue, cost of sales, gross profit, expenses, net. */
export function profitAndLoss(input: ProfitAndLossInput): ProfitAndLoss {
  const columns = input.periods.length;
  const perPeriod = input.periods.map((p) => known(input.accounts, p.sums, (e) => e.debit - e.credit));
  const types = new Map(input.accounts.map((a) => [a.id, a.type]));
  // Income counts credits − debits, expenses debits − credits.
  const amount = (id: string, i: number) => {
    const net = perPeriod[i]!.get(id) ?? 0;
    return types.get(id) === 'income' ? neg(net) : net;
  };

  const roots = treeOf(input.accounts);
  const holdsCogs = (n: Node): boolean => n.account.role === 'COGS' || n.children.some(holdsCogs);
  const income = roots.filter((r) => r.account.type === 'income');
  const expense = roots.filter((r) => r.account.type === 'expense');
  const revenue = section(income, columns, amount);
  const costOfSales = section(expense.filter(holdsCogs), columns, amount);
  const expenses = section(
    expense.filter((r) => !holdsCogs(r)),
    columns,
    amount,
  );

  const grossProfit = zeros(columns).map((_, i) => revenue.total[i]! - costOfSales.total[i]!);
  const netProfit = grossProfit.map((g, i) => g - expenses.total[i]!);
  const margin = (v: number, i: number) => (revenue.total[i]! > 0 ? bp(v, revenue.total[i]!) : null);
  return {
    periods: input.periods.map((p) => ({ from: p.from, to: p.to })),
    revenue,
    costOfSales,
    grossProfit,
    grossMargin: grossProfit.map(margin),
    expenses,
    netProfit,
    netMargin: netProfit.map(margin),
  };
}

/** The change from a comparison column (owner answer 3): the amount, and basis points of the previous amount. */
export function changeOf(current: number, previous: number): { amount: number; bp: number | null } {
  const amount = current - previous;
  return { amount, bp: previous === 0 ? null : bp(amount, Math.abs(previous)) };
}

// ---- Balance sheet ----

export interface BalanceSheetInput {
  accounts: StatementAccount[];
  columns: {
    at: string;
    /** Every account's debits − credits up to and including `at`. */
    balances: { accountId: string; balance: number }[];
    /** The income and expense accounts' debits − credits from the start of `at`'s fiscal year. */
    year: { accountId: string; balance: number }[];
  }[];
}

export interface BalanceSheet {
  columns: { at: string }[];
  assets: StatementSection;
  liabilities: StatementSection;
  /** Its total includes the earlier years' profit and the profit for the year. */
  equity: StatementSection;
  profitForYear: number[];
  /** Income − expenses before this fiscal year: no closing entry moves it (W1-19), so it is added here. */
  earlierProfit: number[];
  /** Whether the earlier profit is inside the retained earnings row; otherwise it is shown on its own. */
  earlierInRetained: boolean;
  liabilitiesAndEquity: number[];
  /** Assets − (liabilities + equity): 0 whenever the books balance. */
  difference: number[];
}

/** The balance sheet on one or more dates (ACC-07, owner answer 3), with this year's profit computed, never posted. */
export function balanceSheet(input: BalanceSheetInput): BalanceSheet {
  const columns = input.columns.length;
  const types = new Map(input.accounts.map((a) => [a.id, a.type]));
  const isPl = (id: string) => types.get(id) === 'income' || types.get(id) === 'expense';
  const all = input.columns.map((c) => known(input.accounts, c.balances, (e) => e.balance));
  const year = input.columns.map((c) => known(input.accounts, c.year, (e) => e.balance));
  // Profit is credits − debits of the income and expense accounts.
  const profitOf = (m: Map<string, number>) => [...m].reduce((s, [id, v]) => (isPl(id) ? s - v : s), 0);
  const profitForYear = year.map(profitOf);
  const earlierProfit = all.map((m, i) => profitOf(m) - profitForYear[i]!);
  const retained = input.accounts.find((a) => a.role === 'RETAINED_EARNINGS');

  const roots = treeOf(input.accounts);
  const of = (type: AccountType) => roots.filter((r) => r.account.type === type);
  const debitSide = (id: string, i: number) => all[i]!.get(id) ?? 0;
  const creditSide = (id: string, i: number) =>
    neg(all[i]!.get(id) ?? 0) + (retained && id === retained.id ? earlierProfit[i]! : 0);

  const assets = section(of('asset'), columns, debitSide);
  const liabilities = section(of('liability'), columns, creditSide);
  const equity = section(of('equity'), columns, creditSide);
  equity.total = equity.total.map((v, i) => v + profitForYear[i]! + (retained ? 0 : earlierProfit[i]!));
  const liabilitiesAndEquity = zeros(columns).map((_, i) => liabilities.total[i]! + equity.total[i]!);
  return {
    columns: input.columns.map((c) => ({ at: c.at })),
    assets,
    liabilities,
    equity,
    profitForYear,
    earlierProfit,
    earlierInRetained: retained !== undefined,
    liabilitiesAndEquity,
    difference: assets.total.map((v, i) => v - liabilitiesAndEquity[i]!),
  };
}

// ---- Stock and purchases ----

export interface StockAndPurchasesInput {
  /** The Inventory account's debits − credits before the period. */
  opening: number;
  /** The Inventory account's lines in the period: each journal's source and its debits − credits. */
  movements: { sourceType: string; amount: number }[];
  /** The COGS account's debits − credits in the period. */
  costOfGoodsSold: number;
}

export interface StockAndPurchases {
  opening: number;
  purchases: number;
  purchaseReturns: number;
  adjustments: number;
  other: number;
  closing: number;
  stockUsed: number;
  costOfGoodsSold: number;
  difference: number;
}

/** The panel under the cost of goods sold (owner answer 2): the familiar view, made from the same books. */
export function stockAndPurchases(input: StockAndPurchasesInput): StockAndPurchases {
  const by = (types: readonly string[]) =>
    input.movements.filter((m) => types.includes(m.sourceType)).reduce((s, m) => s + m.amount, 0);
  const named = ['opening', 'goods_receipt', 'purchase_return', 'stock_adjustment', 'sale', 'sales_void'];
  const opening = input.opening + by(['opening']);
  const purchases = by(['goods_receipt']);
  const purchaseReturns = by(['purchase_return']);
  const adjustments = by(['stock_adjustment']);
  const atCost = by(['sale', 'sales_void']);
  const other = input.movements
    .filter((m) => !named.includes(m.sourceType))
    .reduce((s, m) => s + m.amount, 0);
  const closing = opening + purchases + purchaseReturns + adjustments + other + atCost;
  const stockUsed = opening + purchases + purchaseReturns + adjustments + other - closing;
  return {
    opening,
    purchases,
    purchaseReturns,
    adjustments,
    other,
    closing,
    stockUsed,
    costOfGoodsSold: input.costOfGoodsSold,
    difference: input.costOfGoodsSold - stockUsed,
  };
}

// ---- Cash book ----

export interface CashLine {
  accountId: string;
  date: string;
  debit: number;
  credit: number;
}

export interface CashBookInput<L extends CashLine = CashLine> {
  accounts: { id: string; opening: number }[];
  /** In posting order. */
  lines: L[];
}

export interface CashDay {
  date: string;
  opening: number;
  in: number;
  out: number;
  closing: number;
}

export interface CashBookAccount<L extends CashLine = CashLine> {
  id: string;
  opening: number;
  in: number;
  out: number;
  closing: number;
  days: CashDay[];
  lines: (L & { balance: number })[];
}

/** Each cash and bank account by day (ACC-07, owner answer 5), with every line's running balance. */
export function cashBook<L extends CashLine>(input: CashBookInput<L>): CashBookAccount<L>[] {
  const book = new Map(
    input.accounts.map((a) => [
      a.id,
      {
        id: a.id,
        opening: a.opening,
        in: 0,
        out: 0,
        closing: a.opening,
        days: [] as CashDay[],
        lines: [] as (L & { balance: number })[],
      },
    ]),
  );
  for (const l of input.lines) {
    const a = book.get(l.accountId);
    if (!a) throw new DomainError('unknown_account', `not in the cash book: ${l.accountId}`);
    let day = a.days[a.days.length - 1];
    if (day?.date !== l.date) {
      day = { date: l.date, opening: a.closing, in: 0, out: 0, closing: a.closing };
      a.days.push(day);
    }
    a.in += l.debit;
    a.out += l.credit;
    a.closing += l.debit - l.credit;
    day.in += l.debit;
    day.out += l.credit;
    day.closing = a.closing;
    a.lines.push({ ...l, balance: a.closing });
  }
  return [...book.values()];
}

// ---- Report periods ----

export interface Period {
  from: string;
  to: string;
}

export const PERIOD_PRESETS = [
  'today',
  'yesterday',
  'thisWeek',
  'thisMonth',
  'lastMonth',
  'thisQuarter',
  'lastQuarter',
  'thisYear',
  'lastYear',
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS = 86_400_000;

/** Days since 1970-01-01; a date that isn't one is refused. */
function dayNo(date: string): number {
  const m = DAY.exec(date);
  const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [NaN, NaN, NaN];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (!m || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d)
    throw new DomainError('invalid_date', `not a date: ${date}`);
  return t.getTime() / MS;
}
const dateOf = (n: number) => new Date(n * MS).toISOString().slice(0, 10);
const ymd = (date: string) => ({
  y: Number(date.slice(0, 4)),
  m: Number(date.slice(5, 7)),
  d: Number(date.slice(8, 10)),
});
const iso = (y: number, m: number, d: number) => dateOf(Date.UTC(y, m - 1, d) / MS);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isMonthEnd = (date: string) => {
  const p = ymd(date);
  return p.d === lastDay(p.y, p.m);
};
/** The month `count` months from the one `date` is in: its first and last day. */
const monthFrom = (date: string, count: number): Period => {
  const p = ymd(date);
  const first = new Date(Date.UTC(p.y, p.m - 1 + count, 1));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth() + 1;
  return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) };
};

/** A preset's dates on `today`, quarters and years from the shop's fiscal year (ACC-06). */
export function periodOf(preset: PeriodPreset, today: string, fiscalYearStartMonth: number): Period {
  const n = dayNo(today);
  const year = fiscalYearOf(today, fiscalYearStartMonth);
  const quarter = Math.floor(year.months.findIndex((m) => m.start <= today && today <= m.end) / 3);
  const quarterOf = (y: typeof year, q: number): Period => ({
    from: y.months[q * 3]!.start,
    to: y.months[q * 3 + 2]!.end,
  });
  const lastYear = fiscalYearOf(dateOf(dayNo(year.start) - 1), fiscalYearStartMonth);
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: dateOf(n - 1), to: dateOf(n - 1) };
    case 'thisWeek': {
      // 1970-01-01 was a Thursday: (n + 3) % 7 is 0 on a Monday.
      const monday = n - ((n + 3) % 7);
      return { from: dateOf(monday), to: dateOf(monday + 6) };
    }
    case 'thisMonth':
      return monthFrom(today, 0);
    case 'lastMonth':
      return monthFrom(today, -1);
    case 'thisQuarter':
      return quarterOf(year, quarter);
    case 'lastQuarter':
      return quarter === 0 ? quarterOf(lastYear, 3) : quarterOf(year, quarter - 1);
    case 'thisYear':
      return { from: year.start, to: year.end };
    case 'lastYear':
      return { from: lastYear.start, to: lastYear.end };
    default:
      throw new DomainError('invalid_preset', `not a preset: ${String(preset)}`);
  }
}

/** Both dates real and the right way round. */
function checked(p: Period): { from: number; to: number } {
  const from = dayNo(p.from);
  const to = dayNo(p.to);
  if (from > to) throw new DomainError('invalid_range', `${p.from} is after ${p.to}`);
  return { from, to };
}

/** The number of days in a range, counting both ends; more than `maxDays` is refused (D-116 answer 4). */
export function checkRange(p: Period, maxDays: number): number {
  const r = checked(p);
  const days = r.to - r.from + 1;
  if (days > maxDays) throw new DomainError('range_too_long', `${days} days is more than ${maxDays}`);
  return days;
}

/** The period just before: as many whole months, or as many days (owner answer 3). */
export function previousPeriod(p: Period): Period {
  const r = checked(p);
  if (ymd(p.from).d === 1 && isMonthEnd(p.to)) {
    const a = ymd(p.from);
    const b = ymd(p.to);
    const months = (b.y - a.y) * 12 + (b.m - a.m) + 1;
    return { from: monthFrom(p.from, -months).from, to: monthFrom(p.to, -months).to };
  }
  const days = r.to - r.from + 1;
  return { from: dateOf(r.from - days), to: dateOf(r.to - days) };
}

/** The same period a year before: 29 February becomes the 28th; a month's last day stays the last day. */
export function lastYearPeriod(p: Period): Period {
  checked(p);
  const back = (date: string, end: boolean) => {
    const { y, m, d } = ymd(date);
    return iso(y - 1, m, end ? lastDay(y - 1, m) : Math.min(d, lastDay(y - 1, m)));
  };
  return { from: back(p.from, false), to: back(p.to, isMonthEnd(p.to)) };
}

/** The range month by month, up to 12 (owner answer 3). */
export function monthsOf(p: Period): Period[] {
  checked(p);
  const out: Period[] = [];
  for (let at = p.from; at <= p.to; at = dateOf(dayNo(monthFrom(at, 0).to) + 1)) {
    const end = monthFrom(at, 0).to;
    out.push({ from: at, to: end < p.to ? end : p.to });
    if (out.length > 12) throw new DomainError('range_too_long', `more than 12 months: ${p.from} to ${p.to}`);
  }
  return out;
}
