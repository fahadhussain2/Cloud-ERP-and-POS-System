import { businessDate } from './business-date';
import { MAX_NOTE_LENGTH, trimmedOrNull } from './desk-text';
import { DomainError } from './errors';
import type { Money } from './money';
import {
  answeredParts,
  paymentParts,
  voidOrReturn,
  type BillPayment,
  type PaymentAnswer,
  type PaymentCheck,
  type PaymentKnown,
} from './payment-check';
import { can, effectiveLimits, type RoleGrant } from './permissions';
import { documentNumber } from './sale-document';
import type { PaymentMethodCode } from './tender';

// Voiding a finalized bill (POS-11, PRD W5, D-002, POS spec §18, W1-12): only on the device that made it, on its own
// business day, before its cash reaches the desk, with the PIN of someone holding `pos.void` and a reason. The bill is
// never changed (rule 3): the void is its own signed document (family V), and the server reverses the bill's posting.
// The server flags what looks wrong and never refuses (D-011, D-059). W1-23 (D-111): never once any of the bill's money
// has reached the shop (`voidOrReturn`): the counter checks each payment part, and the void records what it knew.

/** The reasons a bill is voided (owner answer 5 to W1-12); the labels are i18n keys `override.reason.<code>`. */
export const VOID_REASONS = [
  'wrong_item',
  'wrong_quantity',
  'wrong_price',
  'wrong_customer_or_payment',
  'duplicate_bill',
  'customer_cancelled',
  'other',
] as const;
export type VoidReason = (typeof VOID_REASONS)[number];

/** What the counter knows of the bill's cash at the desk: the live check online, else `unknown`. */
export type CashDeskStatus = 'pending' | 'not_applicable' | 'received' | 'paid_out' | 'unknown';

/** What the void document records the counter knew (a handed-over bill is never voided). */
export type HandoverSeen = 'pending' | 'not_applicable' | 'unknown';

/** A bill of this counter, as the void needs it. */
export interface VoidableBill {
  id: string;
  number: string;
  deviceId: string;
  businessDate: string;
  total: Money;
  cashDue: Money;
  status: 'finalized' | 'voided';
  /** Its payments (W1-23): where the money is decides between a void and a return. */
  payments: readonly BillPayment[];
}

export interface VoidInput {
  bill: VoidableBill;
  /** This device: only its own bills are voided here (owner answer 2). */
  deviceId: string;
  branchId: string;
  /** The business date now. */
  today: string;
  deskStatus: CashDeskStatus;
  /** The person's answers for the parts the desk's status doesn't settle (W1-23), by method. */
  answers: Partial<Record<PaymentMethodCode, PaymentAnswer>>;
  approverId: string;
  approverGrants: readonly RoleGrant[];
  reason: VoidReason | null;
  note: string | null;
}

export type VoidProblem =
  | 'other_device'
  | 'already_voided'
  | 'other_day'
  | 'handed_over'
  /** A payment part is still unanswered (W1-23). */
  | 'payment_unanswered'
  /** The money has reached the shop: a return, not a void (W1-23, D-111). */
  | 'money_arrived'
  /** A bank, wallet or card part hasn't arrived while another part has: the customer completes it first. */
  | 'payment_missing'
  | 'not_permitted'
  | 'window_none'
  | 'reason_required'
  | 'note_required'
  | 'note_too_long';

export type VoidCheck =
  | {
      ok: true;
      reason: VoidReason;
      note: string | null;
      handoverSeen: HandoverSeen;
      /** The desk couldn't be asked about a bill with cash: the server flags it if the cash was taken. */
      warning: 'desk_unknown' | null;
      /** What was known of each part that brings money in (W1-23). */
      paymentChecks: PaymentCheck[];
    }
  | { ok: false; problem: VoidProblem };

/**
 * May someone with `grants` approve a void in this branch? `pos.void` and a window other than `none`. No window allows
 * a void after the handover (owner answer 1 to W1-12), so `same_day` behaves as `same_day_before_handover`.
 */
