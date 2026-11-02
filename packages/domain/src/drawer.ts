import type { CashMovementDocument } from './cash-movement';
import type { CashSessionDocument, DeskSession } from './cash-session';
import type { CustomerCollectionDocument } from './collection';
import { MAX_NOTE_LENGTH, trimmedOrNull } from './desk-text';
import { DomainError } from './errors';
import { money, sub, type Money } from './money';
import { can, type Permission, type RoleGrant } from './permissions';

// The drawer close (CSH-07, PRD W10.1, cash desk spec, owner answers 1–3 to W1-11): the cashier counts the drawer note
// by note without seeing the expected cash, and any variance needs a reason and a manager who isn't the session's
// cashier, now or later. What doesn't stay in the drawer goes to the safe. Also the server's review of the desk's
// collections, cash-outs and session documents: findings, never refusals (rule 7).

/** The notes and coins of each currency, largest first, in minor units (the Rs 10 note and coin are one row). */
const DENOMINATIONS: Readonly<Record<string, readonly number[]>> = {
  PKR: [500000, 100000, 50000, 10000, 5000, 2000, 1000, 500, 200, 100],
};

export function denominations(currency: string): Money[] {
  const list = DENOMINATIONS[currency];
  if (list === undefined) throw new DomainError('invalid_currency', `no denominations for ${currency}`);
  return list.map((d) => money(d));
}

/** The counted total: counts keyed by the denomination in minor units, each a whole number of notes or coins. */
export function countDrawer(currency: string, counts: Readonly<Record<string, number>>): Money {
  const valid = new Set(denominations(currency).map(String));
  let total = money(0);
  for (const [key, count] of Object.entries(counts)) {
    if (!valid.has(key) || !Number.isSafeInteger(count) || count < 0)
      throw new DomainError('invalid_count', `not a count: ${count} × ${key}`);
    total = money(total + Number(key) * count);
  }
  return total;
}

export const VARIANCE_REASONS = [
  'change_error',
  'wrong_bill_confirmed',
  'unrecorded_cash_out',
  'counterfeit_note',
  'unknown',
  'other',
] as const;
export type VarianceReason = (typeof VARIANCE_REASONS)[number];

export interface CloseInput {
  /** This desk's current session. */
  session: DeskSession | null;
  /** Who closes (anyone with cash.session.close, owner answer 1 to W1-10). */
  userId: string;
  grants: readonly RoleGrant[];
  branchId: string;
  increment: Money;
  currency: string;
  counts: Readonly<Record<string, number>>;
  /** What the drawer should hold (`expectedCash`). */
  expected: Money;
  reason: VarianceReason | null;
  note: string | null;
  /** The manager who entered their PIN; null = acknowledge later. */
  acknowledger: { userId: string; grants: readonly RoleGrant[] } | null;
  /** What stays in the drawer for the next session; null = all of the count. */
  leftInDrawer: Money | null;
}

export type CloseProblem =
  | 'no_session'
  | 'not_permitted'
  | 'invalid_count'
  | 'left_invalid'
  | 'reason_required'
  | 'note_required'
  | 'note_too_long'
  | 'own_variance'
  | 'not_acknowledger';

export type CloseCheck =
  | {
      ok: true;
      counted: Money;
      /** counted − expected: negative = short. */
      variance: Money;
      varianceReason: VarianceReason | null;
      varianceNote: string | null;
      acknowledgedByUserId: string | null;
      leftInDrawer: Money;
      /** counted − what stays: posted to the safe with the close. */
      toSafe: Money;
    }
  | { ok: false; problem: Exclude<CloseProblem, 'not_permitted'> }
  | { ok: false; problem: 'not_permitted'; permission: Permission };

const VARIANCE_APPROVE: Permission = 'cash.variance.approve';

