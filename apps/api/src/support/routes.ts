import { DiagnosticsUpload, type BillTraceView, type DiagnosticsRow, type TraceStep } from '@erp/contracts';
import { withTenant } from '@erp/db';
import { can } from '@erp/domain';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { loadGrants, requirePermission } from '../auth/routes';
import { moneyOf } from '../reports/routes';

// Support (PLT-12, owner answers 1 and 6 to W1-20, D-110). *Trace a bill*: one bill number's story from every table
// that names it, in time order, for the owner. *Send diagnostics*: a counter's log and health, sent by a manager after
// their PIN, kept 30 days, shown on the device's page and in the trace.

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
  requireDevice: preHandlerAsyncHookHandler;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One bill's timeline: what the counter, the sync, the server, the desk and the books each recorded about it. */
async function traceOf(c: pg.ClientBase, number: string): Promise<BillTraceView | null> {
  const bill = (
    await c.query<{
      id: string;
      number: string;
      kind: 'sale' | 'return' | 'exchange';
      status: 'finalized' | 'voided';
      business_date: string;
      total: string;
      device_id: string;
      device_code: string;
      seller: string;
      handover_status: string;
      created_at: Date;
      received_at: Date;
      client_version: string;
      reissue_of_number: string | null;
      return_of_number: string | null;
    }>(
      `SELECT d.id, d.number, d.kind, d.status, d.business_date::text, d.total, d.device_id, v.code AS device_code,
         u.full_name AS seller, d.handover_status, d.created_at_device AS created_at, d.received_at, d.client_version,
         d.reissue_of_number, d.return_of_number
       FROM erp.sales_documents d JOIN erp.devices v ON v.id = d.device_id
       JOIN erp.users u ON u.id = d.salesperson_user_id
       WHERE d.number = $1 AND d.deleted_at IS NULL ORDER BY d.received_at LIMIT 1`,
      [number],
    )
  ).rows[0];
  if (!bill) return null;
  const steps: TraceStep[] = [];
  const add = (
    at: Date | string,
    step: string,
    source: TraceStep['source'],
    detail: TraceStep['detail'] = {},
  ) => steps.push({ at: typeof at === 'string' ? at : at.toISOString(), step, source, detail });

  add(bill.created_at, 'created', 'counter', {
    device: bill.device_code,
    salesman: bill.seller,
    total: Number(bill.total),
    version: bill.client_version,
    reissueOf: bill.reissue_of_number,
    returnOf: bill.return_of_number,
  });

  const inbox = (
    await c.query<{ received_at: Date; attempts: number; status: string }>(
      'SELECT received_at, attempts, status FROM erp.sync_inbox WHERE document_id = $1',
      [bill.id],
    )
  ).rows[0];
  add(inbox?.received_at ?? bill.received_at, 'accepted', 'sync', {
    attempts: inbox?.attempts ?? 1,
    status: inbox?.status ?? 'accepted',
  });

  for (const o of (
    await c.query<{ at: Date; kind: string; reason: string; approved_by: string }>(
      `SELECT o.at_device AS at, o.kind, o.reason_code AS reason, u.full_name AS approved_by FROM erp.overrides o
       JOIN erp.users u ON u.id = o.approved_by_user_id WHERE o.document_id = $1 AND o.deleted_at IS NULL`,
      [bill.id],
    )
  ).rows)
    add(o.at, o.kind === 'reprint' ? 'reprinted' : 'override', 'counter', {
      kind: o.kind,
      reason: o.reason,
      approvedBy: o.approved_by,
    });

  for (const e of (
    await c.query<{ at: Date; kind: string; severity: string; status: string }>(
      'SELECT created_at AS at, kind, severity, status FROM erp.exceptions WHERE document_id = $1',
      [bill.id],
    )
  ).rows)
    add(e.at, 'exception', 'server', { kind: e.kind, severity: e.severity, status: e.status });

  for (const j of (
    await c.query<{ at: Date; number: string; reversal: boolean }>(
      `SELECT posted_at AS at, number, reversal_of_id IS NOT NULL AS reversal FROM erp.journal_entries
       WHERE source_type = 'sale' AND source_id = $1 ORDER BY posted_at, number`,
      [bill.id],
    )
  ).rows)
    add(j.at, j.reversal ? 'posting_reversed' : 'posted', 'books', { journal: j.number });

  for (const h of (
    await c.query<{ at: Date; number: string; kind: 'in' | 'payout'; amount: string; cashier: string }>(
      `SELECT h.at_device AS at, h.number, h.kind, h.amount, u.full_name AS cashier FROM erp.cash_handovers h
       JOIN erp.users u ON u.id = h.cashier_user_id
       WHERE (h.sales_document_id = $1 OR h.bill_number = $2) AND h.duplicate_of_id IS NULL`,
      [bill.id, bill.number],
    )
  ).rows)
    add(h.at, h.kind === 'in' ? 'handed_over' : 'paid_out', 'desk', {
      number: h.number,
      amount: Number(h.amount),
      cashier: h.cashier,
    });

  for (const v of (
    await c.query<{ at: Date; number: string; reason: string; approved_by: string }>(
      `SELECT sv.at_device AS at, sv.number, sv.reason_code AS reason, u.full_name AS approved_by
       FROM erp.sales_voids sv JOIN erp.users u ON u.id = sv.approved_by_user_id
       WHERE (sv.sale_document_id = $1 OR sv.sale_number = $2) AND sv.duplicate_of_id IS NULL`,
      [bill.id, bill.number],
    )
  ).rows)
    add(v.at, 'voided', 'counter', { number: v.number, reason: v.reason, approvedBy: v.approved_by });

  for (const r of (
    await c.query<{ at: Date; number: string }>(
      'SELECT created_at_device AS at, number FROM erp.sales_documents WHERE reissue_of_number = $1 AND deleted_at IS NULL',
      [bill.number],
    )
  ).rows)
    add(r.at, 'reissued', 'counter', { number: r.number });

  for (const r of (
    await c.query<{ at: Date; number: string }>(
      `SELECT DISTINCT d.created_at_device AS at, d.number FROM erp.sales_lines l
       JOIN erp.sales_lines ol ON ol.id = l.original_line_id JOIN erp.sales_documents d ON d.id = l.document_id
       WHERE ol.document_id = $1 AND l.deleted_at IS NULL AND d.deleted_at IS NULL`,
      [bill.id],
    )
  ).rows)
    add(r.at, 'returned', 'counter', { number: r.number });

  // The counter's own log, when a manager sent it: its events that name this bill (a print that failed, a reprint).
  for (const e of (
    await c.query<{ at: string; kind: string }>(
      `SELECT DISTINCT ev->>'at' AS at, ev->>'kind' AS kind FROM erp.device_diagnostics dd,
         jsonb_array_elements(dd.events) ev
       WHERE dd.device_id = $1 AND position($2 IN (ev->'detail')::text) > 0`,
      [bill.device_id, bill.number],
    )
  ).rows) {
    // `bill.print_failed` → `print_failed`; a logged reprint is told apart from the reprint's approval.
    const step = e.kind.replace(/^[a-z]+\./, '');
    add(e.at, step === 'reprinted' ? 'reprinted_log' : step, 'diagnostics', { kind: e.kind });
  }

  steps.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    money: await moneyOf(c),
    bill: {
      id: bill.id,
      number: bill.number,
      kind: bill.kind,
      status: bill.status,
      businessDate: bill.business_date,
      total: Number(bill.total),
      deviceCode: bill.device_code,
      salespersonName: bill.seller,
      handoverStatus: bill.handover_status,
    },
    steps,
  };
}

