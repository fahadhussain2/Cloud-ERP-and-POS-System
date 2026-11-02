import type { CashVarianceResponse, CashVarianceRow, DayReconciliationResponse } from '@erp/contracts';
import { withTenant } from '@erp/db';
import { money, reconcileDay, type CashMovementKind, type DayInput, type DaySession } from '@erp/domain';
import type { FastifyInstance, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requirePermission } from '../auth/routes';

// The cash reports (CSH-08, RPT-02, cash desk spec, W1-11): the day reconciliation of one branch and business date,
// computed on request from what the server holds (reconcileDay in @erp/domain), the cash variance by session over a
// date range, both also as CSV; and a manager's later acknowledgement of a variance (owner answer 1), audited.

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toMoney = (v: string | number) => money(String(v));
const iso = (t: Date | null) => t?.toISOString() ?? null;

/** RFC 4180: quote a field that holds a comma, quote or line break. */
type Cell = string | number | null;
const csvField = (v: Cell) => {
  const s = v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header: string[], rows: Cell[][]) =>
  [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';

function sendCsv(reply: FastifyReply, name: string, body: string) {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name}"`)
    .send(body);
}

/** Everything the day's reconciliation is made from, read in one tenant transaction. */
async function dayInput(
  c: pg.ClientBase,
  branchId: string,
  date: string,
  now: Date,
): Promise<DayInput | null> {
  const t = (
    await c.query<{ mode: 'required' | 'off'; ends_at: Date; branch: number }>(
      `SELECT cash_handover_mode AS mode,
         ((($1::date + 1)::timestamp + make_interval(hours => day_cutoff_hour)) AT TIME ZONE timezone) AS ends_at,
         (SELECT count(*)::int FROM erp.branches WHERE id = $2) AS branch
       FROM erp.tenants`,
      [date, branchId],
    )
  ).rows[0];
  if (!t || t.branch !== 1) return null;

  const devices = await c.query<{
    code: string;
    last_contact_at: Date | null;
    oldest_unsynced_at: Date | null;
  }>(
    `SELECT d.code, greatest(s.last_push_at, s.last_pull_at) AS last_contact_at, s.oldest_unsynced_at
     FROM erp.devices d LEFT JOIN erp.device_status s ON s.tenant_id = d.tenant_id AND s.device_id = d.id
     WHERE d.branch_id = $1 AND d.status = 'active' AND d.deleted_at IS NULL`,
    [branchId],
  );
  const gaps = await c.query<{ device_code: string; family: string; from_seq: number; to_seq: number }>(
    `SELECT d.code AS device_code, g.family, g.from_seq::int, g.to_seq::int
     FROM erp.sequence_gaps g JOIN erp.devices d ON d.id = g.device_id
     WHERE d.branch_id = $1 AND d.status = 'active' AND g.resolved_at IS NULL`,
    [branchId],
  );
  const sessions = await c.query<{
    id: string;
    number: string;
    device_code: string;
    cashier_name: string;
    status: 'open' | 'closed';
    opening_float: string;
    expected_cash: string | null;
    counted_cash: string | null;
    variance: string | null;
    variance_reason_code: string | null;
    acknowledged_by_name: string | null;
  }>(
    `SELECT s.id, s.number, d.code AS device_code, u.full_name AS cashier_name, s.status, s.opening_float,
       s.expected_cash, s.counted_cash, s.variance, s.variance_reason_code, a.full_name AS acknowledged_by_name
     FROM erp.cash_sessions s JOIN erp.devices d ON d.id = s.device_id JOIN erp.users u ON u.id = s.cashier_user_id
     LEFT JOIN erp.users a ON a.id = s.acknowledged_by_user_id
     WHERE s.branch_id = $1 AND s.business_date = $2`,
    [branchId, date],
  );
  const ids = sessions.rows.map((s) => s.id);
  const handovers = await c.query<{ session_id: string; kind: 'in' | 'payout'; amount: string }>(
    `SELECT session_id, kind, amount FROM erp.cash_handovers
     WHERE session_id = ANY ($1) AND duplicate_of_id IS NULL ORDER BY number`,
    [ids],
  );
  const collections = await c.query<{ session_id: string; cash: boolean; amount: string }>(
    `SELECT p.session_id, m.is_cash AS cash, p.amount FROM erp.payments p
     JOIN erp.payment_methods m ON m.id = p.method_id WHERE p.session_id = ANY ($1) ORDER BY p.number`,
    [ids],
  );
  const movements = await c.query<{ session_id: string; kind: CashMovementKind; amount: string }>(
    'SELECT session_id, kind, amount FROM erp.cash_movements WHERE session_id = ANY ($1) ORDER BY number',
    [ids],
  );
  const of = <T extends { session_id: string }>(rows: T[], id: string) =>
    rows.filter((r) => r.session_id === id);
  const daySessions: DaySession[] = sessions.rows.map((s) => ({
    id: s.id,
    number: s.number,
    deviceCode: s.device_code,
    cashierName: s.cashier_name,
    status: s.status,
    openingFloat: toMoney(s.opening_float),
    deskExpected: s.expected_cash === null ? null : toMoney(s.expected_cash),
    countedCash: s.counted_cash === null ? null : toMoney(s.counted_cash),
    variance: s.variance === null ? null : toMoney(s.variance),
    varianceReason: s.variance_reason_code,
    acknowledgedByName: s.acknowledged_by_name,
    handovers: of(handovers.rows, s.id).map((h) => ({ kind: h.kind, amount: toMoney(h.amount) })),
    collections: of(collections.rows, s.id).map((r) => ({ cash: r.cash, amount: toMoney(r.amount) })),
    movements: of(movements.rows, s.id).map((m) => ({ kind: m.kind, amount: toMoney(m.amount) })),
  }));

  // Finalized, not voided bills of the day with cash still to reach the desk (PRD W10.2).
  const pending = await c.query<{
    number: string;
    seller_id: string;
    seller_name: string | null;
    created_at: Date;
    cash_due: string;
  }>(
    `SELECT b.number, b.salesperson_user_id AS seller_id, u.full_name AS seller_name,
       b.created_at_device AS created_at, b.cash_due
     FROM erp.sales_documents b LEFT JOIN erp.users u ON u.id = b.salesperson_user_id
     WHERE b.branch_id = $1 AND b.business_date = $2 AND b.status = 'finalized' AND b.cash_due <> 0
       AND b.handover_status = 'pending'`,
    [branchId, date],
  );
  const unmatched = await c.query<{
    number: string;
    bill_number: string;
    kind: 'in' | 'payout';
    amount: string;
    at_device: Date;
  }>(
    `SELECT number, bill_number, kind, amount, at_device FROM erp.cash_handovers
     WHERE branch_id = $1 AND business_date = $2 AND sales_document_id IS NULL AND duplicate_of_id IS NULL`,
    [branchId, date],
  );
  const exceptions = await c.query<{ kind: string; severity: 'low' | 'medium' | 'high'; count: number }>(
    `SELECT e.kind, e.severity, count(*)::int AS count FROM erp.exceptions e
     JOIN erp.devices d ON d.id = e.device_id
     WHERE d.branch_id = $1 AND e.business_date = $2 AND e.status = 'open' GROUP BY e.kind, e.severity`,
    [branchId, date],
  );
  const transit = await c.query<{ balance: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0) AS balance
     FROM erp.journal_lines l JOIN erp.journal_entries e ON e.id = l.entry_id
     JOIN erp.accounts a ON a.id = l.account_id
     WHERE a.system_role = 'CASH_IN_TRANSIT' AND l.branch_id = $1 AND e.entry_date <= $2`,
    [branchId, date],
  );

  return {
    businessDate: date,
    dayEndsAt: t.ends_at.toISOString(),
    now: now.toISOString(),
    handoverMode: t.mode,
    devices: devices.rows.map((d) => ({
      code: d.code,
      lastContactAt: iso(d.last_contact_at),
      oldestUnsyncedAt: iso(d.oldest_unsynced_at),
    })),
    gaps: gaps.rows.map((g) => ({
      deviceCode: g.device_code,
      family: g.family,
      fromSeq: g.from_seq,
      toSeq: g.to_seq,
    })),
    sessions: daySessions,
    pendingBills: pending.rows.map((b) => ({
      number: b.number,
      sellerId: b.seller_id,
      sellerName: b.seller_name,
      createdAt: b.created_at.toISOString(),
      cashDue: toMoney(b.cash_due),
    })),
    unmatched: unmatched.rows.map((h) => ({
      number: h.number,
      billNumber: h.bill_number,
      kind: h.kind,
      amount: toMoney(h.amount),
      createdAt: h.at_device.toISOString(),
    })),
    exceptions: exceptions.rows,
    cashInTransit: toMoney(transit.rows[0]!.balance),
  };
}

function dayCsv(r: DayReconciliationResponse): string {
  const rows: Cell[][] = [];
  rows.push(['status', r.status, '', '', '', r.holds.map((h) => h.kind).join(' ')]);
  for (const s of r.sessions)
    rows.push([
      'session',
      s.number,
      s.deviceCode,
      s.cashierName,
      s.variance,
      `expected ${s.expected}; counted ${s.counted ?? ''}; ${s.varianceReason ?? ''}; ${s.acknowledgement}`,
    ]);
  for (const g of r.missingHandovers ?? [])
    for (const b of g.bills)
      rows.push([
        'missing_handover',
        b.number,
        '',
        g.sellerName ?? g.sellerId,
        b.kind === 'in' ? b.amount : -b.amount,
        '',
      ]);
  for (const h of r.unmatchedScans)
    rows.push(['unmatched_scan', h.number, '', h.billNumber, h.amount, h.kind]);
  for (const e of r.exceptions) rows.push(['exception', e.kind, '', '', e.count, e.severity]);
  rows.push(['cash_in_transit', '', '', '', r.cashInTransit, '']);
  return csv(['section', 'number', 'device', 'person', 'amount', 'detail'], rows);
}

export function registerReports(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  const ctx = (req: { auth?: { tenantId: string; userId: string } | null; id: string }) => ({
    tenantId: req.auth!.tenantId,
    userId: req.auth!.userId,
    requestId: req.id,
  });

  scope.get<{ Querystring: { branchId?: string; date?: string; format?: string } }>(
    '/reports/day-reconciliation',
    { preHandler: requirePermission(requireAuth, 'reports.view') },
    async (req, reply) => {
      const { branchId, date, format } = req.query;
      if (!branchId || !UUID.test(branchId) || !date || !DATE.test(date))
        return reply.code(400).send({ error: 'bad_request' });
      const input = await withTenant(pool, ctx(req), (_db, c) => dayInput(c, branchId, date, now()));
      if (input === null) return reply.code(404).send({ error: 'not_found' });
      const result: DayReconciliationResponse = { branchId, ...reconcileDay(input) };
      if (format === 'csv') return sendCsv(reply, `day-reconciliation-${date}.csv`, dayCsv(result));
      return result;
    },
  );

  scope.get<{ Querystring: { from?: string; to?: string; branchId?: string; format?: string } }>(
    '/reports/cash-variance',
    { preHandler: requirePermission(requireAuth, 'reports.view') },
    async (req, reply) => {
      const { from, to, branchId, format } = req.query;
      if (
        !from ||
        !DATE.test(from) ||
        !to ||
        !DATE.test(to) ||
        from > to ||
        (branchId && !UUID.test(branchId))
      )
        return reply.code(400).send({ error: 'bad_request' });
      const rows = await withTenant(
        pool,
        ctx(req),
        async (_db, c) =>
          (
            await c.query<{
              id: string;
              number: string;
              device_code: string;
              cashier_name: string;
              business_date: string;
              status: 'open' | 'closed';
              expected_cash: string | null;
              counted_cash: string | null;
              variance: string | null;
              variance_reason_code: string | null;
              variance_note: string | null;
              acknowledged_by_name: string | null;
            }>(
              `SELECT s.id, s.number, d.code AS device_code, u.full_name AS cashier_name, s.business_date::text,
               s.status, s.expected_cash, s.counted_cash, s.variance, s.variance_reason_code, s.variance_note,
               a.full_name AS acknowledged_by_name
             FROM erp.cash_sessions s JOIN erp.devices d ON d.id = s.device_id
             JOIN erp.users u ON u.id = s.cashier_user_id LEFT JOIN erp.users a ON a.id = s.acknowledged_by_user_id
             WHERE s.business_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR s.branch_id = $3)
             ORDER BY s.business_date, s.number`,
              [from, to, branchId ?? null],
            )
          ).rows,
      );
      const num = (v: string | null) => (v === null ? null : Number(v));
      const sessions: CashVarianceRow[] = rows.map((s) => ({
        sessionId: s.id,
        number: s.number,
        deviceCode: s.device_code,
        cashierName: s.cashier_name,
        businessDate: s.business_date,
        expected: num(s.expected_cash),
        counted: num(s.counted_cash),
        variance: num(s.variance),
        varianceReason: s.variance_reason_code,
        varianceNote: s.variance_note,
        acknowledgement:
          s.status === 'open'
            ? 'open'
            : s.counted_cash === null
              ? 'not_counted'
              : Number(s.variance) === 0
                ? 'exact'
                : s.acknowledged_by_name === null
                  ? 'waiting'
                  : 'acknowledged',
        acknowledgedByName: s.acknowledged_by_name,
      }));
      const totals = new Map<string, { sessions: number; variance: number }>();
      for (const s of sessions)
        if (s.variance !== null) {
          const t = totals.get(s.cashierName) ?? { sessions: 0, variance: 0 };
          totals.set(s.cashierName, { sessions: t.sessions + 1, variance: t.variance + s.variance });
        }
      const result: CashVarianceResponse = {
        from,
        to,
        sessions,
        byCashier: [...totals]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([cashierName, t]) => ({ cashierName, ...t })),
      };
      if (format === 'csv')
        return sendCsv(
          reply,
          `cash-variance-${from}-${to}.csv`,
          csv(
            [
              'business_date',
              'session',
              'desk',
              'cashier',
              'expected',
              'counted',
              'variance',
              'reason',
              'note',
              'acknowledgement',
              'acknowledged_by',
            ],
            sessions.map((s) => [
              s.businessDate,
              s.number,
              s.deviceCode,
              s.cashierName,
              s.expected,
              s.counted,
              s.variance,
              s.varianceReason,
              s.varianceNote,
              s.acknowledgement,
              s.acknowledgedByName,
            ]),
          ),
        );
      return result;
    },
  );

  // A manager acknowledges a variance after the close (owner answer 1): never their own session's, never twice.
  scope.post<{ Params: { id: string } }>(
    '/reports/cash-sessions/:id/acknowledge',
    { preHandler: requirePermission(requireAuth, 'cash.variance.approve') },
    async (req, reply) => {
      const { id } = req.params;
      if (!UUID.test(id)) return reply.code(404).send({ error: 'not_found' });
      const at = now();
      const outcome = await withTenant(pool, ctx(req), async (_db, c) => {
        const row = (
          await c.query<{
            cashier_user_id: string;
            status: string;
            variance: string | null;
            acknowledged_by_user_id: string | null;
          }>(
            `SELECT cashier_user_id, status, variance, acknowledged_by_user_id FROM erp.cash_sessions
             WHERE id = $1 FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (!row) return { code: 404, body: { error: 'not_found' } };
        if (row.status !== 'closed' || row.variance === null || Number(row.variance) === 0)
          return { code: 409, body: { error: 'nothing_to_acknowledge' } };
        if (row.acknowledged_by_user_id !== null)
          return { code: 409, body: { error: 'already_acknowledged' } };
        if (row.cashier_user_id === req.auth!.userId) return { code: 403, body: { error: 'own_variance' } };
        await c.query(
          'UPDATE erp.cash_sessions SET acknowledged_by_user_id = $2, acknowledged_at = $3 WHERE id = $1',
          [id, req.auth!.userId, at],
        );
        await c.query(
          `INSERT INTO erp.audit_log (tenant_id, at, user_id, request_id, action, entity, entity_id, after, ip)
           VALUES ($1, $2, $3, $4, 'cash.variance.acknowledged', 'cash_sessions', $5, $6, $7)`,
          [
            req.auth!.tenantId,
            at,
            req.auth!.userId,
            req.id,
            id,
            JSON.stringify({ variance: Number(row.variance) }),
            req.ip,
          ],
        );
        return { code: 200, body: { id, acknowledgedAt: at.toISOString() } };
      });
      return reply.code(outcome.code).send(outcome.body);
    },
  );
}
