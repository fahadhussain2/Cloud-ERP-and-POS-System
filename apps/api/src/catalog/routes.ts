import {
  AddNameRequest,
  CreateItemRequest,
  SetIdentifiersRequest,
  SetPricesRequest,
  SetVehiclesRequest,
  UpdateCategoryRequest,
  UpdateItemRequest,
  type CatalogLookups,
  type ItemDetail,
  type ItemList,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import {
  can,
  catalogCodeProblems,
  itemProblems,
  money,
  normalizeIdentifier,
  priceChange,
  proposeTierPrices,
  qty,
  type Permission,
} from '@erp/domain';
import { writeFloors } from '@erp/posting';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requireAnyPermission, requirePermission } from '../auth/routes';

// Catalog maintenance in the back office (W1-15 plan; CAT-01…CAT-05, CAT-07). Reading needs cat.item.edit or
// cat.price.edit; details, codes, vehicles and new items need cat.item.edit; prices, floors and the category margin
// cat.price.edit, the owner's only (owner answer 3). Every save sends the row version it read (stale = 409). The
// counters get the changes through the change feed (sync spec §3): every table here is synced.

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
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

const PAGE_SIZE = 50;
const PAGE_SIZE_MAX = 200;
const thousandths = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 1000));
const units = (t: number | null | undefined) => (t === null || t === undefined ? null : t / 1000);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The item's row version, or the answer that someone saved in between (with who and when). */
async function checkVersion(c: Client, table: 'items' | 'categories', id: string, rowVersion: string) {
  const { rows } = await c.query<{ row_version: string; by: string | null; at: Date }>(
    `SELECT t.row_version::text, u.full_name AS by, t.updated_at AS at
     FROM erp.${table} t LEFT JOIN erp.users u ON u.id = t.updated_by_user_id
     WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [id],
  );
  const r = rows[0];
  if (!r) throw new Refusal(404, { error: 'not_found' });
  if (r.row_version !== rowVersion)
    throw new Refusal(409, { error: 'stale', by: r.by, at: r.at.toISOString(), rowVersion: r.row_version });
}

/** Touches the item, so its row version moves with any change to its codes, vehicles or prices. */
async function touchItem(c: Client, id: string): Promise<string> {
  const { rows } = await c.query<{ row_version: string }>(
    'UPDATE erp.items SET updated_at = now() WHERE id = $1 RETURNING row_version::text',
    [id],
  );
  return rows[0]!.row_version;
}

async function tiersOf(c: Client) {
  return (
    await c.query<{ id: string; code: string; name: string }>(
      'SELECT id, code, name FROM erp.price_tiers WHERE deleted_at IS NULL ORDER BY sort, code',
    )
  ).rows;
}

async function pricesOf(c: Client, itemId: string, tiers: { id: string; code: string }[]) {
  const { rows } = await c.query<{ tier_id: string; price: string }>(
    'SELECT tier_id, price::text FROM erp.item_prices WHERE item_id = $1 AND deleted_at IS NULL',
    [itemId],
  );
  const byTier = new Map(rows.map((r) => [r.tier_id, Number(r.price)]));
  return Object.fromEntries(tiers.map((t) => [t.code, byTier.get(t.id) ?? null])) as Record<
    string,
    number | null
  >;
}

/** The barcodes in `normalized` already used by another item: the first one's code, or null. */
async function barcodeTaken(c: Client, itemId: string | null, normalized: string[]) {
  if (normalized.length === 0) return null;
  const { rows } = await c.query<{ code: string }>(
    `SELECT i.code FROM erp.item_identifiers x JOIN erp.items i ON i.id = x.item_id
     WHERE x.kind = 'barcode' AND x.deleted_at IS NULL AND x.normalized_value = ANY($1::text[])
       AND ($2::uuid IS NULL OR x.item_id <> $2) ORDER BY i.code LIMIT 1`,
    [normalized, itemId],
  );
  return rows[0]?.code ?? null;
}

async function writePrices(
  c: Client,
  tenantId: string,
  itemId: string,
  tiers: { id: string; code: string }[],
  changes: { target: string; old: number | null; new: number | null }[],
  why: { reason: string | null; note: string | null },
) {
  const tierId = new Map(tiers.map((t) => [t.code, t.id]));
  for (const ch of changes) {
    if (ch.target === 'floor') {
      await c.query('UPDATE erp.items SET floor_price = $2 WHERE id = $1', [itemId, ch.new]);
    } else if (ch.new === null) {
      await c.query('UPDATE erp.item_prices SET deleted_at = now() WHERE item_id = $1 AND tier_id = $2', [
        itemId,
        tierId.get(ch.target),
      ]);
    } else {
      await c.query(
        `INSERT INTO erp.item_prices (tenant_id, item_id, tier_id, price) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, item_id, tier_id) DO UPDATE SET price = EXCLUDED.price, deleted_at = NULL`,
        [tenantId, itemId, tierId.get(ch.target), ch.new],
      );
    }
    // clock_timestamp(): one save's rows keep their order in the history.
    await c.query(
      `INSERT INTO erp.price_history (tenant_id, item_id, tier_id, old_value, new_value, source, reason_code, note,
         user_id, at)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, erp.current_user_id(), clock_timestamp())`,
      [
        tenantId,
        itemId,
        ch.target === 'floor' ? null : tierId.get(ch.target),
        ch.old,
        ch.new,
        why.reason,
        why.note,
      ],
    );
  }
}

export function registerCatalog(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  const read = requireAnyPermission(requireAuth, ['cat.item.edit', 'cat.price.edit']);
  const editItems = requirePermission(requireAuth, 'cat.item.edit');
  const editPrices = requirePermission(requireAuth, 'cat.price.edit');
  const allowed = (req: FastifyRequest, p: Permission) => can(req.auth!.grants, p, null);

  /** One transaction as the signed-in person; a Refusal rolls back and becomes the answer. */
  const run = async <T>(req: FastifyRequest, reply: FastifyReply, fn: (c: Client) => Promise<T>) => {
    try {
      return await withTenant(
        pool,
        { tenantId: req.auth!.tenantId, userId: req.auth!.userId, requestId: req.id },
        (_db, c) => fn(c),
      );
    } catch (err) {
      if (err instanceof Refusal) return reply.code(err.status).send(err.body);
      const e = err as { code?: string };
      if (e.code === '23503' || e.code === '22P02') return reply.code(400).send({ error: 'invalid_request' });
      throw err;
    }
  };

  scope.get('/catalog/items', { preHandler: read }, async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    const text = (qs['q'] ?? '').trim();
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number(qs['pageSize']) || PAGE_SIZE));
    const page = Math.max(1, Number(qs['page']) || 1);
    const words = text
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `%${likeEscape(w)}%`);
    const normalized = normalizeIdentifier(text);
    return run(req, reply, async (c) => {
      const { rows } = await c.query<Row>(
        `SELECT i.id, i.code, i.name, b.name AS brand, cat.name AS category, i.status,
           (SELECT p.price FROM erp.item_prices p JOIN erp.price_tiers t ON t.id = p.tier_id
            WHERE p.item_id = i.id AND p.deleted_at IS NULL AND t.code = 'RETAIL') AS retail,
           count(*) OVER () AS total
         FROM erp.items i
         JOIN erp.categories cat ON cat.id = i.category_id
         LEFT JOIN erp.brands b ON b.id = i.brand_id
         WHERE i.deleted_at IS NULL
           AND ($1::uuid IS NULL OR i.category_id = $1)
           AND ($2::uuid IS NULL OR i.brand_id = $2)
           AND ($3::text IS NULL OR i.status = $3)
           AND (cardinality($4::text[]) = 0
             OR NOT EXISTS (
               SELECT 1 FROM unnest($4::text[]) w
               WHERE NOT (i.code ILIKE w OR i.name ILIKE w OR coalesce(b.name, '') ILIKE w))
             OR ($5 <> '' AND EXISTS (
               SELECT 1 FROM erp.item_identifiers x
               WHERE x.item_id = i.id AND x.deleted_at IS NULL AND x.normalized_value LIKE $5 || '%')))
         ORDER BY i.code
         LIMIT $6 OFFSET $7`,
        [
          qs['category'] || null,
          qs['brand'] || null,
          qs['status'] || null,
          words,
          likeEscape(normalized),
          pageSize,
          (page - 1) * pageSize,
        ],
      );
      let total = Number(rows[0]?.['total'] ?? 0);
      // A page past the end still says how many there are.
      if (rows.length === 0 && page > 1)
        total = Number(
          (
            await c.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM erp.items i LEFT JOIN erp.brands b ON b.id = i.brand_id
               WHERE i.deleted_at IS NULL AND ($1::uuid IS NULL OR i.category_id = $1)
                 AND ($2::uuid IS NULL OR i.brand_id = $2) AND ($3::text IS NULL OR i.status = $3)
                 AND (cardinality($4::text[]) = 0 OR NOT EXISTS (SELECT 1 FROM unnest($4::text[]) w
                   WHERE NOT (i.code ILIKE w OR i.name ILIKE w OR coalesce(b.name, '') ILIKE w)))`,
              [qs['category'] || null, qs['brand'] || null, qs['status'] || null, words],
            )
          ).rows[0]!.n,
        );
      const out: ItemList = {
        total,
        items: rows.map((r) => ({
          id: r['id'] as string,
          code: r['code'] as string,
          name: r['name'] as string,
          brand: (r['brand'] as string | null) ?? null,
          category: r['category'] as string,
          status: r['status'] as ItemList['items'][number]['status'],
          retail: num(r['retail']),
        })),
      };
      return out;
    });
  });

  scope.get('/catalog/items/:id', { preHandler: read }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return run(req, reply, async (c) => {
      const item = (
        await c.query<Row>(
          `SELECT i.*, i.row_version::text AS rv, u.full_name AS updated_by
           FROM erp.items i LEFT JOIN erp.users u ON u.id = i.updated_by_user_id
           WHERE i.id = $1 AND i.deleted_at IS NULL`,
          [id],
        )
      ).rows[0];
      if (!item) throw new Refusal(404, { error: 'not_found' });
      const tiers = await tiersOf(c);
      const prices = await pricesOf(c, id, tiers);
      const identifiers = (
        await c.query<{
          kind: ItemDetail['identifiers'][number]['kind'];
          value: string;
          is_primary: boolean;
        }>(
          `SELECT kind, value, is_primary FROM erp.item_identifiers WHERE item_id = $1 AND deleted_at IS NULL
           ORDER BY kind = 'barcode' DESC, is_primary DESC, kind, value`,
          [id],
        )
      ).rows.map((r) => ({ kind: r.kind, value: r.value, isPrimary: r.is_primary }));
      const vehicles = (
        await c.query<Row>(
          `SELECT v.make_id, v.model, v.year_from, v.year_to, v.note FROM erp.item_compatibility v
           LEFT JOIN erp.vehicle_makes m ON m.id = v.make_id
           WHERE v.item_id = $1 AND v.deleted_at IS NULL ORDER BY m.name NULLS LAST, v.model, v.year_from`,
          [id],
        )
      ).rows.map((r) => ({
        makeId: (r['make_id'] as string | null) ?? null,
        model: (r['model'] as string | null) ?? null,
        yearFrom: num(r['year_from']),
        yearTo: num(r['year_to']),
        note: (r['note'] as string | null) ?? null,
      }));
      const fromCost = num(
        (
          await c.query<{ floor: string }>(
            'SELECT floor::text FROM erp.item_floors WHERE item_id = $1 AND deleted_at IS NULL',
            [id],
          )
        ).rows[0]?.floor,
      );
      const own = num(item['floor_price']);
      const retail = prices['RETAIL'] ?? null;
      const history = (
        await c.query<Row>(
          `SELECT t.code AS tier, h.old_value, h.new_value, h.source, h.reason_code, h.note, u.full_name, h.at
           FROM erp.price_history h LEFT JOIN erp.price_tiers t ON t.id = h.tier_id
           LEFT JOIN erp.users u ON u.id = h.user_id
           WHERE h.item_id = $1 ORDER BY h.at DESC, h.id DESC LIMIT 200`,
          [id],
        )
      ).rows.map((r) => ({
        target: (r['tier'] as string | null) ?? 'floor',
        old: num(r['old_value']),
        new: num(r['new_value']),
        source: r['source'] as string,
        reason: (r['reason_code'] as string | null) ?? null,
        note: (r['note'] as string | null) ?? null,
        by: (r['full_name'] as string | null) ?? null,
        at: (r['at'] as Date).toISOString(),
      }));
      const detail: ItemDetail = {
        item: {
          id,
          code: item['code'] as string,
          name: item['name'] as string,
          categoryId: item['category_id'] as string,
          unitId: item['unit_id'] as string,
          brandId: (item['brand_id'] as string | null) ?? null,
          originId: (item['origin_id'] as string | null) ?? null,
          variant: (item['variant'] as string | null) ?? null,
          spec: (item['spec'] as string | null) ?? null,
          binLocation: (item['bin_location'] as string | null) ?? null,
          defaultSupplierId: (item['default_supplier_id'] as string | null) ?? null,
          minQty: thousandths(item['min_qty']),
          maxQty: thousandths(item['max_qty']),
          excludeFromReorder: item['exclude_from_reorder'] as boolean,
          status: item['status'] as ItemDetail['item']['status'],
          rowVersion: item['rv'] as string,
          updatedAt: (item['updated_at'] as Date).toISOString(),
          updatedBy: (item['updated_by'] as string | null) ?? null,
        },
        identifiers,
        vehicles,
        prices,
        floor: {
          own,
          fromCost,
          effective: own ?? fromCost ?? retail,
          source: own !== null ? 'item' : fromCost !== null ? 'cost' : 'list',
        },
        history,
      };
      if (allowed(req, 'cost.view')) {
        const cost = (
          await c.query<Row>(
            `SELECT k.avg_cost, k.last_cost, p.name AS supplier, k.last_receipt_at FROM erp.item_costs k
             LEFT JOIN erp.parties p ON p.id = k.last_supplier_id WHERE k.item_id = $1`,
            [id],
          )
        ).rows[0];
        detail.cost = {
          avgCost: num(cost?.['avg_cost']),
          lastCost: num(cost?.['last_cost']),
          lastSupplier: (cost?.['supplier'] as string | null) ?? null,
          lastReceiptAt: cost?.['last_receipt_at'] ? (cost['last_receipt_at'] as Date).toISOString() : null,
        };
      }
      return detail;
    });
  });

  /** The unit's fractions rule, or a refusal for an unknown unit. */
  const unitAllowsFraction = async (c: Client, unitId: string) => {
    const u = (
      await c.query<{ allows_fraction: boolean }>('SELECT allows_fraction FROM erp.units WHERE id = $1', [
        unitId,
      ])
    ).rows[0];
    if (!u) throw new Refusal(400, { error: 'invalid_request' });
    return u.allows_fraction;
  };

  scope.post('/catalog/items', { preHandler: editItems }, async (req, reply) => {
    const parsed = CreateItemRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    if (b.prices !== undefined && !allowed(req, 'cat.price.edit'))
      return reply.code(403).send({ error: 'forbidden', permission: 'cat.price.edit' });
    return run(req, reply, async (c) => {
      const checked = itemProblems({
        code: b.code,
        name: b.name,
        categoryId: b.categoryId,
        unitId: b.unitId,
        allowsFraction: await unitAllowsFraction(c, b.unitId),
        minQty: b.minQty ?? null,
        maxQty: b.maxQty ?? null,
      });
      if (checked.problems.length > 0)
        throw new Refusal(400, { error: 'invalid', problems: checked.problems });
      const code = checked.code;
      if ((await c.query('SELECT 1 FROM erp.items WHERE code = $1', [code])).rowCount)
        throw new Refusal(409, { error: 'code_taken' });
      const taken = await barcodeTaken(c, null, [normalizeIdentifier(code)]);
      if (taken) throw new Refusal(409, { error: 'barcode_taken', code: taken });
      const tiers = await tiersOf(c);
      let changes: { target: string; old: number | null; new: number | null }[] = [];
      if (b.prices !== undefined) {
        const retail = b.prices['RETAIL'];
        const proposed =
          retail !== null && retail !== undefined && Number.isSafeInteger(retail) && retail >= 0
            ? proposeTierPrices(money(retail))
            : {};
        const after = Object.fromEntries(
          tiers.map((t) => [
            t.code,
            b.prices![t.code] ?? (proposed as Record<string, number>)[t.code] ?? null,
          ]),
        );
        const change = priceChange({
          before: { tiers: Object.fromEntries(tiers.map((t) => [t.code, null])), floor: null },
          after: { tiers: after, floor: null },
          reason: null,
          note: null,
        });
        if (change.problems.length > 0)
          throw new Refusal(400, { error: 'invalid', problems: change.problems });
        changes = change.changes;
      }
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO erp.items (tenant_id, code, name, category_id, brand_id, origin_id, unit_id, variant, spec,
           bin_location, default_supplier_id, min_qty, max_qty, exclude_from_reorder, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [
          req.auth!.tenantId,
          code,
          checked.name,
          b.categoryId,
          b.brandId ?? null,
          b.originId ?? null,
          b.unitId,
          b.variant ?? null,
          b.spec ?? null,
          b.binLocation ?? null,
          b.defaultSupplierId ?? null,
          units(b.minQty),
          units(b.maxQty),
          b.excludeFromReorder ?? false,
          b.status ?? 'active',
        ],
      );
      const id = rows[0]!.id;
      // Every item's code is also its barcode: legacy labels encode the code (data model §4).
      await c.query(
        `INSERT INTO erp.item_identifiers (tenant_id, item_id, kind, value, normalized_value, is_primary)
         VALUES ($1, $2, 'barcode', $3, $4, true)`,
        [req.auth!.tenantId, id, code, normalizeIdentifier(code)],
      );
      await writePrices(c, req.auth!.tenantId, id, tiers, changes, { reason: null, note: null });
      return reply.code(201).send({ id });
    });
  });

  scope.patch('/catalog/items/:id', { preHandler: editItems }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateItemRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      await checkVersion(c, 'items', id, b.rowVersion);
      const cur = (await c.query<Row>('SELECT * FROM erp.items WHERE id = $1', [id])).rows[0]!;
      const pick = <T>(key: keyof typeof b, column: string): T =>
        (b[key] !== undefined ? b[key] : cur[column]) as T;
      const minQty = b.minQty !== undefined ? b.minQty : thousandths(cur['min_qty']);
      const maxQty = b.maxQty !== undefined ? b.maxQty : thousandths(cur['max_qty']);
      const unitId = pick<string>('unitId', 'unit_id');
      const checked = itemProblems({
        code: cur['code'] as string,
        name: pick<string>('name', 'name'),
        categoryId: pick<string>('categoryId', 'category_id'),
        unitId,
        allowsFraction: await unitAllowsFraction(c, unitId),
        minQty,
        maxQty,
      });
      if (checked.problems.length > 0)
        throw new Refusal(400, { error: 'invalid', problems: checked.problems });
      const { rows } = await c.query<{ row_version: string }>(
        `UPDATE erp.items SET name = $2, category_id = $3, unit_id = $4, brand_id = $5, origin_id = $6,
           variant = $7, spec = $8, bin_location = $9, default_supplier_id = $10, min_qty = $11, max_qty = $12,
           exclude_from_reorder = $13, status = $14
         WHERE id = $1 RETURNING row_version::text`,
        [
          id,
          checked.name,
          pick('categoryId', 'category_id'),
          unitId,
          pick('brandId', 'brand_id'),
          pick('originId', 'origin_id'),
          pick('variant', 'variant'),
          pick('spec', 'spec'),
          pick('binLocation', 'bin_location'),
          pick('defaultSupplierId', 'default_supplier_id'),
          units(minQty),
          units(maxQty),
          pick('excludeFromReorder', 'exclude_from_reorder'),
          pick('status', 'status'),
        ],
      );
      return { rowVersion: rows[0]!.row_version };
    });
  });

  scope.put('/catalog/items/:id/identifiers', { preHandler: editItems }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SetIdentifiersRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      await checkVersion(c, 'items', id, b.rowVersion);
      const code = (await c.query<{ code: string }>('SELECT code FROM erp.items WHERE id = $1', [id]))
        .rows[0]!.code;
      const problems = catalogCodeProblems({
        code,
        thisYear: now().getUTCFullYear(),
        identifiers: b.identifiers,
        vehicles: [],
      });
      if (problems.length > 0) throw new Refusal(400, { error: 'invalid', problems });
      const wanted = b.identifiers.map((i) => ({
        kind: i.kind,
        value: i.value.trim(),
        normalized: normalizeIdentifier(i.value.trim()),
      }));
      const taken = await barcodeTaken(
        c,
        id,
        wanted.filter((w) => w.kind === 'barcode').map((w) => w.normalized),
      );
      if (taken) throw new Refusal(409, { error: 'barcode_taken', code: taken });
      const current = (
        await c.query<{ id: string; kind: string; normalized_value: string }>(
          'SELECT id, kind, normalized_value FROM erp.item_identifiers WHERE item_id = $1 AND deleted_at IS NULL',
          [id],
        )
      ).rows;
      const key = (kind: string, n: string) => `${kind}|${n}`;
      const keep = new Set(wanted.map((w) => key(w.kind, w.normalized)));
      const have = new Set(current.map((r) => key(r.kind, r.normalized_value)));
      const drop = current.filter((r) => !keep.has(key(r.kind, r.normalized_value))).map((r) => r.id);
      if (drop.length > 0)
        await c.query('UPDATE erp.item_identifiers SET deleted_at = now() WHERE id = ANY($1::uuid[])', [
          drop,
        ]);
      const codeKey = normalizeIdentifier(code);
      for (const w of wanted.filter((w) => !have.has(key(w.kind, w.normalized))))
        await c.query(
          `INSERT INTO erp.item_identifiers (tenant_id, item_id, kind, value, normalized_value, is_primary)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            req.auth!.tenantId,
            id,
            w.kind,
            w.value,
            w.normalized,
            w.kind === 'barcode' && w.normalized === codeKey,
          ],
        );
      return { rowVersion: await touchItem(c, id) };
    });
  });

  scope.put('/catalog/items/:id/vehicles', { preHandler: editItems }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SetVehiclesRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      await checkVersion(c, 'items', id, b.rowVersion);
      const problems = catalogCodeProblems({
        code: 'X',
        thisYear: now().getUTCFullYear(),
        identifiers: [{ kind: 'barcode', value: 'X' }],
        vehicles: b.vehicles,
      });
      if (problems.length > 0) throw new Refusal(400, { error: 'invalid', problems });
      const key = (v: Row | (typeof b.vehicles)[number]) =>
        JSON.stringify(
          'makeId' in v
            ? [v.makeId, v.model, v.yearFrom, v.yearTo, v.note]
            : [
                v['make_id'] ?? null,
                v['model'] ?? null,
                num(v['year_from']),
                num(v['year_to']),
                v['note'] ?? null,
              ],
        );
      const current = (
        await c.query<Row>(
          `SELECT id, make_id, model, year_from, year_to, note FROM erp.item_compatibility
           WHERE item_id = $1 AND deleted_at IS NULL`,
          [id],
        )
      ).rows;
      const keep = new Set(b.vehicles.map(key));
      const have = new Set(current.map(key));
      const drop = current.filter((r) => !keep.has(key(r))).map((r) => r['id'] as string);
      if (drop.length > 0)
        await c.query('UPDATE erp.item_compatibility SET deleted_at = now() WHERE id = ANY($1::uuid[])', [
          drop,
        ]);
      for (const v of b.vehicles.filter((v) => !have.has(key(v))))
        await c.query(
          `INSERT INTO erp.item_compatibility (tenant_id, item_id, make_id, model, year_from, year_to, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [req.auth!.tenantId, id, v.makeId, v.model, v.yearFrom, v.yearTo, v.note],
        );
      return { rowVersion: await touchItem(c, id) };
    });
  });

  scope.put('/catalog/items/:id/prices', { preHandler: editPrices }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SetPricesRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      await checkVersion(c, 'items', id, b.rowVersion);
      const tiers = await tiersOf(c);
      if (Object.keys(b.tiers).some((code) => !tiers.some((t) => t.code === code)))
        throw new Refusal(400, { error: 'invalid_request' });
      const before = await pricesOf(c, id, tiers);
      const floor = num(
        (await c.query<Row>('SELECT floor_price FROM erp.items WHERE id = $1', [id])).rows[0]!['floor_price'],
      );
      const after = Object.fromEntries(
        tiers.map((t) => [t.code, t.code in b.tiers ? b.tiers[t.code]! : before[t.code]!]),
      );
      const reason = b.reason ?? null;
      const note = (b.note ?? '').trim() || null;
      const change = priceChange({
        before: { tiers: before, floor },
        after: { tiers: after, floor: b.floor },
        reason,
        note,
      });
      if (change.problems.length > 0)
        throw new Refusal(400, { error: 'invalid', problems: change.problems, warnings: change.warnings });
      await writePrices(c, req.auth!.tenantId, id, tiers, change.changes, { reason, note });
      return { rowVersion: await touchItem(c, id), warnings: change.warnings };
    });
  });

  scope.get('/catalog/lookups', { preHandler: read }, async (req, reply) =>
    run(req, reply, async (c) => {
      const list = async <T extends Row>(sql: string) => (await c.query<T>(sql)).rows;
      const live = (
        await c.query<{ live: boolean }>(
          'SELECT go_live_at IS NOT NULL AS live FROM erp.tenants WHERE id = $1',
          [req.auth!.tenantId],
        )
      ).rows[0]?.live;
      const out: CatalogLookups = {
        categories: (
          await list<Row>(
            `SELECT id, code, name, parent_id, pricing_rule->>'floor_min_margin_bp' AS margin, row_version::text AS rv
             FROM erp.categories WHERE deleted_at IS NULL ORDER BY code`,
          )
        ).map((r) => ({
          id: r['id'] as string,
          code: r['code'] as string,
          name: r['name'] as string,
          parentId: (r['parent_id'] as string | null) ?? null,
          floorMarginBp: num(r['margin']),
          rowVersion: r['rv'] as string,
        })),
        units: (
          await list<Row>(
            'SELECT id, code, name, allows_fraction FROM erp.units WHERE deleted_at IS NULL ORDER BY code',
          )
        ).map((r) => ({
          id: r['id'] as string,
          code: r['code'] as string,
          name: r['name'] as string,
          allowsFraction: r['allows_fraction'] as boolean,
        })),
        brands: await list('SELECT id, name FROM erp.brands WHERE deleted_at IS NULL ORDER BY lower(name)'),
        origins: await list('SELECT id, name FROM erp.origins WHERE deleted_at IS NULL ORDER BY lower(name)'),
        makes: await list(
          'SELECT id, name FROM erp.vehicle_makes WHERE deleted_at IS NULL ORDER BY lower(name)',
        ),
        tiers: (await tiersOf(c)).map((t) => ({ id: t.id, code: t.code, name: t.name })),
        suppliers: await list(
          `SELECT p.id, p.code, p.name FROM erp.parties p
           JOIN erp.supplier_accounts s ON s.party_id = p.id AND s.deleted_at IS NULL
           WHERE p.deleted_at IS NULL ORDER BY lower(p.name)`,
        ),
        live: live === true,
        can: {
          editItems: allowed(req, 'cat.item.edit'),
          editPrices: allowed(req, 'cat.price.edit'),
          viewCost: allowed(req, 'cost.view'),
        },
      };
      return out;
    }),
  );

  // A brand, origin or vehicle make added while editing an item; the same name (any case) returns the one there is.
  for (const [path, table] of [
    ['brands', 'brands'],
    ['origins', 'origins'],
    ['makes', 'vehicle_makes'],
  ] as const)
    scope.post(`/catalog/${path}`, { preHandler: editItems }, async (req, reply) => {
      const parsed = AddNameRequest.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      const name = parsed.data.name;
      return run(req, reply, async (c) => {
        const found = (
          await c.query<{ id: string; name: string }>(
            `SELECT id, name FROM erp.${table} WHERE lower(name) = lower($1) AND deleted_at IS NULL`,
            [name],
          )
        ).rows[0];
        if (found) return found;
        const { rows } = await c.query<{ id: string; name: string }>(
          `INSERT INTO erp.${table} (tenant_id, name) VALUES ($1, $2) RETURNING id, name`,
          [req.auth!.tenantId, name],
        );
        return reply.code(201).send(rows[0]);
      });
    });

  scope.patch('/catalog/categories/:id', { preHandler: editPrices }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateCategoryRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      await checkVersion(c, 'categories', id, b.rowVersion);
      const { rows } = await c.query<{ row_version: string }>(
        `UPDATE erp.categories SET pricing_rule = CASE WHEN $2::int IS NULL
             THEN coalesce(pricing_rule, '{}'::jsonb) - 'floor_min_margin_bp'
             ELSE jsonb_set(coalesce(pricing_rule, '{}'::jsonb), '{floor_min_margin_bp}', to_jsonb($2::int)) END
         WHERE id = $1 RETURNING row_version::text`,
        [id, b.floorMarginBp],
      );
      // The category's floors from cost follow its new margin at once (CAT-05, D-101), written by the posting layer.
      const costs = (
        await c.query<{ item_id: string; avg_cost: string | null; on_hand: string }>(
          `SELECT k.item_id, k.avg_cost::text, k.on_hand::text FROM erp.item_costs k
           JOIN erp.items i ON i.id = k.item_id WHERE i.category_id = $1`,
          [id],
        )
      ).rows;
      await writeFloors(
        c,
        req.auth!.tenantId,
        Object.fromEntries(
          costs.map((k) => [
            k.item_id,
            {
              avgCost: k.avg_cost === null ? null : money(Number(k.avg_cost)),
              onHand: qty(Math.round(Number(k.on_hand) * 1000)),
            },
          ]),
        ),
        now(),
      );
      return { rowVersion: rows[0]!.row_version };
    });
  });
}
