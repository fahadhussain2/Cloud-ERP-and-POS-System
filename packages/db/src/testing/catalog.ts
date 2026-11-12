import { normalizeIdentifier } from '@erp/domain';
import type pg from 'pg';

// Test catalogs (W1-03): items with identifiers, vehicle tags and tier prices, the way the importer stores them
// (data model §4). Run inside withTenant; lookups are created by name or code when missing.

export interface TestItem {
  code: string;
  name: string;
  /** Category code; its name is the code. */
  category: string;
  brand?: string;
  origin?: string;
  unit?: string;
  /** The unit allows fractions (LITRE, METER, FOOT for Delux); only when the unit is first made. */
  fractional?: boolean;
  variant?: string;
  spec?: string;
  bin?: string;
  /** Minor units; none = unknown (the counter then uses the list price, D-092). */
  floor?: number;
  status?: 'active' | 'dormant' | 'discontinued';
  oem?: string[];
  alternate?: string[];
  vehicles?: { make?: string; model?: string; from?: number; to?: number }[];
  /** Minor units per tier code, e.g. { RETAIL: 450000 }. */
  prices?: Record<string, number>;
  legacy?: Record<string, unknown>;
}

export const TEST_TIERS = [
  { code: 'RETAIL', name: 'Retail', sort: 1, isDefault: true },
  { code: 'MECHANIC', name: 'Mechanic', sort: 2, isDefault: false },
  { code: 'WHOLESALE', name: 'Wholesale', sort: 3, isDefault: false },
];

/** Adds the items (and any missing tiers and lookups); returns item ids by code. */
export async function seedCatalog(
  c: pg.ClientBase,
  tenantId: string,
  items: readonly TestItem[],
): Promise<Record<string, string>> {
  const cache = new Map<string, string>();
  const lookup = async (
    table: string,
    key: 'code' | 'name',
    value: string,
    extra: Record<string, unknown> = {},
  ) => {
    const k = `${table}:${value}`;
    const hit = cache.get(k);
    if (hit) return hit;
    const found = await c.query<{ id: string }>(`SELECT id FROM erp.${table} WHERE ${key} = $1`, [value]);
    let id = found.rows[0]?.id;
    if (!id) {
      const cols = ['tenant_id', key, ...Object.keys(extra)];
      const vals = [tenantId, value, ...Object.values(extra)];
      const res = await c.query<{ id: string }>(
        `INSERT INTO erp.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING id`,
        vals,
      );
      id = res.rows[0]!.id;
    }
    cache.set(k, id);
    return id;
  };

  const tiers: Record<string, string> = {};
  for (const t of TEST_TIERS) {
    tiers[t.code] = await lookup('price_tiers', 'code', t.code, {
      name: t.name,
      sort: t.sort,
      is_default: t.isDefault,
    });
  }

  const ids: Record<string, string> = {};
  for (const it of items) {
    const res = await c.query<{ id: string }>(
      `INSERT INTO erp.items (tenant_id, code, name, category_id, brand_id, origin_id, unit_id, variant, spec,
         bin_location, floor_price, status, legacy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        tenantId,
        it.code,
        it.name,
        await lookup('categories', 'code', it.category, { name: it.category }),
        it.brand ? await lookup('brands', 'name', it.brand) : null,
        it.origin ? await lookup('origins', 'name', it.origin) : null,
        await lookup('units', 'code', it.unit ?? 'PCS', {
          name: it.unit ?? 'PCS',
          allows_fraction: it.fractional ?? false,
        }),
        it.variant ?? null,
        it.spec ?? null,
        it.bin ?? null,
        it.floor ?? null,
        it.status ?? 'active',
        it.legacy ?? null,
      ],
    );
    const itemId = res.rows[0]!.id;
    ids[it.code] = itemId;
    const identifiers = [
      { kind: 'barcode', value: it.code, primary: true },
      ...(it.oem ?? []).map((value, i) => ({ kind: 'oem', value, primary: i === 0 })),
      ...(it.alternate ?? []).map((value) => ({ kind: 'alternate', value, primary: false })),
    ];
    for (const x of identifiers) {
      await c.query(
        `INSERT INTO erp.item_identifiers (tenant_id, item_id, kind, value, normalized_value, is_primary)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, itemId, x.kind, x.value, normalizeIdentifier(x.value), x.primary],
      );
    }
    for (const v of it.vehicles ?? []) {
      await c.query(
        `INSERT INTO erp.item_compatibility (tenant_id, item_id, make_id, model, year_from, year_to)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenantId,
          itemId,
          v.make ? await lookup('vehicle_makes', 'name', v.make) : null,
          v.model ?? null,
          v.from ?? null,
          v.to ?? null,
        ],
      );
    }
    for (const [tier, price] of Object.entries(it.prices ?? {})) {
      const tierId = tiers[tier];
      if (!tierId) throw new Error(`unknown tier ${tier}`);
      await c.query(
        'INSERT INTO erp.item_prices (tenant_id, item_id, tier_id, price) VALUES ($1, $2, $3, $4)',
        [tenantId, itemId, tierId, price],
      );
    }
  }
  return ids;
}
