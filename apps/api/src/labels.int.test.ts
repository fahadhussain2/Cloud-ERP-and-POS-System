import { TenantSpec } from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTenant, createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Item labels (W1-17 plan; CAT-08, D-019, D-055): the labels a posted goods receipt starts with, a relabel of items
// picked on the items screen, and the label template only the owner changes. Under RLS: printing needs
// cat.label.print (owner, manager, purchaser), the template admin.settings (the owner, owner answer 5).

const SHOP = 'label-shop';
const OTHER = 'label-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let pool: pg.Pool;
let tenant: string;
let items: Record<string, string>;
let shopLocation: string;
let naveed = '';
let khan = '';
let receiptId = '';
let draftId = '';
const cookies: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date('2026-11-07T06:00:00.000Z') });

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

const send = (method: 'GET' | 'POST' | 'PUT', url: string, who: string, payload?: unknown) =>
  app().inject({
    method,
    url,
    headers: { origin: ORIGIN, host: HOST },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    cookies: { erp_session: cookies[who]! },
  });

async function login(username: string, shop = SHOP) {
  const res = await app().inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { tenantCode: shop, username, password: PASSWORD },
  });
  const c = res.cookies.find((x) => x.name === 'erp_session')?.value;
  if (!c) throw new Error(`login failed for ${username}: ${res.body}`);
  cookies[username] = c;
}

type Line = { itemId: string; code: string; supplierAbbr: string | null; count: number; warnings: string[] };
type Labels = {
  source: { number: string; supplier: string } | null;
  template: Record<string, unknown>;
  lines: Line[];
};

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  ({ tenantId: tenant } = await setupTenant(db.ownerUrl, TenantSpec.parse({ ...deluxSpec, code: SHOP }), {
    ownerPasswordHash: 'x',
    mustChangePassword: false,
  }));
  const other = await createTenant(db.ownerUrl, 'Other Shop', OTHER);
  items = await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    const ids = await seedCatalog(c, tenant, [
      { code: 'ABEA001', name: 'ADJUSTER BEARING SALOON', category: 'ABEA', prices: { RETAIL: 160000 } },
      { code: 'ABEA002', name: 'ADJUSTER BEARING EVERY', category: 'ABEA', prices: { RETAIL: 60000 } },
      {
        code: 'OIL050',
        name: 'ENGINE OIL',
        category: 'OILS',
        unit: 'LITRE',
        fractional: true,
        prices: { RETAIL: 2500 },
      },
      { code: 'ZZZ001', name: 'NEVER BOUGHT', category: 'ABEA', prices: { RETAIL: 1000 } },
      { code: 'ZZZ002', name: 'NO SUPPLIER AT ALL', category: 'ABEA', prices: { RETAIL: 1000 } },
    ]);
    // ABEA002 comes with the maker's barcode on its box, besides its own code.
    await c.query(
      `INSERT INTO erp.item_identifiers (tenant_id, item_id, kind, value, normalized_value, is_primary)
       VALUES ($1, $2, 'barcode', '8961014000012', '8961014000012', false)`,
      [tenant, ids['ABEA002']],
    );
    return ids;
  });
  shopLocation = await withTenant(
    pool,
    { tenantId: tenant },
    async (_db, c) =>
      (await c.query<{ id: string }>("SELECT id FROM erp.locations WHERE code = 'SHOP'")).rows[0]!.id,
  );
  await addUser('owner', 'owner');
  await addUser('maria', 'manager');
  await addUser('pete', 'purchaser');
  await addUser('sara', 'salesman');
  await addUser('otto', 'owner', other);
  for (const u of ['owner', 'maria', 'pete', 'sara']) await login(u);
  await login('otto', OTHER);

  const supplier = async (code: string, name: string, labelAbbr: string) =>
    (await send('POST', '/api/purchasing/suppliers', 'owner', { code, name, labelAbbr })).json<{
      id: string;
    }>().id;
  naveed = await supplier('0210', 'Naveed Glass', 'ng');
  khan = await supplier('0300', 'Khan Traders', 'KH');
  await withTenant(pool, { tenantId: tenant }, (_db, c) =>
    c.query('UPDATE erp.items SET default_supplier_id = $1 WHERE id = $2', [khan, items['ZZZ001']]),
  );

  const draft = {
    supplierId: naveed,
    billNo: 'INV-77',
    billDate: '2026-11-06',
    receivedOn: '2026-11-07',
    locationId: shopLocation,
    paidFrom: null,
    billDiscount: 0,
    billTotal: 1342050,
    notes: null,
    lines: [
      { itemId: items['ABEA001'], qty: 10000, unitCost: 125000, lineDiscount: 0 },
      { itemId: items['ABEA002'], qty: 2000, unitCost: 45000, lineDiscount: 0 },
      { itemId: items['OIL050'], qty: 20500, unitCost: 100, lineDiscount: 0 },
    ],
  };
  const made = (await send('POST', '/api/purchasing/receipts', 'owner', draft)).json<{
    id: string;
    rowVersion: string;
  }>();
  receiptId = made.id;
  const posted = await send('POST', `/api/purchasing/receipts/${receiptId}/post`, 'owner', {
    rowVersion: made.rowVersion,
  });
  if (posted.statusCode !== 200) throw new Error(`post failed: ${posted.body}`);
  draftId = (await send('POST', '/api/purchasing/receipts', 'owner', { ...draft, billNo: 'INV-78' })).json<{
    id: string;
  }>().id;
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('the label template', () => {
  it('starts as the 40 × 28 mm roll label, and no labels on items with the maker’s barcode (CAT-08)', async () => {
    const res = await send('GET', '/api/catalog/labels/template', 'pete');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      widthMm: 40,
      heightMm: 28,
      marginMm: 1,
      shopAbbr: '',
      showName: true,
      labelMakerBarcoded: false,
    });
  });

  it('is changed by the owner only; a manager is refused', async () => {
    const delux = {
      widthMm: 40,
      heightMm: 28,
      marginMm: 1,
      shopAbbr: 'dcac',
      showName: true,
      labelMakerBarcoded: true,
    };
    expect((await send('PUT', '/api/catalog/labels/template', 'maria', delux)).statusCode).toBe(403);
    const saved = await send('PUT', '/api/catalog/labels/template', 'owner', delux);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ shopAbbr: 'DCAC', labelMakerBarcoded: true });
    expect((await send('GET', '/api/catalog/labels/template', 'maria')).json()).toMatchObject({
      shopAbbr: 'DCAC',
    });
  });

  it('is refused with its problems, and keeps the shop’s other settings', async () => {
    const bad = await send('PUT', '/api/catalog/labels/template', 'owner', {
      widthMm: 300,
      heightMm: 28,
      marginMm: 1,
      shopAbbr: '',
      showName: true,
      labelMakerBarcoded: true,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'invalid', problems: ['width_out_of_range'] });
    const { rows } = await withTenant(pool, { tenantId: tenant }, (_db, c) =>
      c.query<{ settings: Record<string, unknown> }>('SELECT settings FROM erp.tenants'),
    );
    expect(rows[0]!.settings['labels']).toMatchObject({ shopAbbr: 'DCAC' });
  });

  it("is never another shop's", async () => {
    expect((await send('GET', '/api/catalog/labels/template', 'otto')).json()).toMatchObject({
      shopAbbr: '',
    });
  });
});

