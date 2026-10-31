import { uuidv7 } from '@erp/contracts';
import {
  buildSaleDocument,
  businessDate,
  DomainError,
  effectiveLimits,
  money,
  type CreditApproval,
  type Money,
  type PaymentMethodCode,
  type PaymentMethodInfo,
  type SaleDocument,
  type Tender,
} from '@erp/domain';

import { parseOpenBill } from '../bill/open-bill';
import { creditFigures } from './customers';
import { getDevice, grantsFor, log } from './repo';
import type { SqlDb } from './sql';

// Paying, finalizing and reprinting on the counter (POS spec §12–§13, data model §12). Runs in the database worker.

/** An active payment method as pulled (sync spec §3), in its `sort` order. */
export interface PaymentMethodRow extends PaymentMethodInfo {
  id: string;
  name: string;
  sort: number;
}

export type PaperFormat = 'a4' | 'a5' | 'thermal_80' | 'thermal_58';

/** The print profile this counter uses: its own, else the tenant default (POS spec §13). */
export interface PrintProfile {
  id: string;
  name: string;
  paperFormat: PaperFormat;
  codeType: 'barcode' | 'signed_qr';
  copies: 1 | 2;
  headerLines: string[];
  policyText: string | null;
}

export interface CheckoutSettings {
  /** The tenant's cash rounding increment (Delux: 100 = Rs 1). */
  increment: Money;
  timeZone: string;
  cutoffHour: number;
  methods: PaymentMethodRow[];
  printProfile: PrintProfile | null;
  /** The branch's receipt header lines, printed under the shop name. */
  receiptHeader: string[];
}

export interface FinalizeRequest {
  /** Who is unlocked: their open bill is finalized. */
  userId: string;
  /** UUIDv7 for the document, made on the counter. */
  id: string;
  createdAtMs: number;
  clientVersion: string;
  tender: Tender;
  /** What the status bar shows: the offline cap applies (POS spec §15). */
  offline: boolean;
  /** An approval to go over the customer's limit or the offline cap, given in the payment popup. */
  creditApproval: CreditApproval | null;
}

export interface Finalized {
  document: SaleDocument;
  /** True when there was no open bill and this is the person's last bill again (a second Enter): don't print it. */
  repeated: boolean;
}

export interface DocumentSummary {
  id: string;
  number: string;
  createdAt: string;
  total: Money;
  cashDue: Money;
}

export interface Reprint {
  id: string;
  documentId: string;
  number: string;
  userId: string;
  at: string;
  pushedAt: string | null;
}

/** A SQLite value as text: these columns hold only text and numbers. */
const text = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;

/** What paying and printing need, from the pulled tenant, methods, profiles and device; null before the first pull. */
export function checkoutSettings(db: SqlDb): CheckoutSettings | null {
  const data = text(db.selectValue('SELECT data FROM tenant WHERE deleted_at IS NULL LIMIT 1'));
  if (data === null) return null;
  const t = JSON.parse(data) as Record<string, unknown>;
  const methods = db
    .selectObjects(
      `SELECT id, code, name, is_cash, requires_reference, sort FROM payment_methods
       WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort, code`,
    )
    .map((r) => ({
      id: String(r['id']),
      code: String(r['code']) as PaymentMethodCode,
      name: String(r['name']),
      isCash: Number(r['is_cash']) === 1,
      requiresReference: Number(r['requires_reference']) === 1,
      sort: Number(r['sort']),
    }));
  return {
    increment: money(String(t['cash_rounding_increment'])),
    timeZone: String(t['timezone']),
    cutoffHour: Number(t['day_cutoff_hour']),
    methods,
    printProfile: printProfile(db),
    receiptHeader: receiptHeader(db),
  };
}

/** The branch's address and phone, then its `receipt_header.lines` (POS spec §13). */
function receiptHeader(db: SqlDb): string[] {
  const data = text(db.selectValue('SELECT data FROM branch WHERE deleted_at IS NULL LIMIT 1'));
  if (data === null) return [];
  const b = JSON.parse(data) as { address?: unknown; phone?: unknown; receipt_header?: { lines?: unknown } };
  const lines = b.receipt_header?.lines;
  const extra: unknown[] = Array.isArray(lines) ? (lines as unknown[]) : [];
  return [b.address, b.phone, ...extra].filter((l): l is string => typeof l === 'string' && l.trim() !== '');
}

/** The device's own profile, else the tenant default (POS spec §13). */
function printProfile(db: SqlDb): PrintProfile | null {
  const own = text(db.selectValue('SELECT print_profile_id FROM device LIMIT 1'));
  const [r] = db.selectObjects(
    `SELECT id, name, paper_format, code_type, copies, template_options FROM print_profiles
     WHERE deleted_at IS NULL AND (id = ? OR is_tenant_default = 1)
     ORDER BY id = ? DESC, id LIMIT 1`,
    [own, own],
  );
  if (r === undefined) return null;
  const options = JSON.parse(String(r['template_options'])) as {
    headerLines?: unknown;
    policyText?: unknown;
  };
  return {
    id: String(r['id']),
    name: String(r['name']),
    paperFormat: String(r['paper_format']) as PaperFormat,
    codeType: String(r['code_type']) as PrintProfile['codeType'],
    copies: Number(r['copies']) === 2 ? 2 : 1,
    headerLines: Array.isArray(options.headerLines) ? options.headerLines.map(String) : [],
    policyText: typeof options.policyText === 'string' ? options.policyText : null,
  };
}

const parseDocument = (payload: string | null) =>
  payload === null ? null : (JSON.parse(payload) as SaleDocument);

