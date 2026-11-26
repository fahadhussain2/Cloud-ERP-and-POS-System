import type {
  BillApprovalView,
  BillLineView,
  BillListRow,
  BillListView,
  BillView,
  ReturnListRow,
  ReturnListView,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import { can, periodOf, RETURN_REASONS, salesFigures, type Permission } from '@erp/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requirePermission } from '../auth/routes';
import { BadRequest, LIST_DAYS, rangeOf, shop } from './financial';
import { csv, moneyOf, sendCsv, type Cell } from './routes';
import { STOCK_ROWS } from './stock';

// Bill details (W2-10 plan, D-125): one bill, read only, for anyone with reports.view. Found by its number, as Trace
// a bill finds it (the first received, should a number repeat). A line's cost and sales are Sales and gross profit's
// (W2-03): −its stock movements' value, cost corrections left out (D-124), and its line total; cost, profit and
// margin are left out of the answer without cost.view. Every query is by the document's id, under the app role.

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

type Client = pg.ClientBase;
const iso = (d: Date | string | null) => (d === null ? null : typeof d === 'string' ? d : d.toISOString());

/** The approvals with no line other than the bill discount's (PLT-07). */
const BILL_DISCOUNT_KINDS = ['below_list', 'below_floor'];

async function billOf(
  c: Client,
  number: string,
  values: boolean,
  canTrace: boolean,
): Promise<BillView | null> {
  const d = (
    await c.query<{
      id: string;
      number: string;
      kind: 'sale' | 'return' | 'exchange';
      status: 'finalized' | 'voided';
      business_date: string;
      created_at: Date;
      device: string;
      tier: string;
      salesman: string;
      party_id: string | null;
      party_code: string | null;
      party_name: string | null;
      walkin_phone: string | null;
      bill_discount: string;
      rounding: string;
      tax_total: string;
      total: string;
      handover_status: BillView['handover']['status'];
      void_number: string | null;
      voided_at: Date | null;
      void_reason: string | null;
      void_approver: string | null;
      return_of_number: string | null;
      reissue_of_number: string | null;
    }>(
      `SELECT d.id, d.number, d.kind, d.status, d.business_date::text, d.created_at_device AS created_at,
         v.code AS device, t.name AS tier, u.full_name AS salesman, p.id AS party_id, p.code AS party_code,
         p.name AS party_name, d.walkin_phone, d.bill_discount, d.rounding, d.tax_total, d.total, d.handover_status,
         d.void_number, d.voided_at, d.void_reason_code AS void_reason, va.full_name AS void_approver,
         d.return_of_number, d.reissue_of_number
       FROM erp.sales_documents d
       JOIN erp.devices v ON v.id = d.device_id
       JOIN erp.price_tiers t ON t.id = d.price_tier_id
       JOIN erp.users u ON u.id = d.salesperson_user_id
       LEFT JOIN erp.parties p ON p.id = d.customer_party_id
       LEFT JOIN erp.users va ON va.id = d.void_approved_by_user_id
       WHERE d.number = $1 AND d.deleted_at IS NULL ORDER BY d.received_at LIMIT 1`,
      [number],
    )
  ).rows[0];
  if (!d) return null;

  const lines = (
    await c.query<{
      id: string;
      line_no: number;
      item_id: string;
      code: string;
      name: string;
      location: string | null;
      allows_fraction: boolean;
      qty: string;
      list_price: string | null;
      unit_price: string;
      line_discount: string;
      bill_share: string;
      line_total: string;
      return_reason: string | null;
      return_condition: string | null;
      return_note: string | null;
      original_number: string | null;
      cost: string | null;
      no_cost: boolean | null;
    }>(
      `SELECT l.id, l.line_no, l.item_id, i.code, i.name, lo.code AS location, un.allows_fraction,
         (l.qty * 1000)::bigint AS qty, l.list_price, l.unit_price, l.line_discount, l.bill_share, l.line_total,
         l.return_reason_code AS return_reason, l.return_condition, l.return_note, od.number AS original_number,
         k.cost, k.no_cost
       FROM erp.sales_lines l
       JOIN erp.items i ON i.id = l.item_id
       JOIN erp.units un ON un.id = i.unit_id
       LEFT JOIN erp.locations lo ON lo.id = l.location_id
       LEFT JOIN erp.sales_lines ol ON ol.id = l.original_line_id
       LEFT JOIN erp.sales_documents od ON od.id = ol.document_id
       LEFT JOIN LATERAL (
         SELECT -sum(m.value_delta) AS cost, bool_or(m.avg_cost_after IS NULL) AS no_cost
         FROM erp.stock_movements m
         WHERE m.source_type = 'sale' AND m.source_line_id = l.id AND m.qty_delta <> 0
       ) k ON true
       WHERE l.document_id = $1 AND l.deleted_at IS NULL ORDER BY l.line_no`,
      [d.id],
    )
  ).rows;

  const approvals = (
    await c.query<{ line_id: string | null; kind: string; reason: string; approved_by: string; at: Date }>(
      `SELECT o.line_id, o.kind, o.reason_code AS reason, u.full_name AS approved_by, o.at_device AS at
       FROM erp.overrides o JOIN erp.users u ON u.id = o.approved_by_user_id
       WHERE o.document_id = $1 AND o.deleted_at IS NULL ORDER BY o.at_device, o.id`,
      [d.id],
    )
  ).rows;
  const approval = (a: (typeof approvals)[number]): BillApprovalView => ({
    kind: a.kind,
    reason: a.reason,
    approvedBy: a.approved_by,
    at: iso(a.at)!,
  });

  const payments = (
    await c.query<{
      code: string;
      name: string;
      amount: string;
      cash_received: string | null;
      change_due: string | null;
      reference: string | null;
    }>(
      `SELECT pm.code, pm.name, p.amount, p.cash_received, p.change_due, p.reference
       FROM erp.sales_payments p JOIN erp.payment_methods pm ON pm.id = p.method_id
       WHERE p.document_id = $1 AND p.deleted_at IS NULL ORDER BY p.line_no`,
      [d.id],
    )
  ).rows;

  const handover = (
    await c.query<{ number: string; desk: string; cashier: string; at: Date }>(
      `SELECT h.number, v.code AS desk, u.full_name AS cashier, h.at_device AS at
       FROM erp.cash_handovers h JOIN erp.devices v ON v.id = h.device_id
       JOIN erp.users u ON u.id = h.cashier_user_id
       WHERE h.sales_document_id = $1 ORDER BY h.at_device LIMIT 1`,
      [d.id],
    )
  ).rows[0];

  const returns = (
    await c.query<{ number: string; date: string; status: 'finalized' | 'voided'; total: string }>(
      `SELECT number, business_date::text AS date, status, total FROM erp.sales_documents
       WHERE return_of_id = $1 AND deleted_at IS NULL ORDER BY created_at_device, number`,
      [d.id],
    )
  ).rows;
  const reissue =
    d.status === 'voided'
      ? ((
          await c.query<{ number: string }>(
            `SELECT number FROM erp.sales_documents WHERE reissue_of_id = $1 AND deleted_at IS NULL
             ORDER BY received_at LIMIT 1`,
            [d.id],
          )
        ).rows[0]?.number ?? null)
      : null;
  const journal =
    (
      await c.query<{ number: string }>(
        `SELECT number FROM erp.journal_entries WHERE source_type = 'sale' AND source_id = $1 AND reversal_of_id IS NULL
         ORDER BY posted_at LIMIT 1`,
        [d.id],
      )
    ).rows[0]?.number ?? null;

  const lineViews: BillLineView[] = lines.map((l) => {
    const lineTotal = Number(l.line_total);
    const billShare = Number(l.bill_share);
    const cost = Number(l.cost ?? 0);
    const qty = Number(l.qty);
    return {
      lineNo: l.line_no,
      itemId: l.item_id,
      code: l.code,
      name: l.name,
      location: l.location,
      qty,
      allowsFraction: l.allows_fraction,
      listPrice: l.list_price === null ? null : Number(l.list_price),
      unitPrice: Number(l.unit_price),
      lineDiscount: Number(l.line_discount),
      amount: lineTotal + billShare,
      billShare,
      lineTotal,
      approvals: approvals.filter((a) => a.line_id === l.id).map(approval),
      returned:
        qty < 0
          ? {
              reason: l.return_reason ?? 'other',
              condition: l.return_condition ?? 'resellable',
              note: l.return_note,
              billNumber: l.original_number,
            }
          : null,
      cost: values ? cost : null,
      profit: values ? lineTotal - cost : null,
      noCost: values && l.no_cost === true,
    };
  });
  const sales = lineViews.reduce((t, l) => t + l.lineTotal, 0);
  const cost = lines.reduce((t, l) => t + Number(l.cost ?? 0), 0);
  const figures = salesFigures({ qty: 0, sales, cost, listSales: sales });
  const unlined = approvals.filter((a) => a.line_id === null);

  return {
    money: await moneyOf(c),
    values,
    canTrace,
    bill: {
      id: d.id,
      number: d.number,
      kind: d.kind,
      status: d.status,
      businessDate: d.business_date,
      createdAt: iso(d.created_at)!,
      device: d.device,
      priceTier: d.tier,
      salesman: d.salesman,
      customer:
        d.party_id === null ? null : { id: d.party_id, code: d.party_code ?? '', name: d.party_name ?? '' },
      walkinPhone: d.walkin_phone,
    },
    handover: {
      status: d.handover_status,
      number: handover?.number ?? null,
      desk: handover?.desk ?? null,
      cashier: handover?.cashier ?? null,
      at: handover ? iso(handover.at) : null,
    },
    void:
      d.status === 'voided'
        ? {
            number: d.void_number,
            at: iso(d.voided_at),
            reason: d.void_reason,
            approvedBy: d.void_approver,
            reissue,
          }
        : null,
    lines: lineViews,
    totals: {
      lines: lineViews.reduce((t, l) => t + l.amount, 0),
      billDiscount: Number(d.bill_discount),
      rounding: Number(d.rounding),
      tax: Number(d.tax_total),
      total: Number(d.total),
    },
    billApprovals: unlined.filter((a) => BILL_DISCOUNT_KINDS.includes(a.kind)).map(approval),
    payments: payments.map((p) => ({
      method: p.code,
      name: p.name,
      amount: Number(p.amount),
      cashReceived: p.cash_received === null ? null : Number(p.cash_received),
      change: p.change_due === null ? null : Number(p.change_due),
      reference: p.reference,
    })),
    cost: values
      ? {
          cost,
          profit: figures.profit,
          marginBp: figures.marginBp,
          noCostLines: lineViews.filter((l) => l.noCost).length,
        }
      : null,
    related: {
      returns: returns.map((r) => ({
        number: r.number,
        date: r.date,
        status: r.status,
        total: Number(r.total),
      })),
      returnOf: d.return_of_number,
      reissueOf: d.reissue_of_number,
      approvals: unlined.filter((a) => !BILL_DISCOUNT_KINDS.includes(a.kind)).map(approval),
      journal,
    },
  };
}

// ---- Bills and Returns (W2-11 plan, D-126): the sales documents as lists, opening today, up to 92 days ----

type Query = Record<string, string | undefined>;
type Shop = { today: string; startMonth: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A LIKE pattern's own %, _ and \ taken literally (as the sales reports' search). */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (x) => `\\${x}`);

