import {
  GRID_MEASURES,
  SALES_COMPARES,
  SALES_GROUPS,
  SALES_RANKINGS,
  WALK_IN,
  type DiscountRowView,
  type GridMeasure,
  type PurchaseDocumentRow,
  type PurchaseLineView,
  type PurchaseRegisterView,
  type RateLineView,
  type RatesView,
  type SalesBefore,
  type SalesCells,
  type SalesChoicesView,
  type SalesCompare,
  type SalesGroup,
  type SalesOverTimeView,
  type SalesProfitView,
  type SalesRanking,
  type SalesRow,
  type TopItemView,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import {
  can,
  change,
  hourGrid,
  lastYearPeriod,
  normalizeIdentifier,
  periodOf,
  previousPeriod,
  rateOf,
  rateStats,
  salesFigures,
  spread,
  topAndBottom,
  trendSeries,
  trendStep,
  type Period,
  type Permission,
  type SalesSums,
} from '@erp/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requirePermission } from '../auth/routes';
import { BadRequest, LIST_DAYS, rangeOf, shop, SUMMARY_DAYS } from './financial';
import { csv, moneyOf, sendCsv, type Cell } from './routes';
import { STOCK_ROWS } from './stock';

// The sales and purchase reports (W2-03 plan; RPT-07, RPT-09, RPT-15; D-110, D-116): read only, computed on request
// from the bills, their stock movements and the goods receipts inside withTenant under the app role (rule 5); the
// rules in @erp/domain's sales-reports.ts. Every report needs reports.view; cost, profit, purchase amounts and purchase
// rates need cost.view and are left out without it. A line's sales are what the customer paid (after the line and bill
// discounts), its cost its stock movements' (owner answer 1), so a period's sales and cost equal net sales and cost of
// goods sold in the books. Finalized bills only: a voided bill nets to nothing in the books on its own date. Dates are
// business dates. Every report downloads as CSV.

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

type Client = pg.ClientBase;
type Query = Record<string, string | undefined>;
type Shop = { today: string; startMonth: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The top and bottom lists' length (owner answer 5). */
const TOP_N = 20;
/** The price approvals counted beside the discounts given (owner answer 6). */
const PRICE_APPROVALS = ['below_list', 'below_floor'];

/** A LIKE pattern's own %, _ and \ taken literally (as purchasing's item search). */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (x) => `\\${x}`);

const idOf = (q: Query, key: string) => {
  const v = q[key] || null;
  if (v !== null && !UUID.test(v)) throw new BadRequest('bad_request');
  return v;
};

function choiceOf<T extends string>(q: Query, key: string, choices: readonly T[], fallback: T): T {
  const v = q[key] || fallback;
  if (!(choices as readonly string[]).includes(v)) throw new BadRequest('bad_request');
  return v as T;
}

/** The comparison period (owner answer 3): the one before by default. */
function beforeOf(p: Period, compare: SalesCompare): Period | null {
  if (compare === 'none') return null;
  return compare === 'previous' ? previousPeriod(p) : lastYearPeriod(p);
}

// ---- One shape for every sales figure: the period's finalized bill lines, each with its credit and cost ----

/**
 * Per line of a finalized bill in the period: its item's category, brand and first make; the salesman and customer it
 * counts for (owner answer 2, @erp/domain's creditedTo: a returned line counts for the bill it returns, when known);
 * quantity, what was paid, its cost (Σ −value of its stock movements) and the same at list price (listAmount: a line
 * with no list price at what was paid). $1 and $2 are the period.
 */
const LINES = `
  docs AS (
    SELECT d.id, d.business_date, d.created_at_device, d.salesperson_user_id, d.customer_party_id
    FROM erp.sales_documents d
    WHERE d.status = 'finalized' AND d.deleted_at IS NULL AND d.business_date BETWEEN $1 AND $2
  ),
  costs AS (
    SELECT m.source_line_id AS line_id, -sum(m.value_delta) AS cost FROM erp.stock_movements m
    WHERE m.source_type = 'sale' AND m.source_id IN (SELECT id FROM docs) GROUP BY 1
  ),
  mk AS (
    SELECT DISTINCT ON (x.item_id) x.item_id, x.make_id FROM erp.item_compatibility x
    WHERE x.make_id IS NOT NULL AND x.deleted_at IS NULL ORDER BY x.item_id, x.created_at, x.id
  ),
  ln AS (
    SELECT d.id AS doc_id, d.business_date, d.created_at_device, l.item_id, l.location_id, i.category_id,
      i.brand_id, mk.make_id,
      CASE WHEN l.qty < 0 AND od.id IS NOT NULL THEN od.salesperson_user_id ELSE d.salesperson_user_id END
        AS salesman_id,
      CASE WHEN l.qty < 0 AND od.id IS NOT NULL THEN od.customer_party_id ELSE d.customer_party_id END
        AS customer_id,
      (l.qty * 1000)::bigint AS qty, l.line_total AS sales, coalesce(k.cost, 0)::bigint AS cost,
      CASE WHEN l.list_price IS NULL THEN l.line_total ELSE round(l.list_price * l.qty)::bigint END AS list_sales
    FROM docs d
    JOIN erp.sales_lines l ON l.document_id = d.id AND l.deleted_at IS NULL
    JOIN erp.items i ON i.id = l.item_id
    LEFT JOIN costs k ON k.line_id = l.id
    LEFT JOIN mk ON mk.item_id = l.item_id
    LEFT JOIN erp.sales_lines ol ON ol.id = l.original_line_id
    LEFT JOIN erp.sales_documents od ON od.id = ol.document_id
  )`;

/** What a group's rows are keyed by; '' for none (no category, a walk-in). */
const KEYS: Record<SalesGroup, string> = {
  category: `coalesce(category_id::text, '')`,
  item: 'item_id::text',
  brand: `coalesce(brand_id::text, '')`,
  make: `coalesce(make_id::text, '')`,
  salesman: 'salesman_id::text',
  customer: `coalesce(customer_id::text, '')`,
  bill: 'doc_id::text',
  day: 'business_date::text',
  month: `to_char(business_date, 'YYYY-MM')`,
};

/** The filters on the lines (category, brand, make, salesman, customer or walk-in, location, item, words). */
function filtersOf(q: Query, params: unknown[]): string {
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  for (const [key, column] of [
    ['categoryId', 'category_id'],
    ['brandId', 'brand_id'],
    ['makeId', 'make_id'],
    ['salesmanId', 'salesman_id'],
    ['locationId', 'location_id'],
    ['itemId', 'item_id'],
  ] as const) {
    const v = idOf(q, key);
    if (v) where.push(`${column} = ${add(v)}`);
  }
  const customer = q['customerId'] || null;
  if (customer === WALK_IN) where.push('customer_id IS NULL');
  else if (customer !== null) where.push(`customer_id = ${add(idOf(q, 'customerId'))}`);
  const text = (q['q'] ?? '').trim();
  if (text !== '') {
    const p = add(text.split(/\s+/).map((w) => `%${likeEscape(w)}%`));
    const n = add(likeEscape(normalizeIdentifier(text)));
    where.push(`item_id IN (SELECT i.id FROM erp.items i
      WHERE NOT EXISTS (SELECT 1 FROM unnest(${p}::text[]) w WHERE NOT (i.code ILIKE w OR i.name ILIKE w))
        OR EXISTS (SELECT 1 FROM erp.item_identifiers x WHERE x.item_id = i.id AND x.deleted_at IS NULL
                   AND x.normalized_value LIKE ${n} || '%'))`);
  }
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

interface Sums extends SalesSums {
  key: string;
  bills: number;
}

/**
 * Σ over the period's lines that pass the filters, by `key` (an SQL expression over the lines), and over all of them
 * in the same pass: a bill holding several groups' lines counts once in the total.
 */
async function sumsBy(c: Client, p: Period, key: string, q: Query): Promise<{ rows: Sums[]; total: Sums }> {
  const params: unknown[] = [p.from, p.to];
  const where = filtersOf(q, params);
  const { rows } = await c.query<{
    key: string | null;
    whole: boolean;
    bills: number;
    qty: string | null;
    sales: string | null;
    cost: string | null;
    list_sales: string | null;
  }>(
    `WITH ${LINES}
     SELECT ${key} AS key, grouping(${key}) = 1 AS whole, count(DISTINCT doc_id)::int AS bills,
       sum(qty)::text AS qty, sum(sales)::text AS sales, sum(cost)::text AS cost,
       sum(list_sales)::text AS list_sales
     FROM ln ${where} GROUP BY GROUPING SETS ((${key}), ())`,
    params,
  );
  const sums = (r: (typeof rows)[number]): Sums => ({
    key: r.key ?? '',
    bills: r.bills,
    qty: Number(r.qty ?? 0),
    sales: Number(r.sales ?? 0),
    cost: Number(r.cost ?? 0),
    listSales: Number(r.list_sales ?? 0),
  });
  const total = rows.find((r) => r.whole);
  return { rows: rows.filter((r) => !r.whole).map(sums), total: total ? sums(total) : NONE };
}

const NONE: Sums = { key: '', bills: 0, qty: 0, sales: 0, cost: 0, listSales: 0 };
function cellsOf(s: Sums, values: boolean): SalesCells {
  const f = salesFigures(s);
  return {
    bills: s.bills,
    qty: f.qty,
    sales: f.sales,
    discount: f.discount,
    discountBp: f.discountBp,
    cost: values ? f.cost : null,
    profit: values ? f.profit : null,
    marginBp: values ? f.marginBp : null,
  };
}

function beforeCells(now: Sums, before: Sums, values: boolean): SalesBefore {
  const profit = (s: Sums) => s.sales - s.cost;
  return {
    sales: before.sales,
    profit: values ? profit(before) : null,
    salesChange: change(now.sales, before.sales),
    profitChange: values ? change(profit(now), profit(before)) : null,
  };
}

/** The first business date the system has sales for: the opening's, else the first bill's, else today. */
async function sinceOf(c: Client, today: string): Promise<string> {
  const { rows } = await c.query<{ d: string | null }>(
    `SELECT coalesce((SELECT min(business_date) FROM erp.stock_movements WHERE source_type = 'opening'),
       (SELECT min(business_date) FROM erp.sales_documents))::text AS d`,
  );
  const d = rows[0]!.d;
  return d !== null && d < today ? d : today;
}

/** The names of a group's keys: (code, name, date) by key. */
async function namesOf(
  c: Client,
  group: SalesGroup,
  keys: string[],
): Promise<Map<string, { code: string | null; name: string; date: string | null }>> {
  const ids = keys.filter((k) => UUID.test(k));
  const lookup = async (sql: string) =>
    new Map(
      (
        await c.query<{ id: string; code: string | null; name: string; date: string | null }>(sql, [ids])
      ).rows.map((r) => [r.id, { code: r.code, name: r.name, date: r.date }]),
    );
  switch (group) {
    case 'category':
      return lookup(
        'SELECT id, NULL AS code, name, NULL AS date FROM erp.categories WHERE id = ANY($1::uuid[])',
      );
    case 'item':
      return lookup('SELECT id, code, name, NULL AS date FROM erp.items WHERE id = ANY($1::uuid[])');
    case 'brand':
      return lookup('SELECT id, NULL AS code, name, NULL AS date FROM erp.brands WHERE id = ANY($1::uuid[])');
    case 'make':
      return lookup(
        'SELECT id, NULL AS code, name, NULL AS date FROM erp.vehicle_makes WHERE id = ANY($1::uuid[])',
      );
    case 'salesman':
      return lookup(
        'SELECT id, NULL AS code, full_name AS name, NULL AS date FROM erp.users WHERE id = ANY($1::uuid[])',
      );
    case 'customer':
      return lookup('SELECT id, code, name, NULL AS date FROM erp.parties WHERE id = ANY($1::uuid[])');
    case 'bill':
      return lookup(
        `SELECT id, number AS code, number AS name, business_date::text AS date FROM erp.sales_documents
         WHERE id = ANY($1::uuid[])`,
      );
    case 'day':
    case 'month':
      return new Map(keys.map((k) => [k, { code: null, name: k, date: null }]));
  }
}

/** Names in the shop's order, ignoring case: one collator, made once (a new one per comparison is slow). */
const NAMES = new Intl.Collator('en', { sensitivity: 'base' });
/** Dates, numbers and ids: by their characters. */
const byText = (a: string, b: string) => Number(a > b) - Number(a < b);

interface OverTime {
  /** By business date, with the bills made that day. */
  days: Sums[];
  /** Each bill once: its business date, its hour on the counter's clock, and what was paid on it. */
  bills: { date: string; hour: number; sales: number }[];
  items: Sums[];
  /** By the salesman each line counts for (owner answer 2). */
  salesmen: Sums[];
  total: Sums;
}

/** Everything sales over time needs, in one pass over the period's lines (grouping sets). */
async function overTime(c: Client, p: Period, q: Query): Promise<OverTime> {
  const params: unknown[] = [p.from, p.to];
  const where = filtersOf(q, params);
  const { rows } = await c.query<{
    kind: 'day' | 'bill' | 'item' | 'salesman' | 'total';
    day: string | null;
    hour: number | null;
    item: string | null;
    salesman: string | null;
    qty: string;
    sales: string;
    cost: string;
    list_sales: string;
  }>(
    `WITH ${LINES}
     SELECT CASE WHEN grouping(doc_id) = 0 THEN 'bill' WHEN grouping(business_date) = 0 THEN 'day'
              WHEN grouping(item_id) = 0 THEN 'item' WHEN grouping(salesman_id) = 0 THEN 'salesman'
              ELSE 'total' END AS kind,
       business_date::text AS day,
       extract(hour FROM created_at_device AT TIME ZONE (SELECT timezone FROM erp.tenants))::int AS hour,
       item_id::text AS item, salesman_id::text AS salesman,
       sum(qty)::text AS qty, sum(sales)::text AS sales, sum(cost)::text AS cost, sum(list_sales)::text AS list_sales
     FROM ln ${where}
     GROUP BY GROUPING SETS ((business_date), (doc_id, business_date, created_at_device), (item_id), (salesman_id), ())`,
    params,
  );
  const sums = (key: string, r: (typeof rows)[number], bills = 0): Sums => ({
    key,
    bills,
    qty: Number(r.qty ?? 0),
    sales: Number(r.sales ?? 0),
    cost: Number(r.cost ?? 0),
    listSales: Number(r.list_sales ?? 0),
  });
  const bills = rows.filter((r) => r.kind === 'bill');
  const billsOn = new Map<string, number>();
  for (const b of bills) billsOn.set(b.day!, (billsOn.get(b.day!) ?? 0) + 1);
  const total = rows.find((r) => r.kind === 'total');
  return {
    days: rows.filter((r) => r.kind === 'day').map((r) => sums(r.day!, r, billsOn.get(r.day!) ?? 0)),
    bills: bills.map((r) => ({ date: r.day!, hour: r.hour!, sales: Number(r.sales) })),
    items: rows.filter((r) => r.kind === 'item').map((r) => sums(r.item!, r)),
    salesmen: rows.filter((r) => r.kind === 'salesman').map((r) => sums(r.salesman!, r)),
    total: total ? sums('', total, bills.length) : NONE,
  };
}

/** Groups by time or bill read in date order; the others largest sales first, then by name. */
const CHRONOLOGICAL: SalesGroup[] = ['bill', 'day', 'month'];

export function registerSalesReports(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  const view = requirePermission(requireAuth, 'reports.view');
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
      throw err;
    }
  };

  // ---- The filters' choices: salesmen and customers (the rest are the stock reports' choices) ----
  scope.get('/reports/sales-choices', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c): Promise<SalesChoicesView> => {
      const salesmen = (
        await c.query<{ id: string; name: string }>(
          `SELECT u.id, u.full_name AS name FROM erp.users u
           WHERE EXISTS (SELECT 1 FROM erp.sales_documents d WHERE d.salesperson_user_id = u.id)
           ORDER BY lower(u.full_name), u.id`,
        )
      ).rows;
      const customers = (
        await c.query<{ id: string; code: string; name: string }>(
          `SELECT p.id, p.code, p.name FROM erp.parties p
           JOIN erp.customer_accounts a ON a.party_id = p.id AND a.deleted_at IS NULL
           WHERE p.deleted_at IS NULL ORDER BY lower(p.name), p.code`,
        )
      ).rows;
      return { salesmen, customers };
    }),
  );

  // ---- Suppliers and customers for the rates' party picker: code or name words ----
  // The pickers: any party (the rates), or customers or suppliers only (the partner ledger, W2-04).
  const findParties = (req: FastifyRequest, reply: FastifyReply, role: 'customer' | 'supplier' | null) => {
    const text = (query(req)['q'] ?? '').trim();
    if (text === '') return { items: [] };
    return run(req, reply, async (c) => {
      const words = text.split(/\s+/).map((w) => `%${likeEscape(w)}%`);
      const { rows } = await c.query<{ id: string; code: string; name: string }>(
        `SELECT p.id, p.code, p.name FROM erp.parties p
         WHERE p.deleted_at IS NULL
           AND (($2::text IS DISTINCT FROM 'supplier' AND EXISTS (
                 SELECT 1 FROM erp.customer_accounts a WHERE a.party_id = p.id AND a.deleted_at IS NULL))
             OR ($2::text IS DISTINCT FROM 'customer' AND EXISTS (
                 SELECT 1 FROM erp.supplier_accounts a WHERE a.party_id = p.id AND a.deleted_at IS NULL)))
           AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) w WHERE NOT (p.code ILIKE w OR p.name ILIKE w))
         ORDER BY lower(p.name), p.code LIMIT 20`,
        [words, role],
      );
      return { items: rows };
    });
  };
  scope.get('/reports/parties', { preHandler: view }, async (req, reply) => findParties(req, reply, null));
  scope.get('/reports/customers', { preHandler: view }, async (req, reply) =>
    findParties(req, reply, 'customer'),
  );
  scope.get('/reports/suppliers', { preHandler: view }, async (req, reply) =>
    findParties(req, reply, 'supplier'),
  );

  // ---- Sales and gross profit (RPT-07, owner answers 1-3) ----
  scope.get('/reports/sales-profit', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const group = choiceOf(q, 'group', SALES_GROUPS, 'category');
      const compare = choiceOf(q, 'compare', SALES_COMPARES, 'previous');
      // By bill is a list of bills: up to 92 days (D-116 answer 4); the rest are summaries, up to a year.
      const p = rangeOf(
        q,
        periodOf('thisMonth', s.today, s.startMonth),
        group === 'bill' ? LIST_DAYS : SUMMARY_DAYS,
        s,
      );
      const values = allowed(req, 'cost.view');
      const before = beforeOf(p, compare);
      const key = KEYS[group];
      const { rows: sums, total } = await sumsBy(c, p, key, q);
      const earlier = before === null ? null : await sumsBy(c, before, key, q);
      const prior = earlier === null ? null : new Map(earlier.rows.map((x) => [x.key, x]));
      const names = await namesOf(
        c,
        group,
        sums.map((x) => x.key),
      );
      const all = sums
        .map((x) => {
          const n = names.get(x.key);
          return { sums: x, code: n?.code ?? null, name: n?.name ?? '', date: n?.date ?? null };
        })
        .sort((a, b) =>
          CHRONOLOGICAL.includes(group)
            ? byText(a.date ?? a.name, b.date ?? b.name) || byText(a.code ?? '', b.code ?? '')
            : b.sums.sales - a.sums.sales ||
              Number(a.name === '') - Number(b.name === '') ||
              NAMES.compare(a.name, b.name) ||
              byText(a.sums.key, b.sums.key),
        );
      const rows: SalesRow[] = all.slice(0, STOCK_ROWS).map((x) => ({
        key: x.sums.key,
        name: x.name,
        code: x.code,
        date: x.date,
        cells: cellsOf(x.sums, values),
        before: prior === null ? null : beforeCells(x.sums, prior.get(x.sums.key) ?? NONE, values),
      }));
      const priorTotal = earlier?.total ?? null;
      const result: SalesProfitView = {
        money: await moneyOf(c),
        values,
        ...p,
        group,
        compare,
        before,
        since: await sinceOf(c, s.today),
        rows,
        truncated: all.length > STOCK_ROWS,
        total: {
          count: all.length,
          cells: cellsOf(total, values),
          before: priorTotal === null ? null : beforeCells(total, priorTotal, values),
        },
      };
      if (!wantsCsv(req)) return result;
      const line = (code: string | null, name: string, x: Sums, b: Sums | null): Cell[] => {
        const f = salesFigures(x);
        return [
          code,
          name,
          x.bills,
          x.qty / 1000,
          f.sales,
          f.discount,
          ...(values ? [f.cost, f.profit, f.marginBp === null ? null : f.marginBp / 100] : []),
          ...(b === null ? [] : [b.sales, ...(values ? [b.sales - b.cost] : [])]),
        ];
      };
      return sendCsv(
        reply,
        `sales-profit-${group}-${p.from}-${p.to}.csv`,
        csv(
          [
            'code',
            group,
            'bills',
            'qty',
            'sales',
            'discount',
            ...(values ? ['cost', 'profit', 'margin_percent'] : []),
            ...(before === null ? [] : ['before_sales', ...(values ? ['before_profit'] : [])]),
          ],
          [
            ...all.map((x) =>
              line(x.code, x.name, x.sums, prior === null ? null : (prior.get(x.sums.key) ?? NONE)),
            ),
            line('', 'total', total, priorTotal),
          ],
        ),
      );
    }),
  );

  // ---- The purchase register (RPT-09): posted receipts and purchase returns, by supplier ----
  scope.get('/reports/purchase-register', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const p = rangeOf(q, periodOf('thisMonth', s.today, s.startMonth), LIST_DAYS, s);
      const supplierId = idOf(q, 'supplierId');
      const withLines = q['lines'] === '1';
      const values = allowed(req, 'cost.view');
      const { rows: docs } = await c.query<{
        kind: 'receipt' | 'return';
        id: string;
        number: string | null;
        date: string;
        supplier_id: string | null;
        supplier: string | null;
        bill_no: string | null;
        bill_date: string | null;
        location: string;
        bank: boolean;
        due_date: string | null;
        line_count: number;
        qty: string;
        total: string | null;
      }>(
        `SELECT 'receipt' AS kind, g.id, g.number, g.business_date::text AS date, g.supplier_party_id AS supplier_id,
           sp.name AS supplier, g.supplier_bill_no AS bill_no, g.supplier_bill_date::text AS bill_date,
           l.code AS location, g.paid_from_bank_account_id IS NOT NULL AS bank, g.due_date::text AS due_date,
           (SELECT count(*)::int FROM erp.goods_receipt_lines x WHERE x.receipt_id = g.id) AS line_count,
           (SELECT (coalesce(sum(x.qty), 0) * 1000)::bigint::text FROM erp.goods_receipt_lines x
            WHERE x.receipt_id = g.id) AS qty,
           (SELECT sum(x.value)::text FROM erp.goods_receipt_lines x WHERE x.receipt_id = g.id) AS total
         FROM erp.goods_receipts g JOIN erp.locations l ON l.id = g.location_id
         LEFT JOIN erp.parties sp ON sp.id = g.supplier_party_id
         WHERE g.status = 'posted' AND g.business_date BETWEEN $1 AND $2
           AND ($3::uuid IS NULL OR g.supplier_party_id = $3)
         UNION ALL
         SELECT 'return', r.id, r.number, r.business_date::text, r.supplier_party_id, sp.name, gr.supplier_bill_no,
           gr.supplier_bill_date::text, l.code, false, NULL,
           (SELECT count(*)::int FROM erp.purchase_return_lines x WHERE x.return_id = r.id),
           (SELECT (-coalesce(sum(x.qty), 0) * 1000)::bigint::text FROM erp.purchase_return_lines x
            WHERE x.return_id = r.id),
           (-r.total)::text
         FROM erp.purchase_returns r JOIN erp.locations l ON l.id = r.location_id
         LEFT JOIN erp.parties sp ON sp.id = r.supplier_party_id
         LEFT JOIN erp.goods_receipts gr ON gr.id = r.goods_receipt_id
         WHERE r.status = 'posted' AND r.business_date BETWEEN $1 AND $2
           AND ($3::uuid IS NULL OR r.supplier_party_id = $3)
         ORDER BY 6 NULLS LAST, 4, 3, 2`,
        [p.from, p.to, supplierId],
      );
      const lines = new Map<string, PurchaseLineView[]>();
      if (withLines && docs.length > 0) {
        const { rows } = await c.query<{
          doc_id: string;
          item_id: string | null;
          code: string | null;
          name: string | null;
          qty: string;
          rate: string | null;
          value: string | null;
        }>(
          `SELECT x.receipt_id AS doc_id, x.item_id, i.code, i.name, (x.qty * 1000)::bigint::text AS qty,
             x.unit_cost::text AS rate, x.value::text AS value, x.line_no
           FROM erp.goods_receipt_lines x LEFT JOIN erp.items i ON i.id = x.item_id
           WHERE x.receipt_id = ANY($1::uuid[])
           UNION ALL
           SELECT x.return_id, x.item_id, i.code, i.name, (-x.qty * 1000)::bigint::text, x.unit_cost::text,
             (-round(x.qty * x.unit_cost))::bigint::text, x.line_no
           FROM erp.purchase_return_lines x LEFT JOIN erp.items i ON i.id = x.item_id
           WHERE x.return_id = ANY($1::uuid[])
           ORDER BY 1, 8`,
          [docs.map((d) => d.id)],
        );
        for (const r of rows) {
          const list = lines.get(r.doc_id) ?? [];
          lines.set(r.doc_id, list);
          list.push({
            itemId: r.item_id,
            code: r.code,
            name: r.name,
            qty: Number(r.qty),
            rate: values && r.rate !== null ? Number(r.rate) : null,
            value: values && r.value !== null ? Number(r.value) : null,
          });
        }
      }
      const rows: PurchaseDocumentRow[] = docs.map((d) => ({
        kind: d.kind,
        id: d.id,
        number: d.number,
        date: d.date,
        supplierId: d.supplier_id,
        supplier: d.supplier,
        supplierBillNo: d.bill_no,
        supplierBillDate: d.bill_date,
        location: d.location,
        paidBy: d.bank ? 'bank' : 'account',
        dueDate: d.due_date,
        lineCount: d.line_count,
        qty: Number(d.qty),
        total: values ? Number(d.total ?? 0) : null,
        lines: withLines ? (lines.get(d.id) ?? []) : null,
      }));
      const bySupplier = new Map<string, PurchaseRegisterView['suppliers'][number]>();
      for (const r of rows) {
        const k = r.supplierId ?? '';
        const x = bySupplier.get(k) ?? {
          supplierId: r.supplierId,
          name: r.supplier,
          count: 0,
          total: values ? 0 : null,
        };
        bySupplier.set(k, x);
        x.count += 1;
        if (x.total !== null) x.total += r.total ?? 0;
      }
      const sum = (kind: PurchaseDocumentRow['kind'] | null) =>
        values
          ? rows.filter((r) => kind === null || r.kind === kind).reduce((t, r) => t + (r.total ?? 0), 0)
          : null;
      const result: PurchaseRegisterView = {
        money: await moneyOf(c),
        values,
        ...p,
        supplierId,
        withLines,
        rows,
        suppliers: [...bySupplier.values()],
        total: { count: rows.length, receipts: sum('receipt'), returns: sum('return'), net: sum(null) },
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `purchase-register-${p.from}-${p.to}.csv`,
        csv(
          [
            'date',
            'kind',
            'number',
            'supplier',
            'supplier_bill',
            'supplier_bill_date',
            'location',
            'paid_by',
            'due',
            'lines',
            'qty',
            ...(values ? ['total'] : []),
          ],
          [
            ...rows.map((r): Cell[] => [
              r.date,
              r.kind,
              r.number,
              r.supplier,
              r.supplierBillNo,
              r.supplierBillDate,
              r.location,
              r.paidBy,
              r.dueDate,
              r.lineCount,
              r.qty / 1000,
              ...(values ? [r.total] : []),
            ]),
            ['', 'total', '', '', '', '', '', '', '', rows.length, '', ...(values ? [result.total.net] : [])],
          ],
        ),
      );
    }),
  );

  // ---- Purchase and sale rates (RPT-09, owner answer 4): for an item, a supplier or a customer ----
  scope.get('/reports/rates', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const itemId = idOf(q, 'itemId');
      const partyId = idOf(q, 'partyId');
      if (itemId === null && partyId === null) throw new BadRequest('bad_request');
      // A year, though it lists lines: it is for one item or one party (owner answer 4, D-116).
      const p = rangeOf(q, periodOf('thisYear', s.today, s.startMonth), SUMMARY_DAYS, s);
      const values = allowed(req, 'cost.view');
      const item =
        itemId === null
          ? null
          : ((
              await c.query<{ id: string; code: string; name: string }>(
                'SELECT id, code, name FROM erp.items WHERE id = $1',
                [itemId],
              )
            ).rows[0] ?? undefined);
      const party =
        partyId === null
          ? null
          : ((
              await c.query<{ id: string; code: string; name: string }>(
                'SELECT id, code, name FROM erp.parties WHERE id = $1',
                [partyId],
              )
            ).rows[0] ?? undefined);
      if (item === undefined || party === undefined) return reply.code(404).send({ error: 'not_found' });
      type Row = {
        document_id: string;
        number: string | null;
        date: string;
        party: string | null;
        salesman: string | null;
        item_id: string;
        code: string;
        name: string;
        qty: string;
        list_price: string | null;
        rate: string;
        value: string;
      };
      const lineOf =
        (kind: RateLineView['kind']) =>
        (r: Row): RateLineView => ({
          kind,
          documentId: r.document_id,
          number: r.number,
          date: r.date,
          party: r.party,
          salesman: r.salesman,
          itemId: r.item_id,
          code: r.code,
          name: r.name,
          qty: Number(r.qty),
          listPrice: r.list_price === null ? null : Number(r.list_price),
          rate: Number(r.rate),
          netRate: rateOf({ qty: Number(r.qty), value: Number(r.value) }),
          value: Number(r.value),
        });
      const purchases = values
        ? (
            await c.query<Row>(
              `SELECT g.id AS document_id, g.number, g.business_date::text AS date, sp.name AS party, NULL AS salesman,
                 x.item_id, i.code, i.name, (x.qty * 1000)::bigint::text AS qty, NULL AS list_price,
                 x.unit_cost::text AS rate, x.value::text AS value
               FROM erp.goods_receipt_lines x JOIN erp.goods_receipts g ON g.id = x.receipt_id
               JOIN erp.items i ON i.id = x.item_id LEFT JOIN erp.parties sp ON sp.id = g.supplier_party_id
               WHERE g.status = 'posted' AND x.qty > 0 AND g.business_date BETWEEN $1 AND $2
                 AND ($3::uuid IS NULL OR x.item_id = $3) AND ($4::uuid IS NULL OR g.supplier_party_id = $4)
               ORDER BY g.business_date, g.number, x.line_no`,
              [p.from, p.to, itemId, partyId],
            )
          ).rows.map(lineOf('receipt'))
        : null;
      const sales = (
        await c.query<Row>(
          `SELECT d.id AS document_id, d.number, d.business_date::text AS date, cp.name AS party,
             u.full_name AS salesman, l.item_id, i.code, i.name, (l.qty * 1000)::bigint::text AS qty,
             l.list_price::text AS list_price, l.unit_price::text AS rate, l.line_total::text AS value
           FROM erp.sales_lines l JOIN erp.sales_documents d ON d.id = l.document_id
           JOIN erp.items i ON i.id = l.item_id JOIN erp.users u ON u.id = d.salesperson_user_id
           LEFT JOIN erp.parties cp ON cp.id = d.customer_party_id
           WHERE d.status = 'finalized' AND d.deleted_at IS NULL AND l.deleted_at IS NULL AND l.qty > 0
             AND d.business_date BETWEEN $1 AND $2
             AND ($3::uuid IS NULL OR l.item_id = $3) AND ($4::uuid IS NULL OR d.customer_party_id = $4)
           ORDER BY d.business_date, d.created_at_device, d.number, l.line_no`,
          [p.from, p.to, itemId, partyId],
        )
      ).rows.map(lineOf('sale'));
      // Rates of different items don't average: the statistics are for one item.
      const saleStats = item === null ? null : rateStats(sales);
      const purchaseStats = item === null || purchases === null ? null : rateStats(purchases);
      const result: RatesView = {
        money: await moneyOf(c),
        values,
        ...p,
        item,
        party,
        purchases,
        sales,
        purchaseStats,
        saleStats,
        spread: spread(saleStats?.average ?? null, purchaseStats?.average ?? null),
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `rates-${item?.code ?? party?.code ?? ''}-${p.from}-${p.to}.csv`,
        csv(
          [
            'date',
            'kind',
            'number',
            'party',
            'salesman',
            'item',
            'name',
            'qty',
            'list_price',
            'rate',
            'net_rate',
          ],
          [...(purchases ?? []), ...sales]
            .sort((a, b) => byText(a.date, b.date))
            .map((r): Cell[] => [
              r.date,
              r.kind,
              r.number,
              r.party,
              r.salesman,
              r.code,
              r.name,
              r.qty / 1000,
              r.listPrice,
              r.rate,
              r.netRate,
            ]),
        ),
      );
    }),
  );

  // ---- Sales over time (RPT-15, owner answers 5 and 6) ----
  scope.get('/reports/sales-over-time', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const p = rangeOf(q, periodOf('thisMonth', s.today, s.startMonth), SUMMARY_DAYS, s);
      const compare = choiceOf(q, 'compare', SALES_COMPARES, 'previous');
      const values = allowed(req, 'cost.view');
      // Profit needs cost.view: without it the ranking is by sales.
      const asked = choiceOf<SalesRanking>(q, 'by', SALES_RANKINGS, 'sales');
      const by: SalesRanking = asked === 'profit' && !values ? 'sales' : asked;
      choiceOf<GridMeasure>(q, 'measure', GRID_MEASURES, 'bills');
      const before = beforeOf(p, compare);
      const step = trendStep(p);
      const now_ = await overTime(c, p, q);
      const series = (period: Period, o: OverTime) =>
        trendSeries({
          period,
          step,
          days: o.days.map((x) => ({
            date: x.key,
            bills: x.bills,
            sales: x.sales,
            profit: x.sales - x.cost,
          })),
        }).map((t) => ({ ...t, profit: values ? t.profit : null }));
      const trend = series(p, now_);
      const beforeTrend = before === null ? null : series(before, await overTime(c, before, q));

      // Busy hours: each bill once, on its business date's weekday, at its hour on the counter's clock.
      const grid = hourGrid(now_.bills);

      // Top and bottom items.
      const ranked = topAndBottom(
        now_.items.map((x) => ({ id: x.key, qty: x.qty, sales: x.sales, profit: x.sales - x.cost })),
        by,
        TOP_N,
      );
      const itemNames = await namesOf(
        c,
        'item',
        [...ranked.top, ...ranked.bottom].map((x) => x.id),
      );
      const topItem = (x: { id: string; qty: number; sales: number; profit: number }): TopItemView => ({
        itemId: x.id,
        code: itemNames.get(x.id)?.code ?? '',
        name: itemNames.get(x.id)?.name ?? '',
        qty: x.qty,
        sales: x.sales,
        profit: values ? x.profit : null,
      });

      // Discounts given (owner answer 6), with the price approvals on the bills.
      const approvals = async (key: string) =>
        new Map(
          (
            await c.query<{ key: string; n: number }>(
              `SELECT ${key} AS key, count(*)::int AS n FROM erp.overrides o
               JOIN erp.sales_documents d ON d.id = o.document_id
               WHERE d.status = 'finalized' AND d.deleted_at IS NULL AND o.deleted_at IS NULL
                 AND o.kind = ANY($3::text[]) AND d.business_date BETWEEN $1 AND $2
               GROUP BY 1`,
              [p.from, p.to, PRICE_APPROVALS],
            )
          ).rows.map((r) => [r.key, r.n]),
        );
      const discountRow = (key: string, name: string, x: Sums, n: number): DiscountRowView => {
        const f = salesFigures(x);
        return {
          key,
          name,
          listSales: x.listSales,
          sales: x.sales,
          discount: f.discount,
          discountBp: f.discountBp,
          approvals: n,
        };
      };
      const bySalesman = now_.salesmen;
      const sold = now_.total;
      const salesmanNames = await namesOf(
        c,
        'salesman',
        bySalesman.map((x) => x.key),
      );
      const salesmanApprovals = await approvals('d.salesperson_user_id::text');
      const byDay = now_.days;
      const dayApprovals = await approvals('d.business_date::text');
      const result: SalesOverTimeView = {
        money: await moneyOf(c),
        values,
        ...p,
        compare,
        before,
        since: await sinceOf(c, s.today),
        step,
        trend,
        beforeTrend,
        grid,
        by,
        top: ranked.top.map(topItem),
        bottom: ranked.bottom.map(topItem),
        discounts: {
          bySalesman: bySalesman
            .map((x) =>
              discountRow(x.key, salesmanNames.get(x.key)?.name ?? '', x, salesmanApprovals.get(x.key) ?? 0),
            )
            .sort((a, b) => b.discount - a.discount || NAMES.compare(a.name, b.name)),
          byDay: byDay
            .map((x) => discountRow(x.key, x.key, x, dayApprovals.get(x.key) ?? 0))
            .sort((a, b) => byText(a.key, b.key)),
          total: discountRow(
            '',
            '',
            sold,
            [...salesmanApprovals.values()].reduce((t, n) => t + n, 0),
          ),
        },
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `sales-over-time-${p.from}-${p.to}.csv`,
        csv(
          [
            'from',
            'to',
            'bills',
            'sales',
            ...(values ? ['profit'] : []),
            ...(before ? ['before_sales'] : []),
          ],
          trend.map((t, i): Cell[] => [
            t.from,
            t.to,
            t.bills,
            t.sales,
            ...(values ? [t.profit] : []),
            ...(beforeTrend ? [beforeTrend[i]?.sales ?? null] : []),
          ]),
        ),
      );
    }),
  );
}
