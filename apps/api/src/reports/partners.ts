import {
  ACTIVITY_KIND_VIEWS,
  OVERDUE_DAYS,
  PARTY_ROLES,
  REGISTER_SIDES,
  type ActivityKindView,
  type ActivityRow,
  type BalanceTrendView,
  type CashFlowView,
  type CollectionsView,
  type LedgerLineView,
  type OverdueRow,
  type OverdueView,
  type OverLimitView,
  type PartnerLedgerBody,
  type PartnerLedgerView,
  type PartyRoleView,
  type PartyView,
  type MoneyRegisterRow,
  type RegisterSide,
  type MoneyRegisterTotal,
  type ShopHeaderView,
  type StatementItemView,
  type StatementsView,
  type UserActivityView,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import {
  activityKind,
  ageBalances,
  can,
  cashFlowOf,
  cashFlowStatement,
  changedFields,
  DomainError,
  limitState,
  monthsOf,
  overdueOf,
  partnerLedger,
  trendDates,
  withoutVoidedBills,
  type AccountType,
  type CashFlowPart,
  type Period,
  type Permission,
} from '@erp/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requirePermission } from '../auth/routes';
import { BadRequest, dateOr, LIST_DAYS, rangeOf, shop, SUMMARY_DAYS } from './financial';
import { csv, moneyOf, sendCsv, type Cell } from './routes';

// The customer, supplier and control reports and the cash flow (W2-04 plan; RPT-16, RPT-17, ACC-07; D-110, D-116):
// read only, computed on request inside withTenant under the app role (rule 5); the rules in @erp/domain's
// partner-reports.ts. The ledger, the statements, the balance trend, overdue, over the limit and the register need
// reports.view, and their supplier side cost.view too (a supplier's amounts are purchase amounts, as W2-03); the cash
// flow needs reports.financial, user activity admin.users (owner answer 6). Every report downloads as CSV.

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

type Client = pg.ClientBase;
type Query = Record<string, string | undefined>;
type Shop = { today: string; startMonth: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** User activity rows shown on screen, newest first; the CSV has every one (owner answer 6). */
const ACTIVITY_PAGE = 2000;
const num = (v: string | number | null) => Number(v ?? 0);
const NAMES = new Intl.Collator('en', { sensitivity: 'base' });

function choiceOf<T extends string>(q: Query, key: string, choices: readonly T[], fallback?: T): T {
  const v = q[key] || fallback;
  if (v === undefined || !(choices as readonly string[]).includes(v)) throw new BadRequest('bad_request');
  return v as T;
}

const idOf = (q: Query, key: string) => {
  const v = q[key] || null;
  if (v !== null && !UUID.test(v)) throw new BadRequest('bad_request');
  return v;
};

/** The shop's header on a statement: as on its bills (W1-25). */
async function headerOf(c: Client): Promise<ShopHeaderView> {
  const r = (
    await c.query<{
      name: string;
      address: string | null;
      phone: string | null;
      header: { lines?: unknown };
    }>(
      `SELECT t.name, b.address, b.phone, b.receipt_header AS header FROM erp.tenants t
       JOIN erp.branches b ON b.tenant_id = t.id AND b.deleted_at IS NULL ORDER BY b.code LIMIT 1`,
    )
  ).rows[0]!;
  const lines = Array.isArray(r.header?.lines) ? r.header.lines.filter((l) => typeof l === 'string') : [];
  return { name: r.name, address: r.address ?? '', phone: r.phone ?? '', lines };
}

/** The parties with their terms and (customers') limit. */
async function partiesOf(c: Client, role: PartyRoleView, ids: string[]): Promise<Map<string, PartyView>> {
  const { rows } = await c.query<{
    id: string;
    code: string;
    name: string;
    address: string | null;
    city: string | null;
    phones: string[];
    terms: number | null;
    limit: string | null;
  }>(
    role === 'customer'
      ? `SELECT p.id, p.code, p.name, p.address, p.city, p.phones, a.payment_terms_days AS terms,
           a.credit_limit::text AS limit
         FROM erp.parties p LEFT JOIN erp.customer_accounts a ON a.party_id = p.id AND a.deleted_at IS NULL
         WHERE p.id = ANY ($1)`
      : `SELECT p.id, p.code, p.name, p.address, p.city, p.phones, a.payment_terms_days AS terms, NULL AS limit
         FROM erp.parties p LEFT JOIN erp.supplier_accounts a ON a.party_id = p.id AND a.deleted_at IS NULL
         WHERE p.id = ANY ($1)`,
    [ids],
  );
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        code: r.code,
        name: r.name,
        address: r.address,
        city: r.city,
        phones: r.phones,
        termsDays: r.terms,
        limit: r.limit === null ? null : num(r.limit),
      },
    ]),
  );
}

interface EntryRow {
  party_id: string;
  entry_date: string;
  due_date: string;
  source_type: string;
  source_id: string;
  amount: string;
  number: string;
  memo: string | null;
  void_of: string | null;
  voided: boolean;
}

/**
 * Every sub-ledger entry of the role up to `to` (for `parties`, or all), in date and posting order, with its document's
 * number, the bill a void voids, and whether a bill was voided.
 */
