import { withTenant } from '@erp/db';
import { createTenant, createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Catalog maintenance in the back office (W1-15 plan; CAT-01…CAT-05, CAT-07): search, item details, codes,
// vehicle tags, prices and floors with their history, new items, the category margin. Under RLS, with the
// permissions (only the owner prices, owner answer 3) and row versions.

const SHOP = 'catalog-shop';
const OTHER = 'catalog-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Client;
let tenant: string;
let other: string;
let items: Record<string, string>;
let otherItem: string;
let unitPcs: string;
let unitLitre: string;
let categoryAbea: string;
let categoryOils: string;
const cookies: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date() });

async function addUser(username: string, template: RoleTemplateKey, tenantId = tenant) {
  const hash = await hashPassword(PASSWORD);
  await withTenant(pool, { tenantId }, async (_db, c) => {
    const role = await c.query<{ id: string }>(
      `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits) VALUES ($1, $2, NULL, $3, $4)
       RETURNING id`,
      [tenantId, `${username} role`, ROLE_TEMPLATES[template].permissions, ROLE_TEMPLATES[template].limits],
    );
    const user = await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, password_hash) VALUES ($1, $2, initcap($2), $3)
       RETURNING id`,
      [tenantId, username, hash],
    );
    await c.query('INSERT INTO erp.user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
      tenantId,
      user.rows[0]!.id,
      role.rows[0]!.id,
    ]);
  });
}

const send = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, who: string | null, payload?: unknown) =>
  app().inject({
    method,
    url,
    headers: { origin: ORIGIN, host: HOST },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    ...(who ? { cookies: { erp_session: cookies[who]! } } : {}),
  });

async function login(username: string, shop = SHOP) {
  const res = await send('POST', '/api/auth/login', null, { tenantCode: shop, username, password: PASSWORD });
  const c = res.cookies.find((x) => x.name === 'erp_session')?.value;
  if (!c) throw new Error(`login failed for ${username}: ${res.body}`);
  cookies[username] = c;
}

type Detail = {
  item: { id: string; code: string; name: string; rowVersion: string; status: string };
  identifiers: { kind: string; value: string }[];
  vehicles: { makeId: string | null; model: string | null; yearFrom: number | null; yearTo: number | null }[];
  prices: Record<string, number | null>;
  floor: { own: number | null; fromCost: number | null; effective: number | null; source: string };
  cost?: { avgCost: number | null; lastCost: number | null };
  history: { target: string; old: number | null; new: number | null; reason: string | null; by: string }[];
};
const detail = async (id: string, who = 'owner') =>
  (await send('GET', `/api/catalog/items/${id}`, who)).json<Detail>();
const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  (await admin.query<T>(sql, params)).rows;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  tenant = await createTenant(db.ownerUrl, 'Catalog Shop', SHOP);
  other = await createTenant(db.ownerUrl, 'Other Shop', OTHER);
  items = await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    const ids = await seedCatalog(c, tenant, [
      {
        code: 'ABEA001',
        name: 'ADJUSTER BEARING SALOON',
        category: 'ABEA',
        brand: 'CHINA',
        oem: ['16620-22010'],
        vehicles: [{ make: 'TOYOTA', model: 'COROLLA', from: 2008, to: 2014 }],
        prices: { RETAIL: 400000, MECHANIC: 380000, WHOLESALE: 360000 },
      },
      { code: 'ABEA002', name: 'ADJUSTER BEARING EVERY', category: 'ABEA', prices: { RETAIL: 150000 } },
      {
        code: 'OIL050',
        name: 'ENGINE OIL 4L',
        category: 'OILS',
        unit: 'LITRE',
        fractional: true,
        prices: { RETAIL: 650000 },
      },
    ]);
    await c.query(
      `UPDATE erp.categories SET pricing_rule = '{"floor_min_margin_bp": 500}' WHERE code = 'ABEA'`,
    );
    return ids;
  });
  otherItem = (
    await withTenant(pool, { tenantId: other }, (_db, c) =>
      seedCatalog(c, other, [
        { code: 'ZZZ001', name: 'OTHER SHOP ITEM', category: 'ZZZ', prices: { RETAIL: 100 } },
      ]),
    )
  )['ZZZ001']!;
  [unitPcs, unitLitre, categoryAbea, categoryOils] = await withTenant(
    pool,
    { tenantId: tenant },
    async (_db, c) => [
      (await c.query<{ id: string }>("SELECT id FROM erp.units WHERE code = 'PCS'")).rows[0]!.id,
      (await c.query<{ id: string }>("SELECT id FROM erp.units WHERE code = 'LITRE'")).rows[0]!.id,
      (await c.query<{ id: string }>("SELECT id FROM erp.categories WHERE code = 'ABEA'")).rows[0]!.id,
      (await c.query<{ id: string }>("SELECT id FROM erp.categories WHERE code = 'OILS'")).rows[0]!.id,
    ],
  );
  // ABEA001 has a cost: its floor from cost is 3,000 + 5 % = 3,150 (W1-14). The posting layer writes these.
  await admin.query(
    `INSERT INTO erp.item_costs (tenant_id, item_id, avg_cost, on_hand, last_cost) VALUES ($1, $2, 300000, 4, 310000)`,
    [tenant, items['ABEA001']],
  );
  await admin.query(`INSERT INTO erp.item_floors (tenant_id, item_id, floor) VALUES ($1, $2, 315000)`, [
    tenant,
    items['ABEA001'],
  ]);
  await addUser('owner', 'owner');
  await addUser('maria', 'manager');
  await addUser('sara', 'salesman');
  await addUser('otto', 'owner', other);
  for (const u of ['owner', 'maria', 'sara']) await login(u);
  await login('otto', OTHER);
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.drop();
});

describe('the item list', () => {
  it('finds items by code, by name words in any order, and by an OEM number typed with or without dashes', async () => {
    const codes = async (text: string) =>
      (await send('GET', `/api/catalog/items?q=${encodeURIComponent(text)}`, 'owner'))
        .json<{ items: { code: string }[]; total: number }>()
        .items.map((i) => i.code);
    expect(await codes('abea001')).toEqual(['ABEA001']);
    expect(await codes('bearing saloon')).toEqual(['ABEA001']);
    expect(await codes('saloon bearing')).toEqual(['ABEA001']);
    expect(await codes('1662022010')).toEqual(['ABEA001']);
    expect(await codes('16620-22010')).toEqual(['ABEA001']);
    expect(await codes('bearing')).toEqual(['ABEA001', 'ABEA002']);
    expect(await codes('')).toEqual(['ABEA001', 'ABEA002', 'OIL050']);
  });

  it('filters by category and pages', async () => {
    const res = await send('GET', `/api/catalog/items?category=${categoryOils}`, 'owner');
    expect(res.json<{ items: { code: string }[] }>().items.map((i) => i.code)).toEqual(['OIL050']);
    const page = await send('GET', '/api/catalog/items?pageSize=2&page=2', 'owner');
    expect(page.json<{ items: { code: string }[]; total: number }>()).toMatchObject({
      total: 3,
      items: [{ code: 'OIL050' }],
    });
  });

  it("is refused without a catalog permission, and never shows another shop's items", async () => {
    expect((await send('GET', '/api/catalog/items', 'sara')).statusCode).toBe(403);
    expect((await send('GET', `/api/catalog/items/${otherItem}`, 'owner')).statusCode).toBe(404);
    const theirs = await send('GET', '/api/catalog/items', 'otto');
    expect(theirs.json<{ items: { code: string }[] }>().items.map((i) => i.code)).toEqual(['ZZZ001']);
  });
});

describe('an item', () => {
  it('shows its details, codes, vehicles, prices, the floor it gets on the counter and, for the owner, its cost', async () => {
    const d = await detail(items['ABEA001']!);
    expect(d.item).toMatchObject({ code: 'ABEA001', name: 'ADJUSTER BEARING SALOON', status: 'active' });
    expect(d.identifiers).toEqual(
      expect.arrayContaining([
        { kind: 'barcode', value: 'ABEA001', isPrimary: expect.any(Boolean) as boolean },
        expect.objectContaining({ kind: 'oem', value: '16620-22010' }),
      ]),
    );
    expect(d.vehicles).toEqual([expect.objectContaining({ model: 'COROLLA', yearFrom: 2008, yearTo: 2014 })]);
    expect(d.prices).toEqual({ RETAIL: 400000, MECHANIC: 380000, WHOLESALE: 360000 });
    expect(d.floor).toEqual({ own: null, fromCost: 315000, effective: 315000, source: 'cost' });
    expect(d.cost).toMatchObject({ avgCost: 300000, lastCost: 310000 });
    // No cost floor: the list price is the floor (D-092).
    expect((await detail(items['ABEA002']!)).floor).toEqual({
      own: null,
      fromCost: null,
      effective: 150000,
      source: 'list',
    });
  });

  it('hides the cost from someone without cost.view', async () => {
    await withTenant(pool, { tenantId: tenant }, (_db, c) =>
      c.query(
        `UPDATE erp.roles SET permissions = array_remove(permissions, 'cost.view') WHERE name = 'maria role'`,
      ),
    );
    await login('maria');
    expect((await detail(items['ABEA001']!, 'maria')).cost).toBeUndefined();
  });

  it('saves its details, upper-casing nothing but the code, and refuses a stale row version', async () => {
    const d = await detail(items['ABEA002']!);
    const res = await send('PATCH', `/api/catalog/items/${items['ABEA002']}`, 'maria', {
      rowVersion: d.item.rowVersion,
      name: 'Adjuster bearing Every 20mm',
      binLocation: 'R3-07',
      minQty: 2000,
      maxQty: 10000,
      status: 'active',
    });
    expect(res.statusCode).toBe(200);
    const after = await detail(items['ABEA002']!);
    expect(after.item).toMatchObject({ name: 'Adjuster bearing Every 20mm', binLocation: 'R3-07' });
    // The same row version again: someone saved in between.
    const stale = await send('PATCH', `/api/catalog/items/${items['ABEA002']}`, 'owner', {
      rowVersion: d.item.rowVersion,
      name: 'Something else',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'stale', by: 'Maria' });
  });

  it('refuses details that break the rules, with the problems', async () => {
    const d = await detail(items['ABEA002']!);
    const res = await send('PATCH', `/api/catalog/items/${items['ABEA002']}`, 'owner', {
      rowVersion: d.item.rowVersion,
      name: ' ',
      minQty: 1500,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid', problems: ['name_required', 'qty_fraction'] });
  });

  it('never changes its code', async () => {
    const d = await detail(items['ABEA002']!);
    const res = await send('PATCH', `/api/catalog/items/${items['ABEA002']}`, 'owner', {
      rowVersion: d.item.rowVersion,
      code: 'ABEA099',
    });
    expect(res.statusCode).toBe(400);
    expect((await detail(items['ABEA002']!)).item.code).toBe('ABEA002');
  });

  it('replaces its codes and vehicle tags; a barcode used by another item is refused', async () => {
    let d = await detail(items['ABEA002']!);
    const ok = await send('PUT', `/api/catalog/items/${items['ABEA002']}/identifiers`, 'maria', {
      rowVersion: d.item.rowVersion,
      identifiers: [
        { kind: 'barcode', value: 'ABEA002' },
        { kind: 'oem', value: '17540-63R30' },
      ],
    });
    expect(ok.statusCode).toBe(200);
    d = await detail(items['ABEA002']!);
    expect(d.identifiers.map((i) => `${i.kind}:${i.value}`).sort()).toEqual([
      'barcode:ABEA002',
      'oem:17540-63R30',
    ]);
    const taken = await send('PUT', `/api/catalog/items/${items['ABEA002']}/identifiers`, 'maria', {
      rowVersion: d.item.rowVersion,
      identifiers: [
        { kind: 'barcode', value: 'ABEA002' },
        { kind: 'barcode', value: 'abea-001' },
      ],
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ error: 'barcode_taken', code: 'ABEA001' });
    const vehicles = await send('PUT', `/api/catalog/items/${items['ABEA002']}/vehicles`, 'maria', {
      rowVersion: d.item.rowVersion,
      vehicles: [{ makeId: null, model: 'EVERY', yearFrom: 2005, yearTo: null, note: null }],
    });
    expect(vehicles.statusCode).toBe(200);
    expect((await detail(items['ABEA002']!)).vehicles).toEqual([
      expect.objectContaining({ model: 'EVERY', yearFrom: 2005, yearTo: null }),
    ]);
  });
});

describe('prices (only the owner, owner answer 3)', () => {
  it('a manager may not change prices', async () => {
    const d = await detail(items['ABEA001']!);
    const res = await send('PUT', `/api/catalog/items/${items['ABEA001']}/prices`, 'maria', {
      rowVersion: d.item.rowVersion,
      tiers: { RETAIL: 420000, MECHANIC: 380000, WHOLESALE: 360000 },
      floor: null,
    });
    expect(res.statusCode).toBe(403);
  });

  it('the owner changes them; each changed price is kept in the history with who and why', async () => {
    let d = await detail(items['ABEA001']!);
    const up = await send('PUT', `/api/catalog/items/${items['ABEA001']}/prices`, 'owner', {
      rowVersion: d.item.rowVersion,
      tiers: { RETAIL: 420000, MECHANIC: 380000, WHOLESALE: 360000 },
      floor: null,
    });
    expect(up.statusCode).toBe(200);
    d = await detail(items['ABEA001']!);
    const down = await send('PUT', `/api/catalog/items/${items['ABEA001']}/prices`, 'owner', {
      rowVersion: d.item.rowVersion,
      tiers: { RETAIL: 420000, MECHANIC: 370000, WHOLESALE: 350000 },
      floor: 330000,
    });
    expect(down.statusCode).toBe(400);
    expect(down.json()).toMatchObject({ error: 'invalid', problems: ['reason_required'] });
    const withReason = await send('PUT', `/api/catalog/items/${items['ABEA001']}/prices`, 'owner', {
      rowVersion: d.item.rowVersion,
      tiers: { RETAIL: 420000, MECHANIC: 370000, WHOLESALE: 350000 },
      floor: 330000,
      reason: 'market_price',
    });
    expect(withReason.statusCode).toBe(200);
    d = await detail(items['ABEA001']!);
    expect(d.prices).toEqual({ RETAIL: 420000, MECHANIC: 370000, WHOLESALE: 350000 });
    expect(d.floor).toEqual({ own: 330000, fromCost: 315000, effective: 330000, source: 'item' });
    // Newest first.
    expect(d.history).toEqual([
      expect.objectContaining({
        target: 'floor',
        old: null,
        new: 330000,
        reason: 'market_price',
        by: 'Owner',
      }),
      expect.objectContaining({ target: 'WHOLESALE', old: 360000, new: 350000, reason: 'market_price' }),
      expect.objectContaining({ target: 'MECHANIC', old: 380000, new: 370000, reason: 'market_price' }),
      expect.objectContaining({ target: 'RETAIL', old: 400000, new: 420000, reason: null }),
    ]);
    expect(await q("SELECT count(*)::int AS n FROM erp.price_history WHERE source = 'manual'")).toEqual([
      { n: 4 },
    ]);
  });

  it('the price history is append-only for the app role', async () => {
    await expect(
      withTenant(pool, { tenantId: tenant }, (_db, c) => c.query('DELETE FROM erp.price_history')),
    ).rejects.toThrow();
  });
});

describe('a new item', () => {
  it('gets its barcode = its code; the owner sets its prices; Mechanic and Wholesale are proposed', async () => {
    const res = await send('POST', '/api/catalog/items', 'owner', {
      code: ' abea050 ',
      name: 'ADJUSTER BEARING VITZ',
      categoryId: categoryAbea,
      unitId: unitPcs,
      prices: { RETAIL: 395000 },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json<{ id: string }>();
    const d = await detail(id);
    expect(d.item.code).toBe('ABEA050');
    expect(d.identifiers).toEqual([expect.objectContaining({ kind: 'barcode', value: 'ABEA050' })]);
    expect(d.prices).toEqual({ RETAIL: 395000, MECHANIC: 375300, WHOLESALE: 355500 });
    expect(d.history.map((h) => h.target).sort()).toEqual(['MECHANIC', 'RETAIL', 'WHOLESALE']);
  });

  it('a manager adds one without prices, and may not send any', async () => {
    const priced = await send('POST', '/api/catalog/items', 'maria', {
      code: 'OIL051',
      name: 'GEAR OIL 1L',
      categoryId: categoryOils,
      unitId: unitLitre,
      prices: { RETAIL: 120000 },
    });
    expect(priced.statusCode).toBe(403);
    const res = await send('POST', '/api/catalog/items', 'maria', {
      code: 'OIL051',
      name: 'GEAR OIL 1L',
      categoryId: categoryOils,
      unitId: unitLitre,
    });
    expect(res.statusCode).toBe(201);
    expect((await detail(res.json<{ id: string }>().id)).prices).toEqual({
      RETAIL: null,
      MECHANIC: null,
      WHOLESALE: null,
    });
  });

  it('refuses a code already used', async () => {
    const res = await send('POST', '/api/catalog/items', 'owner', {
      code: 'abea001',
      name: 'X',
      categoryId: categoryAbea,
      unitId: unitPcs,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'code_taken' });
  });
});

describe('the category margin', () => {
  it("only the owner changes it; it re-writes that category's floors from cost, and only those", async () => {
    const lookups = (await send('GET', '/api/catalog/lookups', 'owner')).json<{
      categories: { id: string; code: string; floorMarginBp: number | null; rowVersion: string }[];
      live: boolean;
    }>();
    expect(lookups.live).toBe(false);
    const abea = lookups.categories.find((c) => c.code === 'ABEA')!;
    expect(abea.floorMarginBp).toBe(500);
    expect(
      (
        await send('PATCH', `/api/catalog/categories/${abea.id}`, 'maria', {
          rowVersion: abea.rowVersion,
          floorMarginBp: 1000,
        })
      ).statusCode,
    ).toBe(403);
    const res = await send('PATCH', `/api/catalog/categories/${abea.id}`, 'owner', {
      rowVersion: abea.rowVersion,
      floorMarginBp: 1000,
    });
    expect(res.statusCode).toBe(200);
    // 3,000 + 10 % = 3,300.
    expect(
      await q<{ floor: string }>(
        'SELECT floor::text FROM erp.item_floors WHERE item_id = $1 AND deleted_at IS NULL',
        [items['ABEA001']],
      ),
    ).toEqual([{ floor: '330000' }]);
    expect((await detail(items['ABEA001']!)).floor.fromCost).toBe(330000);
  });

  it('says when the shop is live, so the screens stop warning that the final import overwrites them', async () => {
    await admin.query('UPDATE erp.tenants SET go_live_at = now() WHERE id = $1', [tenant]);
    expect((await send('GET', '/api/catalog/lookups', 'owner')).json<{ live: boolean }>().live).toBe(true);
  });
});