export function registerSupport(scope: FastifyInstance, { pool, now, requireAuth, requireDevice }: Deps) {
  const ctx = (req: { auth?: { tenantId: string; userId: string } | null; id: string }) => ({
    tenantId: req.auth!.tenantId,
    userId: req.auth!.userId,
    requestId: req.id,
  });

  scope.get<{ Params: { number: string } }>(
    '/support/bills/:number',
    { preHandler: requirePermission(requireAuth, 'support.trace') },
    async (req, reply) => {
      const number = req.params.number.trim();
      if (number === '' || number.length > 40) return reply.code(404).send({ error: 'not_found' });
      const trace = await withTenant(pool, ctx(req), (_db, c) => traceOf(c, number));
      return trace ?? reply.code(404).send({ error: 'not_found' });
    },
  );

  // A manager sends the counter's log (owner answer 6): checked against the server's roles, as a manager unlock is.
  scope.post('/sync/diagnostics', { preHandler: requireDevice }, async (req, reply) => {
    const parsed = DiagnosticsUpload.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const d = req.device!;
    const b = parsed.data;
    const at = now();
    const outcome = await withTenant(
      pool,
      { tenantId: d.tenantId, deviceId: d.deviceId, requestId: req.id },
      async (_db, c) => {
        const user = (
          await c.query<{ id: string }>(
            "SELECT id FROM erp.users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL",
            [b.sentByUserId],
          )
        ).rows[0];
        if (!user || !can(await loadGrants(c, user.id), 'admin.devices', d.branchId)) return null;
        const id = (
          await c.query<{ id: string }>(
            `INSERT INTO erp.device_diagnostics (tenant_id, device_id, sent_by_user_id, at_device, received_at, health,
               events, event_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              d.tenantId,
              d.deviceId,
              user.id,
              b.atDevice,
              at,
              JSON.stringify(b.health),
              JSON.stringify(b.events),
              b.events.length,
            ],
          )
        ).rows[0]!.id;
        await c.query(
          `INSERT INTO erp.audit_log (tenant_id, at, user_id, device_id, request_id, action, entity, entity_id, after)
           VALUES ($1, $2, $3, $4, $5, 'diagnostics.sent', 'device_diagnostics', $6, $7)`,
          [d.tenantId, at, user.id, d.deviceId, req.id, id, JSON.stringify({ events: b.events.length })],
        );
        return id;
      },
    );
    if (outcome === null) return reply.code(403).send({ error: 'not_permitted' });
    return reply.code(201).send({ id: outcome });
  });

  // The device's page: its last diagnostics (30 days), and one of them in full to download.
  const devices = requirePermission(requireAuth, 'admin.devices');
  scope.get<{ Params: { id: string } }>(
    '/devices/:id/diagnostics',
    { preHandler: devices },
    async (req, reply) => {
      if (!UUID.test(req.params.id)) return reply.code(404).send({ error: 'not_found' });
      const rows = await withTenant(
        pool,
        ctx(req),
        async (_db, c) =>
          (
            await c.query<{
              id: string;
              received_at: Date;
              at_device: Date;
              sent_by: string;
              event_count: number;
            }>(
              `SELECT dd.id, dd.received_at, dd.at_device, u.full_name AS sent_by, dd.event_count
             FROM erp.device_diagnostics dd JOIN erp.users u ON u.id = dd.sent_by_user_id
             WHERE dd.device_id = $1 ORDER BY dd.received_at DESC`,
              [req.params.id],
            )
          ).rows,
      );
      const diagnostics: DiagnosticsRow[] = rows.map((r) => ({
        id: r.id,
        receivedAt: r.received_at.toISOString(),
        atDevice: r.at_device.toISOString(),
        sentByName: r.sent_by,
        eventCount: r.event_count,
      }));
      return { diagnostics };
    },
  );

  scope.get<{ Params: { id: string; diagnosticsId: string } }>(
    '/devices/:id/diagnostics/:diagnosticsId',
    { preHandler: devices },
    async (req, reply) => {
      if (!UUID.test(req.params.id) || !UUID.test(req.params.diagnosticsId))
        return reply.code(404).send({ error: 'not_found' });
      const row = await withTenant(
        pool,
        ctx(req),
        async (_db, c) =>
          (
            await c.query<{ received_at: Date; at_device: Date; health: unknown; events: unknown }>(
              `SELECT received_at, at_device, health, events FROM erp.device_diagnostics
               WHERE id = $1 AND device_id = $2`,
              [req.params.diagnosticsId, req.params.id],
            )
          ).rows[0],
      );
      if (!row) return reply.code(404).send({ error: 'not_found' });
      return {
        receivedAt: row.received_at.toISOString(),
        atDevice: row.at_device.toISOString(),
        health: row.health,
        events: row.events,
      };
    },
  );
}