async function entriesOf(c: Client, role: PartyRoleView, parties: string[] | null, to: string) {
  const { rows } = await c.query<EntryRow>(
    `SELECT e.party_id, e.entry_date::text, e.due_date::text, e.source_type, e.source_id, e.amount::text, e.memo,
       coalesce(s.number, v.number, pm.number, cr.number, jv.number, g.number, pr.number, sp.number, m.number,
         o.label, e.source_type) AS number,
       v.sale_document_id AS void_of,
       (e.source_type = 'sales_void'
         OR EXISTS (SELECT 1 FROM erp.sales_voids x WHERE e.source_type = 'sale' AND x.sale_document_id = e.source_id))
         AS voided
     FROM erp.party_ledger_entries e
     LEFT JOIN erp.sales_documents s ON e.source_type = 'sale' AND s.id = e.source_id
     LEFT JOIN erp.sales_voids v ON e.source_type = 'sales_void' AND v.id = e.source_id
     LEFT JOIN erp.payments pm ON e.source_type = 'payment' AND pm.id = e.source_id
     LEFT JOIN erp.customer_receipts cr ON e.source_type = 'customer_receipt' AND cr.id = e.source_id
     LEFT JOIN erp.journal_vouchers jv ON e.source_type = 'journal_voucher' AND jv.id = e.source_id
     LEFT JOIN erp.goods_receipts g ON e.source_type = 'goods_receipt' AND g.id = e.source_id
     LEFT JOIN erp.purchase_returns pr ON e.source_type = 'purchase_return' AND pr.id = e.source_id
     LEFT JOIN erp.supplier_payments sp ON e.source_type = 'supplier_payment' AND sp.id = e.source_id
     LEFT JOIN erp.cash_movements m ON e.source_type = 'cash_movement' AND m.id = e.source_id
     LEFT JOIN erp.opening_balances o ON e.source_type = 'opening' AND o.id = e.source_id
     WHERE e.role = $1 AND ($2::uuid[] IS NULL OR e.party_id = ANY ($2)) AND e.entry_date <= $3
     ORDER BY e.party_id, e.entry_date, e.posting_seq, e.id`,
    [role, parties, to],
  );
  return rows;
}

/** The lines of the bills and goods receipts among `ids`, for a statement "with items". */
async function itemsOf(c: Client, ids: string[]): Promise<Map<string, StatementItemView[]>> {
  const { rows } = await c.query<{
    doc: string;
    code: string;
    name: string;
    qty: string;
    price: string;
    total: string;
  }>(
    `SELECT l.document_id AS doc, i.code, i.name, (l.qty * 1000)::bigint::text AS qty, l.unit_price::text AS price,
       l.line_total::text AS total, l.line_no
     FROM erp.sales_lines l JOIN erp.items i ON i.id = l.item_id
     WHERE l.document_id = ANY ($1) AND l.deleted_at IS NULL
     UNION ALL
     SELECT l.receipt_id, coalesce(i.code, ''), coalesce(i.name, ''), (l.qty * 1000)::bigint::text, l.unit_cost::text,
       coalesce(l.value, 0)::text, l.line_no
     FROM erp.goods_receipt_lines l LEFT JOIN erp.items i ON i.id = l.item_id
     WHERE l.receipt_id = ANY ($1)
     ORDER BY 1, 7`,
    [ids],
  );
  const out = new Map<string, StatementItemView[]>();
  for (const r of rows)
    out.set(r.doc, [
      ...(out.get(r.doc) ?? []),
      { code: r.code, name: r.name, qty: num(r.qty), price: num(r.price), total: num(r.total) },
    ]);
  return out;
}

/** One party's ledger over the period from its entries up to `to` (owner answers 1 and 2). */
function ledgerBody(
  party: PartyView,
  role: PartyRoleView,
  p: Period,
  rows: readonly EntryRow[],
  statement: boolean,
  items: Map<string, StatementItemView[]> | null,
): PartnerLedgerBody {
  const opening = rows.filter((r) => r.entry_date < p.from).reduce((s, r) => s + num(r.amount), 0);
  const inRange = rows
    .filter((r) => r.entry_date >= p.from)
    .map((r) => ({
      kind: r.source_type,
      amount: num(r.amount),
      sourceId: r.source_id,
      voidOf: r.void_of,
      row: r,
    }));
  const ledger = partnerLedger({
    role,
    opening,
    entries: statement ? withoutVoidedBills(inRange) : inRange,
  });
  const aged = ageBalances({
    asOf: p.to,
    entries: rows.map((r) => ({
      partyId: party.id,
      entryDate: r.entry_date,
      dueDate: r.due_date,
      amount: num(r.amount),
    })),
  });
  return {
    party,
    opening: ledger.opening,
    lines: ledger.lines.map((l): LedgerLineView => ({
      date: l.row.entry_date,
      dueDate: l.row.due_date,
      kind: l.kind,
      sourceId: l.sourceId,
      number: l.row.number,
      memo: l.row.memo,
      debit: l.debit,
      credit: l.credit,
      balance: l.balance,
      voided: l.row.voided,
      ...(items ? { items: items.get(l.sourceId) ?? [] } : {}),
    })),
    byKind: ledger.byKind,
    debit: ledger.debit,
    credit: ledger.credit,
    closing: ledger.closing,
    ageing: {
      balance: aged.totals.balance,
      notDue: aged.totals.notDue,
      days1to30: aged.totals.days1to30,
      days31to60: aged.totals.days31to60,
      days61to90: aged.totals.days61to90,
      over90: aged.totals.over90,
    },
  };
}

