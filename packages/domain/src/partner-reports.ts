import type { AccountType } from './accounts';
import { DomainError } from './errors';
import { dayNumber, settleOldestFirst, type AgeingEntry } from './reports';
import type { Period } from './statements';

// The customer, supplier and control reports' rules (W2-04 plan; RPT-16, RPT-17, ACC-07; D-116). Pure: the API reads
// the party sub-ledger, the audit log and the journal, and hands them here, so the screens, the CSV and the tests agree
// (rule 1). Money is integer minor units, dates YYYY-MM-DD.

const MS = 86_400_000;
const dateOf = (n: number) => new Date(n * MS).toISOString().slice(0, 10);

// ---- The partner ledger (RPT-16, owner answer 1) ----

export type PartyRole = 'customer' | 'supplier';

/** One sub-ledger entry: `amount` > 0 = owed more (the customer owes the shop more, or the shop owes the supplier). */
export interface LedgerEntry {
  kind: string;
  amount: number;
}

export type LedgerLine<E extends LedgerEntry> = E & { debit: number; credit: number; balance: number };

export interface KindTotal {
  kind: string;
  count: number;
  debit: number;
  credit: number;
}

export interface PartnerLedger<E extends LedgerEntry> {
  opening: number;
  lines: LedgerLine<E>[];
  /** The totals by kind of document (the legacy *Business Partner Activity*), by kind. */
  byKind: KindTotal[];
  debit: number;
  credit: number;
  closing: number;
}

/**
 * The entries (in date and posting order) with the opening before them and a running balance. A customer's bill is a
 * debit and a payment a credit; a supplier's bill is a credit and a payment a debit, as in the books.
 */
export function partnerLedger<E extends LedgerEntry>(i: {
  role: PartyRole;
  opening: number;
  entries: readonly E[];
}): PartnerLedger<E> {
  let balance = i.opening;
  const kinds = new Map<string, KindTotal>();
  let debit = 0;
  let credit = 0;
  const lines = i.entries.map((e) => {
    balance += e.amount;
    const raises = e.amount > 0;
    const dr = (i.role === 'customer') === raises ? Math.abs(e.amount) : 0;
    const cr = Math.abs(e.amount) - dr;
    debit += dr;
    credit += cr;
    const k = kinds.get(e.kind) ?? { kind: e.kind, count: 0, debit: 0, credit: 0 };
    kinds.set(e.kind, { kind: e.kind, count: k.count + 1, debit: k.debit + dr, credit: k.credit + cr });
    return { ...e, debit: dr, credit: cr, balance };
  });
  return {
    opening: i.opening,
    lines,
    byKind: [...kinds.values()].sort((a, b) => Number(a.kind > b.kind) - Number(a.kind < b.kind)),
    debit,
    credit,
    closing: balance,
  };
}

export interface VoidableEntry extends LedgerEntry {
  sourceId: string;
  /** For a `sales_void` entry: the bill it voids. */
  voidOf: string | null;
}

/**
 * The statement's entries (owner answer 1): a voided bill and its void are left out when they net to nothing, so the
 * closing is unchanged; anything else stays.
 */
export function withoutVoidedBills<E extends VoidableEntry>(entries: readonly E[]): E[] {
  const net = new Map<string, number>();
  for (const e of entries) {
    const bill = e.kind === 'sales_void' ? e.voidOf : e.kind === 'sale' ? e.sourceId : null;
    if (bill !== null) net.set(bill, (net.get(bill) ?? 0) + e.amount);
  }
  const voided = new Set(
    entries
      .filter((e) => e.kind === 'sales_void' && e.voidOf !== null && net.get(e.voidOf) === 0)
      .map((e) => e.voidOf),
  );
  return entries.filter(
    (e) =>
      !((e.kind === 'sale' && voided.has(e.sourceId)) || (e.kind === 'sales_void' && voided.has(e.voidOf))),
  );
}

// ---- The balance trend (RPT-16, owner answer 3) ----

/** `n` months before a date, the day kept or cut to the month's end (31 May → 30 Apr). */
function monthsBefore(date: string, n: number): string {
  const d = new Date(dayNumber(date) * MS);
  const month = d.getUTCMonth() - n;
  const last = new Date(Date.UTC(d.getUTCFullYear(), month + 1, 0)).getUTCDate();
  return dateOf(Date.UTC(d.getUTCFullYear(), month, Math.min(d.getUTCDate(), last)) / MS);
}

/** As on the date, then 15 days, 1, 2, 3 and 6 months before it: the legacy report's points. */
export function trendDates(asOf: string): string[] {
  return [asOf, dateOf(dayNumber(asOf) - 15), ...[1, 2, 3, 6].map((n) => monthsBefore(asOf, n))];
}

// ---- Overdue and over the limit (RPT-17, owner answer 4) ----

