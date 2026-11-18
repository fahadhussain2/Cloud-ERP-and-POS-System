import {
  DEAD_DAYS,
  STOCK_GROUPS,
  type AbcClassView,
  type AnalysisRow,
  type AnalysisView,
  type DeadStockRow,
  type DeadStockView,
  type ReorderRow,
  type ReorderView,
  type StockAgeKindView,
  type StockAtCells,
  type StockAtView,
  type StockChoicesView,
  type StockGroup,
  type StockLedgerLine,
  type StockLedgerView,
  type StockLine,
  type StockMovementCells,
  type StockMovementView,
  type StockQtyValue,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import {
  abcClasses,
  can,
  daysOfCover,
  groupRows,
  MOVEMENT_BUCKETS,
  normalizeIdentifier,
  periodOf,
  reorderLine,
  SLOW_WINDOW_DAYS,
  stockAge,
  stockMovement,
  turnover,
  type Permission,
  type QtyValue,
} from '@erp/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requirePermission } from '../auth/routes';
import { BadRequest, dateOr, dayBefore, LIST_DAYS, rangeOf, shop, SUMMARY_DAYS } from './financial';
import { csv, moneyOf, sendCsv, type Cell } from './routes';

// The stock reports (W2-02 plan; RPT-08, RPT-12, RPT-13, RPT-14, PUR-07 list; D-110, D-116): read only, computed on
// request from the stock ledger (stock_movements) and the bills inside withTenant under the app role (rule 5); the rules
// in @erp/domain's stock-reports.ts. Every report needs reports.view; values, costs and profit need cost.view and are
// left out without it (owner answer 8). Values are the books' (Σ value_delta), so stock at a date equals Inventory on
// the balance sheet (owner answer 2). Dates are business dates. Every report downloads as CSV.

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

type Client = pg.ClientBase;
type Query = Record<string, string | undefined>;
type Shop = { today: string; startMonth: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The screen shows at most this many rows; totals, subtotals and the CSV count every one (as the W1-20 stock report). */
export const STOCK_ROWS = 2000;
/** The Shop and the Godown: the stock the reorder list and dead stock count (owner answer 4, PUR-07). */
const ON_HAND_KINDS = ['shop', 'storage'];

/** A LIKE pattern's own %, _ and \ taken literally (as purchasing's item search). */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (x) => `\\${x}`);
const num = (v: string | number | null) => (v === null ? null : Number(v));
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** A uuid filter, or null; anything else is a 400. */
const idOf = (q: Query, key: string) => {
  const v = q[key] || null;
  if (v !== null && !UUID.test(v)) throw new BadRequest('bad_request');
  return v;
};

/** The facts of the items a stock list shows, filtered (category, make, brand, supplier, words), by code. */
interface Facts {
  id: string;
  code: string;
  name: string;
  category: string | null;
  make: string | null;
  brand: string | null;
  supplierId: string | null;
  supplier: string | null;
  status: 'active' | 'dormant' | 'discontinued';
  min: number | null;
  max: number | null;
  excluded: boolean;
  lastCost: number | null;
}

/**
 * The items' facts, in code order, keeping only those the filters allow. `ids` null = every item. The make is the
 * first one the item was set to fit (owner answer 3); the supplier its last, else its default (owner answer 4).
 */
async function factsOf(c: Client, ids: string[] | null, q: Query): Promise<Facts[]> {
  const params: unknown[] = [ids];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  const category = idOf(q, 'categoryId');
  const brand = idOf(q, 'brandId');
  const make = idOf(q, 'makeId');
  const supplier = idOf(q, 'supplierId');
  if (category) where.push(`i.category_id = ${add(category)}`);
  if (brand) where.push(`i.brand_id = ${add(brand)}`);
  if (make)
    where.push(`EXISTS (SELECT 1 FROM erp.item_compatibility x WHERE x.item_id = i.id AND x.deleted_at IS NULL
                AND x.make_id = ${add(make)})`);
  if (supplier) where.push(`coalesce(k.last_supplier_id, i.default_supplier_id) = ${add(supplier)}`);
  const text = (q['q'] ?? '').trim();
  if (text !== '') {
    const words = text.split(/\s+/).map((w) => `%${likeEscape(w)}%`);
    const p = add(words);
    const n = add(likeEscape(normalizeIdentifier(text)));
    where.push(`(NOT EXISTS (SELECT 1 FROM unnest(${p}::text[]) w WHERE NOT (i.code ILIKE w OR i.name ILIKE w))
      OR EXISTS (SELECT 1 FROM erp.item_identifiers x WHERE x.item_id = i.id AND x.deleted_at IS NULL
                 AND x.normalized_value LIKE ${n} || '%'))`);
  }
  const { rows } = await c.query<{
    id: string;
    code: string;
    name: string;
    category: string | null;
    make: string | null;
    brand: string | null;
    supplier_id: string | null;
    supplier: string | null;
    status: Facts['status'];
    min: string | null;
    max: string | null;
    excluded: boolean;
    last_cost: string | null;
  }>(
    `WITH mk AS (
       SELECT DISTINCT ON (x.item_id) x.item_id, vm.name FROM erp.item_compatibility x
       JOIN erp.vehicle_makes vm ON vm.id = x.make_id
       WHERE x.make_id IS NOT NULL AND x.deleted_at IS NULL ORDER BY x.item_id, x.created_at, x.id
     )
     SELECT i.id, i.code, i.name, cat.name AS category, mk.name AS make, b.name AS brand,
       coalesce(k.last_supplier_id, i.default_supplier_id) AS supplier_id, sp.name AS supplier, i.status,
       (i.min_qty * 1000)::bigint::text AS min, (i.max_qty * 1000)::bigint::text AS max,
       i.exclude_from_reorder AS excluded, k.last_cost::text AS last_cost
     FROM erp.items i
     LEFT JOIN erp.categories cat ON cat.id = i.category_id
     LEFT JOIN mk ON mk.item_id = i.id
     LEFT JOIN erp.brands b ON b.id = i.brand_id
     LEFT JOIN erp.item_costs k ON k.item_id = i.id
     LEFT JOIN erp.parties sp ON sp.id = coalesce(k.last_supplier_id, i.default_supplier_id)
     WHERE ($1::uuid[] IS NULL OR i.id = ANY($1::uuid[])) ${where.map((w) => `AND ${w}`).join(' ')}
     ORDER BY i.code`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    category: r.category,
    make: r.make,
    brand: r.brand,
    supplierId: r.supplier_id,
    supplier: r.supplier,
    status: r.status,
    min: num(r.min),
    max: num(r.max),
    excluded: r.excluded,
    lastCost: num(r.last_cost),
  }));
}