/** The filters both lists share: the period, the search and the salesman, as SQL parameters $1 to $4. */
function sharedFilters(q: Query, s: Shop) {
  const p = rangeOf(q, periodOf('today', s.today, s.startMonth), LIST_DAYS, s);
  const text = (q['q'] ?? '').trim();
  const salesman = q['salesmanId'] || null;
  if (salesman !== null && !UUID.test(salesman)) throw new BadRequest('bad_request');
  if (text.length > 80) throw new BadRequest('bad_request');
  return { p, params: [p.from, p.to, text === '' ? null : `%${likeEscape(text)}%`, salesman] as unknown[] };
}
function choice<T extends string>(q: Query, key: string, choices: readonly T[]): T | null {
  const v = q[key] || null;
  if (v !== null && !(choices as readonly string[]).includes(v)) throw new BadRequest('bad_request');
  return v as T | null;
}
/** The search and salesman conditions, on documents `d` with their customer `p`. */
const SHARED = `d.deleted_at IS NULL AND d.business_date BETWEEN $1 AND $2
  AND ($3::text IS NULL OR d.number ILIKE $3 OR p.name ILIKE $3 OR p.code ILIKE $3 OR d.walkin_phone ILIKE $3)
  AND ($4::uuid IS NULL OR d.salesperson_user_id = $4)`;
