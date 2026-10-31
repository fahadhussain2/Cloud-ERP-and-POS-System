import {
  buildHandoverDocument,
  buildSessionDocument,
  DomainError,
  expectedCash,
  money,
  sum,
  type CashHandoverDocument,
  type CashSessionDocument,
  type DeskSession,
  type HandoverMethod,
  type HandoverStatus,
  type HandoverTarget,
  type LocalHandover,
  type Money,
  type QueueEntry,
  type SaleDocument,
  type SessionHandover,
} from '@erp/domain';
import { uuidv7 } from '@erp/contracts';

import { checkoutSettings, type CheckoutSettings } from './checkout';
import { getDevice, grantsFor, type DeviceInfo } from './repo';
import type { SqlDb } from './sql';

// The cash desk on its own PC (W1-10, cash desk spec, CSH-01…CSH-04): the pulled queue, this desk's session, and its
// handovers. Every handover and session event is a document written with its outbox row in one transaction (rule 6),
// signed after the commit like a bill. Runs in the database worker.

/** How long this desk remembers its own handovers for the duplicate check and the queue (the queue's 7 days). */
const LOCAL_DAYS = 7;

export interface DeskSessionView extends DeskSession {
  number: string;
  openedAt: string;
  handedIn: Money;
  paidOut: Money;
  /** float + handed in − paid out. */
  expected: Money;
}

export interface DeskState {
  /** This desk's current session, or its last one (closed); null before the first. */
  session: DeskSessionView | null;
  /** Every pulled queue row: the screen lists the pending ones; a scan finds any. */
  queue: (QueueEntry & { deviceId: string })[];
  /** This desk's handovers of the last days. */
  local: LocalHandover[];
}

const amount = (v: unknown): Money | null => (v === null || v === undefined ? null : money(Number(v)));

/** This desk's newest session, open or closed; null before its first. */
function lastSession(db: SqlDb): (DeskSession & { number: string; openedAt: string }) | null {
  const [r] = db.selectObjects(
    `SELECT id, number, cashier_user_id, opened_at, opening_float, status FROM cash_sessions
     ORDER BY opened_at DESC, id DESC LIMIT 1`,
  );
  if (r === undefined) return null;
  return {
    id: String(r['id']),
    number: String(r['number']),
    cashierId: String(r['cashier_user_id']),
    openedAt: String(r['opened_at']),
    openingFloat: money(Number(r['opening_float'])),
    status: r['status'] === 'open' ? 'open' : 'closed',
  };
}

/** The handovers of a session, for its expected cash (posting rules §4.5). Duplicates can't exist on one desk. */
const sessionHandovers = (db: SqlDb, sessionId: string): SessionHandover[] =>
  db
    .selectObjects(
      `SELECT json_extract(payload, '$.kind') AS kind, json_extract(payload, '$.amount') AS amount
       FROM local_documents WHERE family = 'H' AND json_extract(payload, '$.sessionId') = ?`,
      [sessionId],
    )
    .map((r) => ({ kind: r['kind'] === 'payout' ? 'payout' : 'in', amount: money(Number(r['amount'])) }));

function localHandovers(db: SqlDb, nowMs: number): LocalHandover[] {
  const since = new Date(nowMs - LOCAL_DAYS * 86_400_000).toISOString();
  return db
    .selectObjects(
      `SELECT number, created_at, json_extract(payload, '$.billNumber') AS bill,
         json_extract(payload, '$.kind') AS kind, json_extract(payload, '$.cashierId') AS cashier
       FROM local_documents WHERE family = 'H' AND created_at >= ? ORDER BY created_at`,
      [since],
    )
    .map((r) => ({
      billNumber: String(r['bill']),
      kind: r['kind'] === 'payout' ? 'payout' : 'in',
      number: String(r['number']),
      cashierId: String(r['cashier']),
      at: String(r['created_at']),
    }));
}

const queueEntry = (r: Record<string, unknown>): QueueEntry & { deviceId: string } => ({
  id: String(r['id']),
  number: String(r['number']),
  deviceId: String(r['device_id']),
  sellerId: String(r['salesperson_user_id']),
  createdAt: String(r['created_at_device']),
  cashDue: money(Number(r['cash_due'])),
  cashReceived: amount(r['cash_received']),
  changeDue: amount(r['change_due']),
  handoverStatus: String(r['handover_status']) as HandoverStatus,
  status: r['status'] === 'voided' ? 'voided' : 'finalized',
});