export function canVoid(
  grants: readonly RoleGrant[],
  branchId: string,
): 'not_permitted' | 'window_none' | null {
  if (!can(grants, 'pos.void', branchId)) return 'not_permitted';
  if (effectiveLimits(grants, branchId).voidWindow === 'none') return 'window_none';
  return null;
}

/** May this bill be voided now, with this approver and reason? The first problem found, in a fixed order. */
export function checkVoid(input: VoidInput): VoidCheck {
  const { bill } = input;
  if (bill.deviceId !== input.deviceId) return { ok: false, problem: 'other_device' };
  if (bill.status === 'voided') return { ok: false, problem: 'already_voided' };
  if (bill.businessDate !== input.today) return { ok: false, problem: 'other_day' };
  const withCash = bill.cashDue !== 0;
  if (withCash && (input.deskStatus === 'received' || input.deskStatus === 'paid_out'))
    return { ok: false, problem: 'handed_over' };
  const paymentChecks = answeredParts(paymentParts(bill.payments, input.deskStatus), input.answers);
  if (paymentChecks === null) return { ok: false, problem: 'payment_unanswered' };
  const decision = voidOrReturn(paymentChecks).decision;
  if (decision !== 'void')
    return { ok: false, problem: decision === 'return' ? 'money_arrived' : 'payment_missing' };
  const denied = canVoid(input.approverGrants, input.branchId);
  if (denied !== null) return { ok: false, problem: denied };
  if (input.reason === null) return { ok: false, problem: 'reason_required' };
  const note = trimmedOrNull(input.note);
  if (input.reason === 'other' && note === null) return { ok: false, problem: 'note_required' };
  if (note !== null && [...note].length > MAX_NOTE_LENGTH) return { ok: false, problem: 'note_too_long' };
  const handoverSeen: HandoverSeen = !withCash
    ? 'not_applicable'
    : input.deskStatus === 'unknown'
      ? 'unknown'
      : 'pending';
  return {
    ok: true,
    reason: input.reason,
    note,
    handoverSeen,
    warning: handoverSeen === 'unknown' ? 'desk_unknown' : null,
    paymentChecks,
  };
}

/** `SaleVoidV2` in `@erp/contracts` is its wire schema (sync spec §6.2, POS spec §18); V1 (W1-12) has no checks. */
export interface SaleVoidDocument {
  version: 1 | 2;
  id: string;
  family: 'V';
  seq: number;
  number: string;
  deviceId: string;
  branchId: string;
  saleId: string;
  saleNumber: string;
  saleBusinessDate: string;
  saleTotal: Money;
  saleCashDue: Money;
  /** Who was unlocked and asked for the void. */
  userId: string;
  /** Whoever entered their PIN; may be the same person. */
  approvedBy: string;
  reason: VoidReason;
  note: string | null;
  handoverSeen: HandoverSeen;
  /** V2 (W1-23): what the counter knew of each payment part, and how; absent on V1. */
  paymentChecks?: PaymentCheck[];
  createdAt: string;
  businessDate: string;
  clientVersion: string;
}

/** What the counter knows when it writes a void, like a sale's context. */
export interface VoidContext {
  /** UUIDv7 made on the counter. */
  id: string;
  seq: number;
  deviceId: string;
  deviceCode: string;
  branchId: string;
  createdAtMs: number;
  timeZone: string;
  cutoffHour: number;
  clientVersion: string;
}