const customerOf = (r: { party_id: string | null; party_code: string | null; party_name: string | null }) =>
  r.party_id === null ? null : { id: r.party_id, code: r.party_code ?? '', name: r.party_name ?? '' };
/** Finalized documents only: a voided one is listed and left out. */
function totalOf(rows: { status: string; total: number }[]) {
  const done = rows.filter((r) => r.status === 'finalized');
  return { count: done.length, amount: done.reduce((t, r) => t + r.total, 0) };
}

async function billsOf(c: Client, q: Query, s: Shop) {
  const { p, params } = sharedFilters(q, s);
  const method = q['method'] || null;
  if (method !== null && !/^[a-z_]{1,30}$/.test(method)) throw new BadRequest('bad_request');
  const status = choice(q, 'status', ['finalized', 'voided'] as const);
  const { rows } = await c.query<{
    id: string;
    number: string;
    at: Date;
    party_id: string | null;
    party_code: string | null;
    party_name: string | null;
    walkin_phone: string | null;
    items: number;
    total: string;
    paid_by: string[] | null;
    status: 'finalized' | 'voided';
    void_number: string | null;
  }>(
    `SELECT d.id, d.number, d.created_at_device AS at, p.id AS party_id, p.code AS party_code, p.name AS party_name,
       d.walkin_phone, d.total, d.status, d.void_number,
       (SELECT count(*)::int FROM erp.sales_lines l WHERE l.document_id = d.id AND l.deleted_at IS NULL) AS items,
       (SELECT array_agg(pm.name ORDER BY sp.line_no) FROM erp.sales_payments sp
        JOIN erp.payment_methods pm ON pm.id = sp.method_id
        WHERE sp.document_id = d.id AND sp.deleted_at IS NULL) AS paid_by
     FROM erp.sales_documents d LEFT JOIN erp.parties p ON p.id = d.customer_party_id
     WHERE d.kind = 'sale' AND ${SHARED}
       AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM erp.sales_payments sp
         JOIN erp.payment_methods pm ON pm.id = sp.method_id
         WHERE sp.document_id = d.id AND sp.deleted_at IS NULL AND pm.code = $5))
       AND ($6::text IS NULL OR d.status = $6)
     ORDER BY d.business_date DESC, d.created_at_device DESC, d.number DESC`,
    [...params, method, status],
  );
  const all: BillListRow[] = rows.map((r) => ({
    id: r.id,
    number: r.number,
    at: iso(r.at)!,
    customer: customerOf(r),
    walkinPhone: r.walkin_phone,
    items: r.items,
    total: Number(r.total),
    paidBy: [...new Set(r.paid_by ?? [])],
    status: r.status,
    voidNumber: r.void_number,
  }));
  const methods = (
    await c.query<{ code: string; name: string }>(
      'SELECT code, name FROM erp.payment_methods WHERE is_active ORDER BY sort, code',
    )
  ).rows;
  return { p, all, methods };
}

