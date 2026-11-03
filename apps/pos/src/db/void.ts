import {
  businessDate,
  buildVoidDocument,
  money,
  type CashDeskStatus,
  type Money,
  type SaleDocument,
  type SaleVoidDocument,
  type VoidReason,
} from '@erp/domain';

import { checkoutSettings, loadDocument } from './checkout';
import { getDevice, grantsFor, log } from './repo';
import type { SqlDb } from './sql';

// Voiding a bill on the counter that made it (POS-11, PRD W5, POS spec §18, W1-12): this counter's bills of today,
// what this device itself knows of their cash at the desk, and the void: a document of family V written with its
// outbox row in one transaction (rule 6), signed after the commit. The bill itself is never changed (rule 3).

/** A bill the Void dialog lists. */
export interface VoidListBill {
  id: string;
  number: string;
  createdAt: string;
  sellerId: string;
  customerId: string | null;
  total: Money;
  cashDue: Money;
}

export interface VoidRequest {
  /** UUIDv7 for the void, made on the counter. */
  id: string;
  createdAtMs: number;
  clientVersion: string;
  /** Who is unlocked and asks for the void. */
  userId: string;
  /** Who entered their PIN (checked by the screen, offline); may be the same person. */
  approverId: string;
  saleId: string;
  reason: VoidReason | null;
  note: string | null;
  /** What the live check said; this device's own knowledge (a desk's handovers and queue) wins when it knows more. */
  deskStatus: CashDeskStatus;
}

const voidedSql = `EXISTS (SELECT 1 FROM local_documents v WHERE v.family = 'V'
  AND json_extract(v.payload, '$.saleId') = d.id)`;

/** This counter's bills of today's business date that aren't voided, newest first; `filter` matches the number. */
export function voidableBills(db: SqlDb, nowMs: number, filter = ''): VoidListBill[] {
  const s = checkoutSettings(db);
  if (s === null) return [];
  const today = businessDate(nowMs, s.timeZone, s.cutoffHour);
  return db
    .selectObjects(
      `SELECT d.id, d.number, d.created_at, json_extract(d.payload, '$.sellerId') AS seller,
         json_extract(d.payload, '$.customerId') AS customer, json_extract(d.payload, '$.amounts.total') AS total,
         json_extract(d.payload, '$.cashDue') AS cash_due
       FROM local_documents d
       WHERE d.family = 'S' AND d.business_date = ? AND instr(d.number, ?) > 0 AND NOT ${voidedSql}
       ORDER BY d.created_at DESC, d.seq DESC LIMIT 500`,
      [today, filter.trim().toUpperCase()],
    )
    .map((r) => ({
      id: String(r['id']),
      number: String(r['number']),
      createdAt: String(r['created_at']),
      sellerId: String(r['seller']),
      customerId: typeof r['customer'] === 'string' ? r['customer'] : null,
      total: money(Number(r['total'])),
      cashDue: money(Number(r['cash_due'])),
    }));
}

/**
 * What this device itself knows of a bill's cash at the desk: on a cash desk, its own handovers of the bill and the
 * pulled queue row. Null when it knows nothing (a counter, or a bill the desk hasn't seen): the server is asked.
 */
export function localDeskStatus(db: SqlDb, billNumber: string): CashDeskStatus | null {
  const kinds = db
    .selectObjects(
      `SELECT json_extract(payload, '$.kind') AS kind FROM local_documents
       WHERE family = 'H' AND json_extract(payload, '$.billNumber') = ?`,
      [billNumber],
    )
    .map((r) => r['kind']);
  if (kinds.includes('payout')) return 'paid_out';
  if (kinds.includes('in')) return 'received';
  const queued = db.selectValue(
    'SELECT handover_status FROM cash_queue WHERE number = ? AND deleted_at IS NULL',
    [billNumber],
  );
  return queued === 'received' || queued === 'paid_out' || queued === 'pending' || queued === 'not_applicable'
    ? queued
    : null;
}

/** The void of a bill on this device, or null. */
export function voidOf(db: SqlDb, saleId: string): SaleVoidDocument | null {
  const payload = db.selectValue(
    "SELECT payload FROM local_documents WHERE family = 'V' AND json_extract(payload, '$.saleId') = ? LIMIT 1",
    [saleId],
  );
  return typeof payload === 'string' ? (JSON.parse(payload) as SaleVoidDocument) : null;
}

/** Takes the next void number in the caller's transaction. */
function nextVoidSeq(db: SqlDb): number {
  const seq = Number(db.selectValue("SELECT next_seq FROM local_series WHERE family = 'V'") ?? 1);
  db.exec(
    `INSERT INTO local_series (family, next_seq) VALUES ('V', ?)
     ON CONFLICT (family) DO UPDATE SET next_seq = excluded.next_seq`,
    [seq + 1],
  );
  return seq;
}

/** Voids one of this counter's bills; refused with checkVoid's problem as a DomainError, writing nothing. */
export function voidBill(db: SqlDb, req: VoidRequest): { void: SaleVoidDocument; sale: SaleDocument } {
  const device = getDevice(db);
  const settings = checkoutSettings(db);
  if (device === null || settings === null) throw new Error('this counter is not set up yet');
  return db.transaction(() => {
    const sale = loadDocument(db, req.saleId);
    if (sale === null) throw new Error('that bill is not on this counter');
    const local = localDeskStatus(db, sale.number);
    // What this device saw itself is the most it can know: a handover here, or the queue's word, wins.
    const deskStatus: CashDeskStatus =
      local === 'received' || local === 'paid_out'
        ? local
        : req.deskStatus === 'unknown'
          ? (local ?? 'unknown')
          : req.deskStatus;
    const doc = buildVoidDocument({
      bill: {
        id: sale.id,
        number: sale.number,
        deviceId: sale.deviceId,
        businessDate: sale.businessDate,
        total: sale.amounts.total,
        cashDue: sale.cashDue,
        status: voidOf(db, sale.id) === null ? 'finalized' : 'voided',
      },
      deviceId: device.deviceId,
      branchId: device.branchId,
      deskStatus,
      approverId: req.approverId,
      approverGrants: grantsFor(db, req.approverId),
      reason: req.reason,
      note: req.note,
      userId: req.userId,
      context: {
        id: req.id,
        seq: nextVoidSeq(db),
        deviceId: device.deviceId,
        deviceCode: device.code,
        branchId: device.branchId,
        createdAtMs: req.createdAtMs,
        timeZone: settings.timeZone,
        cutoffHour: settings.cutoffHour,
        clientVersion: req.clientVersion,
      },
    });
    const payload = JSON.stringify(doc);
    db.exec(
      `INSERT INTO local_documents (id, family, seq, number, kind, business_date, payload, created_at)
       VALUES (?, 'V', ?, ?, 'void', ?, ?, ?)`,
      [doc.id, doc.seq, doc.number, doc.businessDate, payload, doc.createdAt],
    );
    db.exec(
      `INSERT INTO outbox (id, family, seq, payload, status, attempts, created_at)
       VALUES (?, 'V', ?, ?, 'pending', 0, ?)`,
      [doc.id, doc.seq, payload, doc.createdAt],
    );
    log(db, 'bill.voided', { number: sale.number, void: doc.number, approvedBy: doc.approvedBy });
    return { void: doc, sale };
  });
}
