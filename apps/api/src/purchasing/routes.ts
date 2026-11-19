import {
  CreateSupplierRequest,
  PostRequest,
  ReceiptDraft,
  ReturnDraft,
  SaveReceiptRequest,
  SaveReturnRequest,
  SupplierPaymentRequest,
  UpdateSupplierRequest,
  type DocumentRow,
  type PurchasingLookups,
  type ReceiptView,
  type ReturnView,
  type SupplierDetail,
  type SupplierRow,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import {
  can,
  checkReceipt,
  checkReturn,
  isEmptyDraft,
  normalizeIdentifier,
  receiptTotals,
  type Permission,
} from '@erp/domain';
import { postDocument } from '@erp/posting';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requireAnyPermission, requirePermission } from '../auth/routes';
import { dateRefusal, shopDay } from '../lock';
import { SUPPLIER_DELETABLE } from '../parties';
import { moneyOf } from '../reports/routes';

// Purchasing in the back office (W1-16 plan; PUR-01, PUR-02, PUR-03, PUR-09; owner answers 1–4). Suppliers, goods
// receipts and purchase returns need pur.receive; a payment by bank acc.payment.create (owner answer 2). A receipt or
// return is a draft (no number) until Post, which checks it with the same rules as the screen, takes the next number
// and posts it in the same transaction; a posting that fails rolls the whole post back. Posted = never changed.

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

/** A 201 answer, sent by `run` once the transaction has committed (never from inside it). */
class Created {
  constructor(readonly body: unknown) {}
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body['error']));
  }
}

type Client = pg.PoolClient;
type Row = Record<string, unknown>;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const thousandths = (v: unknown) => Math.round(Number(v) * 1000);
const units = (t: number) => t / 1000;
/** Text for a LIKE pattern, its wildcards taken literally. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (x) => `\\${x}`);
/** A date column read as text (`::text`), or null. */
const day = (v: unknown) => (typeof v === 'string' ? v : null);

/** Adds `days` to an ISO date. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The next number of a family (GR, PR, SP), in the transaction that posts the document. */
async function nextNumber(c: Client, tenantId: string, family: 'GR' | 'PR' | 'SP'): Promise<string> {
  const { rows } = await c.query<{ last_no: string }>(
    `INSERT INTO erp.document_counters (tenant_id, family, last_no) VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, family) DO UPDATE SET last_no = erp.document_counters.last_no + 1
     RETURNING last_no::text`,
    [tenantId, family],
  );
  return `${family}${rows[0]!.last_no.padStart(6, '0')}`;
}

/** The location's branch: back-office documents belong to the branch whose stock they move. */
async function branchOf(c: Client, locationId: string): Promise<string> {
  const r = (
    await c.query<{ branch_id: string }>('SELECT branch_id FROM erp.locations WHERE id = $1', [locationId])
  ).rows[0];
  if (!r) throw new Refusal(400, { error: 'invalid_request' });
  return r.branch_id;
}

/** Each item's unit rule, last cost and Retail price, for the checks and warnings. */
async function itemFacts(c: Client, itemIds: string[]) {
  const { rows } = await c.query<Row>(
    `SELECT i.id, i.code, i.name, u.allows_fraction, k.last_cost,
       (SELECT p.price FROM erp.item_prices p JOIN erp.price_tiers t ON t.id = p.tier_id
        WHERE p.item_id = i.id AND p.deleted_at IS NULL AND t.code = 'RETAIL') AS retail
     FROM erp.items i JOIN erp.units u ON u.id = i.unit_id LEFT JOIN erp.item_costs k ON k.item_id = i.id
     WHERE i.id = ANY($1::uuid[])`,
    [itemIds],
  );
  return new Map(
    rows.map((r) => [
      r['id'] as string,
      {
        code: r['code'] as string,
        name: r['name'] as string,
        allowsFraction: r['allows_fraction'] as boolean,
        lastCost: num(r['last_cost']),
        retail: num(r['retail']),
      },
    ]),
  );
}

async function checkVersion(
  c: Client,
  table: 'goods_receipts' | 'purchase_returns',
  id: string,
  rowVersion: string,
) {
  const r = (
    await c.query<{ status: string; row_version: string; by: string | null; at: Date }>(
      `SELECT d.status, d.row_version::text, u.full_name AS by, d.updated_at AS at
       FROM erp.${table} d LEFT JOIN erp.users u ON u.id = d.updated_by_user_id WHERE d.id = $1`,
      [id],
    )
  ).rows[0];
  if (!r) throw new Refusal(404, { error: 'not_found' });
  if (r.status === 'posted') throw new Refusal(409, { error: 'posted' });
  if (r.row_version !== rowVersion)
    throw new Refusal(409, { error: 'stale', by: r.by, at: r.at.toISOString(), rowVersion: r.row_version });
}