async function returnsOf(c: Client, q: Query, s: Shop) {
  const { p, params } = sharedFilters(q, s);
  const kind = choice(q, 'kind', ['return', 'exchange'] as const);
  const reason = choice(q, 'reason', RETURN_REASONS);
  const { rows } = await c.query<{
    id: string;
    number: string;
    at: Date;
    kind: 'return' | 'exchange';
    original: string | null;
    party_id: string | null;
    party_code: string | null;
    party_name: string | null;
    walkin_phone: string | null;
    items_back: string;
    reasons: (string | null)[] | null;
    total: string;
    handover_status: string;
    desk: string | null;
    status: 'finalized' | 'voided';
  }>(
    `SELECT d.id, d.number, d.created_at_device AS at, d.kind, d.return_of_number AS original, p.id AS party_id,
       p.code AS party_code, p.name AS party_name, d.walkin_phone, d.total, d.handover_status, d.status,
       (SELECT (coalesce(-sum(l.qty), 0) * 1000)::bigint FROM erp.sales_lines l
        WHERE l.document_id = d.id AND l.qty < 0 AND l.deleted_at IS NULL) AS items_back,
       (SELECT array_agg(DISTINCT l.return_reason_code) FROM erp.sales_lines l
        WHERE l.document_id = d.id AND l.qty < 0 AND l.deleted_at IS NULL) AS reasons,
       (SELECT v.code FROM erp.cash_handovers h JOIN erp.devices v ON v.id = h.device_id
        WHERE h.sales_document_id = d.id AND h.kind = 'payout' ORDER BY h.at_device LIMIT 1) AS desk
     FROM erp.sales_documents d LEFT JOIN erp.parties p ON p.id = d.customer_party_id
     WHERE d.kind IN ('return', 'exchange') AND ${SHARED}
       AND ($5::text IS NULL OR d.kind = $5)
       AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM erp.sales_lines l WHERE l.document_id = d.id
         AND l.qty < 0 AND l.deleted_at IS NULL AND l.return_reason_code = $6))
     ORDER BY d.business_date DESC, d.created_at_device DESC, d.number DESC`,
    [...params, kind, reason],
  );
  const all: ReturnListRow[] = rows.map((r) => {
    const total = Number(r.total);
    const reasons = (r.reasons ?? []).filter((x): x is string => x !== null);
    const refund: ReturnListRow['refund'] =
      r.handover_status === 'paid_out'
        ? 'paid'
        : r.handover_status === 'pending' && total < 0
          ? 'pending'
          : 'none';
    return {
      id: r.id,
      number: r.number,
      at: iso(r.at)!,
      kind: r.kind,
      originalBill: r.original,
      customer: customerOf(r),
      walkinPhone: r.walkin_phone,
      itemsBack: Number(r.items_back),
      reason: reasons.length === 1 ? reasons[0]! : reasons.length === 0 ? 'other' : 'several',
      total,
      refund,
      refundDesk: refund === 'paid' ? r.desk : null,
      status: r.status,
    };
  });
  return { p, all };
}