export interface Overdue {
  balance: number;
  /** What is unpaid of the debits more than `days` past due, the oldest paid first. */
  overdue: number;
  /** The oldest unpaid debit more than `days` past due: its entry date and days past due. */
  oldestDate: string | null;
  oldestLate: number | null;
}

/** One party's entries as on a date: what is overdue by more than `days` (0 or more). */
export function overdueOf(i: {
  asOf: string;
  days: number;
  entries: readonly Omit<AgeingEntry, 'partyId'>[];
}): Overdue {
  if (!Number.isInteger(i.days) || i.days < 0)
    throw new DomainError('out_of_range', `not a number of days: ${i.days}`);
  const asOf = dayNumber(i.asOf);
  const { debits } = settleOldestFirst(i.entries);
  const late = debits.filter((d) => d.left > 0 && asOf - d.due > i.days);
  const oldest = late[0];
  return {
    balance: i.entries.reduce((s, e) => s + e.amount, 0),
    overdue: late.reduce((s, d) => s + d.left, 0),
    oldestDate: oldest ? dateOf(oldest.at) : null,
    oldestLate: oldest ? asOf - oldest.due : null,
  };
}

/** Over the limit, or within 10% of it (at 90% or more, with something owed); a null limit is no limit (D-085). */
export function limitState(i: { balance: number; limit: number | null }): 'over' | 'near' | null {
  if (i.limit === null) return null;
  if (i.balance > i.limit) return 'over';
  return i.balance > 0 && BigInt(i.balance) * 10n >= BigInt(i.limit) * 9n ? 'near' : null;
}

// ---- User activity (RPT-17, owner answer 6) ----