export function registerPurchasing(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  const read = requireAnyPermission(requireAuth, ['pur.receive', 'acc.payment.create']);
  const receive = requirePermission(requireAuth, 'pur.receive');
  const payByBank = requirePermission(requireAuth, 'acc.payment.create');
  const allowed = (req: FastifyRequest, p: Permission) => can(req.auth!.grants, p, null);

  const run = async <T>(req: FastifyRequest, reply: FastifyReply, fn: (c: Client) => Promise<T>) => {
    try {
      const out = await withTenant(
        pool,
        { tenantId: req.auth!.tenantId, userId: req.auth!.userId, requestId: req.id },
        (_db, c) => fn(c),
      );
      return out instanceof Created ? reply.code(201).send(out.body) : out;
    } catch (err) {
      if (err instanceof Refusal) return reply.code(err.status).send(err.body);
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'parties_tenant_id_code_key')
        return reply.code(409).send({ error: 'code_taken' });
      if (e.code === '23503' || e.code === '22P02') return reply.code(400).send({ error: 'invalid_request' });
      throw err;
    }
  };

  /** Posts a document in this transaction; a posting that fails refuses the whole post. */
  const post = async (
    req: FastifyRequest,
    c: Client,
    type: 'goods_receipt' | 'purchase_return' | 'supplier_payment',
    id: string,
  ) => {
    // Nothing posts after the shop's business date (W2-05) or into a locked month (D-108); pick another date.
    const refused = await dateRefusal(c, type, id, now());
    if (refused) throw new Refusal(refused.error === 'date_locked' ? 409 : 400, refused);
    const outcome = await postDocument(c, { tenantId: req.auth!.tenantId, type, id, now: now() });
    if (outcome.status === 'failed') throw new Refusal(400, { error: 'posting_failed', code: outcome.code });
  };

  scope.get('/purchasing/lookups', { preHandler: read }, async (req, reply) =>
    run(req, reply, async (c) => {
      const shop = (
        await c.query<{ live: boolean; lock_date: string | null }>(
          'SELECT go_live_at IS NOT NULL AS live, lock_date::text AS lock_date FROM erp.tenants WHERE id = $1',
          [req.auth!.tenantId],
        )
      ).rows[0];
      const live = shop?.live;
      const out: PurchasingLookups = {
        locations: (
          await c.query<{ id: string; code: string; name: string }>(
            "SELECT id, code, name FROM erp.locations WHERE deleted_at IS NULL AND kind <> 'transit' ORDER BY code",
          )
        ).rows,
        bankAccounts: (
          await c.query<{ id: string; code: string; name: string }>(
            `SELECT id, code, name FROM erp.bank_accounts WHERE is_active AND deleted_at IS NULL ORDER BY name`,
          )
        ).rows,
        suppliers: (
          await c.query<{ id: string; code: string; name: string }>(
            `SELECT p.id, p.code, p.name FROM erp.parties p
             JOIN erp.supplier_accounts s ON s.party_id = p.id AND s.deleted_at IS NULL
             WHERE p.deleted_at IS NULL AND p.status = 'active' ORDER BY lower(p.name)`,
          )
        ).rows,
        live: live === true,
        money: await moneyOf(c),
        can: { receive: allowed(req, 'pur.receive'), payByBank: allowed(req, 'acc.payment.create') },
        lockDate: shop?.lock_date ?? null,
        today: (await shopDay(c, now())).today,
      };
      return out;
    }),
  );

  // Items for a receipt or return line: code, name, barcode or OEM number, with what the checks need. The catalog's
  // own search needs a catalog permission a purchaser doesn't have.
  scope.get('/purchasing/items', { preHandler: receive }, async (req, reply) => {
    const text = ((req.query as Record<string, string | undefined>)['q'] ?? '').trim();
    if (text === '') return { items: [] };
    const words = text.split(/\s+/).map((w) => `%${likeEscape(w)}%`);
    const normalized = likeEscape(normalizeIdentifier(text));
    return run(req, reply, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT i.id FROM erp.items i
         WHERE i.deleted_at IS NULL AND i.status <> 'discontinued'
           AND (NOT EXISTS (SELECT 1 FROM unnest($1::text[]) w WHERE NOT (i.code ILIKE w OR i.name ILIKE w))
             OR EXISTS (SELECT 1 FROM erp.item_identifiers x WHERE x.item_id = i.id AND x.deleted_at IS NULL
                        AND x.normalized_value LIKE $2 || '%'))
         ORDER BY i.code LIMIT 20`,
        [words, normalized],
      );
      const facts = await itemFacts(
        c,
        rows.map((r) => r.id),
      );
      return { items: rows.map((r) => ({ id: r.id, ...facts.get(r.id)! })) };
    });
  });

  // ---- Suppliers (PUR-01) ----

  const supplierRow = (r: Row): SupplierRow => ({
    id: r['id'] as string,
    code: r['code'] as string,
    name: r['name'] as string,
    phones: (r['phones'] as string[] | null) ?? [],
    termsDays: num(r['payment_terms_days']),
    labelAbbr: (r['label_abbr'] as string | null) ?? null,
    status: r['status'] as SupplierRow['status'],
    balance: Number(r['balance'] ?? 0),
    deletable: r['deletable'] === true,
  });
  // Deletable = used nowhere and not a customer too (the shared check, W1-22).
  const UNUSED = SUPPLIER_DELETABLE;
  const SUPPLIERS = `SELECT p.*, s.payment_terms_days, p.row_version::text AS rv, (${UNUSED}) AS deletable,
      coalesce((SELECT sum(e.amount) FROM erp.party_ledger_entries e
                WHERE e.party_id = p.id AND e.role = 'supplier'), 0) AS balance
    FROM erp.parties p JOIN erp.supplier_accounts s ON s.party_id = p.id AND s.deleted_at IS NULL
    WHERE p.deleted_at IS NULL`;

  scope.get('/purchasing/suppliers', { preHandler: read }, async (req, reply) => {
    const text = ((req.query as Record<string, string | undefined>)['q'] ?? '').trim();
    return run(req, reply, async (c) => {
      const { rows } = await c.query<Row>(
        `${SUPPLIERS} AND ($1 = '' OR p.code ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%')
         ORDER BY lower(p.name) LIMIT 500`,
        [likeEscape(text)],
      );
      return { suppliers: rows.map(supplierRow) };
    });
  });

  scope.get('/purchasing/suppliers/:id', { preHandler: read }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return run(req, reply, async (c) => {
      const r = (await c.query<Row>(`${SUPPLIERS} AND p.id = $1`, [id])).rows[0];
      if (!r) throw new Refusal(404, { error: 'not_found' });
      const entries = await c.query<Row>(
        `SELECT e.entry_date::text, e.due_date::text, e.source_type, e.source_id, e.amount,
           coalesce(g.number, pr.number, sp.number, m.number, o.label, e.source_type) AS number
         FROM erp.party_ledger_entries e
         LEFT JOIN erp.goods_receipts g ON e.source_type = 'goods_receipt' AND g.id = e.source_id
         LEFT JOIN erp.purchase_returns pr ON e.source_type = 'purchase_return' AND pr.id = e.source_id
         LEFT JOIN erp.supplier_payments sp ON e.source_type = 'supplier_payment' AND sp.id = e.source_id
         LEFT JOIN erp.cash_movements m ON e.source_type = 'cash_movement' AND m.id = e.source_id
         LEFT JOIN erp.opening_balances o ON e.source_type = 'opening' AND o.id = e.source_id
         WHERE e.party_id = $1 AND e.role = 'supplier'
         ORDER BY e.entry_date, e.posting_seq, e.id`,
        [id],
      );
      let running = 0;
      const ledger = entries.rows.map((e) => {
        running += Number(e['amount']);
        return {
          entryDate: e['entry_date'] as string,
          dueDate: e['due_date'] as string,
          kind: e['source_type'] as string,
          sourceId: e['source_id'] as string,
          number: e['number'] as string,
          amount: Number(e['amount']),
          balance: running,
        };
      });
      const out: SupplierDetail = {
        supplier: {
          ...supplierRow(r),
          contactPerson: (r['contact_person'] as string | null) ?? null,
          address: (r['address'] as string | null) ?? null,
          city: (r['city'] as string | null) ?? null,
          notes: (r['notes'] as string | null) ?? null,
          rowVersion: r['rv'] as string,
        },
        balance: running,
        ledger,
      };
      return out;
    });
  });

  scope.post('/purchasing/suppliers', { preHandler: receive }, async (req, reply) => {
    const parsed = CreateSupplierRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      if ((await c.query('SELECT 1 FROM erp.parties WHERE lower(code) = lower($1)', [b.code])).rowCount)
        throw new Refusal(409, { error: 'code_taken' });
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO erp.parties (tenant_id, code, name, contact_person, phones, address, city, label_abbr, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          req.auth!.tenantId,
          b.code,
          b.name,
          b.contactPerson ?? null,
          b.phones ?? [],
          b.address ?? null,
          b.city ?? null,
          b.labelAbbr ?? null,
          b.notes ?? null,
        ],
      );
      const id = rows[0]!.id;
      await c.query(
        'INSERT INTO erp.supplier_accounts (tenant_id, party_id, payment_terms_days) VALUES ($1, $2, $3)',
        [req.auth!.tenantId, id, b.termsDays ?? null],
      );
      return new Created({ id });
    });
  });

  scope.patch('/purchasing/suppliers/:id', { preHandler: receive }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateSupplierRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      const cur = (
        await c.query<Row>(
          `SELECT p.*, p.row_version::text AS rv, u.full_name AS by FROM erp.parties p
           LEFT JOIN erp.users u ON u.id = p.updated_by_user_id WHERE p.id = $1 AND p.deleted_at IS NULL`,
          [id],
        )
      ).rows[0];
      if (!cur) throw new Refusal(404, { error: 'not_found' });
      if (cur['rv'] !== b.rowVersion) throw new Refusal(409, { error: 'stale', by: cur['by'] ?? null });
      // A supplier the shop still owes (or who owes it) stays active, or the balance would drop out of sight.
      if (b.status === 'inactive' && cur['status'] !== 'inactive') {
        const balance = Number(
          (
            await c.query<{ b: string }>(
              `SELECT coalesce(sum(amount), 0)::text AS b FROM erp.party_ledger_entries
               WHERE party_id = $1 AND role = 'supplier'`,
              [id],
            )
          ).rows[0]!.b,
        );
        if (balance !== 0) throw new Refusal(409, { error: 'balance_open', balance });
      }
      const pick = (k: keyof typeof b, col: string) => (b[k] !== undefined ? b[k] : cur[col]);
      const { rows } = await c.query<{ rv: string }>(
        `UPDATE erp.parties SET name = $2, contact_person = $3, phones = $4, address = $5, city = $6, label_abbr = $7,
           notes = $8, status = $9 WHERE id = $1 RETURNING row_version::text AS rv`,
        [
          id,
          pick('name', 'name'),
          pick('contactPerson', 'contact_person'),
          pick('phones', 'phones'),
          pick('address', 'address'),
          pick('city', 'city'),
          pick('labelAbbr', 'label_abbr'),
          pick('notes', 'notes'),
          pick('status', 'status'),
        ],
      );
      if (b.termsDays !== undefined)
        await c.query('UPDATE erp.supplier_accounts SET payment_terms_days = $2 WHERE party_id = $1', [
          id,
          b.termsDays,
        ]);
      return { rowVersion: rows[0]!.rv };
    });
  });

  // A supplier added by mistake: only one never used anywhere, marked deleted (parties are synced, rule 8).
  scope.delete('/purchasing/suppliers/:id', { preHandler: receive }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return run(req, reply, async (c) => {
      const r = (
        await c.query<{ deletable: boolean }>(
          `SELECT (${UNUSED}) AS deletable FROM erp.parties p WHERE p.id = $1 AND p.deleted_at IS NULL`,
          [id],
        )
      ).rows[0];
      if (!r) throw new Refusal(404, { error: 'not_found' });
      if (!r.deletable) throw new Refusal(409, { error: 'in_use' });
      await c.query('UPDATE erp.supplier_accounts SET deleted_at = now() WHERE party_id = $1', [id]);
      await c.query('UPDATE erp.parties SET deleted_at = now() WHERE id = $1', [id]);
      return { deleted: true };
    });
  });

  // ---- Goods receipts (PUR-02) ----

  const receiptView = async (c: Client, id: string): Promise<ReceiptView | null> => {
    const h = (
      await c.query<Row>(
        `SELECT g.*, g.row_version::text AS rv, p.name AS supplier_name, g.supplier_bill_date::text AS bill_date,
           g.business_date::text AS received_on, g.due_date::text AS due FROM erp.goods_receipts g
         LEFT JOIN erp.parties p ON p.id = g.supplier_party_id WHERE g.id = $1`,
        [id],
      )
    ).rows[0];
    if (!h) return null;
    const rows = (
      await c.query<Row>('SELECT * FROM erp.goods_receipt_lines WHERE receipt_id = $1 ORDER BY line_no', [id])
    ).rows;
    const facts = await itemFacts(
      c,
      rows.map((r) => r['item_id'] as string | null).filter((x): x is string => x !== null),
    );
    const lines = rows.map((r) => {
      const f = r['item_id'] ? facts.get(r['item_id'] as string) : undefined;
      return {
        id: r['id'] as string,
        lineNo: Number(r['line_no']),
        itemId: (r['item_id'] as string | null) ?? null,
        code: f?.code ?? null,
        name: f?.name ?? null,
        qty: thousandths(r['qty']),
        unitCost: Number(r['unit_cost']),
        lineDiscount: Number(r['line_discount']),
        value: num(r['value']),
        netUnitCost: null as number | null,
        allowsFraction: f?.allowsFraction ?? false,
        lastCost: f?.lastCost ?? null,
        retail: f?.retail ?? null,
      };
    });
    const posted = h['status'] === 'posted';
    const check = checkReceipt({
      supplierId: (h['supplier_party_id'] as string | null) ?? null,
      billNo: (h['supplier_bill_no'] as string | null) ?? null,
      billDate: day(h['bill_date']),
      locationId: h['location_id'] as string,
      billDiscount: Number(h['bill_discount']),
      billTotal: num(h['bill_total']),
      // A posted receipt's warnings would compare it with itself (its cost is now the last cost).
      lines: lines.map((l) => ({ ...l, lastCost: posted ? null : l.lastCost })),
    });
    if (check.total !== null) {
      const t = receiptTotals({ lines, billDiscount: Number(h['bill_discount']) });
      t.lines.forEach((x, n) => {
        lines[n]!.netUnitCost = x.netUnitCost;
        lines[n]!.value ??= x.value;
      });
    }
    return {
      receipt: {
        id,
        number: (h['number'] as string | null) ?? null,
        status: h['status'] as 'draft' | 'posted',
        supplierId: (h['supplier_party_id'] as string | null) ?? null,
        supplierName: (h['supplier_name'] as string | null) ?? null,
        billNo: (h['supplier_bill_no'] as string | null) ?? null,
        billDate: day(h['bill_date']),
        receivedOn: h['received_on'] as string,
        locationId: h['location_id'] as string,
        paidFrom: (h['paid_from_bank_account_id'] as string | null) ?? null,
        billDiscount: Number(h['bill_discount']),
        billTotal: num(h['bill_total']),
        total: num(h['total']),
        dueDate: day(h['due']),
        notes: (h['notes'] as string | null) ?? null,
        rowVersion: h['rv'] as string,
        postedAt: h['posted_at'] ? (h['posted_at'] as Date).toISOString() : null,
      },
      lines,
      check,
    };
  };

  const writeReceiptLines = async (c: Client, tenantId: string, id: string, b: ReceiptDraft) => {
    await c.query('DELETE FROM erp.goods_receipt_lines WHERE receipt_id = $1', [id]);
    for (const [n, l] of b.lines.entries()) {
      if (!Number.isSafeInteger(l.unitCost))
        throw new Refusal(400, { error: 'invalid', problems: [{ problem: 'cost_invalid', row: n }] });
      await c.query(
        `INSERT INTO erp.goods_receipt_lines (tenant_id, receipt_id, line_no, item_id, qty, unit_cost, line_discount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, id, n + 1, l.itemId, units(l.qty), Math.max(0, l.unitCost), Math.max(0, l.lineDiscount)],
      );
    }
  };

  const receiptHeader = (b: ReceiptDraft) => [
    b.supplierId,
    b.billNo,
    b.billDate,
    b.receivedOn,
    b.locationId,
    b.paidFrom,
    Math.max(0, b.billDiscount),
    b.billTotal,
    b.notes,
  ];

  scope.get('/purchasing/receipts', { preHandler: read }, async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    return run(req, reply, async (c) => {
      const { rows } = await c.query<Row>(
        `SELECT g.id, g.number, g.status, p.name AS supplier_name, g.business_date::text AS date, g.supplier_bill_no,
           coalesce(g.total, g.bill_total) AS amount
         FROM erp.goods_receipts g LEFT JOIN erp.parties p ON p.id = g.supplier_party_id
         WHERE ($1::text IS NULL OR g.status = $1) AND ($2::uuid IS NULL OR g.supplier_party_id = $2)
         ORDER BY g.status = 'draft' DESC, g.business_date DESC, g.number DESC NULLS FIRST LIMIT 200`,
        [qs['status'] || null, qs['supplier'] || null],
      );
      const out: DocumentRow[] = rows.map((r) => ({
        id: r['id'] as string,
        number: (r['number'] as string | null) ?? null,
        status: r['status'] as 'draft' | 'posted',
        supplierName: (r['supplier_name'] as string | null) ?? null,
        date: r['date'] as string,
        billNo: (r['supplier_bill_no'] as string | null) ?? null,
        amount: num(r['amount']),
      }));
      return { receipts: out };
    });
  });

  scope.get('/purchasing/receipts/:id', { preHandler: read }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return run(req, reply, async (c) => {
      const v = await receiptView(c, id);
      if (!v) throw new Refusal(404, { error: 'not_found' });
      return v;
    });
  });

  scope.post('/purchasing/receipts', { preHandler: receive }, async (req, reply) => {
    const parsed = ReceiptDraft.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    // Nothing typed on any line is nothing to keep (owner's review of W1-19).
    if (isEmptyDraft(parsed.data.lines)) return reply.code(400).send({ error: 'empty_draft' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      const branch = await branchOf(c, b.locationId);
      const { rows } = await c.query<{ id: string; rv: string }>(
        `INSERT INTO erp.goods_receipts (tenant_id, branch_id, supplier_party_id, supplier_bill_no, supplier_bill_date,
           business_date, location_id, paid_from_bank_account_id, bill_discount, bill_total, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, row_version::text AS rv`,
        [req.auth!.tenantId, branch, ...receiptHeader(b)],
      );
      await writeReceiptLines(c, req.auth!.tenantId, rows[0]!.id, b);
      return new Created({ id: rows[0]!.id, rowVersion: rows[0]!.rv });
    });
  });

  scope.put('/purchasing/receipts/:id', { preHandler: receive }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SaveReceiptRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      await checkVersion(c, 'goods_receipts', id, b.rowVersion);
      // Nothing typed on any line is nothing to keep (owner's review of W1-19); posted or stale is said first.
      if (isEmptyDraft(b.lines)) throw new Refusal(400, { error: 'empty_draft' });
      const branch = await branchOf(c, b.locationId);
      const { rows } = await c.query<{ rv: string }>(
        `UPDATE erp.goods_receipts SET branch_id = $2, supplier_party_id = $3, supplier_bill_no = $4,
           supplier_bill_date = $5, business_date = $6, location_id = $7, paid_from_bank_account_id = $8,
           bill_discount = $9, bill_total = $10, notes = $11, row_version = row_version + 1
         WHERE id = $1 RETURNING row_version::text AS rv`,
        [id, branch, ...receiptHeader(b)],
      );
      await writeReceiptLines(c, req.auth!.tenantId, id, b);
      return { rowVersion: rows[0]!.rv };
    });
  });

  scope.delete('/purchasing/receipts/:id', { preHandler: receive }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return run(req, reply, async (c) => {
      const r = (
        await c.query<{ status: string }>('SELECT status FROM erp.goods_receipts WHERE id = $1', [id])
      ).rows[0];
      if (!r) throw new Refusal(404, { error: 'not_found' });
      if (r.status === 'posted') throw new Refusal(409, { error: 'posted' });
      if ((await c.query('SELECT 1 FROM erp.purchase_returns WHERE goods_receipt_id = $1', [id])).rowCount)
        throw new Refusal(409, { error: 'in_use' });
      await c.query('DELETE FROM erp.goods_receipt_lines WHERE receipt_id = $1', [id]);
      await c.query('DELETE FROM erp.goods_receipts WHERE id = $1', [id]);
      return { deleted: true };
    });
  });

  scope.post('/purchasing/receipts/:id/post', { preHandler: receive }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PostRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, async (c) => {
      await checkVersion(c, 'goods_receipts', id, parsed.data.rowVersion);
      const v = (await receiptView(c, id))!;
      if (v.check.problems.length > 0)
        throw new Refusal(400, {
          error: 'invalid',
          problems: v.check.problems,
          warnings: v.check.warnings,
          difference: v.check.difference,
        });
      const totals = receiptTotals({ lines: v.lines, billDiscount: v.receipt.billDiscount });
      const terms = (
        await c.query<{ d: number | null }>(
          'SELECT payment_terms_days AS d FROM erp.supplier_accounts WHERE party_id = $1',
          [v.receipt.supplierId],
        )
      ).rows[0]?.d;
      for (const [n, l] of v.lines.entries())
        await c.query('UPDATE erp.goods_receipt_lines SET value = $2 WHERE id = $1', [
          l.id,
          totals.lines[n]!.value,
        ]);
      const number = await nextNumber(c, req.auth!.tenantId, 'GR');
      await c.query(
        `UPDATE erp.goods_receipts SET status = 'posted', posted_at = $2, number = $3, total = $4, due_date = $5,
           row_version = row_version + 1 WHERE id = $1`,
        [id, now(), number, totals.total, addDays(v.receipt.billDate!, terms ?? 0)],
      );
      await post(req, c, 'goods_receipt', id);
      return { number };
    });
  });

  // ---- Purchase returns (PUR-03) ----

  /** What each receipt line still has: received less posted returns of it (except `exceptReturn`). */
  const returnable = async (c: Client, lineIds: string[], exceptReturn: string) => {
    const { rows } = await c.query<{ id: string; left: string }>(
      `SELECT l.id, ((l.qty - coalesce((SELECT sum(x.qty) FROM erp.purchase_return_lines x
           JOIN erp.purchase_returns r ON r.id = x.return_id
           WHERE x.receipt_line_id = l.id AND r.status = 'posted' AND r.id <> $2), 0)) * 1000)::bigint AS left
       FROM erp.goods_receipt_lines l WHERE l.id = ANY($1::uuid[])`,
      [lineIds, exceptReturn],
    );
    return new Map(rows.map((r) => [r.id, Number(r.left)]));
  };

  const returnView = async (c: Client, id: string): Promise<ReturnView | null> => {
    const h = (
      await c.query<Row>(
        `SELECT r.*, r.row_version::text AS rv, p.name AS supplier_name, g.number AS receipt_number,
           r.business_date::text AS returned_on
         FROM erp.purchase_returns r LEFT JOIN erp.parties p ON p.id = r.supplier_party_id
         LEFT JOIN erp.goods_receipts g ON g.id = r.goods_receipt_id WHERE r.id = $1`,
        [id],
      )
    ).rows[0];
    if (!h) return null;
    const rows = (
      await c.query<Row>('SELECT * FROM erp.purchase_return_lines WHERE return_id = $1 ORDER BY line_no', [
        id,
      ])
    ).rows;
    const facts = await itemFacts(
      c,
      rows.map((r) => r['item_id'] as string | null).filter((x): x is string => x !== null),
    );
    const left = await returnable(
      c,
      rows.map((r) => r['receipt_line_id'] as string | null).filter((x): x is string => x !== null),
      id,
    );
    const lines = rows.map((r) => {
      const f = r['item_id'] ? facts.get(r['item_id'] as string) : undefined;
      const receiptLine = (r['receipt_line_id'] as string | null) ?? null;
      return {
        id: r['id'] as string,
        lineNo: Number(r['line_no']),
        itemId: (r['item_id'] as string | null) ?? null,
        code: f?.code ?? null,
        name: f?.name ?? null,
        receiptLineId: receiptLine,
        qty: thousandths(r['qty']),
        unitCost: Number(r['unit_cost']),
        allowsFraction: f?.allowsFraction ?? false,
        returnable: receiptLine === null ? null : (left.get(receiptLine) ?? 0),
      };
    });
    const check = checkReturn({
      supplierId: (h['supplier_party_id'] as string | null) ?? null,
      locationId: h['location_id'] as string,
      reason: (h['reason_code'] as string | null) ?? null,
      note: (h['note'] as string | null) ?? null,
      lines,
    });
    return {
      purchaseReturn: {
        id,
        number: (h['number'] as string | null) ?? null,
        status: h['status'] as 'draft' | 'posted',
        supplierId: (h['supplier_party_id'] as string | null) ?? null,
        supplierName: (h['supplier_name'] as string | null) ?? null,
        goodsReceiptId: (h['goods_receipt_id'] as string | null) ?? null,
        goodsReceiptNumber: (h['receipt_number'] as string | null) ?? null,
        locationId: h['location_id'] as string,
        returnedOn: h['returned_on'] as string,
        reason: (h['reason_code'] as string | null) ?? null,
        note: (h['note'] as string | null) ?? null,
        total: num(h['total']),
        rowVersion: h['rv'] as string,
      },
      lines,
      check,
    };
  };

  const writeReturn = async (c: Client, tenantId: string, id: string | null, b: ReturnDraft) => {
    const branch = await branchOf(c, b.locationId);
    const reason = b.reason !== null && b.reason.trim() !== '' ? b.reason.trim() : null;
    const known = ['damaged', 'wrong_item', 'excess', 'poor_quality', 'price_dispute', 'other'];
    if (reason !== null && !known.includes(reason))
      throw new Refusal(400, { error: 'invalid', problems: [{ problem: 'reason_unknown', row: null }] });
    const values = [
      branch,
      b.supplierId,
      b.goodsReceiptId ?? null,
      b.locationId,
      b.returnedOn,
      reason,
      b.note,
    ];
    let returnId: string;
    let rv: string;
    if (id === null) {
      const r = (
        await c.query<{ id: string; rv: string }>(
          `INSERT INTO erp.purchase_returns (tenant_id, branch_id, supplier_party_id, goods_receipt_id, location_id,
             business_date, reason_code, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, row_version::text AS rv`,
          [tenantId, ...values],
        )
      ).rows[0]!;
      returnId = r.id;
      rv = r.rv;
    } else {
      rv = (
        await c.query<{ rv: string }>(
          `UPDATE erp.purchase_returns SET branch_id = $2, supplier_party_id = $3, goods_receipt_id = $4,
             location_id = $5, business_date = $6, reason_code = $7, note = $8, row_version = row_version + 1
           WHERE id = $1 RETURNING row_version::text AS rv`,
          [id, ...values],
        )
      ).rows[0]!.rv;
      returnId = id;
      await c.query('DELETE FROM erp.purchase_return_lines WHERE return_id = $1', [id]);
    }
    for (const [n, l] of b.lines.entries()) {
      if (!Number.isSafeInteger(l.unitCost) || l.unitCost < 0)
        throw new Refusal(400, { error: 'invalid', problems: [{ problem: 'cost_invalid', row: n }] });
      await c.query(
        `INSERT INTO erp.purchase_return_lines (tenant_id, return_id, line_no, item_id, receipt_line_id, qty, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, returnId, n + 1, l.itemId, l.receiptLineId ?? null, units(l.qty), l.unitCost],
      );
    }
    return { id: returnId, rowVersion: rv };
  };

  scope.get('/purchasing/returns', { preHandler: read }, async (req, reply) =>
    run(req, reply, async (c) => {
      const { rows } = await c.query<Row>(
        `SELECT r.id, r.number, r.status, p.name AS supplier_name, r.business_date::text AS date, r.total AS amount
         FROM erp.purchase_returns r LEFT JOIN erp.parties p ON p.id = r.supplier_party_id
         ORDER BY r.status = 'draft' DESC, r.business_date DESC, r.number DESC NULLS FIRST LIMIT 200`,
      );
      const out: DocumentRow[] = rows.map((r) => ({
        id: r['id'] as string,
        number: (r['number'] as string | null) ?? null,
        status: r['status'] as 'draft' | 'posted',
        supplierName: (r['supplier_name'] as string | null) ?? null,
        date: r['date'] as string,
        billNo: null,
        amount: num(r['amount']),
      }));
      return { returns: out };
    }),
  );

  scope.get('/purchasing/returns/:id', { preHandler: read }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return run(req, reply, async (c) => {
      const v = await returnView(c, id);
      if (!v) throw new Refusal(404, { error: 'not_found' });
      return v;
    });
  });

  scope.post('/purchasing/returns', { preHandler: receive }, async (req, reply) => {
    const parsed = ReturnDraft.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    // Nothing typed on any line is nothing to keep (owner's review of W1-19).
    if (isEmptyDraft(parsed.data.lines)) return reply.code(400).send({ error: 'empty_draft' });
    return run(
      req,
      reply,
      async (c) => new Created(await writeReturn(c, req.auth!.tenantId, null, parsed.data)),
    );
  });

  scope.put('/purchasing/returns/:id', { preHandler: receive }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SaveReturnRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, async (c) => {
      await checkVersion(c, 'purchase_returns', id, parsed.data.rowVersion);
      // Nothing typed on any line is nothing to keep (owner's review of W1-19); posted or stale is said first.
      if (isEmptyDraft(parsed.data.lines)) throw new Refusal(400, { error: 'empty_draft' });
      const { rowVersion } = await writeReturn(c, req.auth!.tenantId, id, parsed.data);
      return { rowVersion };
    });
  });

  scope.delete('/purchasing/returns/:id', { preHandler: receive }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return run(req, reply, async (c) => {
      const r = (
        await c.query<{ status: string }>('SELECT status FROM erp.purchase_returns WHERE id = $1', [id])
      ).rows[0];
      if (!r) throw new Refusal(404, { error: 'not_found' });
      if (r.status === 'posted') throw new Refusal(409, { error: 'posted' });
      await c.query('DELETE FROM erp.purchase_return_lines WHERE return_id = $1', [id]);
      await c.query('DELETE FROM erp.purchase_returns WHERE id = $1', [id]);
      return { deleted: true };
    });
  });

  scope.post('/purchasing/returns/:id/post', { preHandler: receive }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PostRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, async (c) => {
      await checkVersion(c, 'purchase_returns', id, parsed.data.rowVersion);
      // Returns of the same receipt line post one at a time, so two can't both take what is left.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`purchase_return:${req.auth!.tenantId}`]);
      const v = (await returnView(c, id))!;
      if (v.check.problems.length > 0)
        throw new Refusal(400, { error: 'invalid', problems: v.check.problems });
      const number = await nextNumber(c, req.auth!.tenantId, 'PR');
      await c.query(
        `UPDATE erp.purchase_returns SET status = 'posted', posted_at = $2, number = $3, total = $4,
           row_version = row_version + 1 WHERE id = $1`,
        [id, now(), number, v.check.total],
      );
      await post(req, c, 'purchase_return', id);
      return { number };
    });
  });

  // ---- Supplier payments by bank (PUR-09) ----

  scope.post('/purchasing/payments', { preHandler: payByBank }, async (req, reply) => {
    const parsed = SupplierPaymentRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      const supplier = await c.query('SELECT 1 FROM erp.supplier_accounts WHERE party_id = $1', [
        b.supplierId,
      ]);
      if (!supplier.rowCount) throw new Refusal(400, { error: 'invalid_request' });
      const branch = (
        await c.query<{ id: string }>(
          "SELECT branch_id AS id FROM erp.locations WHERE code = 'SHOP' AND deleted_at IS NULL ORDER BY code LIMIT 1",
        )
      ).rows[0]?.id;
      if (!branch) throw new Refusal(400, { error: 'invalid_request' });
      const number = await nextNumber(c, req.auth!.tenantId, 'SP');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO erp.supplier_payments (tenant_id, number, branch_id, supplier_party_id, bank_account_id, amount,
           business_date, reference) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [req.auth!.tenantId, number, branch, b.supplierId, b.bankAccountId, b.amount, b.paidOn, b.reference],
      );
      await post(req, c, 'supplier_payment', rows[0]!.id);
      return new Created({ id: rows[0]!.id, number });
    });
  });
}
