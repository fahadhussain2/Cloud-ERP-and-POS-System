import type { Money } from './money';
import type { PaymentMethodCode } from './tender';

// Void or return, from where the bill's money is (W1-23, D-111): a void is only for a bill whose money hasn't reached
// the shop; once any of it has, the refund must be recorded, which only a return does. The desk's cash is known from
// the server (or this desk's own records), else asked; a bank, wallet or card payment reaches the shop at the counter,
// and only a person checking the account's app or SMS knows it arrived, so it is always asked. On account moves no
// money and is never asked. The counter and the server judge with the same rule.

/** What the desk knows of a bill's cash (`CashDeskStatus` of the void check, repeated here to keep this file alone). */
type DeskStatus = 'pending' | 'not_applicable' | 'received' | 'paid_out' | 'unknown';

export type PaymentAnswer = 'arrived' | 'not_arrived';
/** `checked`: the desk's status said it (the server's live answer, or this desk's own records); `asked`: a person. */
export type PaymentKnown = 'checked' | 'asked';

/** A payment as the bill carries it. */
export interface BillPayment {
  method: PaymentMethodCode;
  amount: Money;
}

/** A part of the bill's payment that brings money in, and what is known of it; null until it is asked. */
export interface PaymentPart {
  method: PaymentMethodCode;
  amount: Money;
  known: PaymentKnown | null;
  answer: PaymentAnswer | null;
}

/** A part whose arrival is known: what the void document records (`SaleVoidV2.paymentChecks`). */
export interface PaymentCheck {
  method: PaymentMethodCode;
  amount: Money;
  known: PaymentKnown;
  answer: PaymentAnswer;
}

export type VoidOrReturn =
  | { decision: 'void' }
  | { decision: 'return' }
  /** A bank, wallet or card part hasn't arrived while another part has: the customer completes it first. */
  | { decision: 'stop'; method: PaymentMethodCode; amount: Money };

/**
 * The parts of a bill's payment that bring money in (never on account, never a refund row), in the bill's order. The
 * cash part is known from the desk's status unless it is `unknown`; every other part is still to ask.
 */
export function paymentParts(payments: readonly BillPayment[], deskStatus: DeskStatus): PaymentPart[] {
  return payments
    .filter((p) => p.method !== 'on_account' && p.amount > 0)
    .map((p) => {
      if (p.method !== 'cash' || deskStatus === 'unknown')
        return { method: p.method, amount: p.amount, known: null, answer: null };
      const arrived = deskStatus === 'received' || deskStatus === 'paid_out';
      return {
        method: p.method,
        amount: p.amount,
        known: 'checked',
        answer: arrived ? 'arrived' : 'not_arrived',
      };
    });
}

/**
 * The parts with the person's answers (by method: a bill has each method once): every part known, or null while any
 * part is still unanswered.
 */
export function answeredParts(
  parts: readonly PaymentPart[],
  answers: Partial<Record<PaymentMethodCode, PaymentAnswer>>,
): PaymentCheck[] | null {
  const checks: PaymentCheck[] = [];
  for (const p of parts) {
    if (p.known !== null && p.answer !== null) {
      checks.push({ method: p.method, amount: p.amount, known: p.known, answer: p.answer });
      continue;
    }
    const answer = answers[p.method];
    if (answer === undefined) return null;
    checks.push({ method: p.method, amount: p.amount, known: 'asked', answer });
  }
  return checks;
}

/**
 * Nothing has arrived → void; everything has, or only the desk's cash is still to come → a return (the refund and the
 * bill's cash due meet in the desk's queue); a bank, wallet or card part missing while another part arrived → stop.
 */
export function voidOrReturn(checks: readonly PaymentCheck[]): VoidOrReturn {
  if (!checks.some((c) => c.answer === 'arrived')) return { decision: 'void' };
  const missing = checks.find((c) => c.answer === 'not_arrived' && c.method !== 'cash');
  if (missing !== undefined) return { decision: 'stop', method: missing.method, amount: missing.amount };
  return { decision: 'return' };
}

/**
 * Guard 1 (W1-23): should a return of this bill be a void instead? Only a bill with a cash part, on its own business
 * day, whose cash hasn't reached the desk and that has no bank, wallet or card part (one paid at the counter has, as a
 * rule, arrived: the return asks nothing about it).
 */
export function returnWouldBeVoid(input: {
  payments: readonly BillPayment[];
  /** The cash part's arrival, from the desk's status or the person's answer; null without a cash part. */
  cash: PaymentAnswer | null;
  billBusinessDate: string;
  today: string;
}): boolean {
  if (input.cash === null || input.billBusinessDate !== input.today) return false;
  const checks = paymentParts(input.payments, 'unknown').map((p): PaymentCheck => ({
    method: p.method,
    amount: p.amount,
    known: 'asked',
    answer: p.method === 'cash' ? input.cash! : 'arrived',
  }));
  return checks.some((c) => c.method === 'cash') && voidOrReturn(checks).decision === 'void';
}
