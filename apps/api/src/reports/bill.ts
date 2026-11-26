import type { BillApprovalView, BillLineView, BillView } from '@erp/contracts';
import { withTenant } from '@erp/db';
import { can, salesFigures, type Permission } from '@erp/domain';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requirePermission } from '../auth/routes';
import { moneyOf } from './routes';

// Bill details (W2-10 plan, D-125): one bill, read only, for anyone with reports.view. Found by its number, as Trace
// a bill finds it (the first received, should a number repeat). A line's cost and sales are Sales and gross profit's
// (W2-03): −its stock movements' value, cost corrections left out (D-124), and its line total; cost, profit and
// margin are left out of the answer without cost.view. Every query is by the document's id, under the app role.

interface Deps {
  pool: pg.Pool;
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

export function registerBill(scope: FastifyInstance, { pool, requireAuth }: Deps) {
  const allowed = (req: FastifyRequest, p: Permission) => can(req.auth!.grants, p, null);
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
