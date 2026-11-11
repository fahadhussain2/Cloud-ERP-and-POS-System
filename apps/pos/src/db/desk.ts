import {
  buildCashMovementDocument,
  buildCollectionDocument,
  buildHandoverDocument,
  buildSessionDocument,
  buildVoidCashDocument,
  businessDate,
  DomainError,
  expectedCash,
  isMoneyOut,
  money,
  sum,
  type CashHandoverDocument,
  type CashMovementDocument,
  type CashMovementKind,
  type CashOutKind,
  type CashSessionDocument,
  type CollectionCustomer,
  type CollectionMethod,
  type CustomerCollectionDocument,
  type DeskSession,
  type MovementBankAccount,
  type MovementCategory,
  type MovementSupplier,
  type SessionCash,
  type SessionCloseInput,
  type HandoverMethod,
  type HandoverStatus,
  type HandoverTarget,
  type LocalHandover,
  type Money,
  type QueueEntry,
  type ReturnDocument,
  type SaleDocument,
  type VoidCashBill,
} from '@erp/domain';
import { uuidv7 } from '@erp/contracts';

import { checkoutSettings, type CheckoutSettings } from './checkout';
import { creditFigures, getCustomer } from './customers';
import { getDevice, getSync, grantsFor, log, type DeviceInfo } from './repo';
import type { SqlDb } from './sql';

// The cash desk on its own PC (W1-10, W1-11, cash desk spec, CSH-01…CSH-07): the pulled queue, this desk's session,
// its handovers, collections and cash-outs, and the counted close. Every one is a document written with its outbox
// row in one transaction (rule 6), signed after the commit like a bill. Runs in the database worker.

/** How long this desk remembers its own handovers for the duplicate check and the queue (the queue's 7 days). */
const LOCAL_DAYS = 7;

export interface DeskSessionView extends DeskSession {
  number: string;
  openedAt: string;
  handedIn: Money;
  paidOut: Money;
  /** Cash collections only: the others don't reach the drawer. */
  collected: Money;
  /** Every cash-out and what went to the safe. */
  cashOut: Money;
  fromSafe: Money;
  /** What the drawer should hold (`expectedCash`). */
  expected: Money;
  /** On a closed session: its count and what stayed in the drawer (null for a close without a count, W1-10). */
  countedCash: Money | null;
  variance: Money | null;
  leftInDrawer: Money | null;
}

export interface DeskState {
  /** This desk's current session, or its last one (closed); null before the first. */
  session: DeskSessionView | null;
  /** Every pulled queue row: the screen lists the pending ones; a scan finds any. */
  queue: (QueueEntry & { deviceId: string })[];
  /** This desk's handovers of the last days. */
  local: LocalHandover[];
  /** Voided bills the desk took cash for, not given back yet (W1-23, D-111), oldest first. */
  voidCash: VoidCashRow[];
}

/** A voided bill whose cash a desk took: what the section "Cash taken for voided bills" lists. */
export interface VoidCashRow {
  number: string;
  voidNumber: string | null;
  /** The cash taken: this desk's handover's figure, else the bill's cash due. */
  amount: Money;
  createdAt: string;
}

const amount = (v: unknown): Money | null => (v === null || v === undefined ? null : money(Number(v)));

/** This desk's newest session, open or closed; null before its first. */
function lastSession(db: SqlDb):
  | (DeskSession & {
      number: string;
      openedAt: string;
      countedCash: Money | null;
      variance: Money | null;
      leftInDrawer: Money | null;
    })
  | null {
  const [r] = db.selectObjects(
    `SELECT id, number, cashier_user_id, opened_at, opening_float, status, counted_cash, variance, left_in_drawer
     FROM cash_sessions ORDER BY opened_at DESC, id DESC LIMIT 1`,
  );
  if (r === undefined) return null;
  return {
    id: String(r['id']),
    number: String(r['number']),
    cashierId: String(r['cashier_user_id']),
    openedAt: String(r['opened_at']),
    openingFloat: money(Number(r['opening_float'])),
    status: r['status'] === 'open' ? 'open' : 'closed',
    countedCash: amount(r['counted_cash']),
    variance: amount(r['variance']),
    leftInDrawer: amount(r['left_in_drawer']),
  };
}

/**
 * A session's handovers, collections and cash movements, for its expected cash (posting rules §4.5). Duplicates
 * can't exist on one desk; only cash collections reach the drawer.
 */
