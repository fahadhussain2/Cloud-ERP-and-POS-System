import { businessDate } from './business-date';
import type { DeskContext, DeskSession } from './cash-session';
import { MAX_NOTE_LENGTH, trimmedOrNull } from './desk-text';
import { DomainError } from './errors';
import type { Money } from './money';
import { can, type Permission, type RoleGrant } from './permissions';
import { documentNumber } from './sale-document';
import { MAX_REFERENCE_LENGTH } from './tender';

// Cash going out of the drawer, and between the drawer and the safe (CSH-06, PRD W9, cash desk spec, owner answer 3 to
// W1-11): an expense by category, a supplier payment, a bank deposit, to or from the safe. Each is its own document
// (family M), written on the desk like a handover. A cash-out above what the drawer should hold asks first rather
// than refusing: the drawer's figure may be what's wrong.

/** What a cashier records in the cash-out dialog. */
export type CashOutKind = 'expense' | 'supplier_payment' | 'bank_deposit' | 'to_safe' | 'from_safe';
/** Every desk movement of family M: the cash-outs, and cash given back for a voided bill (W1-23, `void-cash.ts`). */
export type CashMovementKind = CashOutKind | 'void_cash';

/** Every kind takes cash out of the drawer except `from_safe`. */
export const isMoneyOut = (kind: CashMovementKind): boolean => kind !== 'from_safe';

/** A cash movement as the session's expected cash needs it. */
export interface SessionMovement {
  kind: CashMovementKind;
  amount: Money;
}

/** A pulled expense category (sync spec §3). */
export interface MovementCategory {
  id: string;
  name: string;
  isActive: boolean;
}

/** A pulled supplier (sync spec §3). */
export interface MovementSupplier {
  partyId: string;
  code: string;
  name: string;
}

/** A pulled bank account (sync spec §3); only a `bank` takes a deposit. */
export interface MovementBankAccount {
  id: string;
  name: string;
  kind: 'bank' | 'wallet' | 'card_clearing';
  isActive: boolean;
}

export interface CashMovementInput {
  session: DeskSession | null;
  cashierId: string;
  grants: readonly RoleGrant[];
  branchId: string;
  /** The tenant's cash rounding increment (Delux: 100 = Rs 1). */
  increment: Money;
  kind: CashOutKind;
  amount: Money;
  expenseCategory: MovementCategory | null;
  supplier: MovementSupplier | null;
  bankAccount: MovementBankAccount | null;
  note: string | null;
  reference: string | null;
  /** What the drawer should hold now (`expectedCash`). */
  expected: Money;
  /** The cashier confirmed a cash-out above `expected`. */
  overDrawerConfirmed: boolean;
}

export type CashMovementProblem =
  | 'no_session'
  | 'not_session_cashier'
  | 'not_permitted'
  | 'amount_not_positive'
  | 'amount_not_rounded'
  | 'missing_target'
  | 'extra_target'
  | 'note_required'
  | 'note_too_long'
  | 'reference_too_long'
  | 'over_drawer';

export type CashMovementCheck =
  | {
      ok: true;
      kind: CashOutKind;
      amount: Money;
      expenseCategoryId: string | null;
      partyId: string | null;
      bankAccountId: string | null;
      /** The category, supplier or bank, as the voucher prints it. */
      targetName: string | null;
      note: string | null;
      reference: string | null;
    }
  | { ok: false; problem: Exclude<CashMovementProblem, 'not_permitted' | 'over_drawer'> }
  | { ok: false; problem: 'not_permitted'; permission: Permission }
  | { ok: false; problem: 'over_drawer'; expected: Money };

const PERMISSION: Permission = 'cash.movement.create';

type Target = 'expenseCategory' | 'supplier' | 'bankAccount';
const TARGET: Record<CashOutKind, Target | null> = {
  expense: 'expenseCategory',
  supplier_payment: 'supplier',
  bank_deposit: 'bankAccount',
  to_safe: null,
  from_safe: null,
};