/** May this person close the session with this count, and what is recorded? The first problem found. */
export function checkClose(input: CloseInput): CloseCheck {
  const { session } = input;
  if (session === null || session.status !== 'open') return { ok: false, problem: 'no_session' };
  if (!can(input.grants, 'cash.session.close', input.branchId))
    return { ok: false, problem: 'not_permitted', permission: 'cash.session.close' };
  let counted: Money;
  try {
    counted = countDrawer(input.currency, input.counts);
  } catch (err) {
    if (err instanceof DomainError && err.code === 'invalid_count')
      return { ok: false, problem: 'invalid_count' };
    throw err;
  }
  const left = input.leftInDrawer ?? counted;
  if (!Number.isSafeInteger(left) || left < 0 || left > counted || left % input.increment !== 0)
    return { ok: false, problem: 'left_invalid' };
  const variance = sub(counted, input.expected);
  const exact = variance === 0;
  if (!exact) {
    if (input.reason === null) return { ok: false, problem: 'reason_required' };
    const note = trimmedOrNull(input.note);
    if (input.reason === 'other' && note === null) return { ok: false, problem: 'note_required' };
    if (note !== null && note.length > MAX_NOTE_LENGTH) return { ok: false, problem: 'note_too_long' };
    const ack = input.acknowledger;
    if (ack !== null) {
      if (ack.userId === session.cashierId) return { ok: false, problem: 'own_variance' };
      if (!can(ack.grants, VARIANCE_APPROVE, input.branchId))
        return { ok: false, problem: 'not_acknowledger' };
    }
    return {
      ok: true,
      counted,
      variance,
      varianceReason: input.reason,
      varianceNote: note,
      acknowledgedByUserId: ack?.userId ?? null,
      leftInDrawer: left,
      toSafe: sub(counted, left),
    };
  }
  // Nothing to explain or acknowledge on an exact count.
  return {
    ok: true,
    counted,
    variance,
    varianceReason: null,
    varianceNote: null,
    acknowledgedByUserId: null,
    leftInDrawer: left,
    toSafe: sub(counted, left),
  };
}

export type CashFinding =
  | { kind: 'cash_not_permitted'; userId: string; permission: Permission; ownVariance: boolean }
  | { kind: 'float_mismatch'; openingFloat: Money; floatExpected: Money };

const notPermitted = (userId: string, permission: Permission, ownVariance = false): CashFinding => ({
  kind: 'cash_not_permitted',
  userId,
  permission,
  ownVariance,
});

/** The server's findings on a pushed collection or cash-out (sync spec §6.2): a cashier without the permission. */
export function reviewDeskDocument(
  doc: CustomerCollectionDocument | CashMovementDocument,
  context: { grants: readonly RoleGrant[]; branchId: string },
): CashFinding[] {
  const permission: Permission = doc.family === 'R' ? 'cash.collection.receive' : 'cash.movement.create';
  return can(context.grants, permission, context.branchId) ? [] : [notPermitted(doc.cashierId, permission)];
}

/**
 * The server's findings on a pushed session document: an open by someone without cash.handover.receive, or with a
 * float other than what stayed at the desk's last close; a close by someone without cash.session.close, or
 * acknowledged by someone without cash.variance.approve or by the session's own cashier.
 */
export function reviewSession(
  doc: CashSessionDocument,
  context: {
    grantsOf: (userId: string) => readonly RoleGrant[];
    /** The session's cashier as the server holds it; null until its open has arrived. */
    sessionCashierId: string | null;
    branchId: string;
  },
): CashFinding[] {
  const findings: CashFinding[] = [];
  const allowed = (userId: string, p: Permission) => can(context.grantsOf(userId), p, context.branchId);
  if (doc.event === 'open') {
    if (!allowed(doc.userId, 'cash.handover.receive'))
      findings.push(notPermitted(doc.userId, 'cash.handover.receive'));
    if (doc.version === 2 && doc.floatExpected !== null && doc.openingFloat !== doc.floatExpected)
      findings.push({
        kind: 'float_mismatch',
        openingFloat: doc.openingFloat!,
        floatExpected: doc.floatExpected,
      });
    return findings;
  }
  if (!allowed(doc.userId, 'cash.session.close'))
    findings.push(notPermitted(doc.userId, 'cash.session.close'));
  const ack = doc.version === 2 ? doc.acknowledgedByUserId : null;
  if (ack !== null) {
    if (ack === context.sessionCashierId) findings.push(notPermitted(ack, VARIANCE_APPROVE, true));
    else if (!allowed(ack, VARIANCE_APPROVE)) findings.push(notPermitted(ack, VARIANCE_APPROVE));
  }
  return findings;
}
