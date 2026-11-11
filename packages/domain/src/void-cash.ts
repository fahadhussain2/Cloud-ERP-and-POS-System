import { businessDate } from './business-date';
import type { CashMovementDocument } from './cash-movement';
import type { DeskContext, DeskSession } from './cash-session';
import { DomainError } from './errors';
import type { Money } from './money';
import { can, type Permission, type RoleGrant } from './permissions';
import { documentNumber } from './sale-document';

// Cash taken for a voided bill, given back at the desk (W1-23, D-111): when a void and a handover clash (a counter
// voided offline, a desk took the cash), the cashier gives the full amount back, with the PIN of a `pos.void` holder
// who is never the session's cashier (owner answer 1). A cash movement of kind `void_cash` (family M, V2): it undoes
// what the handover did, `Dr CASH_IN_TRANSIT / Cr CASH_DRAWER`, and is in the session's expected cash. The server
// flags what looks wrong, never refuses (rule 7).

/** A bill the desk may give cash back for, as its queue and its own handovers know it. */
export interface VoidCashBill {
  number: string;
  status: 'finalized' | 'voided';
  /** The cash the desk took for it (a handover in, not a duplicate), or null when none is known. */
  cashTaken: Money | null;
  /** Already given back: this desk's own movement, or the server's word in the queue. */
  givenBack: boolean;
}

export interface VoidCashInput {
  session: DeskSession | null;
  cashierId: string;
  grants: readonly RoleGrant[];
  branchId: string;
  bill: VoidCashBill;
  /** Whoever entered their PIN (checked by the screen, offline), or null before anyone has. */
  approverId: string | null;
  approverGrants: readonly RoleGrant[];
}

export type VoidCashProblem =
  | 'not_voided'
  | 'no_cash_taken'
  | 'already_given_back'
  | 'no_session'
  | 'not_session_cashier'
  | 'not_permitted'
  | 'approver_required'
  | 'approver_is_cashier'
  | 'approver_not_permitted';

export type VoidCashCheck =
  | { ok: true; amount: Money; approverId: string }
  | { ok: false; problem: Exclude<VoidCashProblem, 'not_permitted'> }
  | { ok: false; problem: 'not_permitted'; permission: Permission };

const PAY: Permission = 'cash.refund.pay';
const APPROVE: Permission = 'pos.void';

/** May this cashier give back the cash taken for this voided bill now? The first problem found, in a fixed order. */
export function checkVoidCash(input: VoidCashInput): VoidCashCheck {
  const { bill, session } = input;
  if (bill.status !== 'voided') return { ok: false, problem: 'not_voided' };
  if (bill.cashTaken === null || bill.cashTaken <= 0) return { ok: false, problem: 'no_cash_taken' };
  if (bill.givenBack) return { ok: false, problem: 'already_given_back' };
  if (session === null || session.status !== 'open') return { ok: false, problem: 'no_session' };
  if (session.cashierId !== input.cashierId) return { ok: false, problem: 'not_session_cashier' };
  if (!can(input.grants, PAY, input.branchId))
    return { ok: false, problem: 'not_permitted', permission: PAY };
  if (input.approverId === null) return { ok: false, problem: 'approver_required' };
  if (input.approverId === session.cashierId) return { ok: false, problem: 'approver_is_cashier' };
  if (!can(input.approverGrants, APPROVE, input.branchId))
    return { ok: false, problem: 'approver_not_permitted' };
  // Always the full amount taken (owner answer 2): any other real figure is a variance at the close.
  return { ok: true, amount: bill.cashTaken, approverId: input.approverId };
}

/** The movement giving the cash back (`CashMovementV2`, kind `void_cash`), or the check's problem as a DomainError. */
export function buildVoidCashDocument(input: VoidCashInput & { context: DeskContext }): CashMovementDocument {
  const check = checkVoidCash(input);
  if (!check.ok)
    throw new DomainError(check.problem, `no cash given back for ${input.bill.number}: ${check.problem}`);
  const c = input.context;
  return {
    version: 2,
    id: c.id,
    family: 'M',
    seq: c.seq,
    number: documentNumber(c.deviceCode, 'M', c.seq),
    kind: 'void_cash',
    deviceId: c.deviceId,
    branchId: c.branchId,
    // checkVoidCash has refused without an open session.
    sessionId: input.session!.id,
    cashierId: input.cashierId,
    amount: check.amount,
    expenseCategoryId: null,
    partyId: null,
    bankAccountId: null,
    targetName: null,
    note: null,
    reference: null,
    billNumber: input.bill.number,
    approvedByUserId: check.approverId,
    createdAt: new Date(c.createdAtMs).toISOString(),
    businessDate: businessDate(c.createdAtMs, c.timeZone, c.cutoffHour),
    clientVersion: c.clientVersion,
  };
}

export type VoidCashFinding =
  | { kind: 'void_cash_duplicate'; duplicateOf: string; duplicateOfNumber: string }
  | { kind: 'void_cash_not_voided' }
  | { kind: 'void_cash_without_handover' }
  | { kind: 'void_cash_amount_mismatch'; amount: Money; taken: Money }
  | { kind: 'cash_not_permitted'; userId: string; permission: Permission; ownVariance: boolean };

/** What the server holds when it reviews a pushed `void_cash` movement. */
export interface VoidCashReview {
  /** The stored bill by number, or null until it arrives. */
  bill: { status: 'finalized' | 'voided' } | null;
  /** The bill's handover in that isn't a duplicate, or null. */
  handover: { amount: Money } | null;
  /** An earlier `void_cash` of the bill that isn't itself a duplicate, or null. */
  existing: { id: string; number: string } | null;
  grantsOf: (userId: string) => readonly RoleGrant[];
  /** The session's cashier as the server holds it; null until its open has arrived (the document's cashier then). */
  sessionCashierId: string | null;
  branchId: string;
}

const denied = (userId: string, permission: Permission, ownVariance = false): VoidCashFinding => ({
  kind: 'cash_not_permitted',
  userId,
  permission,
  ownVariance,
});

/**
 * The server's findings on a pushed `void_cash` (sync spec §6.2), in this order: a second one for the bill (alone: it
 * is never posted); a bill that isn't voided (once it is here); no cash taken for it, or another amount; a cashier
 * without `cash.refund.pay`; an approver who is the session's cashier (`ownVariance`) or without `pos.void`.
 */
export function reviewVoidCash(doc: CashMovementDocument, context: VoidCashReview): VoidCashFinding[] {
  if (context.existing !== null && context.existing.id !== doc.id)
    return [
      {
        kind: 'void_cash_duplicate',
        duplicateOf: context.existing.id,
        duplicateOfNumber: context.existing.number,
      },
    ];
  const findings: VoidCashFinding[] = [];
  if (context.bill !== null && context.bill.status !== 'voided')
    findings.push({ kind: 'void_cash_not_voided' });
  if (context.handover === null) findings.push({ kind: 'void_cash_without_handover' });
  else if (context.handover.amount !== doc.amount)
    findings.push({ kind: 'void_cash_amount_mismatch', amount: doc.amount, taken: context.handover.amount });
  if (!can(context.grantsOf(doc.cashierId), PAY, context.branchId)) findings.push(denied(doc.cashierId, PAY));
  const approver = doc.approvedByUserId ?? null;
  const cashier = context.sessionCashierId ?? doc.cashierId;
  if (approver === null || approver === cashier) findings.push(denied(approver ?? cashier, APPROVE, true));
  else if (!can(context.grantsOf(approver), APPROVE, context.branchId))
    findings.push(denied(approver, APPROVE));
  return findings;
}