export function registerBill(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  const allowed = (req: FastifyRequest, p: Permission) => can(req.auth!.grants, p, null);
  const view = requirePermission(requireAuth, 'reports.view');
  const run = async <T>(
    req: FastifyRequest,
    reply: FastifyReply,
    fn: (c: Client, s: Shop) => Promise<T>,
  ): Promise<T | FastifyReply> => {
    try {
      return await withTenant(
        pool,
        { tenantId: req.auth!.tenantId, userId: req.auth!.userId, requestId: req.id },
        async (_db, c) => fn(c, await shop(c, now())),
      );
    } catch (err) {
      if (err instanceof BadRequest) return reply.code(400).send({ error: err.error });
      throw err;
    }
  };
  const query = (req: FastifyRequest) => req.query as Query;
  const wantsCsv = (req: FastifyRequest) => query(req)['format'] === 'csv';
  const who = (r: { customer: { code: string; name: string } | null; walkinPhone: string | null }) =>
    r.customer ? `${r.customer.name} (${r.customer.code})` : (r.walkinPhone ?? '');

  scope.get('/sales/bills', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const { p, all, methods } = await billsOf(c, query(req), s);
      if (wantsCsv(req))
        return sendCsv(
          reply,
          `bills-${p.from}-${p.to}.csv`,
          csv(
            ['number', 'at', 'customer', 'items', 'total', 'paid_by', 'status', 'void_number'],
            all.map((r): Cell[] => [
              r.number,
              r.at,
              who(r),
              r.items,
              r.total / 100,
              r.paidBy.join(' + '),
              r.status,
              r.voidNumber,
            ]),
          ),
        );
      const out: BillListView = {
        money: await moneyOf(c),
        ...p,
        methods,
        rows: all.slice(0, STOCK_ROWS),
        truncated: all.length > STOCK_ROWS,
        total: totalOf(all),
      };
      return out;
    }),
  );

  scope.get('/sales/returns', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const { p, all } = await returnsOf(c, query(req), s);
      if (wantsCsv(req))
        return sendCsv(
          reply,
          `returns-${p.from}-${p.to}.csv`,
          csv(
            [
              'number',
              'at',
              'type',
              'original_bill',
              'customer',
              'items_back',
              'reason',
              'total',
              'refund',
              'status',
            ],
            all.map((r): Cell[] => [
              r.number,
              r.at,
              r.kind,
              r.originalBill,
              who(r),
              r.itemsBack / 1000,
              r.reason,
              r.total / 100,
              r.refundDesk ? `${r.refund} ${r.refundDesk}` : r.refund,
              r.status,
            ]),
          ),
        );
      const out: ReturnListView = {
        money: await moneyOf(c),
        ...p,
        rows: all.slice(0, STOCK_ROWS),
        truncated: all.length > STOCK_ROWS,
        total: totalOf(all),
      };
      return out;
    }),
  );

  scope.get<{ Params: { number: string } }>(
    '/sales/bills/:number',
    { preHandler: requirePermission(requireAuth, 'reports.view') },
    async (req, reply) => {
      const number = req.params.number.trim();
      if (number === '' || number.length > 40) return reply.code(404).send({ error: 'not_found' });
      const view = await withTenant(
        pool,
        { tenantId: req.auth!.tenantId, userId: req.auth!.userId, requestId: req.id },
        (_db, c) => billOf(c, number, allowed(req, 'cost.view'), allowed(req, 'support.trace')),
      );
      return view ?? reply.code(404).send({ error: 'not_found' });
    },
  );
}