/** The void document, or the check's problem as a DomainError; today is the business date of the void's own time. */
export function buildVoidDocument(
  input: Omit<VoidInput, 'today'> & { userId: string; context: VoidContext },
): SaleVoidDocument {
  const c = input.context;
  const today = businessDate(c.createdAtMs, c.timeZone, c.cutoffHour);
  const check = checkVoid({ ...input, today });
  if (!check.ok)
    throw new DomainError(check.problem, `${input.bill.number} can't be voided: ${check.problem}`);
  return {
    version: 2,
    id: c.id,
    family: 'V',
    seq: c.seq,
    number: documentNumber(c.deviceCode, 'V', c.seq),
    deviceId: c.deviceId,
    branchId: c.branchId,
    saleId: input.bill.id,
    saleNumber: input.bill.number,
    saleBusinessDate: input.bill.businessDate,
    saleTotal: input.bill.total,
    saleCashDue: input.bill.cashDue,
    userId: input.userId,
    approvedBy: input.approverId,
    reason: check.reason,
    note: check.note,
    handoverSeen: check.handoverSeen,
    paymentChecks: check.paymentChecks,
    createdAt: new Date(c.createdAtMs).toISOString(),
    businessDate: today,
    clientVersion: c.clientVersion,
  };
}

export type VoidFinding =
  | { kind: 'duplicate_void'; duplicateOf: string; duplicateOfNumber: string }
  | { kind: 'void_not_permitted'; cause: 'not_permitted' | 'window_none' | 'other_day' | 'money_arrived' }
  | {
      kind: 'cash_received_for_void';
      handoverId: string;
      handoverNumber: string;
      handoverAt: string;
      /** The desk took the cash before the void (a void after the handover), or after it (cash for a voided bill). */
      order: 'before_void' | 'after_void';
      /** How the counter knew the cash wasn't at the desk (W1-23): the desk's status, a person's answer, or null (V1). */
      cashKnown: PaymentKnown | null;
    };

/** What the server holds when it reviews a void. */
export interface VoidReview {
  /** The stored bill, or null until it arrives. */
  bill: { id: string; businessDate: string; cashDue: Money } | null;
  /** A handover in of the bill's number that isn't a duplicate (an offline scan may have no bill yet), or null. */
  handover: { id: string; number: string; at: string } | null;
  /** An earlier void of the bill that isn't itself a duplicate, or null. */
  existing: { id: string; number: string } | null;
  /** The roles the server holds for the approver. */
  grants: readonly RoleGrant[];
  branchId: string;
}

/**
 * The server's findings on a pushed void (sync spec §6.2), in this order: a second void of the bill (alone: it is never
 * posted), an approver or a day the rules don't allow, cash in the drawer for the voided bill (D-059).
 */
export function reviewVoid(document: SaleVoidDocument, context: VoidReview): VoidFinding[] {
  if (context.existing !== null && context.existing.id !== document.id)
    return [
      {
        kind: 'duplicate_void',
        duplicateOf: context.existing.id,
        duplicateOfNumber: context.existing.number,
      },
    ];
  const findings: VoidFinding[] = [];
  const denied = canVoid(context.grants, context.branchId);
  const saleDate = context.bill?.businessDate ?? document.saleBusinessDate;
  if (denied !== null) findings.push({ kind: 'void_not_permitted', cause: denied });
  else if (saleDate !== document.businessDate)
    findings.push({ kind: 'void_not_permitted', cause: 'other_day' });
  else if (document.paymentChecks !== undefined && voidOrReturn(document.paymentChecks).decision !== 'void')
    findings.push({ kind: 'void_not_permitted', cause: 'money_arrived' });
  if (context.handover !== null)
    findings.push({
      kind: 'cash_received_for_void',
      handoverId: context.handover.id,
      handoverNumber: context.handover.number,
      handoverAt: context.handover.at,
      order: context.handover.at <= document.createdAt ? 'before_void' : 'after_void',
      cashKnown: cashKnownOf(document),
    });
  return findings;
}

/** How the void's counter knew the bill's cash wasn't at the desk: from its cash check (V2), else null. */
export function cashKnownOf(document: Pick<SaleVoidDocument, 'paymentChecks'>): PaymentKnown | null {
  return document.paymentChecks?.find((c) => c.method === 'cash')?.known ?? null;
}
