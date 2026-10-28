import { DomainError } from './errors';
import { toSafeNumber } from './exact';
import { money, sub, sum, type Money } from './money';

// Paying a bill on the counter (POS spec §12, POS-06, POS-17, D-047, D-053): which tenders are valid, the change, what
// goes to the cash desk, and the quick-cash amounts. The counter checks with these; the server re-checks synced bills
// with the same functions (W1-07).

/** Payment method codes (data model §5); a tenant turns them on and off. */
export type PaymentMethodCode =
  'cash' | 'bank_transfer' | 'raast' | 'jazzcash' | 'easypaisa' | 'card' | 'on_account';

/** An active payment method as the counter pulled it. */
export interface PaymentMethodInfo {
  code: PaymentMethodCode;
  isCash: boolean;
  requiresReference: boolean;
}

/** One row of what the customer pays: a method and its amount, with a reference for non-cash methods. */
export interface TenderLine {
  method: string;
  amount: Money;
  reference: string | null;
}

export interface Tender {
  payments: TenderLine[];
  /** What the customer handed over for the cash row; null = the exact amount. */
  cashReceived: Money | null;
}

/** The first problem with a tender (POS spec §12), shown as the i18n key `tender.<code>`. */
export type TenderProblem =
  | 'no_payment'
  | 'unknown_method'
  | 'on_account_needs_customer'
  | 'duplicate_method'
  | 'amount_not_positive'
  | 'amount_not_rounded'
  | 'reference_required'
  | 'reference_too_long'
  | 'sum_mismatch'
  | 'cash_received_without_cash'
  | 'cash_received_short';

/** At most this many characters in a payment reference. */
export const MAX_REFERENCE_LENGTH = 40;

/** A payment as the finalized document carries it (sync spec §6.1). */
export interface SettledPayment {
  method: PaymentMethodCode;
  amount: Money;
  /** Cash only: what was handed over, null = exact. */
  cashReceived: Money | null;
  /** Cash only: the change; null for other methods. */
  changeDue: Money | null;
  /** Trimmed; null when there is none. */
  reference: string | null;
}

export interface Settlement {
  payments: SettledPayment[];
  /** The cash row's amount (0 without one): what the salesman brings to the cash desk. */
  cashDue: Money;
  change: Money;
}

const isCashRow = (methods: readonly PaymentMethodInfo[], line: TenderLine) =>
  methods.some((m) => m.code === line.method && m.isCash);

const trimmed = (reference: string | null) => reference?.trim() ?? '';

interface TenderInput {
  total: Money;
  increment: Money;
  methods: readonly PaymentMethodInfo[];
  tender: Tender;
  hasCreditCustomer: boolean;
}

/** The first problem with a tender in the order of POS spec §12, or null when it is valid. */
export function checkTender(input: TenderInput): TenderProblem | null {
  const { total, increment, methods, tender } = input;
  if (increment <= 0)
    throw new DomainError('invalid_increment', `the rounding increment must be positive: ${increment}`);
  const rows = tender.payments;
  if (rows.length === 0) return 'no_payment';
  const info = rows.map((r) => methods.find((m) => m.code === r.method));
  if (info.some((m) => m === undefined)) return 'unknown_method';
  if (rows.some((r) => r.method === 'on_account') && !input.hasCreditCustomer)
    return 'on_account_needs_customer';
  if (new Set(rows.map((r) => r.method)).size !== rows.length) return 'duplicate_method';
  if (rows.some((r) => r.amount <= 0)) return 'amount_not_positive';
  if (rows.some((r) => r.amount % increment !== 0)) return 'amount_not_rounded';
  if (rows.some((r, i) => info[i]!.requiresReference && trimmed(r.reference) === ''))
    return 'reference_required';
  // A reference on a cash row is dropped, so only the others count.
  if (rows.some((r, i) => !info[i]!.isCash && trimmed(r.reference).length > MAX_REFERENCE_LENGTH))
    return 'reference_too_long';
  if (sum(rows.map((r) => r.amount)) !== total) return 'sum_mismatch';
  if (tender.cashReceived !== null) {
    const cash = rows.find((r) => isCashRow(methods, r));
    if (cash === undefined) return 'cash_received_without_cash';
    if (tender.cashReceived < cash.amount) return 'cash_received_short';
  }
  return null;
}

/** The payments as the document keeps them, the cash due and the change. Refuses a tender `checkTender` refuses. */
export function settleTender(input: TenderInput): Settlement {
  const problem = checkTender(input);
  if (problem !== null) throw new DomainError('invalid_tender', `the tender is not valid: ${problem}`);
  const { methods, tender } = input;
  let cashDue = money(0);
  let change = money(0);
  const payments = tender.payments.map((r): SettledPayment => {
    const method = r.method as PaymentMethodCode;
    if (!isCashRow(methods, r)) {
      const reference = trimmed(r.reference);
      return { method, amount: r.amount, cashReceived: null, changeDue: null, reference: reference || null };
    }
    cashDue = r.amount;
    change = tender.cashReceived === null ? money(0) : sub(tender.cashReceived, r.amount);
    return {
      method,
      amount: r.amount,
      cashReceived: tender.cashReceived,
      changeDue: change,
      reference: null,
    };
  });
  return { payments, cashDue, change };
}

const QUICK_CASH_NOTES = [500n, 1_000n, 5_000n, 10_000n];
const QUICK_CASH_TOP_UP = 5_000n;

/**
 * The quick-cash amounts above `total` (POS spec §12): for each of 500, 1,000, 5,000 and 10,000 major units, the next
 * multiple strictly above the total; the three smallest distinct ones, topped up with multiples of 5,000. `unit` is one
 * major unit in minor units (Rs 1 = 100).
 */
export function quickCash(total: Money, unit: Money): Money[] {
  const t = BigInt(total);
  const above = (step: bigint) => (t / step + 1n) * step;
  // Each note is a multiple of the one before, so its next multiple is never smaller: the list is already in order.
  const picked = [...new Set(QUICK_CASH_NOTES.map((n) => above(n * BigInt(unit))))].slice(0, 3);
  const topUp = QUICK_CASH_TOP_UP * BigInt(unit);
  while (picked.length < 3) picked.push((picked.at(-1)! / topUp + 1n) * topUp);
  return picked.map((a) => toSafeNumber(a) as Money);
}