export const ACTIVITY_KINDS = [
  'sign_in',
  'sales',
  'approvals',
  'items',
  'parties',
  'money',
  'stock',
  'settings',
  'books',
  'other',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

const TABLE_KINDS: Record<string, ActivityKind> = {
  sales_documents: 'sales',
  sales_voids: 'sales',
  overrides: 'approvals',
  exceptions: 'approvals',
  items: 'items',
  item_prices: 'items',
  item_identifiers: 'items',
  item_compatibility: 'items',
  categories: 'items',
  brands: 'items',
  vehicle_makes: 'items',
  origins: 'items',
  price_tiers: 'items',
  parties: 'parties',
  customer_accounts: 'parties',
  supplier_accounts: 'parties',
  payments: 'money',
  customer_receipts: 'money',
  supplier_payments: 'money',
  expenses: 'money',
  fund_transfers: 'money',
  journal_vouchers: 'money',
  cash_sessions: 'money',
  cash_handovers: 'money',
  cash_movements: 'money',
  goods_receipts: 'stock',
  purchase_returns: 'stock',
  stock_adjustments: 'stock',
  stock_transfers: 'stock',
  users: 'settings',
  roles: 'settings',
  user_roles: 'settings',
  devices: 'settings',
  tenants: 'settings',
  branches: 'settings',
  locations: 'settings',
  payment_methods: 'settings',
  print_profiles: 'settings',
  tax_codes: 'settings',
  transfer_routes: 'settings',
  bank_accounts: 'settings',
  expense_categories: 'settings',
  accounts: 'settings',
  opening_balances: 'books',
};

const EVENT_KINDS: Record<string, ActivityKind> = {
  login: 'sign_in',
  password: 'sign_in',
  pin: 'sign_in',
  sale: 'sales',
  exception: 'approvals',
  exceptions: 'approvals',
  device: 'settings',
  period: 'books',
  posting: 'books',
  pilot: 'books',
};

/** A bill's lines and payments are part of the bill's own row (one row per bill). */
const LINE_TABLES = new Set(['sales_lines', 'sales_payments']);

/**
 * The kind of an audit row: a named event (`login.failed`, `sale.voided`) by its first word, a row change (`create`,
 * `update`, `delete`) by its table; null for a bill's lines, which the bill's row stands for.
 */
export function activityKind(entity: string, action: string): ActivityKind | null {
  const dot = action.indexOf('.');
  if (dot > 0) return EVENT_KINDS[action.slice(0, dot)] ?? 'other';
  if (LINE_TABLES.has(entity)) return null;
  return TABLE_KINDS[entity] ?? 'other';
}

export interface ChangedField {
  field: string;
  before: unknown;
  after: unknown;
}

/** Bookkeeping columns every change touches; never a change worth showing. */
const NOISE = new Set(['row_version', 'txid', 'updated_at', 'updated_by_user_id']);

/** The fields an update changed, by name; a field added or removed counts, with null on the missing side. */
export function changedFields(
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>> | null,
): ChangedField[] {
  if (before === null || after === null) return [];
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((f) => !NOISE.has(f))
    .sort();
  return fields
    .filter((f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null))
    .map((f) => ({ field: f, before: before[f] ?? null, after: after[f] ?? null }));
}

// ---- The cash flow (ACC-07, owner answer 7) ----

export const CASH_FLOW_CLASSES = [
  'opening',
  'sales',
  'customers',
  'suppliers',
  'expenses',
  'owner',
  'shortOver',
  'other',
] as const;
export type CashFlowClass = (typeof CASH_FLOW_CLASSES)[number];

/** One journal line on an account that isn't cash or bank: debit − credit. */
export interface CashFlowLine {
  accountId: string;
  role: string | null;
  type: AccountType;
  amount: number;
}

/** One journal entry that touches cash or bank: its net change in cash and bank, and its other lines. */
export interface CashFlowEntry {
  sourceType: string;
  cash: number;
  others: readonly CashFlowLine[];
}

export interface CashFlowPart {
  cls: CashFlowClass;
  /** The expense account, for expenses; null otherwise. */
  accountId: string | null;
  /** In > 0, out < 0. */
  amount: number;
}

/** Documents whose whole cash change is one class, whatever their other lines are. */
const SOURCE_CLASSES: Record<string, CashFlowClass> = {
  opening: 'opening',
  sale: 'sales',
  sales_void: 'sales',
  goods_receipt: 'suppliers',
  purchase_return: 'suppliers',
};

const ROLE_CLASSES: Record<string, CashFlowClass> = {
  AR_CONTROL: 'customers',
  AP_CONTROL: 'suppliers',
  CASH_SHORT_OVER: 'shortOver',
  SALES: 'sales',
  SALES_RETURNS: 'sales',
  SALES_DISCOUNT: 'sales',
  ROUNDING: 'sales',
};

function classOf(l: CashFlowLine): CashFlowClass {
  const byRole = l.role === null ? undefined : ROLE_CLASSES[l.role];
  if (byRole) return byRole;
  return l.type === 'expense' ? 'expenses' : l.type === 'equity' ? 'owner' : 'other';
}

/**
 * What an entry's cash change was for. A bill, a void, a goods receipt or a purchase return is one class; anything else
 * (collections, payments, expenses, the desk's cash-outs and variances, transfers' charges, vouchers) is split by the
 * accounts on its other lines. Moves between cash and bank accounts change nothing, so transfers drop out.
 */
export function cashFlowOf(e: CashFlowEntry): CashFlowPart[] {
  if (e.cash === 0) return [];
  const whole = SOURCE_CLASSES[e.sourceType];
  if (whole) return [{ cls: whole, accountId: null, amount: e.cash }];
  if (e.others.length === 0) return [{ cls: 'other', accountId: null, amount: e.cash }];
  const parts = new Map<string, CashFlowPart>();
  for (const l of e.others) {
    const cls = classOf(l);
    const accountId = cls === 'expenses' ? l.accountId : null;
    const key = `${cls}:${accountId ?? ''}`;
    const p = parts.get(key) ?? { cls, accountId, amount: 0 };
    parts.set(key, { ...p, amount: p.amount - l.amount });
  }
  return [...parts.values()].filter((p) => p.amount !== 0);
}

export interface CashFlowColumn extends Period {
  opening: number;
  net: number;
  closing: number;
}

export interface CashFlowRow {
  cls: CashFlowClass;
  accountId: string | null;
  /** One per column. */
  amounts: number[];
  total: number;
}

export interface CashFlowStatement {
  columns: CashFlowColumn[];
  rows: CashFlowRow[];
  total: { opening: number; net: number; closing: number };
}

/**
 * The parts by column (month): opening + every class = closing, each column opening where the last one closed. Rows in
 * the classes' order, expenses by account id; a class with nothing is left out.
 */
export function cashFlowStatement(i: {
  columns: readonly Period[];
  opening: number;
  parts: readonly (CashFlowPart & { date: string })[];
}): CashFlowStatement {
  const rows = new Map<string, CashFlowRow>();
  const nets = i.columns.map(() => 0);
  for (const p of i.parts) {
    const at = i.columns.findIndex((c) => c.from <= p.date && p.date <= c.to);
    if (at < 0) throw new DomainError('invalid_range', `${p.date} is outside the columns`);
    const key = `${CASH_FLOW_CLASSES.indexOf(p.cls)}:${p.accountId ?? ''}`;
    const row = rows.get(key) ?? {
      cls: p.cls,
      accountId: p.accountId,
      amounts: i.columns.map(() => 0),
      total: 0,
    };
    row.amounts[at]! += p.amount;
    row.total += p.amount;
    rows.set(key, row);
    nets[at]! += p.amount;
  }
  let open = i.opening;
  const columns = i.columns.map((c, n) => {
    const col = { from: c.from, to: c.to, opening: open, net: nets[n]!, closing: open + nets[n]! };
    open = col.closing;
    return col;
  });
  const net = nets.reduce((s, x) => s + x, 0);
  return {
    columns,
    rows: [...rows.entries()]
      .sort(([a], [b]) => Number(a > b) - Number(a < b))
      .map(([, r]) => r)
      .filter((r) => r.amounts.some((x) => x !== 0)),
    total: { opening: i.opening, net, closing: i.opening + net },
  };
}