const QUEUE_COLUMNS = `id, number, device_id, salesperson_user_id, created_at_device, cash_due, cash_received,
  change_due, handover_status, status`;

export function deskState(db: SqlDb, nowMs = Date.now()): DeskState {
  const s = lastSession(db);
  let session: DeskSessionView | null = null;
  if (s !== null) {
    const handovers = sessionHandovers(db, s.id);
    const total = (kind: 'in' | 'payout') =>
      sum(handovers.filter((h) => h.kind === kind).map((h) => h.amount));
    session = {
      ...s,
      handedIn: total('in'),
      paidOut: total('payout'),
      expected: expectedCash({ openingFloat: s.openingFloat, handovers }),
    };
  }
  return {
    session,
    queue: db
      .selectObjects(`SELECT ${QUEUE_COLUMNS} FROM cash_queue ORDER BY created_at_device`)
      .map(queueEntry),
    local: localHandovers(db, nowMs),
  };
}

interface Ready {
  device: DeviceInfo;
  settings: CheckoutSettings;
}

function ready(db: SqlDb): Ready {
  const device = getDevice(db);
  const settings = checkoutSettings(db);
  if (device === null || settings === null) throw new Error('this desk is not set up yet');
  if (device.kind !== 'cash_desk') throw new Error('only a cash desk keeps a drawer');
  return { device, settings };
}

/** Takes the next number of a family in the caller's transaction. */
function nextSeq(db: SqlDb, family: 'H' | 'Z'): number {
  const seq = Number(db.selectValue('SELECT next_seq FROM local_series WHERE family = ?', [family]) ?? 1);
  db.exec(
    `INSERT INTO local_series (family, next_seq) VALUES (?, ?)
     ON CONFLICT (family) DO UPDATE SET next_seq = excluded.next_seq`,
    [family, seq + 1],
  );
  return seq;
}

