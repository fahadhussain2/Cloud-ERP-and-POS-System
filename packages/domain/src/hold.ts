import { businessDate } from './business-date';
import { trimmedOrNull } from './desk-text';
import { can, type RoleGrant } from './permissions';

// Holding (parking) the open bill on a counter and recalling it later (POS-08, POS spec §17, W1-12). A held bill is
// the open bill set aside on this counter: never pushed, recalled only by the person who held it, and gone once its
// business day is over (owner answer 4 to W1-12).

/** At most this many bills held on one counter. */
export const MAX_HELD_BILLS = 20;
/** At most this many characters in a held bill's label. */
export const MAX_HOLD_LABEL_LENGTH = 40;

export type HoldProblem = 'not_permitted' | 'empty_bill' | 'too_many' | 'label_too_long';

export type HoldCheck = { ok: true; label: string | null } | { ok: false; problem: HoldProblem };

/** May this person hold their open bill now, and with what label? The first problem found, in a fixed order. */
export function checkHold(input: {
  grants: readonly RoleGrant[];
  branchId: string;
  /** Lines on the open bill. */
  lineCount: number;
  /** Bills already held on this counter, everyone's. */
  heldCount: number;
  label: string | null;
}): HoldCheck {
  if (!can(input.grants, 'pos.sale.hold', input.branchId)) return { ok: false, problem: 'not_permitted' };
  if (input.lineCount === 0) return { ok: false, problem: 'empty_bill' };
  if (input.heldCount >= MAX_HELD_BILLS) return { ok: false, problem: 'too_many' };
  const label = trimmedOrNull(input.label);
  if (label !== null && [...label].length > MAX_HOLD_LABEL_LENGTH)
    return { ok: false, problem: 'label_too_long' };
  return { ok: true, label };
}

/**
 * Whether a held bill has expired: its business day is over, at the next day's cutoff (D-056). A bill dated after now
 * (the clock was set back) is kept.
 */
export function heldExpired(input: {
  heldBusinessDate: string;
  nowMs: number;
  timeZone: string;
  cutoffHour: number;
}): boolean {
  return businessDate(input.nowMs, input.timeZone, input.cutoffHour) > input.heldBusinessDate;
}