describe('labels for a posted goods receipt', () => {
  it('one per piece, one per line for oil, with the receipt’s supplier; by id or by number', async () => {
    const res = await send('GET', `/api/catalog/labels/receipt?receipt=${receiptId}`, 'pete');
    expect(res.statusCode).toBe(200);
    const body = res.json<Labels>();
    expect(body.source).toEqual({ number: 'GR000001', supplier: 'Naveed Glass' });
    expect(body.template).toMatchObject({ shopAbbr: 'DCAC' });
    // The shop labels items with the maker's barcode too (saved above): ABEA002 gets its 2.
    expect(body.lines.map((l) => [l.code, l.supplierAbbr, l.count])).toEqual([
      ['ABEA001', 'NG', 10],
      ['ABEA002', 'NG', 2],
      ['OIL050', 'NG', 1],
    ]);
    const byNumber = await send('GET', '/api/catalog/labels/receipt?receipt=gr000001', 'maria');
    expect(byNumber.json<Labels>().lines).toHaveLength(3);
  });

  it('an item with the maker’s barcode starts at 0 when the shop doesn’t label those', async () => {
    await send('PUT', '/api/catalog/labels/template', 'owner', {
      widthMm: 40,
      heightMm: 28,
      marginMm: 1,
      shopAbbr: 'DCAC',
      showName: true,
      labelMakerBarcoded: false,
    });
    const body = (
      await send('GET', `/api/catalog/labels/receipt?receipt=${receiptId}`, 'pete')
    ).json<Labels>();
    expect(body.lines.map((l) => [l.code, l.count])).toEqual([
      ['ABEA001', 10],
      ['ABEA002', 0],
      ['OIL050', 1],
    ]);
  });

  it('a draft is refused, an unknown or another shop’s receipt is not found', async () => {
    const draft = await send('GET', `/api/catalog/labels/receipt?receipt=${draftId}`, 'pete');
    expect(draft.statusCode).toBe(409);
    expect(draft.json()).toEqual({ error: 'not_posted' });
    expect((await send('GET', '/api/catalog/labels/receipt?receipt=GR999999', 'pete')).statusCode).toBe(404);
    expect((await send('GET', `/api/catalog/labels/receipt?receipt=${receiptId}`, 'otto')).statusCode).toBe(
      404,
    );
    expect((await send('GET', '/api/catalog/labels/receipt', 'pete')).statusCode).toBe(400);
  });

  it('a salesman can’t print labels', async () => {
    expect((await send('GET', `/api/catalog/labels/receipt?receipt=${receiptId}`, 'sara')).statusCode).toBe(
      403,
    );
    expect((await send('GET', '/api/catalog/labels/template', 'sara')).statusCode).toBe(403);
  });
});

describe('a relabel of items', () => {
  it('one each, with the last supplier, else the default supplier, else none', async () => {
    const res = await send('POST', '/api/catalog/labels/items', 'maria', {
      itemIds: [items['ZZZ002'], items['ABEA001'], items['ZZZ001']],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Labels>();
    expect(body.source).toBeNull();
    expect(body.lines.map((l) => [l.code, l.supplierAbbr, l.count, l.warnings])).toEqual([
      ['ZZZ002', null, 1, ['supplier_abbr_missing']],
      ['ABEA001', 'NG', 1, []],
      ['ZZZ001', 'KH', 1, []],
    ]);
  });

  it('leaves out items that are not the shop’s, and refuses a salesman', async () => {
    const res = await send('POST', '/api/catalog/labels/items', 'otto', { itemIds: [items['ABEA001']] });
    expect(res.json<Labels>().lines).toEqual([]);
    expect(
      (await send('POST', '/api/catalog/labels/items', 'sara', { itemIds: [items['ABEA001']] })).statusCode,
    ).toBe(403);
    expect((await send('POST', '/api/catalog/labels/items', 'maria', { itemIds: ['x'] })).statusCode).toBe(
      400,
    );
  });
});
