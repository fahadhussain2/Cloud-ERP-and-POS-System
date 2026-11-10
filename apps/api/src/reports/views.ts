import {
  ReviewExceptionRequest,
  type AgeingView,
  type ExceptionRow,
  type ExceptionsView,
  type OverrideRow,
  type OverridesView,
  type RegisterRow,
  type ReturnLineRow,
  type SalesRegisterView,
  type StockRow,
  type StockView,
  type VoidRow,
  type VoidsReturnsView,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import { ageBalances, can, money, mulQty, qty, registerTotals, type Permission } from '@erp/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requirePermission } from '../auth/routes';
import { csv, moneyOf, sendCsv, type Cell } from './routes';

// The W1-20 reports (RPT-01, RPT-03, RPT-04, RPT-05, RPT-06, RPT-10, D-110): read only, computed on request from the
// tables that already hold the facts, inside withTenant under the app role (rule 5). Every report needs reports.view;
// a cost or a value is left out without cost.view (owner answer 1). Today by default, up to 92 days, one branch or
// all, and Download CSV (owner answer 2).

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The longest range a dated report takes (owner answer 2): a quarter. */
export const MAX_RANGE_DAYS = 92;
/** The stock report sends at most this many rows; the totals still count every one. */
const STOCK_ROWS = 2000;

const num = (v: string | number | null) => (v === null ? null : Number(v));
const iso = (t: Date | null) => t?.toISOString() ?? null;
const daysBetween = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
const sortBy =
  <T>(key: (x: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

type Query = Record<string, string | undefined>;
type Range = { from: string; to: string; branchId: string | null };
class BadRequest extends Error {
  constructor(readonly body: { error: string }) {
    super(body.error);
  }
}

/** The shop's business date now, in its time zone and day cut-off. */
async function shopToday(c: pg.ClientBase, now: Date): Promise<string> {
  const { rows } = await c.query<{ d: string }>(
    `SELECT (($1::timestamptz AT TIME ZONE timezone) - make_interval(hours => day_cutoff_hour))::date::text AS d
     FROM erp.tenants`,
    [now.toISOString()],
  );
  return rows[0]!.d;
}

/** from/to (both default to today), at most 92 days, the right way round; an optional branch. */
function rangeOf(q: Query, today: string): Range {
  const from = q['from'] || today;
  const to = q['to'] || today;
  const branchId = q['branchId'] || null;
  if (!DATE.test(from) || !DATE.test(to) || from > to || (branchId !== null && !UUID.test(branchId)))
    throw new BadRequest({ error: 'bad_request' });
  if (daysBetween(from, to) >= MAX_RANGE_DAYS) throw new BadRequest({ error: 'range_too_long' });
  return { from, to, branchId };
}

const counted = <K extends string>(values: string[], key: K) => {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([v, count]) => ({ [key]: v, count }) as { [P in K]: string } & { count: number });
};

export function registerReportViews(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  const ctx = (req: FastifyRequest) => ({
    tenantId: req.auth!.tenantId,
    userId: req.auth!.userId,
    requestId: req.id,
  });
  const allowed = (req: FastifyRequest, p: Permission) => can(req.auth!.grants, p, null);
  const view = requirePermission(requireAuth, 'reports.view');

  /** Runs a report: bad filters are a 400; the rest is read in one tenant transaction. */
  const run = async <T>(
    req: FastifyRequest,
    reply: FastifyReply,
    fn: (c: pg.ClientBase, today: string) => Promise<T>,
  ): Promise<T | FastifyReply> => {
    try {
      return await withTenant(pool, ctx(req), async (_db, c) => fn(c, await shopToday(c, now())));
    } catch (err) {
      if (err instanceof BadRequest) return reply.code(400).send(err.body);
      throw err;
    }
  };
  const query = (req: FastifyRequest) => req.query as Query;
  const wantsCsv = (req: FastifyRequest) => query(req)['format'] === 'csv';

  // ---- Sales register (RPT-01, owner answer 3) ----
  scope.get('/reports/sales-register', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, today) => {
      const r = rangeOf(query(req), today);
      const docs = await c.query<{
        id: string;
        number: string;
        kind: 'sale' | 'return' | 'exchange';
        status: 'finalized' | 'voided';
        business_date: string;
        created_at: Date;
        device_code: string;
        seller_id: string;
        seller_name: string;
        customer_name: string | null;
        total: string;
        void_number: string | null;
        void_reason: string | null;
      }>(
        `SELECT d.id, d.number, d.kind, d.status, d.business_date::text, d.created_at_device AS created_at,
           v.code AS device_code, d.salesperson_user_id AS seller_id, u.full_name AS seller_name,
           p.name AS customer_name, d.total, sv.number AS void_number, d.void_reason_code AS void_reason
         FROM erp.sales_documents d
         JOIN erp.devices v ON v.id = d.device_id
         JOIN erp.users u ON u.id = d.salesperson_user_id
         LEFT JOIN erp.parties p ON p.id = d.customer_party_id
         LEFT JOIN erp.sales_voids sv ON sv.id = d.void_document_id
         WHERE d.deleted_at IS NULL AND d.business_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR d.branch_id = $3)
         ORDER BY d.business_date, d.created_at_device, d.number`,
        [r.from, r.to, r.branchId],
      );
      const pays = await c.query<{ document_id: string; code: string; name: string; amount: string }>(
        `SELECT s.document_id, m.code, m.name, s.amount FROM erp.sales_payments s
         JOIN erp.payment_methods m ON m.id = s.method_id
         WHERE s.deleted_at IS NULL AND s.document_id = ANY ($1) ORDER BY s.document_id, s.line_no`,
        [docs.rows.map((d) => d.id)],
      );
      const paysOf = new Map<string, RegisterRow['payments']>();
      for (const p of pays.rows)
        paysOf.set(p.document_id, [
          ...(paysOf.get(p.document_id) ?? []),
          { methodCode: p.code, methodName: p.name, amount: Number(p.amount) },
        ]);
      const bills: RegisterRow[] = docs.rows.map((d) => ({
        id: d.id,
        number: d.number,
        kind: d.kind,
        status: d.status,
        businessDate: d.business_date,
        createdAt: d.created_at.toISOString(),
        deviceCode: d.device_code,
        salespersonName: d.seller_name,
        customerName: d.customer_name,
        total: Number(d.total),
        payments: paysOf.get(d.id) ?? [],
        voidNumber: d.void_number,
        voidReason: d.void_reason,
      }));
      const totals = registerTotals(
        bills.map((b, i) => ({
          number: b.number,
          status: b.status,
          kind: b.kind,
          salespersonId: docs.rows[i]!.seller_id,
          salespersonName: b.salespersonName,
          deviceCode: b.deviceCode,
          total: b.total,
          payments: b.payments,
        })),
      );
      const result: SalesRegisterView = { money: await moneyOf(c), from: r.from, to: r.to, bills, totals };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `sales-register-${r.from}-${r.to}.csv`,
        csv(
          [
            'number',
            'date',
            'time',
            'kind',
            'status',
            'counter',
            'salesman',
            'customer',
            'total',
            'tenders',
            'void',
          ],
          bills.map((b): Cell[] => [
            b.number,
            b.businessDate,
            b.createdAt,
            b.kind,
            b.status,
            b.deviceCode,
            b.salespersonName,
            b.customerName,
            b.total,
            b.payments.map((p) => `${p.methodCode} ${p.amount}`).join('; '),
            b.voidNumber === null ? null : `${b.voidNumber} ${b.voidReason ?? ''}`.trim(),
          ]),
        ),
      );
    }),
  );

  // ---- Overrides (RPT-03): below list, below floor and every other approval, by who asked and who approved ----
  scope.get('/reports/overrides', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, today) => {
      const r = rangeOf(query(req), today);
      const cost = allowed(req, 'cost.view');
      const { rows } = await c.query<{
        id: string;
        kind: string;
        bill_number: string;
        business_date: string;
        at: Date;
        item_code: string | null;
        item_name: string | null;
        requested_by: string;
        approved_by: string;
        reason_code: string;
        note: string | null;
        list_price: string | null;
        unit_price: string | null;
        floor_price: string | null;
      }>(
        `SELECT o.id, o.kind, coalesce(d.number, sv.sale_number) AS bill_number,
           coalesce(d.business_date, sv.business_date)::text AS business_date, o.at_device AS at,
           i.code AS item_code, i.name AS item_name, rq.full_name AS requested_by, ap.full_name AS approved_by,
           o.reason_code, o.note, l.list_price, l.unit_price, l.floor_price_at_sale AS floor_price
         FROM erp.overrides o
         LEFT JOIN erp.sales_documents d ON d.id = o.document_id
         LEFT JOIN erp.sales_voids sv ON sv.id = o.document_id
         LEFT JOIN erp.sales_lines l ON l.id = o.line_id
         LEFT JOIN erp.items i ON i.id = l.item_id
         JOIN erp.users rq ON rq.id = o.requested_by_user_id
         JOIN erp.users ap ON ap.id = o.approved_by_user_id
         WHERE o.deleted_at IS NULL AND coalesce(d.business_date, sv.business_date) BETWEEN $1 AND $2
           AND ($3::uuid IS NULL OR coalesce(d.branch_id, sv.branch_id) = $3)
         ORDER BY o.at_device, o.id`,
        [r.from, r.to, r.branchId],
      );
      const overrides: OverrideRow[] = rows.map((o) => ({
        id: o.id,
        kind: o.kind,
        billNumber: o.bill_number,
        businessDate: o.business_date,
        at: o.at.toISOString(),
        itemCode: o.item_code,
        itemName: o.item_name,
        requestedByName: o.requested_by,
        approvedByName: o.approved_by,
        reasonCode: o.reason_code,
        note: o.note,
        listPrice: num(o.list_price),
        unitPrice: num(o.unit_price),
        floorPrice: cost ? num(o.floor_price) : null,
      }));
      const result: OverridesView = {
        money: await moneyOf(c),
        from: r.from,
        to: r.to,
        overrides,
        byRequester: counted(
          overrides.map((o) => o.requestedByName),
          'name',
        ),
        byApprover: counted(
          overrides.map((o) => o.approvedByName),
          'name',
        ),
        byKind: counted(
          overrides.map((o) => o.kind),
          'kind',
        ),
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `overrides-${r.from}-${r.to}.csv`,
        csv(
          [
            'date',
            'time',
            'kind',
            'bill',
            'item',
            'asked_by',
            'approved_by',
            'reason',
            'note',
            'list',
            'price',
            'floor',
          ],
          overrides.map((o): Cell[] => [
            o.businessDate,
            o.at,
            o.kind,
            o.billNumber,
            o.itemCode,
            o.requestedByName,
            o.approvedByName,
            o.reasonCode,
            o.note,
            o.listPrice,
            o.unitPrice,
            o.floorPrice,
          ]),
        ),
      );
    }),
  );

  // ---- Voids and returns (RPT-04) ----
  scope.get('/reports/voids-returns', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, today) => {
      const r = rangeOf(query(req), today);
      const v = await c.query<{
        number: string;
        sale_number: string;
        business_date: string;
        at: Date;
        reason_code: string;
        note: string | null;
        voided_by: string;
        approved_by: string;
        sale_total: string | null;
        reissue_number: string | null;
      }>(
        `SELECT sv.number, sv.sale_number, sv.business_date::text, sv.at_device AS at, sv.reason_code, sv.note,
           vb.full_name AS voided_by, ap.full_name AS approved_by, d.total AS sale_total,
           (SELECT min(x.number) FROM erp.sales_documents x
            WHERE x.reissue_of_number = sv.sale_number AND x.deleted_at IS NULL) AS reissue_number
         FROM erp.sales_voids sv
         JOIN erp.users vb ON vb.id = sv.voided_by_user_id
         JOIN erp.users ap ON ap.id = sv.approved_by_user_id
         LEFT JOIN erp.sales_documents d ON d.id = sv.sale_document_id
         WHERE sv.duplicate_of_id IS NULL AND sv.business_date BETWEEN $1 AND $2
           AND ($3::uuid IS NULL OR sv.branch_id = $3)
         ORDER BY sv.at_device, sv.number`,
        [r.from, r.to, r.branchId],
      );
      const ret = await c.query<{
        bill_number: string;
        business_date: string;
        seller: string;
        item_code: string;
        item_name: string;
        qty: string;
        amount: string;
        reason: string;
        condition: 'resellable' | 'defective';
        original_bill: string | null;
      }>(
        `SELECT d.number AS bill_number, d.business_date::text, u.full_name AS seller, i.code AS item_code,
           i.name AS item_name, (-l.qty * 1000)::bigint::text AS qty, (-l.line_total)::text AS amount,
           l.return_reason_code AS reason, l.return_condition AS condition, od.number AS original_bill
         FROM erp.sales_lines l
         JOIN erp.sales_documents d ON d.id = l.document_id
         JOIN erp.users u ON u.id = d.salesperson_user_id
         JOIN erp.items i ON i.id = l.item_id
         LEFT JOIN erp.sales_lines ol ON ol.id = l.original_line_id
         LEFT JOIN erp.sales_documents od ON od.id = ol.document_id
         WHERE l.deleted_at IS NULL AND d.deleted_at IS NULL AND d.status = 'finalized' AND l.qty < 0
           AND d.business_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR d.branch_id = $3)
         ORDER BY d.business_date, d.number, l.line_no`,
        [r.from, r.to, r.branchId],
      );
      const voids: VoidRow[] = v.rows.map((x) => ({
        number: x.number,
        saleNumber: x.sale_number,
        businessDate: x.business_date,
        at: x.at.toISOString(),
        reasonCode: x.reason_code,
        note: x.note,
        voidedByName: x.voided_by,
        approvedByName: x.approved_by,
        saleTotal: num(x.sale_total),
        reissueNumber: x.reissue_number,
      }));
      const returns: ReturnLineRow[] = ret.rows.map((x) => ({
        billNumber: x.bill_number,
        businessDate: x.business_date,
        salespersonName: x.seller,
        itemCode: x.item_code,
        itemName: x.item_name,
        qty: Number(x.qty),
        amount: Number(x.amount),
        reasonCode: x.reason,
        condition: x.condition,
        originalBillNumber: x.original_bill,
      }));
      const summed = <K extends 'reason' | 'condition'>(key: K, of: (x: ReturnLineRow) => string) => {
        const m = new Map<string, { count: number; amount: number }>();
        for (const x of returns) {
          const t = m.get(of(x)) ?? { count: 0, amount: 0 };
          m.set(of(x), { count: t.count + 1, amount: t.amount + x.amount });
        }
        return [...m]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, t]) => ({ [key]: k, ...t }) as { [P in K]: string } & { count: number; amount: number });
      };
      const result: VoidsReturnsView = {
        money: await moneyOf(c),
        from: r.from,
        to: r.to,
        voids,
        returns,
        voidsByReason: counted(
          voids.map((x) => x.reasonCode),
          'reason',
        ),
        returnsByReason: summed('reason', (x) => x.reasonCode),
        returnsByCondition: summed('condition', (x) => x.condition),
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `voids-returns-${r.from}-${r.to}.csv`,
        csv(
          [
            'section',
            'date',
            'number',
            'bill',
            'reason',
            'person',
            'approved_by',
            'item',
            'qty',
            'amount',
            'detail',
          ],
          [
            ...voids.map((x): Cell[] => [
              'void',
              x.businessDate,
              x.number,
              x.saleNumber,
              x.reasonCode,
              x.voidedByName,
              x.approvedByName,
              null,
              null,
              x.saleTotal,
              x.reissueNumber === null ? x.note : `reissued ${x.reissueNumber}`,
            ]),
            ...returns.map((x): Cell[] => [
              'return',
              x.businessDate,
              x.billNumber,
              x.originalBillNumber,
              x.reasonCode,
              x.salespersonName,
              null,
              x.itemCode,
              x.qty / 1000,
              x.amount,
              x.condition,
            ]),
          ],
        ),
      );
    }),
  );

  // ---- Stock and valuation (RPT-05, owner answer 7): on hand now, at average cost ----
  scope.get('/reports/stock', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c) => {
      const f = query(req);
      for (const k of ['locationId', 'categoryId'] as const)
        if (f[k] && !UUID.test(f[k])) throw new BadRequest({ error: 'bad_request' });
      const values = allowed(req, 'cost.view');
      const text = (f['q'] ?? '').trim().toLowerCase();
      const { rows } = await c.query<{
        item_id: string;
        item_code: string;
        item_name: string;
        category: string | null;
        location_code: string;
        location_name: string;
        qty: string;
        avg_cost: string | null;
      }>(
        `SELECT i.id AS item_id, i.code AS item_code, i.name AS item_name, cat.name AS category,
           l.code AS location_code, l.name AS location_name, (b.qty * 1000)::bigint::text AS qty, k.avg_cost
         FROM erp.stock_balances b
         JOIN erp.items i ON i.id = b.item_id
         JOIN erp.locations l ON l.id = b.location_id
         LEFT JOIN erp.categories cat ON cat.id = i.category_id
         LEFT JOIN erp.item_costs k ON k.item_id = b.item_id
         WHERE b.qty <> 0 AND ($1::uuid IS NULL OR b.location_id = $1) AND ($2::uuid IS NULL OR i.category_id = $2)
           AND ($3 = '' OR lower(i.code) LIKE '%' || $3 || '%' OR lower(i.name) LIKE '%' || $3 || '%')
           AND ($4::boolean IS NOT TRUE OR b.qty < 0)
         ORDER BY i.code, l.code`,
        [f['locationId'] || null, f['categoryId'] || null, text, f['below'] === '1'],
      );
      const all: StockRow[] = rows.map((x) => {
        const q = Number(x.qty);
        const cost = x.avg_cost === null ? null : Number(x.avg_cost);
        return {
          itemId: x.item_id,
          itemCode: x.item_code,
          itemName: x.item_name,
          categoryName: x.category,
          locationCode: x.location_code,
          qty: q,
          avgCost: values ? cost : null,
          // An item without a cost counts 0, as posting does (no_cost).
          value: values ? (cost === null ? 0 : mulQty(qty(q), money(cost))) : null,
        };
      });
      const group = <K>(key: (x: StockRow) => K) => {
        const m = new Map<K, { qty: number; value: number }>();
        for (const x of all) {
          const t = m.get(key(x)) ?? { qty: 0, value: 0 };
          m.set(key(x), { qty: t.qty + x.qty, value: t.value + (x.value ?? 0) });
        }
        return m;
      };
      const names = new Map(rows.map((x) => [x.location_code, x.location_name]));
      const byLocation = [...group((x) => x.locationCode)]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([code, t]) => ({
          code,
          name: names.get(code) ?? code,
          qty: t.qty,
          value: values ? t.value : null,
        }));
      const byCategory = [...group((x) => x.categoryName ?? '')]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, t]) => ({ name, qty: t.qty, value: values ? t.value : null }));
      const result: StockView = {
        money: await moneyOf(c),
        values,
        rows: all.slice(0, STOCK_ROWS),
        truncated: all.length > STOCK_ROWS,
        byLocation,
        byCategory,
        total: {
          qty: all.reduce((s, x) => s + x.qty, 0),
          value: values ? all.reduce((s, x) => s + (x.value ?? 0), 0) : null,
        },
        noCost: new Set(rows.filter((x) => x.avg_cost === null && Number(x.qty) > 0).map((x) => x.item_id))
          .size,
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `stock-${await shopToday(c, now())}.csv`,
        csv(
          ['item', 'name', 'category', 'location', 'qty', ...(values ? ['avg_cost', 'value'] : [])],
          all.map((x): Cell[] => [
            x.itemCode,
            x.itemName,
            x.categoryName,
            x.locationCode,
            x.qty / 1000,
            ...(values ? [x.avgCost, x.value] : []),
          ]),
        ),
      );
    }),
  );

  // ---- Outstanding and ageing (RPT-06, owner answer 4) ----
  scope.get('/reports/ageing', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, today) => {
      const f = query(req);
      const side = f['side'] === 'suppliers' ? 'suppliers' : f['side'] === 'customers' ? 'customers' : null;
      const asOf = f['asOf'] || today;
      if (side === null || !DATE.test(asOf)) throw new BadRequest({ error: 'bad_request' });
      const role = side === 'customers' ? 'customer' : 'supplier';
      const entries = await c.query<{
        party_id: string;
        entry_date: string;
        due_date: string;
        amount: string;
      }>(
        `SELECT party_id, entry_date::text, due_date::text, amount FROM erp.party_ledger_entries
         WHERE role = $1 AND entry_date <= $2 ORDER BY party_id, due_date, entry_date`,
        [role, asOf],
      );
      const aged = ageBalances({
        asOf,
        entries: entries.rows.map((e) => ({
          partyId: e.party_id,
          entryDate: e.entry_date,
          dueDate: e.due_date,
          amount: Number(e.amount),
        })),
      });
      const parties = await c.query<{ id: string; code: string; name: string; terms: number | null }>(
        side === 'customers'
          ? `SELECT p.id, p.code, p.name, a.payment_terms_days AS terms FROM erp.parties p
             LEFT JOIN erp.customer_accounts a ON a.party_id = p.id WHERE p.id = ANY ($1)`
          : `SELECT p.id, p.code, p.name, a.payment_terms_days AS terms FROM erp.parties p
             LEFT JOIN erp.supplier_accounts a ON a.party_id = p.id WHERE p.id = ANY ($1)`,
        [aged.rows.map((x) => x.partyId)],
      );
      const of = new Map(parties.rows.map((p) => [p.id, p]));
      const control = await c.query<{ b: string }>(
        `SELECT coalesce(sum(${side === 'customers' ? 'l.debit - l.credit' : 'l.credit - l.debit'}), 0)::text AS b
         FROM erp.journal_lines l JOIN erp.journal_entries e ON e.id = l.entry_id
         JOIN erp.accounts a ON a.id = l.account_id
         WHERE a.system_role = $1 AND e.entry_date <= $2`,
        [side === 'customers' ? 'AR_CONTROL' : 'AP_CONTROL', asOf],
      );
      const result: AgeingView = {
        money: await moneyOf(c),
        side,
        asOf,
        rows: aged.rows
          .map((x) => {
            const p = of.get(x.partyId);
            return { ...x, code: p?.code ?? '', name: p?.name ?? '', termsDays: p?.terms ?? null };
          })
          .sort(sortBy((x) => x.name.toLowerCase())),
        totals: aged.totals,
        controlBalance: Number(control.rows[0]!.b),
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `ageing-${side}-${asOf}.csv`,
        csv(
          ['code', 'name', 'terms_days', 'balance', 'not_due', '1_30', '31_60', '61_90', 'over_90'],
          result.rows.map((x): Cell[] => [
            x.code,
            x.name,
            x.termsDays,
            x.balance,
            x.notDue,
            x.days1to30,
            x.days31to60,
            x.days61to90,
            x.over90,
          ]),
        ),
      );
    }),
  );

  // ---- Exceptions (RPT-10, owner answer 5): listed, and reviewed without changing what was recorded ----
  const exceptionRows = async (
    c: pg.ClientBase,
    where: string,
    params: unknown[],
  ): Promise<ExceptionRow[]> => {
    const { rows } = await c.query<{
      id: string;
      kind: string;
      severity: 'low' | 'medium' | 'high';
      business_date: string;
      created_at: Date;
      device_code: string | null;
      user_name: string | null;
      document_type: string | null;
      document_number: string | null;
      details: Record<string, unknown>;
      status: 'open' | 'reviewed' | 'dismissed';
      reviewed_by: string | null;
      reviewed_at: Date | null;
      review_note: string | null;
    }>(
      `SELECT e.id, e.kind, e.severity, e.business_date::text, e.created_at, v.code AS device_code,
         u.full_name AS user_name, e.document_type,
         coalesce(sd.number, sv.number, h.number) AS document_number, e.details, e.status,
         r.full_name AS reviewed_by, e.reviewed_at, e.review_note
       FROM erp.exceptions e
       LEFT JOIN erp.devices v ON v.id = e.device_id
       LEFT JOIN erp.users u ON u.id = e.user_id
       LEFT JOIN erp.users r ON r.id = e.reviewed_by_user_id
       LEFT JOIN erp.sales_documents sd ON sd.id = e.document_id
       LEFT JOIN erp.sales_voids sv ON sv.id = e.document_id
       LEFT JOIN erp.cash_handovers h ON h.id = e.document_id
       WHERE ${where}
       ORDER BY e.business_date DESC, e.created_at DESC`,
      params,
    );
    return rows.map((e) => ({
      id: e.id,
      kind: e.kind,
      severity: e.severity,
      businessDate: e.business_date,
      createdAt: e.created_at.toISOString(),
      deviceCode: e.device_code,
      userName: e.user_name,
      documentType: e.document_type,
      documentNumber: e.document_number,
      details: e.details,
      status: e.status,
      reviewedByName: e.reviewed_by,
      reviewedAt: iso(e.reviewed_at),
      reviewNote: e.review_note,
    }));
  };

  scope.get('/reports/exceptions', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, today) => {
      const f = query(req);
      const r = rangeOf(f, today);
      const status = f['status'] || null;
      const severity = f['severity'] || null;
      if (
        (status !== null && !['open', 'reviewed', 'dismissed'].includes(status)) ||
        (severity !== null && !['low', 'medium', 'high'].includes(severity))
      )
        throw new BadRequest({ error: 'bad_request' });
      const all = await exceptionRows(
        c,
        `e.business_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR v.branch_id = $3)
         AND ($4::text IS NULL OR e.kind = $4) AND ($5::text IS NULL OR e.severity = $5)`,
        [r.from, r.to, r.branchId, f['kind'] || null, severity],
      );
      const kinds = new Map<string, { open: number; total: number }>();
      for (const e of all) {
        const t = kinds.get(e.kind) ?? { open: 0, total: 0 };
        kinds.set(e.kind, { open: t.open + (e.status === 'open' ? 1 : 0), total: t.total + 1 });
      }
      const exceptions = status === null ? all : all.filter((e) => e.status === status);
      const result: ExceptionsView = {
        from: r.from,
        to: r.to,
        exceptions,
        byKind: [...kinds].sort(([a], [b]) => (a < b ? -1 : 1)).map(([kind, t]) => ({ kind, ...t })),
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `exceptions-${r.from}-${r.to}.csv`,
        csv(
          [
            'date',
            'kind',
            'severity',
            'counter',
            'person',
            'document',
            'status',
            'reviewed_by',
            'note',
            'details',
          ],
          exceptions.map((e): Cell[] => [
            e.businessDate,
            e.kind,
            e.severity,
            e.deviceCode,
            e.userName,
            e.documentNumber,
            e.status,
            e.reviewedByName,
            e.reviewNote,
            JSON.stringify(e.details),
          ]),
        ),
      );
    }),
  );

  // The home screen's count: open exceptions of the last 7 days, the high ones apart.
  scope.get('/reports/exceptions/open-count', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, today) => {
      const { rows } = await c.query<{ high: number; total: number }>(
        `SELECT count(*) FILTER (WHERE severity = 'high')::int AS high, count(*)::int AS total
         FROM erp.exceptions WHERE status = 'open' AND business_date > $1::date - 7`,
        [today],
      );
      return rows[0]!;
    }),
  );

  scope.post<{ Params: { id: string } }>(
    '/reports/exceptions/:id/review',
    { preHandler: requirePermission(requireAuth, 'exceptions.review') },
    async (req, reply) => {
      const parsed = ReviewExceptionRequest.safeParse(req.body);
      if (!parsed.success || !UUID.test(req.params.id))
        return reply.code(400).send({ error: 'invalid_request' });
      const { status, note } = parsed.data;
      const at = now();
      const outcome = await withTenant(pool, ctx(req), async (_db, c) => {
        const before = (
          await c.query<{ status: string; review_note: string | null }>(
            'SELECT status, review_note FROM erp.exceptions WHERE id = $1 FOR UPDATE',
            [req.params.id],
          )
        ).rows[0];
        if (!before) return null;
        const open = status === 'open';
        await c.query(
          `UPDATE erp.exceptions SET status = $2, review_note = $3, reviewed_by_user_id = $4, reviewed_at = $5
           WHERE id = $1`,
          [
            req.params.id,
            status,
            open ? null : note || null,
            open ? null : req.auth!.userId,
            open ? null : at,
          ],
        );
        await c.query(
          `INSERT INTO erp.audit_log (tenant_id, at, user_id, request_id, action, entity, entity_id, before, after, ip)
           VALUES ($1, $2, $3, $4, $5, 'exceptions', $6, $7, $8, $9)`,
          [
            req.auth!.tenantId,
            at,
            req.auth!.userId,
            req.id,
            open ? 'exception.reopened' : `exception.${status}`,
            req.params.id,
            JSON.stringify(before),
            JSON.stringify({ status, note: open ? null : note || null }),
            req.ip,
          ],
        );
        return (await exceptionRows(c, 'e.id = $1', [req.params.id]))[0]!;
      });
      if (outcome === null) return reply.code(404).send({ error: 'not_found' });
      return outcome;
    },
  );
}
