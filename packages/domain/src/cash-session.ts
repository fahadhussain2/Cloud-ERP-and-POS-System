import { businessDate } from './business-date';
import { DomainError } from './errors';
import { add, money, sub, type Money } from './money';
import { can, type RoleGrant } from './permissions';
import { documentNumber } from './sale-document';

// Cash sessions on the desk (CSH-01, cash desk spec, owner answer 1 to W1-10): one open session per desk, belonging to
// the cashier who opened it; opened with a float and closed without a count until W1-11 adds the denomination close.
// The open and the close are documents of family Z, made on the desk like any other (CLAUDE.md rule 6).

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

/** `CashSessionV1` in `@erp/contracts` is its wire schema (cash desk spec). */
export interface CashSessionDocument {
  version: 1;
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
  /** On a close only: float + handovers in − payouts (shown to the cashier, not a count). */
  expectedCash: Money | null;
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

/** What the drawer should hold: the float, plus every handover in, minus every payout (posting rules §4.5). */
export function expectedCash(input: { openingFloat: Money; handovers: readonly SessionHandover[] }): Money {
  return input.handovers.reduce(
    (total, h) => (h.kind === 'in' ? add(total, h.amount) : sub(total, h.amount)),
    input.openingFloat,
  );
}

/**
 * The open or close document. Opening needs `cash.handover.receive` and no open session on the desk; closing needs
 * `cash.session.close`, by anyone who holds it (owner answer 1). The float is whole cash: 0 or more, in increments.
 */
export function buildSessionDocument(input: {
  event: 'open' | 'close';
  current: DeskSession | null;
  userId: string;
  grants: readonly RoleGrant[];
  /** Open only. */
  openingFloat: Money | null;
  /** Close only: the session's handovers. */
  handovers: readonly SessionHandover[];
  context: DeskContext & { increment: Money };
}): CashSessionDocument {
  const { event, current, context: c } = input;
  const open = current !== null && current.status === 'open';
  let sessionId = c.id;
  let openingFloat: Money | null = null;
  let expected: Money | null = null;
  if (event === 'open') {
    if (open) throw new DomainError('session_open', `session ${current.id} is still open on this desk`);
    if (!can(input.grants, 'cash.handover.receive', c.branchId))
      throw new DomainError('not_permitted', 'opening a session needs cash.handover.receive');
    const float = input.openingFloat;
    if (float === null || float < 0 || float % c.increment !== 0)
      throw new DomainError('invalid_float', `not a float: ${float}`);
    openingFloat = money(float);
  } else {
    if (!open) throw new DomainError('no_session', 'no session is open on this desk');
    if (!can(input.grants, 'cash.session.close', c.branchId))
      throw new DomainError('not_permitted', 'closing a session needs cash.session.close');
    sessionId = current.id;
    expected = expectedCash({ openingFloat: current.openingFloat, handovers: input.handovers });
  }
  return {
    version: 1,
    id: c.id,
    family: 'Z',
    seq: c.seq,
    number: documentNumber(c.deviceCode, 'Z', c.seq),
    event,
    sessionId,
    deviceId: c.deviceId,
    branchId: c.branchId,
    userId: input.userId,
    openingFloat,
    expectedCash: expected,
    createdAt: new Date(c.createdAtMs).toISOString(),
    businessDate: businessDate(c.createdAtMs, c.timeZone, c.cutoffHour),
    clientVersion: c.clientVersion,
  };
}
