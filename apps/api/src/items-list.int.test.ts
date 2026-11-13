import { withTenant } from '@erp/db';
import { createTenant, createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { hashPassword } from './auth/password';

// The items list with its stock (W1-26 plan; CAT-01, INV-01…INV-03, RPT-05): each item's quantity in the shop- and
// storage-kind locations (not Damaged), its unit, average cost and stock value (Shop + Godown, owner answer 1), and a
// level from its minimum (Low at or below it, owner answer 2); filtered, sorted and paged on the server, with the
// value of every match. Cost and value only with cost.view; under RLS.

const SHOP = 'items-shop';
const OTHER = 'items-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let pool: pg.Pool;
let tenant: string;
let other: string;
let shop: string;
let godown: string;
let otherShop: string;
const cookies: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date() });

async function addUser(username: string, permissions: readonly string[], tenantId = tenant) {
  const hash = await hashPassword(PASSWORD);
  await withTenant(pool, { tenantId }, async (_db, c) => {
    const role = await c.query<{ id: string }>(
      `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits) VALUES ($1, $2, NULL, $3, $4)
       RETURNING id`,
      [tenantId, `${username} role`, permissions, ROLE_TEMPLATES.owner.limits],
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
const template = (key: RoleTemplateKey) => ROLE_TEMPLATES[key].permissions;

const send = (url: string, who: string) =>
  app().inject({
    method: 'GET',
    url,
    headers: { origin: ORIGIN, host: HOST },
    cookies: { erp_session: cookies[who]! },
  });

async function login(username: string, code = SHOP) {
  const res = await app().inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { tenantCode: code, username, password: PASSWORD },
  });
  const c = res.cookies.find((x) => x.name === 'erp_session')?.value;
  if (!c) throw new Error(`login failed for ${username}: ${res.body}`);
  cookies[username] = c;
}

interface Row {
  code: string;
  unit: string;
  fraction: boolean;
  stock: Record<string, number>;
  level: string;
  avgCost?: number | null;
  value?: number;
}
interface List {
  items: Row[];
  total: number;
  locations: { id: string; name: string }[];
  totalValue?: number;
}
const list = async (qs = '', who = 'owner') => {
  const res = await send(`/api/catalog/items?${qs}`, who);
  expect(res.statusCode).toBe(200);
  return res.json<List>();
};
const codes = async (qs: string, who = 'owner') => (await list(qs, who)).items.map((i) => i.code);
const row = async (code: string, who = 'owner') => (await list(`q=${code}`, who)).items[0]!;

// Shop + Godown and the values, as posting would leave them (thousandths, paisa).
const PAD_VALUE = 12 * 218000; // 8 shop + 4 godown at Rs 2,180; the 2 damaged don't count
const FILTER_VALUE = 3 * 64000;
const FILTER2_VALUE = 3 * 70000;
const PLUG_VALUE = -2 * 105000;
const HOSE_VALUE = Math.round(14.5 * 38000);
const ALL_VALUE = PAD_VALUE + FILTER_VALUE + FILTER2_VALUE + PLUG_VALUE + HOSE_VALUE;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  tenant = await createTenant(db.ownerUrl, 'Items Shop', SHOP);
  other = await createTenant(db.ownerUrl, 'Other Shop', OTHER);
  const where = async (c: pg.ClientBase, tenantId: string) => {
    const branch = (
      await c.query<{ id: string }>(
        "INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'MAIN', 'Main') RETURNING id",
        [tenantId],
      )
    ).rows[0]!.id;
    const loc = async (code: string, name: string, kind: string, sellable: boolean) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO erp.locations (tenant_id, branch_id, code, name, kind, is_sellable)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [tenantId, branch, code, name, kind, sellable],
        )
      ).rows[0]!.id;
    // Made out of order: the list still shows the shop first, then storage.
    const damaged = await loc('DAMAGED', 'Damaged', 'damaged', false);
    const store = await loc('GODOWN', 'Godown', 'storage', false);
    const front = await loc('SHOP', 'Shop', 'shop', true);
    return { damaged, store, front };
  };
  await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    const ids = await seedCatalog(c, tenant, [
      {
        code: 'PAD001',
        name: 'BRAKE PAD SET',
        category: 'BRPD',
        brand: 'GENUINE',
        prices: { RETAIL: 295000 },
      },
      { code: 'FLT001', name: 'OIL FILTER CIVIC', category: 'FILT', prices: { RETAIL: 85000 } },
      { code: 'FLT002', name: 'OIL FILTER CITY', category: 'FILT', prices: { RETAIL: 90000 } },
      {
        code: 'LMP001',
        name: 'HEAD LAMP CULTUS',
        category: 'LAMP',
        status: 'dormant',
        prices: { RETAIL: 950000 },
      },
      { code: 'PLG001', name: 'SPARK PLUG', category: 'PLUG', prices: { RETAIL: 140000 } },
      {
        code: 'HOS001',
        name: 'BRAKE HOSE',
        category: 'BRPD',
        unit: 'METER',
        fractional: true,
        prices: { RETAIL: 52000 },
      },
      { code: 'NOC001', name: 'NO COST WASHER', category: 'PLUG', prices: { RETAIL: 1000 } },
    ]);
    const { damaged, store, front } = await where(c, tenant);
    [shop, godown] = [front, store];
    for (const [code, min] of [
      ['PAD001', 5],
      ['FLT001', 5],
      ['FLT002', 3],
      ['LMP001', 2],
    ] as const)
      await c.query('UPDATE erp.items SET min_qty = $2 WHERE id = $1', [ids[code], min]);
    const stock: [string, string, number][] = [
      ['PAD001', front, 8],
      ['PAD001', store, 4],
      ['PAD001', damaged, 2],
      ['FLT001', front, 3],
      ['FLT002', front, 3],
      ['PLG001', front, -2],
      ['HOS001', front, 4.5],
      ['HOS001', store, 10],
      ['NOC001', front, 2],
    ];
    for (const [code, location, qty] of stock)
      await c.query(
        'INSERT INTO erp.stock_balances (tenant_id, item_id, location_id, qty) VALUES ($1, $2, $3, $4)',
        [tenant, ids[code], location, qty],
      );
    for (const [code, avg] of [
      ['PAD001', 218000],
      ['FLT001', 64000],
      ['FLT002', 70000],
      ['PLG001', 105000],
      ['HOS001', 38000],
    ] as const)
      await c.query(
        'INSERT INTO erp.item_costs (tenant_id, item_id, avg_cost, on_hand) VALUES ($1, $2, $3, 0)',
        [tenant, ids[code], avg],
      );
  });
  await withTenant(pool, { tenantId: other }, async (_db, c) => {
    const ids = await seedCatalog(c, other, [
      { code: 'ZZZ001', name: 'OTHER SHOP ITEM', category: 'ZZZ', prices: { RETAIL: 100 } },
    ]);
    const { front } = await where(c, other);
    otherShop = front;
    await c.query(
      'INSERT INTO erp.stock_balances (tenant_id, item_id, location_id, qty) VALUES ($1, $2, $3, 7)',
      [other, ids['ZZZ001'], front],
    );
  });
  await addUser('owner', template('owner'));
  await addUser('perry', template('purchaser'));
  // A manager whose role has lost cost.view (a custom role, Wave 2), and a pricer who can open nothing else.
  await addUser(
    'maria',
    template('manager').filter((p) => p !== 'cost.view'),
  );
  await addUser('pete', ['cat.price.edit']);
  await addUser('sara', template('salesman'));
  await addUser('otto', template('owner'), other);
  for (const u of ['owner', 'perry', 'maria', 'pete', 'sara']) await login(u);
  await login('otto', OTHER);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('the items list with its stock (W1-26)', () => {
  it('shows the shop- and storage-kind locations, the shop first, and not Damaged', async () => {
    expect((await list()).locations).toEqual([
      { id: shop, name: 'Shop' },
      { id: godown, name: 'Godown' },
    ]);
  });

  it("gives each item's unit, quantity per location, average cost and stock value", async () => {
    expect(await row('PAD001')).toMatchObject({
      unit: 'PCS',
      fraction: false,
      stock: { [shop]: 8000, [godown]: 4000 },
      avgCost: 218000,
      value: PAD_VALUE,
    });
    expect(await row('HOS001')).toMatchObject({
      unit: 'METER',
      fraction: true,
      stock: { [shop]: 4500, [godown]: 10000 },
      value: HOSE_VALUE,
    });
    // Below zero counts below zero; an item with no cost counts 0, as posting does; no stock is an empty map.
    expect(await row('PLG001')).toMatchObject({ stock: { [shop]: -2000 }, value: PLUG_VALUE });
    expect(await row('NOC001')).toMatchObject({ avgCost: null, value: 0 });
    expect((await row('LMP001')).stock).toEqual({});
  });

  it('gives the level from the minimum: Out at 0 or below, Low at or below the minimum, else OK', async () => {
    const level = async (code: string) => (await row(code)).level;
    expect(await level('PAD001')).toBe('ok'); // 12, minimum 5
    expect(await level('FLT001')).toBe('low'); // 3, minimum 5
    expect(await level('FLT002')).toBe('low'); // 3, minimum 3
    expect(await level('LMP001')).toBe('out'); // none, minimum 2
    expect(await level('PLG001')).toBe('out'); // −2
    expect(await level('HOS001')).toBe('ok'); // 14.5, no minimum
    expect(await level('NOC001')).toBe('ok'); // 2, no minimum
  });

  it('filters by level: Low, Out and Below zero', async () => {
    expect(await codes('level=low')).toEqual(['FLT001', 'FLT002']);
    expect(await codes('level=out')).toEqual(['LMP001', 'PLG001']);
    expect(await codes('level=below')).toEqual(['PLG001']);
    // With the other filters and the count.
    expect(await list('level=out&status=active')).toMatchObject({ total: 1, items: [{ code: 'PLG001' }] });
  });

  it('sorts by stock value and by a location, either way, and pages in that order', async () => {
    expect(await codes('sort=value&dir=desc')).toEqual([
      'PAD001',
      'HOS001',
      'FLT002',
      'FLT001',
      'LMP001',
      'NOC001',
      'PLG001',
    ]);
    expect(await codes(`sort=${shop}&dir=asc`)).toEqual([
      'PLG001',
      'LMP001',
      'NOC001',
      'FLT001',
      'FLT002',
      'HOS001',
      'PAD001',
    ]);
    expect(await codes(`sort=${godown}&dir=desc&pageSize=2&page=1`)).toEqual(['HOS001', 'PAD001']);
    // The default stays by code.
    expect(await codes('')).toEqual(['FLT001', 'FLT002', 'HOS001', 'LMP001', 'NOC001', 'PAD001', 'PLG001']);
  });

  it('totals the stock value of every match, not only the page', async () => {
    expect(await list('pageSize=1')).toMatchObject({ total: 7, totalValue: ALL_VALUE });
    expect((await list('level=low&pageSize=1')).totalValue).toBe(FILTER_VALUE + FILTER2_VALUE);
    expect((await list('q=nothing-matches')).totalValue).toBe(0);
  });

  it('leaves out the cost, the value and the total without cost.view, and sorts by code instead of value', async () => {
    const theirs = await list('', 'maria');
    expect(theirs.totalValue).toBeUndefined();
    const pad = theirs.items.find((i) => i.code === 'PAD001')!;
    expect(pad).not.toHaveProperty('avgCost');
    expect(pad).not.toHaveProperty('value');
    expect(pad).toMatchObject({ stock: { [shop]: 8000, [godown]: 4000 }, level: 'ok' });
    expect(await codes('sort=value&dir=desc', 'maria')).toEqual([
      'FLT001',
      'FLT002',
      'HOS001',
      'LMP001',
      'NOC001',
      'PAD001',
      'PLG001',
    ]);
    // A purchaser sees them.
    expect((await row('PAD001', 'perry')).value).toBe(PAD_VALUE);
  });

  it('refuses an unknown level or sort', async () => {
    expect((await send('/api/catalog/items?level=soon', 'owner')).statusCode).toBe(400);
    expect((await send('/api/catalog/items?sort=price', 'owner')).statusCode).toBe(400);
    expect((await send('/api/catalog/items?sort=value&dir=sideways', 'owner')).statusCode).toBe(400);
    // Another shop's location is no column here, so it can't be sorted on.
    expect((await send(`/api/catalog/items?sort=${otherShop}`, 'owner')).statusCode).toBe(400);
  });

  it('says who can open the stock card from the list', async () => {
    const can = async (who: string) =>
      (await send('/api/catalog/lookups', who)).json<{ can: { stockCard: boolean } }>().can.stockCard;
    expect(await can('owner')).toBe(true);
    expect(await can('perry')).toBe(true);
    expect(await can('maria')).toBe(true); // through transfers and adjustments
    expect(await can('pete')).toBe(false);
  });

  it("never shows another shop's stock or locations", async () => {
    expect((await send('/api/catalog/items', 'sara')).statusCode).toBe(403);
    const theirs = await list('', 'otto');
    expect(theirs.locations[0]).toEqual({ id: otherShop, name: 'Shop' });
    expect(theirs.locations.map((l) => l.id)).not.toContain(shop);
    expect(theirs.items).toMatchObject([{ code: 'ZZZ001', stock: { [otherShop]: 7000 } }]);
    expect(Object.keys((await row('PAD001')).stock)).not.toContain(otherShop);
  });
});