async function locationsOf(c: Client) {
  const { rows } = await c.query<{ id: string; code: string; name: string; kind: string }>(
    `SELECT id, code, name, kind FROM erp.locations ORDER BY code`,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** The first day the system knows: the opening's date, else the first movement's, else today (owner answer 1). */
async function sinceOf(c: Client, today: string): Promise<string> {
  const { rows } = await c.query<{ d: string | null }>(
    `SELECT coalesce(min(business_date) FILTER (WHERE source_type = 'opening'), min(business_date))::text AS d
     FROM erp.stock_movements`,
  );
  const d = rows[0]!.d;
  return d !== null && d < today ? d : today;
}

/** Per item (and location, if `perLocation`): Σ quantity and value of the movements on or before `at`. */
async function stockAt(
  c: Client,
  at: string,
  locationId: string | null,
  perLocation: boolean,
  kinds?: string[],
) {
  const { rows } = await c.query<{ item_id: string; location_id: string | null; qty: string; value: string }>(
    `SELECT m.item_id, ${perLocation ? 'm.location_id' : 'NULL::uuid'} AS location_id,
       (sum(m.qty_delta) * 1000)::bigint::text AS qty, sum(m.value_delta)::text AS value
     FROM erp.stock_movements m
     WHERE m.business_date <= $1 AND ($2::uuid IS NULL OR m.location_id = $2)
       AND ($3::text[] IS NULL OR m.location_id IN (SELECT id FROM erp.locations WHERE kind = ANY($3::text[])))
     GROUP BY 1, 2 HAVING sum(m.qty_delta) <> 0 OR sum(m.value_delta) <> 0`,
    [at, locationId, kinds ?? null],
  );
  return rows.map((r) => ({
    itemId: r.item_id,
    locationId: r.location_id,
    qty: Number(r.qty),
    value: Number(r.value),
  }));
}

/** Per item: net quantity sold and its amount, and the last day sold, on finalized bills between two dates. */
async function salesOf(c: Client, from: string, to: string, ids: string[] | null) {
  const { rows } = await c.query<{ item_id: string; qty: string; amount: string; last: string | null }>(
    `SELECT l.item_id, (sum(l.qty) * 1000)::bigint::text AS qty, sum(l.line_total)::text AS amount,
       max(d.business_date) FILTER (WHERE l.qty > 0)::text AS last
     FROM erp.sales_lines l JOIN erp.sales_documents d ON d.id = l.document_id
     WHERE d.status = 'finalized' AND d.deleted_at IS NULL AND l.deleted_at IS NULL
       AND d.business_date BETWEEN $1 AND $2 AND ($3::uuid[] IS NULL OR l.item_id = ANY($3::uuid[]))
     GROUP BY l.item_id`,
    [from, to, ids],
  );
  return new Map(
    rows.map((r) => [r.item_id, { qty: Number(r.qty), amount: Number(r.amount), last: r.last }]),
  );
}

/** Per item: the last day stock was received from a supplier (a goods receipt). */
async function lastReceipts(c: Client, ids: string[]) {
  const { rows } = await c.query<{ item_id: string; d: string }>(
    `SELECT item_id, max(business_date)::text AS d FROM erp.stock_movements
     WHERE source_type = 'goods_receipt' AND item_id = ANY($1::uuid[]) GROUP BY item_id`,
    [ids],
  );
  return new Map(rows.map((r) => [r.item_id, r.d]));
}

/** The group path of a row (owner answer 3). */
function pathOf(group: StockGroup, f: Facts, location: string | null): string[] {
  switch (group) {
    case 'category':
      return [f.category ?? '', f.make ?? ''];
    case 'brand':
      return [f.brand ?? ''];
    case 'location':
      return [location ?? ''];
    case 'supplier':
      return [f.supplier ?? ''];
    case 'none':
      return [];
  }
}
const depthOf = (group: StockGroup) => (group === 'category' ? 2 : group === 'none' ? 0 : 1);

/** Grouped lines for the screen, cut after STOCK_ROWS rows; the groups' subtotals still count every row. */
function linesOf<
  C,
  R extends { key: string; itemId: string; code: string; name: string; location: string | null },
>(
  rows: R[],
  group: StockGroup,
  facts: Map<string, Facts>,
  values: (r: R) => number[],
  cells: (v: number[]) => C,
): { lines: StockLine<C>[]; truncated: boolean; total: { count: number; values: number[] } } {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const g = groupRows({
    rows: rows.map((r) => ({
      key: r.key,
      group: pathOf(group, facts.get(r.itemId)!, r.location),
      values: values(r),
    })),
    depth: depthOf(group),
  });
  const lines: StockLine<C>[] = [];
  let shown = 0;
  for (const l of g.lines) {
    if (l.kind === 'row') {
      if (shown === STOCK_ROWS) break;
      shown += 1;
      const r = byKey.get(l.key)!;
      lines.push({
        kind: 'row',
        depth: l.depth,
        itemId: r.itemId,
        code: r.code,
        name: r.name,
        location: r.location,
        cells: cells(l.values),
      });
    } else
      lines.push({
        kind: 'group',
        depth: l.depth,
        path: l.path,
        name: l.name,
        count: l.count,
        cells: cells(l.values),
      });
  }
  return { lines, truncated: rows.length > STOCK_ROWS, total: g.total };
}

const groupOf = (q: Query): StockGroup => {
  const g = q['group'] || 'category';
  if (!(STOCK_GROUPS as readonly string[]).includes(g)) throw new BadRequest('bad_request');
  return g as StockGroup;
};

export function registerStockReports(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
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

  // ---- The filters' choices ----
  scope.get('/reports/stock-choices', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c): Promise<StockChoicesView> => {
      const names = async (table: string) =>
        (
          await c.query<{ id: string; name: string }>(
            `SELECT id, name FROM erp.${table} WHERE deleted_at IS NULL ORDER BY lower(name), name`,
          )
        ).rows;
      const categories = await names('categories');
      const makes = await names('vehicle_makes');
      const brands = await names('brands');
      const locations = (
        await c.query<{ id: string; code: string; name: string }>(
          `SELECT id, code, name FROM erp.locations WHERE deleted_at IS NULL ORDER BY code`,
        )
      ).rows;
      const suppliers = (
        await c.query<{ id: string; code: string; name: string }>(
          `SELECT p.id, p.code, p.name FROM erp.parties p
           JOIN erp.supplier_accounts s ON s.party_id = p.id AND s.deleted_at IS NULL
           WHERE p.deleted_at IS NULL ORDER BY lower(p.name), p.code`,
        )
      ).rows;
      return { categories, makes, brands, locations, suppliers };
    }),
  );

  // ---- Items for the item picker (the stock ledger): code, name words, a barcode or an OEM number ----
  scope.get('/reports/items', { preHandler: view }, async (req, reply) => {
    const text = (query(req)['q'] ?? '').trim();
    if (text === '') return { items: [] };
    return run(req, reply, async (c) => {
      const words = text.split(/\s+/).map((w) => `%${likeEscape(w)}%`);
      const { rows } = await c.query<{ id: string; code: string; name: string }>(
        `SELECT i.id, i.code, i.name FROM erp.items i
         WHERE i.deleted_at IS NULL
           AND (NOT EXISTS (SELECT 1 FROM unnest($1::text[]) w WHERE NOT (i.code ILIKE w OR i.name ILIKE w))
             OR EXISTS (SELECT 1 FROM erp.item_identifiers x WHERE x.item_id = i.id AND x.deleted_at IS NULL
                        AND x.normalized_value LIKE $2 || '%'))
         ORDER BY i.code LIMIT 20`,
        [words, likeEscape(normalizeIdentifier(text))],
      );
      return { items: rows };
    });
  });

  // ---- Stock at a date (RPT-13, owner answers 2 and 3) ----
  scope.get('/reports/stock-at', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const at = dateOr(q['at'], s.today);
      const group = groupOf(q);
      const locationId = idOf(q, 'locationId');
      const negativeOnly = q['negative'] === 'only';
      const values = allowed(req, 'cost.view');
      const perLocation = group === 'location' || locationId !== null;
      const stock = (await stockAt(c, at, locationId, perLocation)).filter((x) => !negativeOnly || x.qty < 0);
      const facts = await factsOf(c, [...new Set(stock.map((x) => x.itemId))], q);
      const byItem = new Map(facts.map((f) => [f.id, f]));
      const locations = await locationsOf(c);
      const order = new Map(facts.map((f, i) => [f.id, i]));
      const rows = stock
        .filter((x) => byItem.has(x.itemId))
        .map((x) => {
          const f = byItem.get(x.itemId)!;
          const location = x.locationId === null ? null : locations.get(x.locationId)!.code;
          return {
            ...x,
            key: `${x.itemId}:${x.locationId ?? ''}`,
            code: f.code,
            name: f.name,
            location,
          };
        })
        .sort(
          (a, b) =>
            order.get(a.itemId)! - order.get(b.itemId)! || (a.location ?? '').localeCompare(b.location ?? ''),
        );
      const cells = (v: number[]): StockAtCells => ({ qty: v[0] ?? 0, value: values ? (v[1] ?? 0) : null });
      const g = linesOf(rows, group, byItem, (r) => [r.qty, r.value], cells);
      const result: StockAtView = {
        money: await moneyOf(c),
        values,
        at,
        group,
        locationId,
        negativeOnly,
        lines: g.lines,
        truncated: g.truncated,
        total: { count: g.total.count, ...cells(g.total.values) },
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `stock-at-${at}.csv`,
        csv(
          [
            'item',
            'name',
            'category',
            'make',
            'brand',
            'supplier',
            'location',
            'qty',
            ...(values ? ['value'] : []),
          ],
          [
            ...rows.map((r): Cell[] => {
              const f = byItem.get(r.itemId)!;
              return [
                r.code,
                r.name,
                f.category,
                f.make,
                f.brand,
                f.supplier,
                r.location,
                r.qty / 1000,
                ...(values ? [r.value] : []),
              ];
            }),
            [
              '',
              'total',
              '',
              '',
              '',
              '',
              '',
              g.total.values[0]! / 1000,
              ...(values ? [g.total.values[1]!] : []),
            ],
          ],
        ),
      );
    }),
  );

  // ---- Stock movement (RPT-13): opening, purchases, returns, sales, adjustments, transfers, closing ----
  scope.get('/reports/stock-movement', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const p = rangeOf(q, periodOf('thisMonth', s.today, s.startMonth), SUMMARY_DAYS, s);
      const group = groupOf(q);
      const locationId = idOf(q, 'locationId');
      const values = allowed(req, 'cost.view');
      const perLocation = group === 'location' || locationId !== null;
      const loc = perLocation ? 'm.location_id' : 'NULL::uuid';
      const opening = await stockAt(c, dayBefore(p.from), locationId, perLocation);
      const moves = await c.query<{
        item_id: string;
        location_id: string | null;
        source_type: string;
        qty: string;
        value: string;
      }>(
        `SELECT m.item_id, ${loc} AS location_id, m.source_type, (sum(m.qty_delta) * 1000)::bigint::text AS qty,
           sum(m.value_delta)::text AS value
         FROM erp.stock_movements m
         WHERE m.business_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR m.location_id = $3)
         GROUP BY 1, 2, 3, sign(m.qty_delta)`,
        [p.from, p.to, locationId],
      );
      const keyOf = (item: string, location: string | null) => `${item}:${location ?? ''}`;
      const items = new Map<
        string,
        {
          itemId: string;
          locationId: string | null;
          opening: QtyValue;
          moves: { source: string; qty: number; value: number }[];
        }
      >();
      const entry = (itemId: string, locationId: string | null) => {
        const k = keyOf(itemId, locationId);
        const e = items.get(k) ?? { itemId, locationId, opening: { qty: 0, value: 0 }, moves: [] };
        items.set(k, e);
        return e;
      };
      for (const o of opening) entry(o.itemId, o.locationId).opening = { qty: o.qty, value: o.value };
      for (const m of moves.rows)
        entry(m.item_id, m.location_id).moves.push({
          source: m.source_type,
          qty: Number(m.qty),
          value: Number(m.value),
        });
      const facts = await factsOf(c, [...new Set([...items.values()].map((x) => x.itemId))], q);
      const byItem = new Map(facts.map((f) => [f.id, f]));
      const order = new Map(facts.map((f, i) => [f.id, i]));
      const locations = await locationsOf(c);
      const rows = [...items.entries()]
        .filter(([, x]) => byItem.has(x.itemId))
        .map(([key, x]) => {
          const f = byItem.get(x.itemId)!;
          const location = x.locationId === null ? null : locations.get(x.locationId)!.code;
          return { key, itemId: f.id, code: f.code, name: f.name, location, m: stockMovement(x) };
        })
        .sort(
          (a, b) =>
            order.get(a.itemId)! - order.get(b.itemId)! || (a.location ?? '').localeCompare(b.location ?? ''),
        );
      const flat = (m: ReturnType<typeof stockMovement>) =>
        [m.opening, ...MOVEMENT_BUCKETS.map((b) => m.buckets[b]), m.closing].flatMap((x) => [x.qty, x.value]);
      const cells = (v: number[]): StockMovementCells => {
        const qv = (i: number): StockQtyValue => ({
          qty: v[i * 2] ?? 0,
          value: values ? (v[i * 2 + 1] ?? 0) : null,
        });
        return {
          opening: qv(0),
          openings: qv(1),
          purchases: qv(2),
          purchaseReturns: qv(3),
          sales: qv(4),
          salesReturns: qv(5),
          adjustments: qv(6),
          transfersIn: qv(7),
          transfersOut: qv(8),
          closing: qv(9),
        };
      };
      const g = linesOf(rows, group, byItem, (r) => flat(r.m), cells);
      const result: StockMovementView = {
        money: await moneyOf(c),
        values,
        ...p,
        group,
        locationId,
        lines: g.lines,
        truncated: g.truncated,
        total: { count: g.total.count, ...cells(g.total.values) },
      };
      if (!wantsCsv(req)) return result;
      const names = ['opening', ...MOVEMENT_BUCKETS, 'closing'];
      const pairs = (v: number[]) =>
        names.flatMap((_, i) => [v[i * 2]! / 1000, ...(values ? [v[i * 2 + 1]!] : [])]);
      return sendCsv(
        reply,
        `stock-movement-${p.from}-${p.to}.csv`,
        csv(
          [
            'item',
            'name',
            'category',
            'make',
            'location',
            ...names.flatMap((n) => [`${n}_qty`, ...(values ? [`${n}_value`] : [])]),
          ],
          [
            ...rows.map((r): Cell[] => {
              const f = byItem.get(r.itemId)!;
              return [r.code, r.name, f.category, f.make, r.location, ...pairs(flat(r.m))];
            }),
            ['', 'total', '', '', '', ...pairs(g.total.values)],
          ],
        ),
      );
    }),
  );

  // ---- Stock ledger (RPT-12, owner answer 6): one item's documents, with the opening and running balance ----
  scope.get('/reports/stock-ledger', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const itemId = idOf(q, 'itemId');
      if (itemId === null) throw new BadRequest('bad_request');
      const p = rangeOf(q, periodOf('thisMonth', s.today, s.startMonth), LIST_DAYS, s);
      const locationId = idOf(q, 'locationId');
      const values = allowed(req, 'cost.view');
      const item = (
        await c.query<{ id: string; code: string; name: string }>(
          'SELECT id, code, name FROM erp.items WHERE id = $1',
          [itemId],
        )
      ).rows[0];
      if (!item) return reply.code(404).send({ error: 'not_found' });
      const opening = (
        await c.query<{ qty: string; value: string }>(
          `SELECT (coalesce(sum(qty_delta), 0) * 1000)::bigint::text AS qty, coalesce(sum(value_delta), 0)::text AS value
           FROM erp.stock_movements WHERE item_id = $1 AND business_date < $2 AND ($3::uuid IS NULL OR location_id = $3)`,
          [itemId, p.from, locationId],
        )
      ).rows[0]!;
      const { rows } = await c.query<{
        seq: string;
        date: string;
        kind: string;
        document_id: string;
        number: string | null;
        location: string;
        qty: string;
        value: string;
      }>(
        `SELECT m.posting_seq::text AS seq, m.business_date::text AS date, m.source_type AS kind,
           CASE WHEN m.source_type = 'stock_transfer_receipt' THEN tr.id ELSE m.source_id END AS document_id,
           coalesce(sd.number, g.number, pr.number, t.number, tr.number, a.number, v.number, o.label) AS number,
           l.code AS location, (m.qty_delta * 1000)::bigint::text AS qty, m.value_delta::text AS value
         FROM erp.stock_movements m
         JOIN erp.locations l ON l.id = m.location_id
         LEFT JOIN erp.sales_documents sd ON m.source_type = 'sale' AND sd.id = m.source_id
         LEFT JOIN erp.goods_receipts g ON m.source_type = 'goods_receipt' AND g.id = m.source_id
         LEFT JOIN erp.purchase_returns pr ON m.source_type = 'purchase_return' AND pr.id = m.source_id
         LEFT JOIN erp.stock_transfers t ON m.source_type = 'stock_transfer' AND t.id = m.source_id
         LEFT JOIN erp.stock_transfers tr ON m.source_type = 'stock_transfer_receipt' AND tr.receipt_id = m.source_id
         LEFT JOIN erp.stock_adjustments a ON m.source_type = 'stock_adjustment' AND a.id = m.source_id
         LEFT JOIN erp.sales_voids v ON m.source_type = 'sales_void' AND v.id = m.source_id
         LEFT JOIN erp.opening_balances o ON m.source_type = 'opening' AND o.id = m.source_id
         WHERE m.item_id = $1 AND m.business_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR m.location_id = $4)
         ORDER BY m.business_date, m.posting_seq, m.source_line_id NULLS FIRST, m.qty_delta, m.id`,
        [itemId, p.from, p.to, locationId],
      );
      let balance = Number(opening.qty);
      let balanceValue = Number(opening.value);
      const inn = { qty: 0, value: 0 };
      const out = { qty: 0, value: 0 };
      const all: StockLedgerLine[] = rows.map((r) => {
        const qty = Number(r.qty);
        const value = Number(r.value);
        balance += qty;
        balanceValue += value;
        const side = qty > 0 || (qty === 0 && value >= 0) ? inn : out;
        side.qty += qty;
        side.value += value;
        return {
          seq: Number(r.seq),
          date: r.date,
          kind: r.kind,
          documentId: r.document_id,
          number: r.number,
          locationCode: r.location,
          qty,
          value: values ? value : null,
          balance,
          balanceValue: values ? balanceValue : null,
        };
      });
      const qv = (x: { qty: number; value: number }): StockQtyValue => ({
        qty: x.qty,
        value: values ? x.value : null,
      });
      const result: StockLedgerView = {
        money: await moneyOf(c),
        values,
        item,
        ...p,
        locationId,
        opening: qv({ qty: Number(opening.qty), value: Number(opening.value) }),
        lines: all.slice(0, STOCK_ROWS),
        truncated: all.length > STOCK_ROWS,
        in: qv(inn),
        out: qv(out),
        closing: qv({ qty: balance, value: balanceValue }),
      };
      if (!wantsCsv(req)) return result;
      const v = (x: number | null): Cell[] => (values ? [x] : []);
      return sendCsv(
        reply,
        `stock-ledger-${item.code}-${p.from}-${p.to}.csv`,
        csv(
          [
            'date',
            'document',
            'kind',
            'location',
            'qty',
            ...(values ? ['value'] : []),
            'balance',
            ...(values ? ['balance_value'] : []),
          ],
          [
            ['', '', 'opening', '', '', ...v(null), result.opening.qty / 1000, ...v(result.opening.value)],
            ...all.map((l): Cell[] => [
              l.date,
              l.number,
              l.kind,
              l.locationCode,
              l.qty / 1000,
              ...v(l.value),
              l.balance / 1000,
              ...v(l.balanceValue),
            ]),
            ['', '', 'closing', '', '', ...v(null), result.closing.qty / 1000, ...v(result.closing.value)],
          ],
        ),
      );
    }),
  );

  // ---- The reorder list (PUR-07 list, owner answer 4): always today ----
  scope.get('/reports/reorder', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const values = allowed(req, 'cost.view');
      const since = await sinceOf(c, s.today);
      const onHand = new Map(
        (await stockAt(c, s.today, null, false, ON_HAND_KINDS)).map((x) => [x.itemId, x.qty]),
      );
      const facts = await factsOf(c, null, q);
      const listed = facts.flatMap((f) => {
        const line = reorderLine({
          onHand: onHand.get(f.id) ?? 0,
          min: f.min,
          max: f.max,
          excluded: f.excluded,
          status: f.status,
        });
        return line ? [{ f, line }] : [];
      });
      const ids = listed.map((x) => x.f.id);
      const recent = await salesOf(c, addDays(s.today, -(SLOW_WINDOW_DAYS - 1)), s.today, ids);
      const recent30 = await salesOf(c, addDays(s.today, -29), s.today, ids);
      const receipts = await lastReceipts(c, ids);
      const window = Math.min(SLOW_WINDOW_DAYS, (Date.parse(s.today) - Date.parse(since)) / 86_400_000 + 1);
      const all: ReorderRow[] = listed
        .map(({ f, line }) => {
          const stock = onHand.get(f.id) ?? 0;
          const sold90 = recent.get(f.id)?.qty ?? 0;
          return {
            itemId: f.id,
            code: f.code,
            name: f.name,
            category: f.category,
            supplierId: f.supplierId,
            supplier: f.supplier,
            onHand: stock,
            min: f.min!,
            max: f.max!,
            order: line.order,
            levelsNeedFixing: line.levelsNeedFixing,
            lastCost: values ? f.lastCost : null,
            orderValue: values && f.lastCost !== null ? Math.round((line.order * f.lastCost) / 1000) : null,
            lastReceipt: receipts.get(f.id) ?? null,
            sold30: recent30.get(f.id)?.qty ?? 0,
            sold90,
            daysOfCover: daysOfCover(stock, sold90, window),
          };
        })
        .sort(
          (a, b) =>
            Number(a.supplier === null) - Number(b.supplier === null) ||
            (a.supplier ?? '').localeCompare(b.supplier ?? '', 'en', { sensitivity: 'base' }) ||
            (a.supplierId ?? '').localeCompare(b.supplierId ?? '') ||
            (a.code < b.code ? -1 : 1),
        );
      const suppliers: ReorderView['suppliers'] = [];
      for (const r of all) {
        const last = suppliers.at(-1);
        if (last && last.supplierId === r.supplierId) {
          last.count += 1;
          if (last.value !== null) last.value += r.orderValue ?? 0;
        } else
          suppliers.push({
            supplierId: r.supplierId,
            supplier: r.supplier,
            count: 1,
            value: values ? (r.orderValue ?? 0) : null,
          });
      }
      const result: ReorderView = {
        money: await moneyOf(c),
        values,
        today: s.today,
        since,
        rows: all.slice(0, STOCK_ROWS),
        suppliers,
        truncated: all.length > STOCK_ROWS,
        total: { count: all.length, value: values ? all.reduce((t, r) => t + (r.orderValue ?? 0), 0) : null },
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `reorder-${s.today}.csv`,
        csv(
          [
            'supplier',
            'item',
            'name',
            'category',
            'on_hand',
            'min',
            'max',
            'order',
            'levels_need_fixing',
            ...(values ? ['last_cost', 'order_value'] : []),
            'last_receipt',
            'sold_30',
            'sold_90',
            'days_of_cover',
          ],
          all.map((r): Cell[] => [
            r.supplier,
            r.code,
            r.name,
            r.category,
            r.onHand / 1000,
            r.min / 1000,
            r.max / 1000,
            r.order / 1000,
            r.levelsNeedFixing ? 'yes' : '',
            ...(values ? [r.lastCost, r.orderValue] : []),
            r.lastReceipt,
            r.sold30 / 1000,
            r.sold90 / 1000,
            r.daysOfCover,
          ]),
        ),
      );
    }),
  );

  // ---- Dead and slow stock (RPT-08, owner answers 1 and 5): always today ----
  scope.get('/reports/dead-stock', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const days = Number(q['days'] || 90);
      if (!(DEAD_DAYS as readonly number[]).includes(days)) throw new BadRequest('bad_request');
      const values = allowed(req, 'cost.view');
      const since = await sinceOf(c, s.today);
      const stock = (await stockAt(c, s.today, null, false, ON_HAND_KINDS)).filter((x) => x.qty > 0);
      const facts = await factsOf(
        c,
        stock.map((x) => x.itemId),
        q,
      );
      const ids = facts.map((f) => f.id);
      const byItem = new Map(stock.map((x) => [x.itemId, x]));
      const ever = await salesOf(c, since, s.today, ids);
      const recent = await salesOf(c, addDays(s.today, -(SLOW_WINDOW_DAYS - 1)), s.today, ids);
      const receipts = await lastReceipts(c, ids);
      const all: DeadStockRow[] = facts.flatMap((f) => {
        const x = byItem.get(f.id)!;
        const sold90 = recent.get(f.id)?.qty ?? 0;
        const lastSale = ever.get(f.id)?.last ?? null;
        const age = stockAge({ onHand: x.qty, lastSale, sold: sold90, today: s.today, days, since });
        if (age.kind === 'moving' || age.kind === 'none') return [];
        return [
          {
            itemId: f.id,
            code: f.code,
            name: f.name,
            category: f.category,
            make: f.make,
            kind: age.kind,
            onHand: x.qty,
            value: values ? x.value : null,
            lastSale,
            lastReceipt: receipts.get(f.id) ?? null,
            sold90,
            daysSinceSale: age.daysSinceSale,
            daysOfCover: age.daysOfCover,
          },
        ];
      });
      const kinds: StockAgeKindView[] = ['dead', 'notSoldSinceGoLive', 'slow'];
      const totals = Object.fromEntries(
        kinds.map((k) => {
          const rows = all.filter((r) => r.kind === k);
          return [
            k,
            { count: rows.length, value: values ? rows.reduce((t, r) => t + (r.value ?? 0), 0) : null },
          ];
        }),
      ) as DeadStockView['totals'];
      const result: DeadStockView = {
        money: await moneyOf(c),
        values,
        today: s.today,
        since,
        days,
        rows: all.slice(0, STOCK_ROWS),
        truncated: all.length > STOCK_ROWS,
        totals,
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `dead-stock-${days}-${s.today}.csv`,
        csv(
          [
            'kind',
            'item',
            'name',
            'category',
            'make',
            'on_hand',
            ...(values ? ['value'] : []),
            'last_sale',
            'last_receipt',
            'sold_90',
            'days_since_sale',
            'days_of_cover',
          ],
          all.map((r): Cell[] => [
            r.kind,
            r.code,
            r.name,
            r.category,
            r.make,
            r.onHand / 1000,
            ...(values ? [r.value] : []),
            r.lastSale,
            r.lastReceipt,
            r.sold90 / 1000,
            r.daysSinceSale,
            r.daysOfCover,
          ]),
        ),
      );
    }),
  );

  // ---- Inventory analysis (RPT-14, owner answer 7): ABC, turnover, days of cover ----
  scope.get('/reports/inventory-analysis', { preHandler: view }, async (req, reply) =>
    run(req, reply, async (c, s) => {
      const q = query(req);
      const p = rangeOf(q, { from: addDays(s.today, -364), to: s.today }, SUMMARY_DAYS, s);
      const values = allowed(req, 'cost.view');
      const since = await sinceOf(c, s.today);
      const sales = await salesOf(c, p.from, p.to, null);
      const costs = new Map(
        (
          await c.query<{ item_id: string; cost: string }>(
            `SELECT m.item_id, (-sum(m.value_delta))::text AS cost FROM erp.stock_movements m
             JOIN erp.sales_documents d ON d.id = m.source_id AND d.status = 'finalized'
             WHERE m.source_type = 'sale' AND d.business_date BETWEEN $1 AND $2 GROUP BY m.item_id`,
            [p.from, p.to],
          )
        ).rows.map((r) => [r.item_id, Number(r.cost)]),
      );
      const closing = await stockAt(c, p.to, null, false);
      const openingValue = (await stockAt(c, dayBefore(p.from), null, false)).reduce(
        (t, x) => t + x.value,
        0,
      );
      const closingValue = closing.reduce((t, x) => t + x.value, 0);
      const stockOf = new Map(closing.map((x) => [x.itemId, x]));
      const facts = await factsOf(c, [...new Set([...sales.keys(), ...stockOf.keys()])], q);
      const sold = facts.filter((f) => sales.has(f.id));
      const salesAbc = new Map(
        abcClasses(sold.map((f) => ({ id: f.id, amount: sales.get(f.id)!.amount }))).map((r) => [
          r.id,
          r.class,
        ]),
      );
      const profitOf = (id: string) => sales.get(id)!.amount - (costs.get(id) ?? 0);
      const profitAbc = new Map(
        abcClasses(sold.map((f) => ({ id: f.id, amount: profitOf(f.id) }))).map((r) => [r.id, r.class]),
      );
      const days = (Date.parse(p.to) - Date.parse(p.from < since ? since : p.from)) / 86_400_000 + 1;
      const all: AnalysisRow[] = sold
        .map((f) => {
          const x = sales.get(f.id)!;
          const st = stockOf.get(f.id);
          return {
            itemId: f.id,
            code: f.code,
            name: f.name,
            category: f.category,
            qtySold: x.qty,
            sales: x.amount,
            profit: values ? profitOf(f.id) : null,
            salesClass: salesAbc.get(f.id) ?? null,
            profitClass: values ? (profitAbc.get(f.id) ?? null) : null,
            onHand: st?.qty ?? 0,
            stockValue: values ? (st?.value ?? 0) : null,
            daysOfCover: daysOfCover(st?.qty ?? 0, x.qty, Math.max(days, 1)),
          };
        })
        .sort((a, b) => b.sales - a.sales || (a.code < b.code ? -1 : 1));
      const classes = Object.fromEntries(
        (['A', 'B', 'C'] as AbcClassView[]).map((k) => {
          const rows = all.filter((r) => r.salesClass === k);
          return [
            k,
            {
              count: rows.length,
              sales: rows.reduce((t, r) => t + r.sales, 0),
              profit: values ? rows.reduce((t, r) => t + (r.profit ?? 0), 0) : null,
            },
          ];
        }),
      ) as AnalysisView['classes'];
      const unsold = facts.filter((f) => !sales.has(f.id) && (stockOf.get(f.id)?.qty ?? 0) > 0);
      const costOfSales = [...costs.values()].reduce((t, x) => t + x, 0);
      const result: AnalysisView = {
        money: await moneyOf(c),
        values,
        ...p,
        since,
        rows: all.slice(0, STOCK_ROWS),
        truncated: all.length > STOCK_ROWS,
        classes,
        unsold: {
          count: unsold.length,
          value: values ? unsold.reduce((t, f) => t + stockOf.get(f.id)!.value, 0) : null,
        },
        costOfSales: values ? costOfSales : null,
        openingValue: values ? openingValue : null,
        closingValue: values ? closingValue : null,
        turnover: values ? turnover(costOfSales, openingValue, closingValue) : null,
      };
      if (!wantsCsv(req)) return result;
      return sendCsv(
        reply,
        `inventory-analysis-${p.from}-${p.to}.csv`,
        csv(
          [
            'item',
            'name',
            'category',
            'qty_sold',
            'sales',
            ...(values ? ['profit'] : []),
            'sales_class',
            ...(values ? ['profit_class'] : []),
            'on_hand',
            ...(values ? ['stock_value'] : []),
            'days_of_cover',
          ],
          all.map((r): Cell[] => [
            r.code,
            r.name,
            r.category,
            r.qtySold / 1000,
            r.sales,
            ...(values ? [r.profit] : []),
            r.salesClass,
            ...(values ? [r.profitClass] : []),
            r.onHand / 1000,
            ...(values ? [r.stockValue] : []),
            r.daysOfCover,
          ]),
        ),
      );
    }),
  );
}
