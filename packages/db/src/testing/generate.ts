import pg from 'pg';

import { normalizeIdentifier } from '@erp/domain';

import { TEST_TIERS, type TestItem } from './catalog';

// A made-up catalog in Delux's shape for staging (W1-21): codes, names, part numbers, vehicle tags, three tiers, some
// floors, dormant items and goods sold by the metre or litre. Deterministic: the same seed gives the same catalog.
// No real data: real searches are checked on the owner's PC against erp_dev (D-076).

/** Category code, name, base Retail price in rupees, OEM prefix (none for universal goods), fractional unit. */
const PARTS: readonly (readonly [string, string, number, string | null, ('METER' | 'LITRE')?])[] = [
  ['BRPD', 'BRAKE PADS FRONT', 3600, '04465'],
  ['BRSH', 'BRAKE SHOE REAR', 2800, '04495'],
  ['AFLT', 'AIR FILTER', 1400, '17801'],
  ['OFLT', 'OIL FILTER', 650, '90915'],
  ['FNBL', 'FAN BELT', 1300, '17521'],
  ['SPLG', 'SPARK PLUG', 650, '90919'],
  ['CLPL', 'CLUTCH PLATE', 7800, '31250'],
  ['WTBD', 'WATER BODY', 5200, '16100'],
  ['WBRG', 'WHEEL BEARING FRONT', 2600, '90369'],
  ['ENMT', 'ENGINE MOUNTING', 3200, '12361'],
  ['HDLT', 'HEADLIGHT', 9800, '81150'],
  ['WIPR', 'WIPER BLADE SET', 1500, '85222'],
  ['RADT', 'RADIATOR', 15000, '16400'],
  ['SHCK', 'SHOCK ABSORBER FRONT', 6500, '48510'],
  ['TMBL', 'TIMING BELT', 2500, '13568'],
  ['HOSE', 'FUEL HOSE 8MM', 200, null, 'METER'],
  ['ENOL', 'ENGINE OIL LOOSE 20W-50', 1800, null, 'LITRE'],
];
const VEHICLES: readonly (readonly [string, string, number, number | null])[] = [
  ['SUZUKI', 'MEHRAN', 1989, 2019],
  ['SUZUKI', 'CULTUS', 2017, null],
  ['SUZUKI', 'ALTO', 2019, null],
  ['SUZUKI', 'WAGON R', 2014, null],
  ['SUZUKI', 'SWIFT', 2010, 2021],
  ['TOYOTA', 'COROLLA', 2009, 2014],
  ['TOYOTA', 'COROLLA', 2015, 2020],
  ['TOYOTA', 'VITZ', 2005, 2010],
  ['TOYOTA', 'HIACE', 2005, 2018],
  ['HONDA', 'CIVIC', 2016, 2021],
  ['HONDA', 'CITY', 2009, 2020],
  ['DAIHATSU', 'CUORE', 2000, 2012],
  ['KIA', 'PICANTO', 2019, null],
  ['HYUNDAI', 'SANTRO', 2000, 2014],
];
const ORIGINS: readonly (readonly [string, number])[] = [
  ['GENUINE', 1.6],
  ['JAPAN', 1.35],
  ['TAIWAN', 1],
  ['CHINA', 0.75],
  ['LOCAL', 0.65],
];
const BRANDS = ['KASHIYAMA', 'NGK', 'DENSO', 'GATES', 'TOYO'];
const ALNUM = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