/** The person's last bill on this counter: what a second Enter gets back. */
const lastDocumentOf = (db: SqlDb, userId: string): SaleDocument | null =>
  parseDocument(
    text(
      db.selectValue(
        `SELECT payload FROM local_documents WHERE family = 'S' AND json_extract(payload, '$.sellerId') = ?
         ORDER BY seq DESC LIMIT 1`,
        [userId],
      ),
    ),
  );

/**
 * Finalizes the person's open bill in one transaction (POS spec §12): takes the next `S` number, writes the document
 * and its outbox row, deletes the open bill. Any error rolls all of it back.
 */
export function finalizeSale(db: SqlDb, req: FinalizeRequest): Finalized {
  const device = getDevice(db);
  const settings = checkoutSettings(db);
  if (device === null || settings === null) throw new Error('this counter is not set up yet');
  const sellerMaxDiscountBp = effectiveLimits(grantsFor(db, req.userId), device.branchId).maxDiscountBp;
  return db.transaction((): Finalized => {
    const stored = text(db.selectValue('SELECT bill FROM open_bills WHERE user_id = ?', [req.userId]));
    const open = stored === null ? null : parseOpenBill(stored);
    if (open === null) {
      // A second Enter, or a click and an Enter: the bill is already finalized (POS spec §12, step 1).
      const last = lastDocumentOf(db, req.userId);
      if (last === null) throw new DomainError('empty_bill', 'there is no open bill to finalize');
      return { document: last, repeated: true };
    }
    const seq = Number(db.selectValue("SELECT next_seq FROM local_series WHERE family = 'S'") ?? 1);
    db.exec(
      `INSERT INTO local_series (family, next_seq) VALUES ('S', ?)
       ON CONFLICT (family) DO UPDATE SET next_seq = excluded.next_seq`,
      [seq + 1],
    );
    const customerId = open.customer?.id ?? null;
    const today = businessDate(req.createdAtMs, settings.timeZone, settings.cutoffHour);
    const document = buildSaleDocument({
      bill: open.bill,
      tender: req.tender,
      methods: settings.methods,
      sellerMaxDiscountBp,
      customer: { id: customerId, walkinPhone: open.walkinPhone ?? null },
      // Read in this transaction, so two bills for one customer can't both use the same room (POS spec §15).
      credit: customerId === null ? null : creditFigures(db, customerId, req.offline, today),
      creditApproval: req.creditApproval,
      context: {
        id: req.id,
        seq,
        deviceId: device.deviceId,
        deviceCode: device.code,
        branchId: device.branchId,
        createdAtMs: req.createdAtMs,
        timeZone: settings.timeZone,
        cutoffHour: settings.cutoffHour,
        increment: settings.increment,
        clientVersion: req.clientVersion,
      },
    });
    const payload = JSON.stringify(document);
    db.exec(
      `INSERT INTO local_documents (id, family, seq, number, kind, business_date, payload, created_at)
       VALUES (?, 'S', ?, ?, 'sale', ?, ?, ?)`,
      [document.id, seq, document.number, document.businessDate, payload, document.createdAt],
    );
    db.exec(
      `INSERT INTO outbox (id, family, seq, payload, status, attempts, created_at)
       VALUES (?, 'S', ?, ?, 'pending', 0, ?)`,
      [document.id, seq, payload, document.createdAt],
    );
    db.exec('DELETE FROM open_bills WHERE user_id = ?', [req.userId]);
    return { document, repeated: false };
  });
}

/** Stores the device's signature on the document's outbox row (after the commit). */
export const setSignature = (db: SqlDb, documentId: string, signature: string): void =>
  db.exec('UPDATE outbox SET signature = ? WHERE id = ?', [signature, documentId]);

/** This counter's bills since `since` (ISO), newest first; `filter` matches part of the number. */
export const recentDocuments = (db: SqlDb, since: string, filter = ''): DocumentSummary[] =>
  db
    .selectObjects(
      `SELECT id, number, created_at, json_extract(payload, '$.amounts.total') AS total,
         json_extract(payload, '$.cashDue') AS cash_due
       FROM local_documents WHERE created_at >= ? AND instr(number, ?) > 0
       ORDER BY created_at DESC, seq DESC LIMIT 500`,
      [since, filter.trim().toUpperCase()],
    )
    .map((r) => ({
      id: String(r['id']),
      number: String(r['number']),
      createdAt: String(r['created_at']),
      total: money(Number(r['total'])),
      cashDue: money(Number(r['cash_due'])),
    }));

export const loadDocument = (db: SqlDb, id: string): SaleDocument | null =>
  parseDocument(text(db.selectValue('SELECT payload FROM local_documents WHERE id = ?', [id])));

/** Keeps a reprint for the audit log (pushed with W1-07) and the diagnostic log. */
export function recordReprint(db: SqlDb, r: Omit<Reprint, 'id' | 'pushedAt'>): Reprint {
  const reprint: Reprint = { id: uuidv7(Date.parse(r.at)), ...r, pushedAt: null };
  db.transaction(() => {
    db.exec('INSERT INTO reprints (id, document_id, number, user_id, at) VALUES (?, ?, ?, ?, ?)', [
      reprint.id,
      r.documentId,
      r.number,
      r.userId,
      r.at,
    ]);
    log(db, 'bill.reprinted', { documentId: r.documentId, number: r.number, userId: r.userId });
  });
  return reprint;
}

export const listReprints = (db: SqlDb): Reprint[] =>
  db
    .selectObjects('SELECT id, document_id, number, user_id, at, pushed_at FROM reprints ORDER BY at, id')
    .map((r) => ({
      id: String(r['id']),
      documentId: String(r['document_id']),
      number: String(r['number']),
      userId: String(r['user_id']),
      at: String(r['at']),
      pushedAt: text(r['pushed_at']),
    }));
