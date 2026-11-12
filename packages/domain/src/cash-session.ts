import { businessDate } from './business-date';
import { DomainError } from './errors';
import { isMoneyOut, type SessionMovement } from './cash-movement';
import { checkClose, type CloseInput, type VarianceReason } from './drawer';
import { add, money, sub, type Money } from './money';
import { can, type RoleGrant } from './permissions';
import { documentNumber } from './sale-document';

// Cash sessions on the desk (CSH-01, CSH-07, cash desk spec, owner answer 1 to W1-10, owner answers 1–3 to W1-11): one
// open session per desk, belonging to the cashier who opened it; opened with a float (filled in with what stayed at the
// last close) and closed with a denomination count. The open and the close are documents of family Z, made on the desk
// like any other (CLAUDE.md rule 6).

/** This desk's current (or last) session, as the desk keeps it. */
export interface DeskSession {
  /** The id of the session's open document. */
  id: string;
  cashierId: string;
  openingFloat: Money;
  status: 'open' | 'closed';
}

export interface SessionHandover {
  kind: 'in' | 'payout';
  amount: Money;
}

/** A collection as the expected cash needs it: only cash ones reach the drawer. */
export interface SessionCollection {
  cash: boolean;
  amount: Money;
}

/**
 * `CashSessionV2` in `@erp/contracts` is its wire schema (cash desk spec); the desk makes only V2. A V1 close (W1-10,
 * no count) reads as version 1 with the V2 fields null.
 */
export interface CashSessionDocument {
  version: 1 | 2;
  id: string;
  family: 'Z';
  seq: number;
  number: string;
  event: 'open' | 'close';
  /** The open document's id: its own on an open. */
  sessionId: string;
  deviceId: string;
  branchId: string;
  /** Who opened it, or who closed it. */
  userId: string;
  /** On an open only. */
  openingFloat: Money | null;
  /** On a close only: what the drawer should hold. */
  expectedCash: Money | null;
  /** On an open: what stayed in the drawer at this desk's last close; null for its first session. */
  floatExpected: Money | null;
  /** On a close (V2) only, from here down. */
  countedCash: Money | null;
  /** Count per denomination, keyed by the denomination in minor units. */
  denominations: Record<string, number> | null;
  /** countedCash − expectedCash: negative = short. */
  variance: Money | null;
  varianceReason: VarianceReason | null;
  varianceNote: string | null;
  /** null = not needed (exact) or acknowledged later. */
  acknowledgedByUserId: string | null;
  leftInDrawer: Money | null;
  createdAt: string;
  businessDate: string;
  clientVersion: string;
}

export interface DeskContext {
  /** UUIDv7 made on the desk. */
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

/** The session's documents, as the expected cash needs them. */
export interface SessionCash {
  handovers: readonly SessionHandover[];
  collections?: readonly SessionCollection[];
  movements?: readonly SessionMovement[];
}

/**
 * What the drawer should hold (posting rules §4.5, PRD W10.1): the float, plus handovers in, minus payouts, plus cash
 * collections, minus every cash-out and what went to the safe, plus what came from it.
 */
export function expectedCash(input: SessionCash & { openingFloat: Money }): Money {
  let total = input.openingFloat;
  for (const h of input.handovers) total = h.kind === 'in' ? add(total, h.amount) : sub(total, h.amount);
  for (const c of input.collections ?? []) if (c.cash) total = add(total, c.amount);
  for (const m of input.movements ?? [])
    total = isMoneyOut(m.kind) ? sub(total, m.amount) : add(total, m.amount);
  return total;
}

/** The count and its explanation, for a close. */
export type SessionCloseInput = Omit<
  CloseInput,
  'session' | 'userId' | 'grants' | 'branchId' | 'increment' | 'expected'
>;

/**
 * The open or close document. Opening needs `cash.handover.receive` and no open session on the desk; the float is
 * whole cash, 0 or more, and may differ from `floatExpected` (the server flags it). Closing needs `cash.session.close`,
 * by anyone who holds it, and the count (`checkClose`'s rules).
 */
export function buildSessionDocument(
  input: SessionCash & {
    event: 'open' | 'close';
    current: DeskSession | null;
    userId: string;
    grants: readonly RoleGrant[];
    /** Open only. */
    openingFloat: Money | null;
    /** Open only. */
    floatExpected?: Money | null;
    /** Close only. */
    close?: SessionCloseInput | null;
    context: DeskContext & { increment: Money };
  },
): CashSessionDocument {
  const { event, current, context: c } = input;
  const open = current !== null && current.status === 'open';
  const doc: CashSessionDocument = {
    version: 2,
    id: c.id,
    family: 'Z',
    seq: c.seq,
    number: documentNumber(c.deviceCode, 'Z', c.seq),
    event,
    sessionId: c.id,
    deviceId: c.deviceId,
    branchId: c.branchId,
    userId: input.userId,
    openingFloat: null,
    expectedCash: null,
    floatExpected: null,
    countedCash: null,
    denominations: null,
    variance: null,
    varianceReason: null,
    varianceNote: null,
    acknowledgedByUserId: null,
    leftInDrawer: null,
    createdAt: new Date(c.createdAtMs).toISOString(),
    businessDate: businessDate(c.createdAtMs, c.timeZone, c.cutoffHour),
    clientVersion: c.clientVersion,
  };
  if (event === 'open') {
    if (open) throw new DomainError('session_open', `session ${current.id} is still open on this desk`);
    if (!can(input.grants, 'cash.handover.receive', c.branchId))
      throw new DomainError('not_permitted', 'opening a session needs cash.handover.receive');
    const float = input.openingFloat;
    if (float === null || float < 0 || float % c.increment !== 0)
      throw new DomainError('invalid_float', `not a float: ${float}`);
    return { ...doc, openingFloat: money(float), floatExpected: input.floatExpected ?? null };
  }
  if (!open) throw new DomainError('no_session', 'no session is open on this desk');
  if (input.close === undefined || input.close === null)
    throw new DomainError('invalid_count', 'a close needs the drawer count');
  const expected = expectedCash({ ...input, openingFloat: current.openingFloat });
  const check = checkClose({
    ...input.close,
    session: current,
    userId: input.userId,
    grants: input.grants,
    branchId: c.branchId,
    increment: c.increment,
    expected,
  });
  if (!check.ok) throw new DomainError(check.problem, `no close: ${check.problem}`);
  return {
    ...doc,
    sessionId: current.id,
    expectedCash: expected,
    countedCash: check.counted,
    denominations: { ...input.close.counts },
    variance: check.variance,
    varianceReason: check.varianceReason,
    varianceNote: check.varianceNote,
    acknowledgedByUserId: check.acknowledgedByUserId,
    leftInDrawer: check.leftInDrawer,
  };
}