function sessionCash(db: SqlDb, sessionId: string): Required<SessionCash> {
  const rows = db.selectObjects(
    `SELECT family, json_extract(payload, '$.kind') AS kind, json_extract(payload, '$.amount') AS amount,
       json_extract(payload, '$.methodCode') AS method
     FROM local_documents WHERE family IN ('H', 'R', 'M') AND json_extract(payload, '$.sessionId') = ?
     ORDER BY created_at`,
    [sessionId],
  );
  const of = (family: string) => rows.filter((r) => r['family'] === family);
  return {
    handovers: of('H').map((r) => ({
      kind: r['kind'] === 'payout' ? 'payout' : 'in',
      amount: money(Number(r['amount'])),
    })),
    collections: of('R').map((r) => ({ cash: r['method'] === 'cash', amount: money(Number(r['amount'])) })),
    movements: of('M').map((r) => ({
      kind: String(r['kind']) as CashMovementKind,
      amount: money(Number(r['amount'])),
    })),
  };
}

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

/** This desk's own `void_cash` movements, by bill (W1-23). */
const givenBackHere = (db: SqlDb, billNumber: string): boolean =>
  db.selectValue(
    `SELECT 1 FROM local_documents WHERE family = 'M' AND json_extract(payload, '$.kind') = 'void_cash'
       AND json_extract(payload, '$.billNumber') = ? LIMIT 1`,
    [billNumber],
  ) !== undefined;

/** This desk's handover in of a bill, with its figure, or null. */
const handedInHere = (db: SqlDb, billNumber: string): Money | null => {
  const v = db.selectValue(
    `SELECT json_extract(payload, '$.amount') FROM local_documents WHERE family = 'H'
       AND json_extract(payload, '$.kind') = 'in' AND json_extract(payload, '$.billNumber') = ? LIMIT 1`,
    [billNumber],
  );
  return v === undefined || v === null ? null : money(Number(v));
};

/**
 * Voided bills whose cash was taken (by this desk, or by another as the queue says) and not given back yet (W1-23):
 * the server keeps such a bill in the queue until its cash is given back.
 */
function voidCashRows(db: SqlDb): VoidCashRow[] {
  return db
    .selectObjects(
      `SELECT number, created_at_device, cash_due, handover_status, status, void_number, cash_given_back_number, id
       FROM cash_queue WHERE cash_due > 0 AND deleted_at IS NULL ORDER BY created_at_device, number`,
    )
    .flatMap((r) => {
      const number = String(r['number']);
      const voided = r['status'] === 'voided' || voidedHere(db, String(r['id']));
      if (!voided || r['cash_given_back_number'] !== null || givenBackHere(db, number)) return [];
      const here = handedInHere(db, number);
      if (here === null && r['handover_status'] !== 'received') return [];
      return [
        {
          number,
          voidNumber: typeof r['void_number'] === 'string' ? r['void_number'] : null,
          amount: here ?? money(Number(r['cash_due'])),
          createdAt: String(r['created_at_device']),
        },
      ];
    });
}

