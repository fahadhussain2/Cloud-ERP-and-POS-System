import type { SystemRole } from './accounts';
import { DomainError } from './errors';

// Back-office accounting (W1-19; ACC-04, ACC-05, ACC-06; owner answers 1–6; D-108). Pure; money in paisa (CLAUDE.md
// rule 1), dates as YYYY-MM-DD. The API checks with these before it posts; the back office as you type.

/**
 * Accounts the system keeps equal to something else, so a journal voucher can't touch them (D-108): Inventory (the
 * stock ledger), the drawer (the desk's count) and cash in transit (the bills not handed over).
 */
export const KEPT_ROLES = [
  'INVENTORY',
  'CASH_DRAWER',
  'CASH_IN_TRANSIT',
] as const satisfies readonly SystemRole[];

const whole = (v: number) => Number.isSafeInteger(v);
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date as YYYY-MM-DD, or null. */
function parts(date: string): { y: number; m: number; d: number } | null {
  const match = DAY.exec(date);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? { y, m, d } : null;
}
const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The last day of the date's month. */
export function monthEnd(date: string): string {
  const p = parts(date);
  if (!p) throw new DomainError('invalid_date', `not a date: ${date}`);
  return iso(p.y, p.m, lastDay(p.y, p.m));
}

export type DateProblem = 'date_required' | 'date_in_future' | 'date_locked';

/** A back-office document's date: given, not after today, after the lock date (D-108). */
export function checkDocumentDate(
  date: string | null,
  today: string,
  lockDate: string | null,
): DateProblem | null {
  if (!date || !parts(date)) return 'date_required';
  if (date > today) return 'date_in_future';
  if (lockDate !== null && date <= lockDate) return 'date_locked';
  return null;
}

/** `safe` = the shop's safe (CASH_SAFE); any other value is a bank account's id; null = not chosen. */
export type MoneyEnd = string | null;

export type MoneyDocumentInput = {
  date: string | null;
  today: string;
  lockDate: string | null;
  amount: number;
  /** What is already recorded on that date, of the same kind: its key (see `moneyDocumentKey`) and amount. */
  sameDay: { key: string; amount: number }[];
} & (
  | { kind: 'receipt'; customerId: string | null; bankAccountId: string | null }
  | { kind: 'expense'; categoryId: string | null; paidFrom: MoneyEnd }
  | {
      kind: 'transfer';
      from: MoneyEnd;
      to: MoneyEnd;
      charges: number;
      chargesCategoryId: string | null;
    }
);

export type MoneyProblem =
  | DateProblem
  | 'amount_invalid'
  | 'customer_required'
  | 'bank_required'
  | 'category_required'
  | 'paid_from_required'
  | 'from_required'
  | 'to_required'
  | 'same_account'
  | 'charges_invalid'
  | 'charges_category_required';

/** What makes two documents of a kind look like the same one: the customer, the category, the route. */
export function moneyDocumentKey(input: MoneyDocumentInput): string {
  if (input.kind === 'receipt') return input.customerId ?? '';
  if (input.kind === 'expense') return input.categoryId ?? '';
  return `${input.from ?? ''}>${input.to ?? ''}`;
}

/** A receipt, expense or transfer before it is posted (ACC-04): problems block it, the warning doesn't. */
export function checkMoneyDocument(input: MoneyDocumentInput): {
  problems: MoneyProblem[];
  warnings: 'possible_duplicate'[];
} {
  const problems: MoneyProblem[] = [];
  const date = checkDocumentDate(input.date, input.today, input.lockDate);
  if (date) problems.push(date);
  if (!whole(input.amount) || input.amount <= 0) problems.push('amount_invalid');
  if (input.kind === 'receipt') {
    if (!input.customerId) problems.push('customer_required');
    if (!input.bankAccountId) problems.push('bank_required');
  } else if (input.kind === 'expense') {
    if (!input.categoryId) problems.push('category_required');
    if (!input.paidFrom) problems.push('paid_from_required');
  } else {
    if (!input.from) problems.push('from_required');
    if (!input.to) problems.push('to_required');
    if (input.from && input.from === input.to) problems.push('same_account');
    if (!whole(input.charges) || input.charges < 0 || input.charges >= input.amount)
      problems.push('charges_invalid');
    else if (input.charges > 0 && !input.chargesCategoryId) problems.push('charges_category_required');
  }
  const key = moneyDocumentKey(input);
  const duplicate = input.sameDay.some((d) => d.key === key && d.amount === input.amount);
  return { problems, warnings: duplicate ? ['possible_duplicate'] : [] };
}

export interface VoucherAccount {
  postable: boolean;
  active: boolean;
  role: SystemRole | null;
}

export interface VoucherCheckInput {
  date: string | null;
  today: string;
  lockDate: string | null;
  narration: string | null;
  lines: { accountId: string | null; partyId: string | null; debit: number; credit: number }[];
  /** Every account the lines name. */
  accounts: Record<string, VoucherAccount>;
  /** Every party the lines name: is it a customer, a supplier (or both)? */
  parties: Record<string, { customer: boolean; supplier: boolean }>;
}