/** The document in local_documents and the outbox, unsigned (signed after the commit, POS spec §12). */
function store(db: SqlDb, doc: CashHandoverDocument | CashSessionDocument, kind: string): void {
  const payload = JSON.stringify(doc);
  db.exec(
    `INSERT INTO local_documents (id, family, seq, number, kind, business_date, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [doc.id, doc.family, doc.seq, doc.number, kind, doc.businessDate, payload, doc.createdAt],
  );
  db.exec(
    `INSERT INTO outbox (id, family, seq, payload, status, attempts, created_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
    [doc.id, doc.family, doc.seq, payload, doc.createdAt],
  );
}

const contextOf = (
  r: Ready,
  seq: number,
  req: { id: string; createdAtMs: number; clientVersion: string },
) => ({
  id: req.id,
  seq,
  deviceId: r.device.deviceId,
  deviceCode: r.device.code,
  branchId: r.device.branchId,
  createdAtMs: req.createdAtMs,
  timeZone: r.settings.timeZone,
  cutoffHour: r.settings.cutoffHour,
  clientVersion: req.clientVersion,
});

export interface DeskRequest {
  /** Who is unlocked. */
  userId: string;
  /** UUIDv7 made on the desk. */
  id: string;
  createdAtMs: number;
  clientVersion: string;
}

/** Opens a session with its float (CSH-01); refused while one is open, or without `cash.handover.receive`. */
export function openSession(db: SqlDb, req: DeskRequest & { openingFloat: Money }): CashSessionDocument {
  const r = ready(db);
  const grants = grantsFor(db, req.userId);
  return db.transaction(() => {
    const doc = buildSessionDocument({
      event: 'open',
      current: lastSession(db),
      userId: req.userId,
      grants,
      openingFloat: req.openingFloat,
      handovers: [],
      context: { ...contextOf(r, nextSeq(db, 'Z'), req), increment: r.settings.increment },
    });
    store(db, doc, 'session_open');
    db.exec(
      `INSERT INTO cash_sessions (id, number, cashier_user_id, opened_at, opening_float, status)
       VALUES (?, ?, ?, ?, ?, 'open')`,
      [doc.id, doc.number, req.userId, doc.createdAt, req.openingFloat],
    );
    return doc;
  });
}

/** Closes the open session, by anyone with `cash.session.close` (owner answer 1 to W1-10); no count until W1-11. */
export function closeSession(db: SqlDb, req: DeskRequest): CashSessionDocument {
  const r = ready(db);
  const grants = grantsFor(db, req.userId);
  return db.transaction(() => {
    const s = lastSession(db);
    const doc = buildSessionDocument({
      event: 'close',
      current: s,
      userId: req.userId,
      grants,
      openingFloat: null,
      handovers: s === null ? [] : sessionHandovers(db, s.id),
      context: { ...contextOf(r, nextSeq(db, 'Z'), req), increment: r.settings.increment },
    });
    store(db, doc, 'session_close');
    db.exec(`UPDATE cash_sessions SET status = 'closed', closed_at = ?, closed_by_user_id = ? WHERE id = ?`, [
      doc.createdAt,
      req.userId,
      doc.sessionId,
    ]);
    return doc;
  });
}

/** The bill a handover is for: the queue's row when the desk has it, else what the scanned code says. */
function targetOf(db: SqlDb, number: string, code: { cashDue: Money } | null): HandoverTarget {
  const [row] = db.selectObjects(`SELECT ${QUEUE_COLUMNS} FROM cash_queue WHERE number = ? LIMIT 1`, [
    number,
  ]);
  if (row !== undefined) {
    const e = queueEntry(row);
    return {
      number,
      cashDue: e.cashDue,
      saleDocumentId: e.id,
      cashReceived: e.cashReceived,
      handoverStatus: e.handoverStatus,
    };
  }
  if (code === null) throw new DomainError('nothing_to_collect', `${number} is not in the queue`);
  return {
    number,
    cashDue: code.cashDue,
    saleDocumentId: null,
    cashReceived: null,
    handoverStatus: 'pending',
  };
}

export interface HandoverRequest extends DeskRequest {
  billNumber: string;
  /** The cashier's correction, or the figure typed for a bill known only from its code; null = as shown. */
  cashReceived: Money | null;
  method: Exclude<HandoverMethod, 'auto'>;
  /** From a scanned code, for a bill not in the queue (an offline scan, PRD W4). */
  code: { cashDue: Money } | null;
}

/** Records a handover or a payout (CSH-02, CSH-03, CSH-04): refused with the check's problem as a DomainError. */
export function confirmHandover(db: SqlDb, req: HandoverRequest): CashHandoverDocument {
  const r = ready(db);
  const grants = grantsFor(db, req.userId);
  return db.transaction(() => {
    const doc = buildHandoverDocument({
      session: lastSession(db),
      cashierId: req.userId,
      grants,
      branchId: r.device.branchId,
      increment: r.settings.increment,
      target: targetOf(db, req.billNumber, req.code),
      cashReceived: req.cashReceived,
      existing: localHandovers(db, req.createdAtMs),
      method: req.method,
      context: contextOf(r, nextSeq(db, 'H'), req),
    });
    store(db, doc, doc.kind === 'in' ? 'handover' : 'payout');
    return doc;
  });
}

/**
 * A cash sale (or refund) on the desk itself is handed over at once to the open session (PRD W4.5, owner answer 4 to
 * W1-10), in the caller's finalize transaction. Nothing happens on a counter, without cash, or with no open session:
 * the bill then waits in the queue like any other.
 */
export function autoHandover(
  db: SqlDb,
  sale: SaleDocument,
  req: { createdAtMs: number; clientVersion: string },
): CashHandoverDocument | null {
  const device = getDevice(db);
  const settings = checkoutSettings(db);
  const session = lastSession(db);
  if (device?.kind !== 'cash_desk' || settings === null || sale.cashDue === 0) return null;
  if (session === null || session.status !== 'open') return null;
  const cash = sale.payments.find((p) => p.method === 'cash');
  const doc = buildHandoverDocument({
    session,
    // Received into the session's drawer, by its cashier, whoever sold.
    cashierId: session.cashierId,
    grants: grantsFor(db, session.cashierId),
    branchId: device.branchId,
    increment: settings.increment,
    target: {
      number: sale.number,
      cashDue: sale.cashDue,
      saleDocumentId: sale.id,
      cashReceived: cash?.cashReceived ?? null,
      handoverStatus: 'pending',
    },
    cashReceived: null,
    existing: [],
    method: 'auto',
    // Its own id: the request is the sale's, and carries the sale's.
    context: contextOf({ device, settings }, nextSeq(db, 'H'), {
      id: uuidv7(req.createdAtMs),
      createdAtMs: req.createdAtMs,
      clientVersion: req.clientVersion,
    }),
  });
  store(db, doc, doc.kind === 'in' ? 'handover' : 'payout');
  return doc;
}
