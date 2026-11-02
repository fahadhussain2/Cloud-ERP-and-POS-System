import { businessDate } from './business-date';
import type { DeskContext, DeskSession } from './cash-session';
import { MAX_NOTE_LENGTH, trimmedOrNull } from './desk-text';
import { DomainError } from './errors';
import { money, sub, type Money } from './money';
import { can, type Permission, type RoleGrant } from './permissions';
import { documentNumber } from './sale-document';
import { MAX_REFERENCE_LENGTH, type PaymentMethodCode } from './tender';

// Customer collections at the desk (CSH-05, PRD W8, cash desk spec, W1-11): a customer pays what they owe, in cash or
// by any active method with its reference, and gets a printed receipt. A collection is its own document (family R),
// written on the desk like a handover; paying more than the balance is allowed and kept as an advance.

/** The customer as the desk knows them: the balance is the last synced one with this desk's unsynced documents. */
export interface CollectionCustomer {
  partyId: string;
  code: string;
  name: string;
  /** What they owe; negative = an advance. */
  balance: Money;
}

/** A pulled payment method (sync spec §3). */
export interface CollectionMethod {
  id: string;
  code: PaymentMethodCode;
  isCash: boolean;
  requiresReference: boolean;
  isActive: boolean;
}

export interface CollectionInput {
  session: DeskSession | null;
  cashierId: string;
  grants: readonly RoleGrant[];
  branchId: string;
  /** The tenant's cash rounding increment (Delux: 100 = Rs 1). */
  increment: Money;
  customer: CollectionCustomer | null;
  method: CollectionMethod | null;
  amount: Money;
  reference: string | null;
  note: string | null;
}

export type CollectionProblem =
  | 'no_session'
  | 'not_session_cashier'
  | 'not_permitted'
  | 'no_customer'
  | 'invalid_method'
  | 'amount_not_positive'
  | 'amount_not_rounded'
  | 'reference_required'
  | 'reference_too_long'
  | 'note_too_long';

export type CollectionCheck =
  | {
      ok: true;
      amount: Money;
      reference: string | null;
      note: string | null;
      /** The balance once this is paid; negative = an advance. */
      balanceAfter: Money;
      /** The part of the amount beyond what was owed. */
      advance: Money;
    }
  | { ok: false; problem: Exclude<CollectionProblem, 'not_permitted'> }
  | { ok: false; problem: 'not_permitted'; permission: Permission };

const PERMISSION: Permission = 'cash.collection.receive';

/** May this cashier record this collection now, and what is recorded? The first problem found, in a fixed order. */
export function checkCollection(input: CollectionInput): CollectionCheck {
  const { session, customer, method, amount } = input;
  if (session === null || session.status !== 'open') return { ok: false, problem: 'no_session' };
  if (session.cashierId !== input.cashierId) return { ok: false, problem: 'not_session_cashier' };
  if (!can(input.grants, PERMISSION, input.branchId))
    return { ok: false, problem: 'not_permitted', permission: PERMISSION };
  if (customer === null) return { ok: false, problem: 'no_customer' };
  if (method === null || !method.isActive || method.code === 'on_account')
    return { ok: false, problem: 'invalid_method' };
  if (amount <= 0) return { ok: false, problem: 'amount_not_positive' };
  if (method.isCash && amount % input.increment !== 0) return { ok: false, problem: 'amount_not_rounded' };
  const reference = trimmedOrNull(input.reference);
  if (method.requiresReference && reference === null) return { ok: false, problem: 'reference_required' };
  if (reference !== null && reference.length > MAX_REFERENCE_LENGTH)
    return { ok: false, problem: 'reference_too_long' };
  const note = trimmedOrNull(input.note);
  if (note !== null && note.length > MAX_NOTE_LENGTH) return { ok: false, problem: 'note_too_long' };
  const owed = customer.balance > 0 ? customer.balance : money(0);
  return {
    ok: true,
    amount,
    reference,
    note,
    balanceAfter: sub(customer.balance, amount),
    advance: amount > owed ? sub(amount, owed) : money(0),
  };
}

/** `CustomerCollectionV1` in `@erp/contracts` is its wire schema (cash desk spec, data model §6). */
export interface CustomerCollectionDocument {
  version: 1;
  id: string;
  family: 'R';
  seq: number;
  number: string;
  deviceId: string;
  branchId: string;
  sessionId: string;
  cashierId: string;
  partyId: string;
  /** As the receipt printed them, so a reprint works offline. */
  customerCode: string;
  customerName: string;
  methodId: string;
  methodCode: PaymentMethodCode;
  /** The posted figure (positive). */
  amount: Money;
  reference: string | null;
  note: string | null;
  /** The desk's figure, printed on the receipt; never posted. */
  balanceBefore: Money;
  createdAt: string;
  businessDate: string;
  clientVersion: string;
}

/** The collection document, or the check's problem as a DomainError. */
export function buildCollectionDocument(
  input: CollectionInput & { context: DeskContext },
): CustomerCollectionDocument {
  const check = checkCollection(input);
  if (!check.ok) throw new DomainError(check.problem, `no collection: ${check.problem}`);
  const c = input.context;
  // checkCollection has refused without a session, a customer or a method.
  const customer = input.customer!;
  const method = input.method!;
  return {
    version: 1,
    id: c.id,
    family: 'R',
    seq: c.seq,
    number: documentNumber(c.deviceCode, 'R', c.seq),
    deviceId: c.deviceId,
    branchId: c.branchId,
    sessionId: input.session!.id,
    cashierId: input.cashierId,
    partyId: customer.partyId,
    customerCode: customer.code,
    customerName: customer.name,
    methodId: method.id,
    methodCode: method.code,
    amount: check.amount,
    reference: check.reference,
    note: check.note,
    balanceBefore: customer.balance,
    createdAt: new Date(c.createdAtMs).toISOString(),
    businessDate: businessDate(c.createdAtMs, c.timeZone, c.cutoffHour),
    clientVersion: c.clientVersion,
  };
}