/** mulberry32: a small, fast, seedable generator, so the catalog is the same on every run. */
function random(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateCatalog(opts: { items: number; seed?: number }): TestItem[] {
  const rnd = random(opts.seed ?? 20261027);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const chars = (n: number) => Array.from({ length: n }, () => pick([...ALNUM])).join('');
  // Prices in whole rupees, rounded to Rs 10 like the shop's, then to paisa (minor units).
  const rupees10 = (rs: number) => Math.max(10, Math.round(rs / 10) * 10);
  const counters = new Map<string, number>();
  const items: TestItem[] = [];
  for (let n = 0; n < opts.items; n++) {
    // Universal goods (hose, loose oil) are rarer than vehicle parts.
    const part = rnd() < 0.03 ? pick(PARTS.filter((p) => p[4])) : pick(PARTS.filter((p) => !p[4]));
    const [category, partName, base, oemPrefix, unit] = part;
    const seq = (counters.get(category) ?? 0) + 1;
    counters.set(category, seq);
    const [origin, factor] = pick(ORIGINS);
    const vehicle = unit ? null : pick(VEHICLES);
    const retail = rupees10(base * factor * (0.9 + rnd() * 0.2));
    const item: TestItem = {
      code: `${category}${String(seq).padStart(3, '0')}`,
      name: [partName, vehicle?.[1], origin].filter(Boolean).join(' '),
      category,
      origin,
      bin: `R${1 + Math.floor(rnd() * 12)}-${pick([...'ABCDEF'])}${1 + Math.floor(rnd() * 5)}`,
      prices: {
        RETAIL: retail * 100,
        MECHANIC: rupees10(retail * 0.95) * 100,
        WHOLESALE: rupees10(retail * 0.9) * 100,
      },
    };
    if (rnd() < 0.5) item.brand = pick(BRANDS);
    if (part[1] === 'HEADLIGHT') item.variant = pick(['L/H', 'R/H']);
    if (unit) {
      item.unit = unit;
      item.fractional = true;
    }
    if (vehicle) {
      const [make, model, from, to] = vehicle;
      item.vehicles = [{ make, model, from, ...(to === null ? {} : { to }) }];
    }
    if (oemPrefix) {
      item.oem = [`${oemPrefix}-${chars(5)}`];
      if (rnd() < 0.1) item.alternate = [`${oemPrefix}${chars(5)}`];
    }
    if (rnd() < 0.05) item.floor = rupees10(retail * 0.85) * 100;
    if (rnd() < 0.03) item.status = 'dormant';
    items.push(item);
  }
  return items;
}

const CHUNK = 2000;

/**
 * The same rows as seedCatalog, in a few statements per 2,000 items instead of one per row: 20,000 items row by row
 * took over 10 minutes.
 */
async function insertInBulk(c: pg.ClientBase, tenantId: string, items: readonly TestItem[]): Promise<void> {
  const ids = async (table: string, key: string): Promise<Map<string, string>> =>
    new Map(
      (
        await c.query<{ id: string; k: string }>(
          `SELECT id, ${key} AS k FROM erp.${table} WHERE tenant_id = $1`,
          [tenantId],
        )
      ).rows.map((r) => [r.k, r.id]),
    );
  // The few lookup rows (tiers, units, categories, brands, origins, makes), each made if missing, one statement each.
  // Synced tables never delete rows, so nothing is made that would have to be removed again.
  const ensure = async (
    table: string,
    key: string,
    values: Iterable<string>,
    extra: (v: string) => Record<string, unknown> = () => ({}),
  ) => {
    const have = await ids(table, key);
    for (const v of values) {
      if (have.has(v)) continue;
      const cols = ['tenant_id', key, ...Object.keys(extra(v))];
      const vals = [tenantId, v, ...Object.values(extra(v))];
      await c.query(
        `INSERT INTO erp.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        vals,
      );
    }
  };
  const distinct = (pick: (i: TestItem) => (string | undefined)[]) =>
    new Set(items.flatMap(pick).filter((v): v is string => v !== undefined));
  for (const t of TEST_TIERS)
    await ensure('price_tiers', 'code', [t.code], () => ({
      name: t.name,
      sort: t.sort,
      is_default: t.isDefault,
    }));
  const fractional = new Set(items.filter((i) => i.fractional).map((i) => i.unit));
  await ensure(
    'units',
    'code',
    distinct((i) => [i.unit ?? 'PCS']),
    (u) => ({ name: u, allows_fraction: fractional.has(u) }),
  );
  await ensure(
    'categories',
    'code',
    distinct((i) => [i.category]),
    (cat) => ({ name: cat }),
  );
  await ensure(
    'brands',
    'name',
    distinct((i) => [i.brand]),
  );
  await ensure(
    'origins',
    'name',
    distinct((i) => [i.origin]),
  );
  await ensure(
    'vehicle_makes',
    'name',
    distinct((i) => (i.vehicles ?? []).map((v) => v.make)),
  );

  // One connection runs one query at a time.
  const tiers = await ids('price_tiers', 'code');
  const units = await ids('units', 'code');
  const categories = await ids('categories', 'code');
  const brands = await ids('brands', 'name');
  const origins = await ids('origins', 'name');
  const makes = await ids('vehicle_makes', 'name');
  const id = (map: Map<string, string>, k: string | undefined) => (k === undefined ? null : map.get(k)!);

  for (let start = 0; start < items.length; start += CHUNK) {
    const chunk = items.slice(start, start + CHUNK);
    const inserted = await c.query<{ id: string; code: string }>(
      `INSERT INTO erp.items (tenant_id, code, name, category_id, brand_id, origin_id, unit_id, variant, spec,
         bin_location, floor_price, status)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[], $8::text[],
         $9::text[], $10::text[], $11::bigint[], $12::text[])
       RETURNING id, code`,
      [
        tenantId,
        chunk.map((i) => i.code),
        chunk.map((i) => i.name),
        chunk.map((i) => id(categories, i.category)),
        chunk.map((i) => id(brands, i.brand)),
        chunk.map((i) => id(origins, i.origin)),
        chunk.map((i) => id(units, i.unit ?? 'PCS')),
        chunk.map((i) => i.variant ?? null),
        chunk.map((i) => i.spec ?? null),
        chunk.map((i) => i.bin ?? null),
        chunk.map((i) => i.floor ?? null),
        chunk.map((i) => i.status ?? 'active'),
      ],
    );
    const itemId = new Map(inserted.rows.map((r) => [r.code, r.id]));

    const idf: [string, string, string, string, boolean][] = [];
    const veh: [string, string | null, string | null, number | null, number | null][] = [];
    const prc: [string, string, number][] = [];
    for (const it of chunk) {
      const iid = itemId.get(it.code)!;
      idf.push([iid, 'barcode', it.code, normalizeIdentifier(it.code), true]);
      (it.oem ?? []).forEach((v, n) => idf.push([iid, 'oem', v, normalizeIdentifier(v), n === 0]));
      for (const v of it.alternate ?? []) idf.push([iid, 'alternate', v, normalizeIdentifier(v), false]);
      for (const v of it.vehicles ?? [])
        veh.push([iid, id(makes, v.make), v.model ?? null, v.from ?? null, v.to ?? null]);
      for (const [tier, price] of Object.entries(it.prices ?? {})) prc.push([iid, tiers.get(tier)!, price]);
    }
    const col = <T extends unknown[], K extends number>(rows: T[], k: K) => rows.map((r) => r[k]);
    await c.query(
      `INSERT INTO erp.item_identifiers (tenant_id, item_id, kind, value, normalized_value, is_primary)
       SELECT $1, * FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::boolean[])`,
      [tenantId, col(idf, 0), col(idf, 1), col(idf, 2), col(idf, 3), col(idf, 4)],
    );
    await c.query(
      `INSERT INTO erp.item_compatibility (tenant_id, item_id, make_id, model, year_from, year_to)
       SELECT $1, * FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::smallint[], $6::smallint[])`,
      [tenantId, col(veh, 0), col(veh, 1), col(veh, 2), col(veh, 3), col(veh, 4)],
    );
    await c.query(
      `INSERT INTO erp.item_prices (tenant_id, item_id, tier_id, price)
       SELECT $1, * FROM unnest($2::uuid[], $3::uuid[], $4::bigint[])`,
      [tenantId, col(prc, 0), col(prc, 1), col(prc, 2)],
    );
  }
}

export interface SeedReport {
  tenantId: string;
  items: number;
  ms: number;
}

/**
 * Seeds a generated catalog into a shop that has no items yet, as the owner role, in one transaction. Refuses
 * production: test data never goes there (W1-21).
 */
export async function seedGeneratedCatalog(
  ownerUrl: string,
  opts: { environment: string; tenantCode: string; items: number; seed?: number },
): Promise<SeedReport> {
  if (opts.environment === 'prod') throw new Error('refused: test data never goes to production');
  const started = Date.now();
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    const dir = await c.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM erp.tenant_directory WHERE code = $1',
      [opts.tenantCode],
    );
    const tenantId = dir.rows[0]?.tenant_id;
    if (!tenantId) throw new Error(`no shop ${opts.tenantCode}`);
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const existing = await c.query<{ n: string }>(
      'SELECT count(*) AS n FROM erp.items WHERE tenant_id = $1',
      [tenantId],
    );
    if (Number(existing.rows[0]!.n) > 0)
      throw new Error(`shop ${opts.tenantCode} already has items: nothing was changed`);
    const items = generateCatalog({
      items: opts.items,
      ...(opts.seed === undefined ? {} : { seed: opts.seed }),
    });
    await insertInBulk(c, tenantId, items);
    await c.query('COMMIT');
    return { tenantId, items: items.length, ms: Date.now() - started };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}