function ledgerCsv(role: PartyRoleView, bodies: PartnerLedgerBody[]): string {
  const rows: Cell[][] = [];
  for (const b of bodies) {
    rows.push([b.party.code, b.party.name, '', 'opening', '', '', '', '', b.opening]);
    for (const l of b.lines)
      rows.push([b.party.code, b.party.name, l.date, l.kind, l.number, l.memo, l.debit, l.credit, l.balance]);
    rows.push([b.party.code, b.party.name, '', 'closing', '', '', b.debit, b.credit, b.closing]);
  }
  return csv([role, 'name', 'date', 'kind', 'number', 'memo', 'debit', 'credit', 'balance'], rows);
}

/** The cash and bank accounts, as the cash book (W2-01): the drawer, in transit, the safe, every bank's account. */
async function cashAccounts(c: Client): Promise<string[]> {
  return (
    await c.query<{ id: string }>(
      `SELECT a.id FROM erp.accounts a
       WHERE a.system_role IN ('CASH_DRAWER', 'CASH_IN_TRANSIT', 'CASH_SAFE')
         OR EXISTS (SELECT 1 FROM erp.bank_accounts b WHERE b.gl_account_id = a.id)`,
    )
  ).rows.map((r) => r.id);
}

/** The control account's balance (AR: debit − credit, AP: credit − debit) at each date. */
async function controlAt(c: Client, role: PartyRoleView, dates: string[]): Promise<number[]> {
  const { rows } = await c.query<{ b: string[] }>(
    `SELECT array_agg(coalesce((
       SELECT sum(${role === 'customer' ? 'l.debit - l.credit' : 'l.credit - l.debit'})
       FROM erp.journal_lines l JOIN erp.journal_entries e ON e.id = l.entry_id
       JOIN erp.accounts a ON a.id = l.account_id
       WHERE a.system_role = $1 AND e.entry_date <= d), 0)::text ORDER BY n) AS b
     FROM unnest($2::date[]) WITH ORDINALITY AS x (d, n)`,
    [role === 'customer' ? 'AR_CONTROL' : 'AP_CONTROL', dates],
  );
  return rows[0]!.b.map(num);
}

