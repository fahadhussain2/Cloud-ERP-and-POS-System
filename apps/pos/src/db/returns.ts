import { RETURN_BILL_DAYS } from '@erp/contracts';
import {
  DomainError,
  lowestPrice90,
  money,
  normalizePhone,
  parseBillCode,
  qty,
  refundFor,
  returnable,
  type Bill,
  type ItemPolicy,
  type Money,
  type PricedLine,
  type Qty,
  type Returned,
  type SaleDocument,
  type ReturnDocument,
} from '@erp/domain';

import type { SqlDb } from './sql';

// Returns on the counter (POS spec §19, POS-12, W1-13): finding the bill (the branch's 90-day bills pulled to every
// counter, and this counter's own documents, its unsynced ones too), what each of its lines can still give back, the
// price suggested without a receipt and the return policy. Runs in the database worker. The rules are
// `returnable`, `returnNeeds` and `lowestPrice90` in @erp/domain. Phones are never written to the diagnostic log.

export interface FoundBill {
  id: string;
  number: string;
  businessDate: string;
  createdAt: string;
  total: Money;
  customerId: string | null;
  kind: string;
}

export interface ReturnableLine {
  lineNo: number;
  itemId: string;
  /** As sold, above 0 (below 0 for a returned line, which can't be returned). */
  qty: Qty;
  /** What the customer paid for the line. */
  lineTotal: Money;
  unitPrice: Money;
  /** What earlier returns took of it, here and on the server. */
  returned: Returned;
  isReturn: boolean;
}

export interface ReturnableBill {
  id: string;
  number: string;
  businessDate: string;
  createdAt: string;
  customerId: string | null;
  total: Money;
  lines: ReturnableLine[];
  /** Paid in part on account: the refund goes back to the account by default (PRD W7). */
  paidOnAccount: boolean;
}

const text = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;

type AnyDocument = SaleDocument | ReturnDocument;