export function deskState(db: SqlDb, nowMs = Date.now()): DeskState {
  const s = lastSession(db);
  let session: DeskSessionView | null = null;
  if (s !== null) {
    const cash = sessionCash(db, s.id);
    const total = (kind: 'in' | 'payout') =>
      sum(cash.handovers.filter((h) => h.kind === kind).map((h) => h.amount));
    session = {
      ...s,
      handedIn: total('in'),
      paidOut: total('payout'),
      collected: sum(cash.collections.filter((c) => c.cash).map((c) => c.amount)),
      cashOut: sum(cash.movements.filter((m) => isMoneyOut(m.kind)).map((m) => m.amount)),
      fromSafe: sum(cash.movements.filter((m) => !isMoneyOut(m.kind)).map((m) => m.amount)),
      expected: expectedCash({ ...cash, openingFloat: s.openingFloat }),
    };
  }
  return {
    session,
    queue: db
      .selectObjects(`SELECT ${QUEUE_COLUMNS} FROM cash_queue ORDER BY created_at_device`)
      .map(queueEntry)
      // A bill voided on this desk leaves its queue at once, before the server knows (W1-12).
      .map((e) =>
        e.status === 'finalized' && voidedHere(db, e.id) ? { ...e, status: 'voided' as const } : e,
      ),
    local: localHandovers(db, nowMs),
    voidCash: voidCashRows(db),
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
function store(
  db: SqlDb,
  doc: CashHandoverDocument | CashSessionDocument | CustomerCollectionDocument | CashMovementDocument,
  kind: string,
): void {
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

/**
 * Opens a session with its float (CSH-01); refused while one is open, or without `cash.handover.receive`. What stayed
 * in the drawer at this desk's last counted close goes on the document, so a different float shows (owner answer 3).
 */
export function openSession(db: SqlDb, req: DeskRequest & { openingFloat: Money }): CashSessionDocument {
  const r = ready(db);
  const grants = grantsFor(db, req.userId);
  return db.transaction(() => {
    const current = lastSession(db);
    const doc = buildSessionDocument({
      event: 'open',
      current,
      userId: req.userId,
      grants,
      openingFloat: req.openingFloat,
      floatExpected: current?.leftInDrawer ?? null,
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

export interface CloseRequest extends DeskRequest {
  counts: Record<string, number>;
  reason: SessionCloseInput['reason'];
  note: string | null;
  /** The manager whose PIN the dialog verified; null = acknowledge later (owner answer 1). */
  acknowledgerId: string | null;
  /** null = all of the count stays. */
  leftInDrawer: Money | null;
}

/**
 * Closes the open session with its count (CSH-07), by anyone with `cash.session.close` (owner answer 1 to W1-10);
 * refused with the close check's problem as a DomainError.
 */
export function closeSession(db: SqlDb, req: CloseRequest): CashSessionDocument {
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
      ...(s === null ? { handovers: [] } : sessionCash(db, s.id)),
      close: {
        currency: currencyOf(db),
        counts: req.counts,
        reason: req.reason,
        note: req.note,
        acknowledger:
          req.acknowledgerId === null
            ? null
            : { userId: req.acknowledgerId, grants: grantsFor(db, req.acknowledgerId) },
        leftInDrawer: req.leftInDrawer,
      },
      context: { ...contextOf(r, nextSeq(db, 'Z'), req), increment: r.settings.increment },
    });
    store(db, doc, 'session_close');
    db.exec(
      `UPDATE cash_sessions SET status = 'closed', closed_at = ?, closed_by_user_id = ?, counted_cash = ?, variance = ?,
         left_in_drawer = ? WHERE id = ?`,
      [doc.createdAt, req.userId, doc.countedCash, doc.variance, doc.leftInDrawer, doc.sessionId],
    );
    return doc;
  });
}

/** The bill a handover is for: the queue's row when the desk has it, else what the scanned code says. */
const voidedHere = (db: SqlDb, saleId: string): boolean =>
  db.selectValue(
    "SELECT 1 FROM local_documents WHERE family = 'V' AND json_extract(payload, '$.saleId') = ? LIMIT 1",
    [saleId],
  ) !== undefined;

/**
 * A return's original bill whose cash is still waiting in the queue (W1-23, guard 2), or null: pending as the queue
 * says, not voided, and not handed over at this desk either.
 */
function unpaidOriginal(db: SqlDb, originalNumber: unknown): { number: string; amount: Money } | null {
  if (typeof originalNumber !== 'string') return null;
  const [o] = db.selectObjects(
    'SELECT id, cash_due, handover_status, status FROM cash_queue WHERE number = ? AND deleted_at IS NULL LIMIT 1',
    [originalNumber],
  );
  if (o === undefined || Number(o['cash_due']) <= 0) return null;
  if (o['handover_status'] !== 'pending' || o['status'] !== 'finalized' || voidedHere(db, String(o['id'])))
    return null;
  if (handedInHere(db, originalNumber) !== null) return null;
  return { number: originalNumber, amount: money(Number(o['cash_due'])) };
}

function targetOf(db: SqlDb, number: string, code: { cashDue: Money } | null): HandoverTarget {
  const [row] = db.selectObjects(
    `SELECT ${QUEUE_COLUMNS}, return_of_number FROM cash_queue WHERE number = ? LIMIT 1`,
    [number],
  );
  if (row !== undefined) {
    const e = queueEntry(row);
    return {
      number,
      cashDue: e.cashDue,
      saleDocumentId: e.id,
      cashReceived: e.cashReceived,
      handoverStatus: e.handoverStatus,
      // Voided as the queue says, or by this desk itself before the server knows (W1-12).
      status: e.status === 'voided' || voidedHere(db, e.id) ? 'voided' : 'finalized',
      // A refund waits for its bill's cash (W1-23, guard 2); a scanned code alone can't be linked.
      unpaidOriginal: e.cashDue < 0 ? unpaidOriginal(db, row['return_of_number']) : null,
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
  sale: SaleDocument | ReturnDocument,
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

/** The tenant's currency, for the denominations of the count. */
function currencyOf(db: SqlDb): string {
  const data = db.selectValue('SELECT data FROM tenant WHERE deleted_at IS NULL LIMIT 1');
  const t = typeof data === 'string' ? (JSON.parse(data) as Record<string, unknown>) : {};
  return typeof t['base_currency'] === 'string' ? t['base_currency'] : 'PKR';
}

export interface DeskCustomer extends CollectionCustomer {
  phones: string[];
  /** This desk's last collection from them, if it still has it. */
  lastCollection: { number: string; amount: Money; at: string } | null;
}

/** This desk's collections from a customer the pulled balance can't include yet (as unsynced bills, POS spec §15). */
function unsyncedCollections(db: SqlDb, partyId: string): Money {
  const asOf = getSync(db, 'complete_pull_started_at') ?? '';
  return money(
    Number(
      db.selectValue(
        `SELECT coalesce(sum(json_extract(payload, '$.amount')), 0) FROM local_documents
         WHERE family = 'R' AND json_extract(payload, '$.partyId') = ?
           AND (id IN (SELECT id FROM outbox) OR accepted_at > ?)`,
        [partyId, asOf],
      ),
    ),
  );
}

/**
 * What the collection dialog shows (CSH-05): the customer's balance as this desk knows it, the last synced one plus
 * its unsynced bills on account, minus its unsynced collections; and the last collection here.
 */
export function deskCustomer(db: SqlDb, partyId: string, nowMs = Date.now()): DeskCustomer | null {
  const c = getCustomer(db, partyId);
  const s = checkoutSettings(db);
  if (c === null || s === null) return null;
  const today = businessDate(nowMs, s.timeZone, s.cutoffHour);
  const figures = creditFigures(db, partyId, false, today);
  const [last] = db.selectObjects(
    `SELECT number, json_extract(payload, '$.amount') AS amount, created_at FROM local_documents
     WHERE family = 'R' AND json_extract(payload, '$.partyId') = ? ORDER BY created_at DESC LIMIT 1`,
    [partyId],
  );
  return {
    partyId: c.id,
    code: c.code,
    name: c.name,
    phones: c.phones,
    balance: money(figures.balance + figures.unsynced - unsyncedCollections(db, partyId)),
    lastCollection:
      last === undefined
        ? null
        : {
            number: String(last['number']),
            amount: money(Number(last['amount'])),
            at: String(last['created_at']),
          },
  };
}

export interface DeskLookups {
  /** Active methods a customer can pay by: not on account. */
  methods: (CollectionMethod & { name: string })[];
  categories: MovementCategory[];
  suppliers: (MovementSupplier & { balance: Money })[];
  /** Banks a deposit can go to. */
  banks: MovementBankAccount[];
  currency: string;
}

/** What the collection and cash-out dialogs offer (sync spec §3: the desk's own datasets). */
export function deskLookups(db: SqlDb): DeskLookups {
  return {
    methods: db
      .selectObjects(
        `SELECT id, code, name, is_cash, requires_reference FROM payment_methods
         WHERE is_active = 1 AND deleted_at IS NULL AND code <> 'on_account' ORDER BY sort, code`,
      )
      .map((r) => ({
        id: String(r['id']),
        code: String(r['code']) as CollectionMethod['code'],
        name: String(r['name']),
        isCash: Number(r['is_cash']) === 1,
        requiresReference: Number(r['requires_reference']) === 1,
        isActive: true,
      })),
    categories: db
      .selectObjects('SELECT id, name FROM expense_categories WHERE is_active = 1 ORDER BY name')
      .map((r) => ({ id: String(r['id']), name: String(r['name']), isActive: true })),
    suppliers: db
      .selectObjects(
        `SELECT s.id, s.code, s.name, coalesce(b.balance, 0) AS balance FROM suppliers s
         LEFT JOIN supplier_balances b ON b.party_id = s.id WHERE s.status = 'active' ORDER BY s.name, s.code`,
      )
      .map((r) => ({
        partyId: String(r['id']),
        code: String(r['code']),
        name: String(r['name']),
        balance: money(Number(r['balance'])),
      })),
    banks: db
      .selectObjects("SELECT id, name FROM bank_accounts WHERE is_active = 1 AND kind = 'bank' ORDER BY name")
      .map((r) => ({ id: String(r['id']), name: String(r['name']), kind: 'bank' as const, isActive: true })),
    currency: currencyOf(db),
  };
}

function nextDeskSeq(db: SqlDb, family: 'R' | 'M'): number {
  const seq = Number(db.selectValue('SELECT next_seq FROM local_series WHERE family = ?', [family]) ?? 1);
  db.exec(
    `INSERT INTO local_series (family, next_seq) VALUES (?, ?)
     ON CONFLICT (family) DO UPDATE SET next_seq = excluded.next_seq`,
    [family, seq + 1],
  );
  return seq;
}

export interface CollectionRequest extends DeskRequest {
  partyId: string;
  methodId: string;
  amount: Money;
  reference: string | null;
  note: string | null;
}

/** Records a customer's payment (CSH-05): refused with the check's problem as a DomainError. */
export function receiveCollection(db: SqlDb, req: CollectionRequest): CustomerCollectionDocument {
  const r = ready(db);
  const grants = grantsFor(db, req.userId);
  return db.transaction(() => {
    const doc = buildCollectionDocument({
      session: lastSession(db),
      cashierId: req.userId,
      grants,
      branchId: r.device.branchId,
      increment: r.settings.increment,
      customer: deskCustomer(db, req.partyId, req.createdAtMs),
      method: deskLookups(db).methods.find((m) => m.id === req.methodId) ?? null,
      amount: req.amount,
      reference: req.reference,
      note: req.note,
      context: contextOf(r, nextDeskSeq(db, 'R'), req),
    });
    store(db, doc, 'collection');
    return doc;
  });
}

export interface CashMovementRequest extends DeskRequest {
  kind: CashOutKind;
  amount: Money;
  expenseCategoryId: string | null;
  supplierId: string | null;
  bankAccountId: string | null;
  note: string | null;
  reference: string | null;
  /** The cashier confirmed a cash-out above what the drawer should hold. */
  overDrawerConfirmed: boolean;
}

/** Records a cash-out or a safe movement (CSH-06): refused with the check's problem as a DomainError. */
export function recordCashMovement(db: SqlDb, req: CashMovementRequest): CashMovementDocument {
  const r = ready(db);
  const grants = grantsFor(db, req.userId);
  return db.transaction(() => {
    const session = lastSession(db);
    const lookups = deskLookups(db);
    const doc = buildCashMovementDocument({
      session,
      cashierId: req.userId,
      grants,
      branchId: r.device.branchId,
      increment: r.settings.increment,
      kind: req.kind,
      amount: req.amount,
      expenseCategory: lookups.categories.find((c) => c.id === req.expenseCategoryId) ?? null,
      supplier: lookups.suppliers.find((s) => s.partyId === req.supplierId) ?? null,
      bankAccount: lookups.banks.find((b) => b.id === req.bankAccountId) ?? null,
      note: req.note,
      reference: req.reference,
      expected:
        session === null
          ? money(0)
          : expectedCash({ ...sessionCash(db, session.id), openingFloat: session.openingFloat }),
      overDrawerConfirmed: req.overDrawerConfirmed,
      context: contextOf(r, nextDeskSeq(db, 'M'), req),
    });
    store(db, doc, doc.kind);
    return doc;
  });
}

export interface VoidCashRequest extends DeskRequest {
  billNumber: string;
  /** Whoever entered their PIN on the screen (a pos.void holder, never the session's cashier). */
  approverId: string;
}

/** A bill as the give-back check needs it, from the queue and this desk's own documents (W1-23). */
function voidCashBill(db: SqlDb, billNumber: string): VoidCashBill {
  const [r] = db.selectObjects(
    `SELECT id, cash_due, handover_status, status, cash_given_back_number FROM cash_queue
     WHERE number = ? AND deleted_at IS NULL LIMIT 1`,
    [billNumber],
  );
  const here = handedInHere(db, billNumber);
  const voided = r !== undefined && (r['status'] === 'voided' || voidedHere(db, String(r['id'])));
  return {
    number: billNumber,
    status: voided ? 'voided' : 'finalized',
    cashTaken:
      here ?? (r !== undefined && r['handover_status'] === 'received' ? money(Number(r['cash_due'])) : null),
    givenBack: givenBackHere(db, billNumber) || (r !== undefined && r['cash_given_back_number'] !== null),
  };
}

/**
 * Gives back the cash taken for a voided bill (W1-23, D-111): a cash movement of kind void_cash, written with its
 * outbox row in one transaction (rule 6); refused with checkVoidCash's problem as a DomainError, writing nothing.
 */
export function giveBackVoidCash(db: SqlDb, req: VoidCashRequest): CashMovementDocument {
  const r = ready(db);
  return db.transaction(() => {
    const doc = buildVoidCashDocument({
      session: lastSession(db),
      cashierId: req.userId,
      grants: grantsFor(db, req.userId),
      branchId: r.device.branchId,
      bill: voidCashBill(db, req.billNumber),
      approverId: req.approverId,
      approverGrants: grantsFor(db, req.approverId),
      context: contextOf(r, nextDeskSeq(db, 'M'), req),
    });
    store(db, doc, doc.kind);
    log(db, 'desk.void_cash', { bill: req.billNumber, number: doc.number, approvedBy: req.approverId });
    return doc;
  });
}