export function registerPartnerReports(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  const view = requirePermission(requireAuth, 'reports.view');
  const financial = requirePermission(requireAuth, 'reports.financial');
  const owner = requirePermission(requireAuth, 'admin.users');
  const query = (req: FastifyRequest) => req.query as Query;
  const wantsCsv = (req: FastifyRequest) => query(req)['format'] === 'csv';
  const allowed = (req: FastifyRequest, p: Permission) => can(req.auth!.grants, p, null);

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
      if (err instanceof Forbidden) return reply.code(403).send({ error: 'forbidden' });
      throw err;
    }
  };

  /** A supplier's figures are purchase amounts: cost.view too (as W2-03). */
  const roleOf = (req: FastifyRequest): PartyRoleView => {
    const role = choiceOf(query(req), 'role', PARTY_ROLES, 'customer');
    if (role === 'supplier' && !allowed(req, 'cost.view')) throw new Forbidden();
    return role;
  };

  // ---- The partner ledger and the statement (RPT-16, owner answers 1 and 2) ----
  scope.get('/reports/partner-ledger', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s): Promise<PartnerLedgerView | FastifyReply> => {
      const q = query(req);
      const role = roleOf(req);
      const partyId = idOf(q, 'partyId');
      if (partyId === null) throw new BadRequest('bad_request');
      const p = rangeOf(q, { from: `${s.today.slice(0, 8)}01`, to: s.today }, SUMMARY_DAYS, s);
      const statement = q['statement'] === '1';
      const party = (await partiesOf(c, role, [partyId])).get(partyId);
      if (!party) throw new BadRequest('not_found');
      const rows = await entriesOf(c, role, [partyId], p.to);
      const items =
        q['items'] === '1'
          ? await itemsOf(
              c,
              rows.filter((r) => r.entry_date >= p.from).map((r) => r.source_id),
            )
          : null;
      const body = ledgerBody(party, role, p, rows, statement, items);
      const result: PartnerLedgerView = {
        money: await moneyOf(c),
        role,
        from: p.from,
        to: p.to,
        statement,
        header: await headerOf(c),
        ...body,
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(reply, `ledger-${party.code}-${p.from}-${p.to}.csv`, ledgerCsv(role, [body]));
    }),
  );

  // ---- Statements for every customer with a balance or a document (owner answer 2) ----
  scope.get('/reports/statements', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s): Promise<StatementsView | FastifyReply> => {
      const q = query(req);
      const p = rangeOf(q, { from: `${s.today.slice(0, 8)}01`, to: s.today }, SUMMARY_DAYS, s);
      const rows = await entriesOf(c, 'customer', null, p.to);
      const byParty = new Map<string, EntryRow[]>();
      for (const r of rows) byParty.set(r.party_id, [...(byParty.get(r.party_id) ?? []), r]);
      const kept = [...byParty.entries()].filter(
        ([, es]) => es.some((e) => e.entry_date >= p.from) || es.reduce((t, e) => t + num(e.amount), 0) !== 0,
      );
      const parties = await partiesOf(
        c,
        'customer',
        kept.map(([id]) => id),
      );
      const items =
        q['items'] === '1'
          ? await itemsOf(
              c,
              rows.filter((r) => r.entry_date >= p.from).map((r) => r.source_id),
            )
          : null;
      const statements = kept
        .map(([id, es]) => ledgerBody(parties.get(id)!, 'customer', p, es, true, items))
        .sort(
          (a, b) => NAMES.compare(a.party.name, b.party.name) || NAMES.compare(a.party.code, b.party.code),
        );
      const result: StatementsView = {
        money: await moneyOf(c),
        from: p.from,
        to: p.to,
        header: await headerOf(c),
        statements,
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(reply, `statements-${p.from}-${p.to}.csv`, ledgerCsv('customer', statements));
    }),
  );

  // ---- The balance trend (RPT-16, owner answer 3) ----
  scope.get('/reports/balance-trend', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s): Promise<BalanceTrendView | FastifyReply> => {
      const q = query(req);
      const role = roleOf(req);
      const asOf = dateOr(q['asOf'], s.today);
      const dates = trendDates(asOf);
      const since =
        (await c.query<{ d: string | null }>('SELECT min(entry_date)::text AS d FROM erp.journal_entries'))
          .rows[0]!.d ?? null;
      const before = (d: string) => since === null || d < since;
      const { rows } = await c.query<{ party_id: string; b: string[] }>(
        `SELECT e.party_id,
           array_agg(coalesce((SELECT sum(x.amount) FROM erp.party_ledger_entries x
             WHERE x.party_id = e.party_id AND x.role = $1 AND x.entry_date <= d), 0)::text ORDER BY n) AS b
         FROM (SELECT DISTINCT party_id FROM erp.party_ledger_entries WHERE role = $1 AND entry_date <= $3) e
         CROSS JOIN unnest($2::date[]) WITH ORDINALITY AS t (d, n)
         GROUP BY e.party_id`,
        [role, dates, asOf],
      );
      const kept = rows.filter((r) => r.b.some((b) => num(b) !== 0));
      const parties = await partiesOf(
        c,
        role,
        kept.map((r) => r.party_id),
      );
      const control = await controlAt(c, role, dates);
      const result: BalanceTrendView = {
        money: await moneyOf(c),
        role,
        asOf,
        dates,
        since,
        rows: kept
          .map((r) => {
            const p = parties.get(r.party_id)!;
            const balances = r.b.map((b, i) => (before(dates[i]!) ? null : num(b)));
            return {
              partyId: r.party_id,
              code: p.code,
              name: p.name,
              balances,
              change: balances[0] === null || balances[2] === null ? null : balances[0]! - balances[2]!,
            };
          })
          .sort((a, b) => NAMES.compare(a.name, b.name) || NAMES.compare(a.code, b.code)),
        totals: dates.map((d, i) => (before(d) ? null : kept.reduce((t, r) => t + num(r.b[i] ?? '0'), 0))),
        control: dates.map((d, i) => (before(d) ? null : control[i]!)),
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `balance-trend-${role}-${asOf}.csv`,
        csv(
          [role, 'name', ...dates, 'change'],
          [
            ...result.rows.map((r): Cell[] => [r.code, r.name, ...r.balances, r.change]),
            ['', 'total', ...result.totals, null],
          ],
        ),
      );
    }),
  );

  // ---- Overdue customers (RPT-17, owner answer 4) ----
  scope.get('/reports/overdue', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s): Promise<OverdueView | FastifyReply> => {
      const q = query(req);
      const asOf = dateOr(q['asOf'], s.today);
      const days = Number(q['days'] ?? 30);
      if (!(OVERDUE_DAYS as readonly number[]).includes(days)) throw new BadRequest('bad_request');
      const rows = await entriesOf(c, 'customer', null, asOf);
      const byParty = new Map<string, EntryRow[]>();
      for (const r of rows) byParty.set(r.party_id, [...(byParty.get(r.party_id) ?? []), r]);
      const late = [...byParty.entries()]
        .map(([id, es]) => {
          const o = overdueOf({
            asOf,
            days,
            entries: es.map((e) => ({ entryDate: e.entry_date, dueDate: e.due_date, amount: num(e.amount) })),
          });
          const paid = es.filter((e) => ['payment', 'customer_receipt'].includes(e.source_type)).at(-1);
          return {
            id,
            o,
            lastPayment: paid ? { date: paid.entry_date, amount: -num(paid.amount) } : null,
          };
        })
        .filter((x) => x.o.overdue > 0);
      const parties = await partiesOf(
        c,
        'customer',
        late.map((x) => x.id),
      );
      const out = late
        .map((x): OverdueRow => {
          const p = parties.get(x.id)!;
          return {
            partyId: x.id,
            code: p.code,
            name: p.name,
            phones: p.phones,
            balance: x.o.balance,
            overdue: x.o.overdue,
            oldestDate: x.o.oldestDate,
            oldestLate: x.o.oldestLate,
            lastPayment: x.lastPayment,
            limit: p.limit,
            termsDays: p.termsDays,
          };
        })
        .sort((a, b) => b.overdue - a.overdue || NAMES.compare(a.name, b.name));
      const result: OverdueView = {
        money: await moneyOf(c),
        asOf,
        days,
        rows: out,
        totals: {
          balance: out.reduce((t, r) => t + r.balance, 0),
          overdue: out.reduce((t, r) => t + r.overdue, 0),
        },
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `overdue-${days}-${asOf}.csv`,
        csv(
          [
            'customer',
            'name',
            'phone',
            'balance',
            'overdue',
            'oldest_bill',
            'days_late',
            'last_payment',
            'last_payment_amount',
            'limit',
            'terms_days',
          ],
          out.map((r): Cell[] => [
            r.code,
            r.name,
            r.phones.join(' / '),
            r.balance,
            r.overdue,
            r.oldestDate,
            r.oldestLate,
            r.lastPayment?.date ?? null,
            r.lastPayment?.amount ?? null,
            r.limit,
            r.termsDays,
          ]),
        ),
      );
    }),
  );

  // ---- Over the limit or near it (RPT-17, owner answer 4) ----
  scope.get('/reports/over-limit', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s): Promise<OverLimitView | FastifyReply> => {
      const { rows } = await c.query<{
        id: string;
        code: string;
        name: string;
        phones: string[];
        limit: string;
        balance: string;
        approved: string | null;
      }>(
        `SELECT p.id, p.code, p.name, p.phones, a.credit_limit::text AS limit,
           coalesce((SELECT sum(e.amount) FROM erp.party_ledger_entries e
             WHERE e.party_id = p.id AND e.role = 'customer' AND e.entry_date <= $1), 0)::text AS balance,
           (SELECT max(d.business_date)::text FROM erp.overrides o JOIN erp.sales_documents d ON d.id = o.document_id
            WHERE o.kind = 'credit_limit' AND o.deleted_at IS NULL AND d.customer_party_id = p.id) AS approved
         FROM erp.customer_accounts a JOIN erp.parties p ON p.id = a.party_id
         WHERE a.deleted_at IS NULL AND p.deleted_at IS NULL AND a.credit_limit IS NOT NULL`,
        [s.today],
      );
      const out = rows
        .map((r) => {
          const balance = num(r.balance);
          const limit = num(r.limit);
          return { r, balance, limit, state: limitState({ balance, limit }) };
        })
        .filter((x): x is typeof x & { state: 'over' | 'near' } => x.state !== null)
        .map((x) => ({
          partyId: x.r.id,
          code: x.r.code,
          name: x.r.name,
          phones: x.r.phones,
          limit: x.limit,
          balance: x.balance,
          left: x.limit - x.balance,
          state: x.state,
          lastApproval: x.r.approved,
        }))
        .sort((a, b) => a.left - b.left || NAMES.compare(a.name, b.name));
      const result: OverLimitView = {
        money: await moneyOf(c),
        asOf: s.today,
        rows: out,
        withLimit: rows.length,
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `over-limit-${s.today}.csv`,
        csv(
          ['customer', 'name', 'phone', 'limit', 'balance', 'left', 'state', 'last_approval'],
          out.map((r): Cell[] => [
            r.code,
            r.name,
            r.phones.join(' / '),
            r.limit,
            r.balance,
            r.left,
            r.state,
            r.lastApproval,
          ]),
        ),
      );
    }),
  );

  // ---- Money received from customers and paid to suppliers (RPT-17, owner answer 5) ----
  scope.get('/reports/collections', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s): Promise<CollectionsView | FastifyReply> => {
      const q = query(req);
      const side = choiceOf<RegisterSide>(q, 'side', REGISTER_SIDES, 'received');
      if (side === 'paid' && !allowed(req, 'cost.view')) throw new Forbidden();
      const p = rangeOf(q, { from: s.today, to: s.today }, LIST_DAYS, s);
      const { rows } = await c.query<{
        date: string;
        kind: string;
        id: string;
        number: string;
        party_id: string;
        code: string;
        name: string;
        how: string;
        counter: string | null;
        by: string | null;
        reference: string | null;
        amount: string;
      }>(
        side === 'received'
          ? `SELECT x.business_date::text AS date, 'payment' AS kind, x.id, x.number, p.id AS party_id, p.code, p.name,
               m.name AS how, coalesce(d.name, d.code) AS counter, u.full_name AS by, x.reference, x.amount::text
             FROM erp.payments x JOIN erp.parties p ON p.id = x.party_id
             JOIN erp.payment_methods m ON m.id = x.method_id LEFT JOIN erp.devices d ON d.id = x.device_id
             LEFT JOIN erp.users u ON u.id = x.cashier_user_id
             WHERE x.direction = 'in' AND x.deleted_at IS NULL AND x.business_date BETWEEN $1 AND $2
             UNION ALL
             SELECT x.business_date::text, 'customer_receipt', x.id, x.number, p.id, p.code, p.name, b.name, NULL,
               u.full_name, x.reference, x.amount::text
             FROM erp.customer_receipts x JOIN erp.parties p ON p.id = x.customer_party_id
             JOIN erp.bank_accounts b ON b.id = x.bank_account_id LEFT JOIN erp.users u ON u.id = x.created_by_user_id
             WHERE x.business_date BETWEEN $1 AND $2
             ORDER BY 1, 4`
          : `SELECT x.business_date::text AS date, 'supplier_payment' AS kind, x.id, x.number, p.id AS party_id, p.code,
               p.name, b.name AS how, NULL AS counter, u.full_name AS by, x.reference, x.amount::text
             FROM erp.supplier_payments x JOIN erp.parties p ON p.id = x.supplier_party_id
             JOIN erp.bank_accounts b ON b.id = x.bank_account_id LEFT JOIN erp.users u ON u.id = x.created_by_user_id
             WHERE x.business_date BETWEEN $1 AND $2
             UNION ALL
             SELECT x.business_date::text, 'cash_movement', x.id, x.number, p.id, p.code, p.name, 'cash', coalesce(d.name, d.code),
               u.full_name, x.reference, x.amount::text
             FROM erp.cash_movements x JOIN erp.parties p ON p.id = x.party_id
             LEFT JOIN erp.devices d ON d.id = x.device_id LEFT JOIN erp.users u ON u.id = x.cashier_user_id
             WHERE x.kind = 'supplier_payment' AND x.deleted_at IS NULL AND x.business_date BETWEEN $1 AND $2
             UNION ALL
             SELECT x.business_date::text, 'goods_receipt', x.id, x.number, p.id, p.code, p.name, b.name, NULL,
               u.full_name, x.supplier_bill_no, x.total::text
             FROM erp.goods_receipts x JOIN erp.parties p ON p.id = x.supplier_party_id
             JOIN erp.bank_accounts b ON b.id = x.paid_from_bank_account_id
             LEFT JOIN erp.users u ON u.id = x.created_by_user_id
             WHERE x.status = 'posted' AND x.business_date BETWEEN $1 AND $2
             ORDER BY 1, 4`,
        [p.from, p.to],
      );
      const out = rows.map((r): MoneyRegisterRow => ({
        date: r.date,
        kind: r.kind,
        sourceId: r.id,
        number: r.number,
        partyId: r.party_id,
        partyCode: r.code,
        partyName: r.name,
        how: r.how,
        counter: r.counter,
        by: r.by,
        reference: r.reference,
        amount: num(r.amount),
      }));
      const totals = (key: (r: MoneyRegisterRow) => string): MoneyRegisterTotal[] => {
        const m = new Map<string, MoneyRegisterTotal>();
        for (const r of out) {
          const t = m.get(key(r)) ?? { name: key(r), count: 0, amount: 0 };
          m.set(key(r), { ...t, count: t.count + 1, amount: t.amount + r.amount });
        }
        return [...m.values()].sort((a, b) => b.amount - a.amount || NAMES.compare(a.name, b.name));
      };
      const result: CollectionsView = {
        money: await moneyOf(c),
        side,
        from: p.from,
        to: p.to,
        rows: out,
        byMethod: totals((r) => r.how),
        byPerson: totals((r) => r.by ?? ''),
        total: out.reduce((t, r) => t + r.amount, 0),
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `${side}-${p.from}-${p.to}.csv`,
        csv(
          ['date', 'kind', 'number', 'party', 'name', 'how', 'counter', 'by', 'reference', 'amount'],
          out.map((r): Cell[] => [
            r.date,
            r.kind,
            r.number,
            r.partyCode,
            r.partyName,
            r.how,
            r.counter,
            r.by,
            r.reference,
            r.amount,
          ]),
        ),
      );
    }),
  );

  // ---- User activity (RPT-17, owner answer 6) ----
  scope.get('/reports/user-activity', { preHandler: owner }, async (req, reply) =>
    run(req, reply, async (c, s): Promise<UserActivityView | FastifyReply> => {
      const q = query(req);
      const p = rangeOf(q, { from: s.today, to: s.today }, LIST_DAYS, s);
      const userId = idOf(q, 'userId');
      const kind = q['kind'] ? choiceOf<ActivityKindView>(q, 'kind', ACTIVITY_KIND_VIEWS) : null;
      // Two sources, one list. The audit log has sign-ins, users and settings, the catalog and parties (each change
      // with its before and after) and named events (voids, reviews, locks); documents keep who made them on their own
      // rows, so each document of the shop's days counts as its maker's "create". From the audit log: the shop's days,
      // from the cut-off hour of `from` to the one after `to`, in its time zone; an update carries only the fields it
      // changed (changedFields drops the bookkeeping columns); rows without a user (the data import) are left out.
      const { rows } = await c.query<{
        at: Date;
        user_id: string;
        user_name: string;
        device: string | null;
        action: string;
        entity: string;
        entity_id: string | null;
        label: string | null;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }>(
        `WITH t AS (
           SELECT (($1::date + make_interval(hours => day_cutoff_hour))::timestamp AT TIME ZONE timezone) AS lo,
             (($2::date + 1 + make_interval(hours => day_cutoff_hour))::timestamp AT TIME ZONE timezone) AS hi
           FROM erp.tenants)
         SELECT a.at, a.user_id, u.full_name AS user_name, coalesce(d.name, d.code) AS device, a.action, a.entity, a.entity_id,
           coalesce(a.after->>'number', a.after->>'code', a.after->>'username', a.after->>'name') AS label,
           CASE WHEN a.action = 'update' THEN (SELECT jsonb_object_agg(k, a.before->k)
             FROM jsonb_object_keys(a.after) k WHERE a.before->k IS DISTINCT FROM a.after->k) END AS before,
           CASE WHEN a.action = 'update' THEN (SELECT jsonb_object_agg(k, a.after->k)
             FROM jsonb_object_keys(a.after) k WHERE a.before->k IS DISTINCT FROM a.after->k)
             WHEN a.action LIKE '%.%' THEN a.after END AS after
         FROM erp.audit_log a CROSS JOIN t
         JOIN erp.users u ON u.id = a.user_id LEFT JOIN erp.devices d ON d.id = a.device_id
         WHERE a.at >= t.lo AND a.at < t.hi AND a.user_id IS NOT NULL
           AND a.entity NOT IN ('sales_lines', 'sales_payments') AND ($3::uuid IS NULL OR a.user_id = $3)
         UNION ALL
         SELECT x.at, x.user_id, u.full_name, coalesce(d.name, d.code), 'create', x.entity, x.id, x.label, NULL, NULL
         FROM (
           SELECT created_at_device AS at, salesperson_user_id AS user_id, device_id, 'sales_documents' AS entity, id,
             number AS label FROM erp.sales_documents WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT at_device, cashier_user_id, device_id, 'payments', id, number FROM erp.payments
             WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT at_device, cashier_user_id, device_id, 'cash_movements', id, number FROM erp.cash_movements
             WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT at_device, cashier_user_id, device_id, 'cash_handovers', id, number FROM erp.cash_handovers
             WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT created_at, cashier_user_id, device_id, 'cash_sessions', id, number FROM erp.cash_sessions
             WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT created_at, created_by_user_id, device_id, 'customer_receipts', id, number
             FROM erp.customer_receipts WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT created_at, created_by_user_id, device_id, 'supplier_payments', id, number
             FROM erp.supplier_payments WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT created_at, created_by_user_id, device_id, 'expenses', id, number FROM erp.expenses
             WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT created_at, created_by_user_id, device_id, 'fund_transfers', id, number
             FROM erp.fund_transfers WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT created_at, created_by_user_id, device_id, 'journal_vouchers', id, number
             FROM erp.journal_vouchers WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT created_at, created_by_user_id, device_id, 'goods_receipts', id,
             coalesce(number, supplier_bill_no) FROM erp.goods_receipts WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT created_at, created_by_user_id, device_id, 'purchase_returns', id, number
             FROM erp.purchase_returns WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT created_at, created_by_user_id, device_id, 'stock_adjustments', id, number
             FROM erp.stock_adjustments WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT created_at, created_by_user_id, device_id, 'stock_transfers', id, number
             FROM erp.stock_transfers WHERE business_date BETWEEN $1 AND $2
           UNION ALL SELECT o.created_at, o.approved_by_user_id, NULL, 'overrides', o.id, o.kind FROM erp.overrides o
             CROSS JOIN t WHERE o.created_at >= t.lo AND o.created_at < t.hi AND o.deleted_at IS NULL
         ) x JOIN erp.users u ON u.id = x.user_id LEFT JOIN erp.devices d ON d.id = x.device_id
         WHERE $3::uuid IS NULL OR x.user_id = $3
         ORDER BY 1 DESC, 7 DESC`,
        [p.from, p.to, userId],
      );
      const all = rows
        .map((r): ActivityRow | null => {
          const k = activityKind(r.entity, r.action);
          if (k === null || (kind !== null && k !== kind)) return null;
          return {
            at: r.at.toISOString(),
            userId: r.user_id,
            userName: r.user_name,
            device: r.device,
            kind: k,
            action: r.action,
            entity: r.entity,
            entityId: r.entity_id,
            label: r.action.includes('.') ? null : r.label,
            changes: r.action === 'update' ? changedFields(r.before ?? {}, r.after ?? {}) : [],
          };
        })
        .filter((r): r is ActivityRow => r !== null && (r.action !== 'update' || r.changes.length > 0));
      const users = (
        await c.query<{ id: string; name: string }>(
          'SELECT id, full_name AS name FROM erp.users WHERE deleted_at IS NULL ORDER BY lower(full_name), id',
        )
      ).rows;
      if (wantsCsv(req))
        return sendCsv(
          reply,
          `user-activity-${p.from}-${p.to}.csv`,
          csv(
            ['at', 'user', 'device', 'kind', 'action', 'record', 'id', 'label', 'changes'],
            all.map((r): Cell[] => [
              r.at,
              r.userName,
              r.device,
              r.kind,
              r.action,
              r.entity,
              r.entityId,
              r.label,
              r.changes
                .map((x) => `${x.field}: ${JSON.stringify(x.before)} → ${JSON.stringify(x.after)}`)
                .join('; '),
            ]),
          ),
        );
      return { from: p.from, to: p.to, users, rows: all.slice(0, ACTIVITY_PAGE), count: all.length };
    }),
  );

  // ---- The cash flow (ACC-07, owner answer 7) ----
  scope.get('/reports/cash-flow', { preHandler: financial }, async (req, reply) =>
    run(req, reply, async (c, s): Promise<CashFlowView | FastifyReply> => {
      const q = query(req);
      const p = rangeOf(q, { from: `${s.today.slice(0, 8)}01`, to: s.today }, SUMMARY_DAYS, s);
      let columns: Period[];
      try {
        columns = monthsOf(p);
      } catch (err) {
        if (err instanceof DomainError) throw new BadRequest('range_too_long');
        throw err;
      }
      const cash = await cashAccounts(c);
      const opening = num(
        (
          await c.query<{ b: string }>(
            `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM erp.journal_lines l
             JOIN erp.journal_entries e ON e.id = l.entry_id WHERE l.account_id = ANY ($1) AND e.entry_date < $2`,
            [cash, p.from],
          )
        ).rows[0]!.b,
      );
      const { rows } = await c.query<{
        entry_id: string;
        date: string;
        source_type: string;
        account_id: string;
        role: string | null;
        type: AccountType;
        amount: string;
        is_cash: boolean;
      }>(
        `WITH moved AS (
           SELECT DISTINCT l.entry_id FROM erp.journal_lines l JOIN erp.journal_entries e ON e.id = l.entry_id
           WHERE l.account_id = ANY ($1) AND e.entry_date BETWEEN $2 AND $3)
         SELECT l.entry_id, e.entry_date::text AS date, x.source_type, l.account_id, a.system_role AS role, a.type,
           (l.debit - l.credit)::text AS amount, l.account_id = ANY ($1) AS is_cash
         FROM moved m JOIN erp.journal_lines l ON l.entry_id = m.entry_id
         JOIN erp.journal_entries e ON e.id = l.entry_id JOIN erp.postings x ON x.seq = e.posting_seq
         JOIN erp.accounts a ON a.id = l.account_id
         ORDER BY l.entry_id, l.line_no`,
        [cash, p.from, p.to],
      );
      const entries = new Map<
        string,
        { date: string; sourceType: string; cash: number; others: CashFlowLine[] }
      >();
      for (const r of rows) {
        const e = entries.get(r.entry_id) ?? { date: r.date, sourceType: r.source_type, cash: 0, others: [] };
        if (r.is_cash) e.cash += num(r.amount);
        else e.others.push({ accountId: r.account_id, role: r.role, type: r.type, amount: num(r.amount) });
        entries.set(r.entry_id, e);
      }
      const parts: (CashFlowPart & { date: string })[] = [...entries.values()].flatMap((e) =>
        cashFlowOf(e).map((x) => ({ ...x, date: e.date })),
      );
      const flow = cashFlowStatement({ columns, opening, parts });
      const ids = [...new Set(flow.rows.map((r) => r.accountId).filter((x): x is string => x !== null))];
      const accounts = new Map(
        (
          await c.query<{ id: string; code: string; name: string }>(
            'SELECT id, code, name FROM erp.accounts WHERE id = ANY ($1)',
            [ids],
          )
        ).rows.map((a) => [a.id, a]),
      );
      const result: CashFlowView = {
        money: await moneyOf(c),
        from: p.from,
        to: p.to,
        columns: flow.columns,
        rows: flow.rows
          .map((r) => ({
            cls: r.cls,
            account: r.accountId === null ? null : (accounts.get(r.accountId) ?? null),
            amounts: r.amounts,
            total: r.total,
          }))
          // Expenses by account code, inside the classes' order.
          .sort(
            (a, b) =>
              CLASS_ORDER.indexOf(a.cls) - CLASS_ORDER.indexOf(b.cls) ||
              (a.account?.code ?? '').localeCompare(b.account?.code ?? ''),
          ),
        total: flow.total,
      };
      if (!wantsCsv(req)) return result;
      const head = result.columns.map((x) => x.from.slice(0, 7));
      return sendCsv(
        reply,
        `cash-flow-${p.from}-${p.to}.csv`,
        csv(
          ['class', 'account', ...head, 'total'],
          [
            ['opening', '', ...result.columns.map((x) => x.opening), result.total.opening],
            ...result.rows.map((r): Cell[] => [r.cls, r.account?.name ?? '', ...r.amounts, r.total]),
            ['net', '', ...result.columns.map((x) => x.net), result.total.net],
            ['closing', '', ...result.columns.map((x) => x.closing), result.total.closing],
          ],
        ),
      );
    }),
  );
}

class Forbidden extends Error {}

type CashFlowLine = { accountId: string; role: string | null; type: AccountType; amount: number };
const CLASS_ORDER = ['opening', 'sales', 'customers', 'suppliers', 'expenses', 'owner', 'shortOver', 'other'];