/** This counter's bills, not voided here, newest first. */
function localBills(db: SqlDb, where: string, params: (string | number)[]): AnyDocument[] {
  return db
    .selectObjects(
      `SELECT d.payload FROM local_documents d WHERE d.family = 'S' AND (${where})
         AND NOT EXISTS (SELECT 1 FROM local_documents v
                         WHERE v.family = 'V' AND json_extract(v.payload, '$.saleId') = d.id)
       ORDER BY d.created_at DESC LIMIT 200`,
      params,
    )
    .map((r) => JSON.parse(String(r['payload'])) as AnyDocument);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
const NUMBER = /^(?:([A-Z]\d{2,})-)?S?0*(\d{1,6})$/;

/** A typed or scanned search as what it means: a bill number, a date, phone digits, or part of a number. */
function readQuery(query: string, unit: Money) {
  const q = query.trim().toUpperCase();
  try {
    return { number: parseBillCode(q, unit).number };
  } catch {
    // Not a scanned code.
  }
  if (DAY.test(q)) return { date: q };
  const dmy = DMY.exec(q);
  if (dmy) return { date: `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}` };
  if (/^[A-Z]\d{2,}-S\d{6,}$/.test(q)) return { number: q };
  const n = NUMBER.exec(q);
  const digits = q.replace(/\D/g, '');
  return {
    numberEnd: n ? { device: n[1] ?? null, seq: n[2]! } : null,
    phone: digits.length >= 4 && /^[\d\s+()-]+$/.test(q) ? digits : null,
  };
}

/**
 * The bills a search finds (POS spec §19): by scanned code or number, by date, or by 4 or more digits of a phone (the
 * bills of customers with that phone, and walk-in bills with it). Voided bills aren't listed. Newest first, at most 50.
 */
export function findBills(db: SqlDb, query: string, unit: Money): FoundBill[] {
  const r = readQuery(query, unit);
  const found = new Map<string, FoundBill>();
  const add = (b: FoundBill) => {
    if (!found.has(b.id)) found.set(b.id, b);
  };
  const fromDoc = (d: AnyDocument): FoundBill => ({
    id: d.id,
    number: d.number,
    businessDate: d.businessDate,
    createdAt: d.createdAt,
    total: d.amounts.total,
    customerId: d.customerId,
    kind: d.kind,
  });
  const pulled = (where: string, params: (string | number)[]) =>
    db
      .selectObjects(
        `SELECT id, number, business_date, created_at_device, total, customer_party_id, kind FROM bills
         WHERE deleted_at IS NULL AND status <> 'voided' AND (${where}) ORDER BY created_at_device DESC LIMIT 200`,
        params,
      )
      .map((b): FoundBill => ({
        id: String(b['id']),
        number: String(b['number']),
        businessDate: String(b['business_date']),
        createdAt: String(b['created_at_device']),
        total: money(Number(b['total'])),
        customerId: text(b['customer_party_id']),
        kind: String(b['kind']),
      }));

  if ('number' in r && r.number !== undefined) {
    for (const d of localBills(db, 'd.number = ?', [r.number])) add(fromDoc(d));
    for (const b of pulled('number = ?', [r.number])) add(b);
  } else if ('date' in r && r.date !== undefined) {
    for (const d of localBills(db, 'd.business_date = ?', [r.date])) add(fromDoc(d));
    for (const b of pulled('business_date = ?', [r.date])) add(b);
  } else {
    if (r.numberEnd) {
      const end = `-S${r.numberEnd.seq.padStart(6, '0')}`;
      const like = `${r.numberEnd.device ?? '%'}${end}`;
      for (const d of localBills(db, 'd.number LIKE ?', [like])) add(fromDoc(d));
      for (const b of pulled('number LIKE ?', [like])) add(b);
    }
    if (r.phone) {
      const parties = db
        .selectObjects('SELECT id, phones FROM customers WHERE deleted_at IS NULL')
        .filter((c) =>
          (JSON.parse(String(c['phones'])) as unknown[]).some((p) =>
            (normalizePhone(String(p)) ?? String(p).replace(/\D/g, '')).includes(r.phone!),
          ),
        )
        .map((c) => String(c['id']));
      for (const id of parties) {
        for (const d of localBills(db, "json_extract(d.payload, '$.customerId') = ?", [id])) add(fromDoc(d));
        for (const b of pulled('customer_party_id = ?', [id])) add(b);
      }
      for (const d of localBills(db, "instr(json_extract(d.payload, '$.walkinPhone'), ?) > 0", [r.phone]))
        add(fromDoc(d));
      for (const b of pulled('instr(walkin_phone, ?) > 0', [r.phone])) add(b);
    }
  }
  return [...found.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 50);
}

/** What returns of each original line took (by line number), from the server's returns and this counter's own. */
function returnedByLine(db: SqlDb, billId: string): Map<number, Returned> {
  const out = new Map<number, Returned>();
  const take = (lineNo: number, q: number, lineTotal: number) => {
    const r = out.get(lineNo) ?? { qty: qty(0), refund: money(0) };
    out.set(lineNo, { qty: qty(r.qty - q), refund: money(r.refund - lineTotal) });
  };
  // Returns the server has (pulled), not voided.
  const pulled = db.selectObjects(
    `SELECT o.line_no, r.qty, r.line_total, r.document_id FROM bill_lines r
     JOIN bill_lines o ON o.id = r.original_line_id
     JOIN bills d ON d.id = r.document_id
     WHERE o.document_id = ? AND d.status <> 'voided' AND r.deleted_at IS NULL`,
    [billId],
  );
  const seen = new Set<string>();
  for (const p of pulled) {
    seen.add(String(p['document_id']));
    take(Number(p['line_no']), Number(p['qty']), Number(p['line_total']));
  }
  // This counter's own returns the pull doesn't have yet.
  for (const d of localBills(db, "json_extract(d.payload, '$.returnOf.id') = ?", [billId])) {
    if (seen.has(d.id) || d.version !== 2) continue;
    for (const l of d.lines)
      if ('returnOf' in l && l.returnOf !== null) take(l.returnOf.lineNo, l.qty, l.lineTotal);
  }
  return out;
}

/** The bill a return starts from, with what each line can still give back; null when it isn't known here. */
export function returnableBill(db: SqlDb, billId: string): ReturnableBill | null {
  const returned = returnedByLine(db, billId);
  const none: Returned = { qty: qty(0), refund: money(0) };
  const [own] = localBills(db, 'd.id = ?', [billId]);
  if (own !== undefined)
    return {
      id: own.id,
      number: own.number,
      businessDate: own.businessDate,
      createdAt: own.createdAt,
      customerId: own.customerId,
      total: own.amounts.total,
      paidOnAccount: own.payments.some((p) => p.method === 'on_account' && p.amount > 0),
      lines: own.lines.map((l) => ({
        lineNo: l.lineNo,
        itemId: l.itemId,
        qty: l.qty,
        lineTotal: l.lineTotal,
        unitPrice: l.unitPrice,
        returned: returned.get(l.lineNo) ?? none,
        isReturn: l.qty < 0,
      })),
    };
  const [b] = db.selectObjects(
    `SELECT id, number, business_date, created_at_device, customer_party_id, total FROM bills
     WHERE id = ? AND deleted_at IS NULL AND status <> 'voided'`,
    [billId],
  );
  if (b === undefined) return null;
  const lines = db.selectObjects(
    `SELECT line_no, item_id, qty, unit_price, line_total FROM bill_lines
     WHERE document_id = ? AND deleted_at IS NULL ORDER BY line_no`,
    [billId],
  );
  const onAccount = Number(
    db.selectValue(
      `SELECT count(*) FROM bill_payments p JOIN payment_methods m ON m.id = p.method_id
       WHERE p.document_id = ? AND m.code = 'on_account' AND p.amount > 0 AND p.deleted_at IS NULL`,
      [billId],
    ),
  );
  return {
    id: String(b['id']),
    number: String(b['number']),
    businessDate: String(b['business_date']),
    createdAt: String(b['created_at_device']),
    customerId: text(b['customer_party_id']),
    total: money(Number(b['total'])),
    paidOnAccount: onAccount > 0,
    lines: lines.map((l) => ({
      lineNo: Number(l['line_no']),
      itemId: String(l['item_id']),
      qty: qty(Number(l['qty'])),
      lineTotal: money(Number(l['line_total'])),
      unitPrice: money(Number(l['unit_price'])),
      returned: returned.get(Number(l['line_no'])) ?? none,
      isReturn: Number(l['qty']) < 0,
    })),
  };
}

/**
 * The refund per unit suggested for a return without a receipt (POS spec §19, D-005): the lowest net unit price in
 * the branch's last 90 days (pulled bills and this counter's own), else the item's default-tier price, else null.
 */
export function noReceiptPrice(db: SqlDb, itemId: string, today: string): Money | null {
  const sales: PricedLine[] = db
    .selectObjects(
      `SELECT d.business_date, l.qty, l.line_total, d.status FROM bill_lines l JOIN bills d ON d.id = l.document_id
       WHERE l.item_id = ? AND l.deleted_at IS NULL`,
      [itemId],
    )
    .map((r) => ({
      itemId,
      businessDate: String(r['business_date']),
      qty: qty(Number(r['qty'])),
      lineTotal: money(Number(r['line_total'])),
      voided: String(r['status']) === 'voided',
    }));
  const pulledIds = new Set(
    db.selectObjects('SELECT id FROM bills WHERE deleted_at IS NULL').map((r) => String(r['id'])),
  );
  for (const d of localBills(db, '1 = 1', []))
    if (!pulledIds.has(d.id))
      for (const l of d.lines)
        if (l.itemId === itemId)
          sales.push({
            itemId,
            businessDate: d.businessDate,
            qty: l.qty,
            lineTotal: l.lineTotal,
            voided: false,
          });
  const fallback = db.selectValue(
    `SELECT p.price FROM item_prices p JOIN price_tiers t ON t.id = p.tier_id
     WHERE p.item_id = ? AND t.is_default = 1 AND p.deleted_at IS NULL AND t.deleted_at IS NULL LIMIT 1`,
    [itemId],
  );
  return lowestPrice90({
    itemId,
    today,
    sales,
    fallback: fallback === null || fallback === undefined ? null : money(Number(fallback)),
  });
}

/** The tenant's return window and each item's category policy (data model §2, PRD Q3). */
export function returnPolicy(
  db: SqlDb,
  itemIds: readonly string[],
): { windowDays: number; items: ItemPolicy[] } {
  const data = text(db.selectValue('SELECT data FROM tenant WHERE deleted_at IS NULL LIMIT 1'));
  const t = data === null ? {} : (JSON.parse(data) as Record<string, unknown>);
  const windowDays = Number(t['return_window_days'] ?? 30);
  const items = itemIds.map((id): ItemPolicy => {
    const policy = text(
      db.selectValue(
        'SELECT c.return_policy FROM items i JOIN categories c ON c.id = i.category_id WHERE i.id = ?',
        [id],
      ),
    );
    const p = policy === null ? {} : (JSON.parse(policy) as Record<string, unknown>);
    return {
      ...(typeof p['returnable'] === 'boolean' ? { returnable: p['returnable'] } : {}),
      ...(typeof p['window_days'] === 'number' ? { windowDays: p['window_days'] } : {}),
      ...(typeof p['windowDays'] === 'number' ? { windowDays: p['windowDays'] } : {}),
    };
  });
  return { windowDays, items };
}

/**
 * Inside the finalize transaction: the returned lines of `bill` are still there to return, at the refunds they
 * were given (another return of the same bill on this counter may have taken them since). Refused otherwise.
 */
export function recheckReturn(db: SqlDb, bill: Bill): void {
  const ret = bill.returns ?? null;
  if (ret === null || ret.source.kind !== 'bill') return;
  const original = returnableBill(db, ret.source.id);
  if (original === null) return;
  for (const l of ret.lines) {
    const o = original.lines.find((x) => x.lineNo === l.originalLineNo);
    if (o === undefined) continue;
    const left = returnable(o, o.returned);
    if (l.qty > left.qty || refundFor(o, o.returned, l.qty) !== l.refund)
      throw new DomainError(
        'return_over_quantity',
        `line ${o.lineNo} was returned since: start the return again`,
      );
  }
}

/** Drops the pulled bills older than the 90 days (SYN-01); the server stops sending them. */
export function pruneBills(db: SqlDb, today: string): number {
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - (RETURN_BILL_DAYS - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  db.exec('DELETE FROM bill_lines WHERE document_id IN (SELECT id FROM bills WHERE business_date < ?)', [
    cutoff,
  ]);
  db.exec('DELETE FROM bill_payments WHERE document_id IN (SELECT id FROM bills WHERE business_date < ?)', [
    cutoff,
  ]);
  db.exec('DELETE FROM bills WHERE business_date < ?', [cutoff]);
  return Number(db.selectValue('SELECT changes()'));
}
