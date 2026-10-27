import type { Money } from './money';

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

const notBuilt = (...args: unknown[]): never => {
  throw new Error(`not built yet (W1-06): ${args.length} arguments`);
};

export function checkTender(input: {
  total: Money;
  increment: Money;
  methods: readonly PaymentMethodInfo[];
  tender: Tender;
  hasCreditCustomer: boolean;
}): TenderProblem | null {
  return notBuilt(input);
}

/** The payments as the document keeps them, the cash due and the change. Refuses a tender `checkTender` refuses. */
export function settleTender(input: {
  total: Money;
  increment: Money;
  methods: readonly PaymentMethodInfo[];
  tender: Tender;
  hasCreditCustomer: boolean;
}): Settlement {
  return notBuilt(input);
}

/**
 * The quick-cash amounts above `total` (POS spec §12): for each of 500, 1,000, 5,000 and 10,000 major units, the next
 * multiple strictly above the total; the three smallest distinct ones, topped up with multiples of 5,000. `unit` is one
 * major unit in minor units (Rs 1 = 100).
 */
export function quickCash(total: Money, unit: Money): Money[] {
  return notBuilt(total, unit);
}
