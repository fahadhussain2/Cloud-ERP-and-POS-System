import { businessDate, checkHold, DomainError, heldExpired } from '@erp/domain';

import { parseOpenBill, type OpenBill } from '../bill/open-bill';
import { checkoutSettings } from './checkout';
import { getDevice, grantsFor, log, saveOpenBill } from './repo';
import type { SqlDb } from './sql';

// Held bills on the counter (POS-08, POS spec §17, W1-12): a person's open bill set aside in `held_bills`, recalled
// later by the same person exactly as it was, gone once its business day is over (owner answer 4). Never pushed.
// Runs in the database worker; each write is one transaction.

export interface HeldBill {
  id: string;
  userId: string;
  heldAt: string;
  businessDate: string;
  label: string | null;
  bill: OpenBill;
}

/** Holding the person's open bill: the held bill's id (UUIDv7) and time come from the counter. */
export interface HoldRequest {
  id: string;
  userId: string;
  label: string | null;
  atMs: number;
}

export interface RecallRequest {
  /** The held bill to recall. */
  id: string;
  userId: string;
  /** Hold the open bill first (the swap), when it has lines; without it such a recall is refused. */
  holdCurrent: Omit<HoldRequest, 'userId'> | null;
}

const settingsOf = (db: SqlDb) => {
  const s = checkoutSettings(db);
  if (s === null) throw new Error('this counter is not set up yet');
  return s;
};

const heldCount = (db: SqlDb): number => Number(db.selectValue('SELECT count(*) FROM held_bills'));

/** The person's open bill, read inside the caller's transaction (one this version can't read counts as none). */
const openBillOf = (db: SqlDb, userId: string): OpenBill | null => {
  const stored = db.selectValue('SELECT bill FROM open_bills WHERE user_id = ?', [userId]);
  return typeof stored === 'string' ? parseOpenBill(stored) : null;
};

/** Holds the open bill as it is now (inside the caller's transaction). */
function holdOpen(db: SqlDb, req: HoldRequest): HeldBill {
  // An expired bill no longer counts against the cap.
  dropExpired(db, req.atMs);
  const open = openBillOf(db, req.userId);
  const branchId = getDevice(db)?.branchId ?? null;
  if (branchId === null) throw new Error('this counter is not set up yet');
  const check = checkHold({
    grants: grantsFor(db, req.userId),
    branchId,
    lineCount: open?.bill.lines.length ?? 0,
    heldCount: heldCount(db),
    label: req.label,
  });
  if (!check.ok) throw new DomainError(check.problem, `the bill can't be held: ${check.problem}`);
  const s = settingsOf(db);
  const held: HeldBill = {
    id: req.id,
    userId: req.userId,
    heldAt: new Date(req.atMs).toISOString(),
    businessDate: businessDate(req.atMs, s.timeZone, s.cutoffHour),
    label: check.label,
    // checkHold has refused a missing or empty bill.
    bill: open!,
  };
  db.exec(
    'INSERT INTO held_bills (id, user_id, held_at, business_date, label, bill) VALUES (?, ?, ?, ?, ?, ?)',
    [held.id, held.userId, held.heldAt, held.businessDate, held.label, JSON.stringify(held.bill)],
  );
  db.exec('DELETE FROM open_bills WHERE user_id = ?', [req.userId]);
  return held;
}

/** Holds the person's open bill (`F8`) and leaves them an empty one; refused with checkHold's problem. */
export const holdBill = (db: SqlDb, req: HoldRequest): HeldBill => db.transaction(() => holdOpen(db, req));

/** Deletes the held bills whose business day is over, everyone's, inside the caller's transaction. */
function dropExpired(db: SqlDb, nowMs: number): number {
  const s = checkoutSettings(db);
  if (s === null) return 0;
  const expired = db
    .selectObjects('SELECT id, business_date FROM held_bills')
    .filter((r) =>
      heldExpired({
        heldBusinessDate: String(r['business_date']),
        nowMs,
        timeZone: s.timeZone,
        cutoffHour: s.cutoffHour,
      }),
    )
    .map((r) => String(r['id']));
  if (expired.length === 0) return 0;
  for (const id of expired) db.exec('DELETE FROM held_bills WHERE id = ?', [id]);
  // Only the count: a held bill's lines and customer stay out of the diagnostic log.
  log(db, 'held.expired', { count: expired.length });
  return expired.length;
}

/** Deletes every held bill whose business day is over (owner answer 4); returns how many. */
export const sweepHeld = (db: SqlDb, nowMs: number): number => db.transaction(() => dropExpired(db, nowMs));

const rowToHeld = (r: Record<string, unknown>): HeldBill | null => {
  const bill = parseOpenBill(String(r['bill']));
  if (bill === null) return null;
  return {
    id: String(r['id']),
    userId: String(r['user_id']),
    heldAt: String(r['held_at']),
    businessDate: String(r['business_date']),
    label: typeof r['label'] === 'string' ? r['label'] : null,
    bill,
  };
};

/** The person's held bills, newest first, after the expired ones are swept (owner answer 4). */
export function heldBills(db: SqlDb, userId: string, nowMs: number): HeldBill[] {
  sweepHeld(db, nowMs);
  return db
    .selectObjects('SELECT * FROM held_bills WHERE user_id = ? ORDER BY held_at DESC, id DESC', [userId])
    .flatMap((r) => rowToHeld(r) ?? []);
}

/**
 * Recalls one of the person's held bills as their open bill (`Shift+F8`), in one transaction: with `holdCurrent`, an
 * open bill with lines is held first (the swap), so neither bill can be lost halfway.
 */
export function recallBill(db: SqlDb, req: RecallRequest): OpenBill {
  return db.transaction(() => {
    const row = db.selectObjects('SELECT * FROM held_bills WHERE id = ? AND user_id = ?', [
      req.id,
      req.userId,
    ])[0];
    const held = row === undefined ? null : rowToHeld(row);
    if (held === null) throw new DomainError('not_found', 'that held bill is not on this counter');
    // The recalled bill leaves first, so a swap never counts against the cap.
    db.exec('DELETE FROM held_bills WHERE id = ?', [req.id]);
    const open = openBillOf(db, req.userId);
    if ((open?.bill.lines.length ?? 0) > 0) {
      if (req.holdCurrent === null) throw new DomainError('bill_open', 'hold or finish the open bill first');
      holdOpen(db, { ...req.holdCurrent, userId: req.userId });
    }
    saveOpenBill(db, req.userId, held.bill);
    return held.bill;
  });
}

/** Clears one of the person's held bills (`Del` in the list); false when it isn't there. */
export function clearHeld(db: SqlDb, id: string, userId: string): boolean {
  const found = Number(
    db.selectValue('SELECT count(*) FROM held_bills WHERE id = ? AND user_id = ?', [id, userId]),
  );
  if (found === 0) return false;
  db.exec('DELETE FROM held_bills WHERE id = ? AND user_id = ?', [id, userId]);
  return true;
}