export type VoucherProblem =
  | DateProblem
  | 'narration_required'
  | 'lines_too_few'
  | 'unbalanced'
  | 'account_required'
  | 'account_not_postable'
  | 'account_inactive'
  | 'account_kept'
  | 'amount_invalid'
  | 'party_required'
  | 'party_not_customer'
  | 'party_not_supplier'
  | 'party_not_allowed';

const KEPT = new Set<SystemRole>(KEPT_ROLES);

/** A journal voucher before it is posted (ACC-05): the header's problems, then each line's, and the totals. */
export function checkJournalVoucher(input: VoucherCheckInput): {
  problems: { problem: VoucherProblem; row: number | null }[];
  debit: number;
  credit: number;
} {
  const header: { problem: VoucherProblem; row: null }[] = [];
  const rows: { problem: VoucherProblem; row: number }[] = [];
  const date = checkDocumentDate(input.date, input.today, input.lockDate);
  if (date) header.push({ problem: date, row: null });
  if (!input.narration?.trim()) header.push({ problem: 'narration_required', row: null });
  if (input.lines.length < 2) header.push({ problem: 'lines_too_few', row: null });

  let debit = 0;
  let credit = 0;
  let amountsValid = true;
  input.lines.forEach((l, row) => {
    const account = l.accountId ? input.accounts[l.accountId] : undefined;
    if (!account) rows.push({ problem: 'account_required', row });
    else if (!account.postable) rows.push({ problem: 'account_not_postable', row });
    else if (!account.active) rows.push({ problem: 'account_inactive', row });
    else if (account.role !== null && KEPT.has(account.role)) rows.push({ problem: 'account_kept', row });

    const valid =
      whole(l.debit) && whole(l.credit) && l.debit >= 0 && l.credit >= 0 && l.debit > 0 !== l.credit > 0;
    if (!valid) {
      amountsValid = false;
      rows.push({ problem: 'amount_invalid', row });
    } else {
      debit += l.debit;
      credit += l.credit;
    }

    if (!account) return;
    const party = l.partyId ? input.parties[l.partyId] : undefined;
    if (account.role === 'AR_CONTROL' || account.role === 'AP_CONTROL') {
      if (!party) rows.push({ problem: 'party_required', row });
      else if (account.role === 'AR_CONTROL' && !party.customer)
        rows.push({ problem: 'party_not_customer', row });
      else if (account.role === 'AP_CONTROL' && !party.supplier)
        rows.push({ problem: 'party_not_supplier', row });
    } else if (l.partyId) rows.push({ problem: 'party_not_allowed', row });
  });
  if (amountsValid && debit !== credit) header.push({ problem: 'unbalanced', row: null });
  return { problems: [...header, ...rows], debit, credit };
}

export interface FiscalMonth {
  start: string;
  end: string;
}
export interface FiscalYear {
  /** `2027` for a January year, `2026-27` for any other. */
  label: string;
  start: string;
  end: string;
  months: FiscalMonth[];
}

/** The fiscal year a date falls in, from the shop's start month (ACC-06, D-035): computed, never stored. */
export function fiscalYearOf(date: string, startMonth: number): FiscalYear {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12)
    throw new DomainError('invalid_start_month', `not a month: ${startMonth}`);
  const p = parts(date);
  if (!p) throw new DomainError('invalid_date', `not a date: ${date}`);
  const startYear = p.m >= startMonth ? p.y : p.y - 1;
  const months: FiscalMonth[] = [];
  for (let i = 0; i < 12; i += 1) {
    const m0 = startMonth - 1 + i;
    const y = startYear + Math.floor(m0 / 12);
    const m = (m0 % 12) + 1;
    months.push({ start: iso(y, m, 1), end: iso(y, m, lastDay(y, m)) });
  }
  const label =
    startMonth === 1 ? String(startYear) : `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  return { label, start: months[0]!.start, end: months[11]!.end, months };
}

export interface LockMoveInput {
  current: string | null;
  proposed: string;
  today: string;
  /** acc.period.reopen: only the owner (owner answer 5). */
  canReopen: boolean;
  reason: string | null;
}

export type LockProblem =
  'not_month_end' | 'month_not_over' | 'unchanged' | 'reopen_not_allowed' | 'reason_required';

/** Moving the lock date (ACC-06, owner answer 5): forward to the end of a month that is over; back only by the owner. */
export function checkLockMove(input: LockMoveInput): {
  problems: LockProblem[];
  direction: 'forward' | 'back' | null;
} {
  const { current, proposed } = input;
  if (current !== null && proposed === current) return { problems: ['unchanged'], direction: null };
  const direction = current !== null && proposed < current ? 'back' : 'forward';
  const problems: LockProblem[] = [];
  const p = parts(proposed);
  if (!p || proposed !== iso(p.y, p.m, lastDay(p.y, p.m))) problems.push('not_month_end');
  else if (proposed >= input.today) problems.push('month_not_over');
  if (direction === 'back') {
    if (!input.canReopen) problems.push('reopen_not_allowed');
    else if (!input.reason?.trim()) problems.push('reason_required');
  }
  return { problems, direction };
}