/** May this cashier record this movement now, and what is recorded? The first problem found, in a fixed order. */
export function checkCashMovement(input: CashMovementInput): CashMovementCheck {
  const { session, kind, amount } = input;
  if (session === null || session.status !== 'open') return { ok: false, problem: 'no_session' };
  if (session.cashierId !== input.cashierId) return { ok: false, problem: 'not_session_cashier' };
  if (!can(input.grants, PERMISSION, input.branchId))
    return { ok: false, problem: 'not_permitted', permission: PERMISSION };
  if (amount <= 0) return { ok: false, problem: 'amount_not_positive' };
  if (amount % input.increment !== 0) return { ok: false, problem: 'amount_not_rounded' };

  const { expenseCategory: category, supplier, bankAccount: bank } = input;
  const needed = TARGET[kind];
  const valid =
    needed === 'expenseCategory'
      ? category !== null && category.isActive
      : needed === 'supplier'
        ? supplier !== null
        : needed === 'bankAccount'
          ? bank !== null && bank.isActive && bank.kind === 'bank'
          : true;
  if (!valid) return { ok: false, problem: 'missing_target' };
  const given: Target[] = [];
  if (category !== null) given.push('expenseCategory');
  if (supplier !== null) given.push('supplier');
  if (bank !== null) given.push('bankAccount');
  if (given.some((t) => t !== needed)) return { ok: false, problem: 'extra_target' };

  const note = trimmedOrNull(input.note);
  if (note === null && needed !== null) return { ok: false, problem: 'note_required' };
  if (note !== null && note.length > MAX_NOTE_LENGTH) return { ok: false, problem: 'note_too_long' };
  const reference = trimmedOrNull(input.reference);
  if (reference !== null && reference.length > MAX_REFERENCE_LENGTH)
    return { ok: false, problem: 'reference_too_long' };
  if (isMoneyOut(kind) && amount > input.expected && !input.overDrawerConfirmed)
    return { ok: false, problem: 'over_drawer', expected: input.expected };

  return {
    ok: true,
    kind,
    amount,
    expenseCategoryId: category?.id ?? null,
    partyId: supplier?.partyId ?? null,
    bankAccountId: bank?.id ?? null,
    targetName: category?.name ?? supplier?.name ?? bank?.name ?? null,
    note,
    reference,
  };
}

/**
 * `CashMovementV1` and `CashMovementV2` in `@erp/contracts` are its wire schema (cash desk spec, data model §6). V2
 * (W1-23) adds `void_cash`, with the voided bill and who approved giving its cash back.
 */
export interface CashMovementDocument {
  version: 1 | 2;
  id: string;
  family: 'M';
  seq: number;
  number: string;
  kind: CashMovementKind;
  deviceId: string;
  branchId: string;
  sessionId: string;
  cashierId: string;
  /** The posted figure (positive). */
  amount: Money;
  expenseCategoryId: string | null;
  partyId: string | null;
  bankAccountId: string | null;
  /** As the voucher printed it, so a reprint works offline. */
  targetName: string | null;
  note: string | null;
  reference: string | null;
  /** `void_cash` only (V2): the voided bill whose cash is given back. */
  billNumber?: string;
  /** `void_cash` only (V2): the `pos.void` holder who entered their PIN, never the session's cashier. */
  approvedByUserId?: string;
  createdAt: string;
  businessDate: string;
  clientVersion: string;
}

/** The movement document, or the check's problem as a DomainError. */
export function buildCashMovementDocument(
  input: CashMovementInput & { context: DeskContext },
): CashMovementDocument {
  const check = checkCashMovement(input);
  if (!check.ok) throw new DomainError(check.problem, `no cash movement: ${check.problem}`);
  const c = input.context;
  return {
    version: 1,
    id: c.id,
    family: 'M',
    seq: c.seq,
    number: documentNumber(c.deviceCode, 'M', c.seq),
    kind: check.kind,
    deviceId: c.deviceId,
    branchId: c.branchId,
    // checkCashMovement has refused without an open session.
    sessionId: input.session!.id,
    cashierId: input.cashierId,
    amount: check.amount,
    expenseCategoryId: check.expenseCategoryId,
    partyId: check.partyId,
    bankAccountId: check.bankAccountId,
    targetName: check.targetName,
    note: check.note,
    reference: check.reference,
    createdAt: new Date(c.createdAtMs).toISOString(),
    businessDate: businessDate(c.createdAtMs, c.timeZone, c.cutoffHour),
    clientVersion: c.clientVersion,
  };
}
