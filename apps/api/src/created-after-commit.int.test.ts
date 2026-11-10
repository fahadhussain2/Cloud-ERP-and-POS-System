import { TenantSpec } from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Bug (CI, PR #112, 2026-11-06): the catalog and purchasing routes answered 201 from inside their transaction, so a
// client could read before the commit and not find what it had just made (a draft "not found", a payment missing from
// the ledger). Every COMMIT is slowed here, so an answer sent before it shows: what a 201 names must already be
// readable from another connection when the answer arrives.

const SHOP = 'commit-shop';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';
const COMMIT_DELAY_MS = 300;

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Client;
let tenant: string;
let cookie = '';
let shopLocation = '';
let category = '';
let unit = '';
/** A seeded item: a draft needs a line (owner review of W1-19). */
let bearing = '';
const app = () => buildApp({ pool, now: () => new Date('2026-11-06T06:00:00.000Z') });

const send = (method: 'POST', url: string, payload: unknown) =>
  app().inject({
    method,
    url,
    headers: { origin: ORIGIN, host: HOST },
    payload: payload as Record<string, unknown>,
    cookies: { erp_session: cookie },
  });
const exists = async (table: string, id: string) =>
  (await admin.query(`SELECT 1 FROM erp.${table} WHERE id = $1`, [id])).rowCount === 1;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  // Every transaction takes a while to commit, as on a busy machine.
  pool.on('connect', (client) => {
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (
      ...args: unknown[]
    ) =>
      args[0] === 'COMMIT'
        ? new Promise((resolve) => setTimeout(resolve, COMMIT_DELAY_MS)).then(() => query(...args))
        : query(...args);
  });
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  ({ tenantId: tenant } = await setupTenant(db.ownerUrl, TenantSpec.parse({ ...deluxSpec, code: SHOP }), {
    ownerPasswordHash: 'x',
    mustChangePassword: false,
  }));
  await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    await seedCatalog(c, tenant, [
      { code: 'ABEA001', name: 'BEARING', category: 'ABEA', prices: { RETAIL: 100 } },
    ]);
    const role = await c.query<{ id: string }>(
      `INSERT INTO erp.roles (tenant_id, name, permissions, limits) VALUES ($1, 'All', $2, $3) RETURNING id`,
      [tenant, ROLE_TEMPLATES.owner.permissions, ROLE_TEMPLATES.owner.limits],
    );
    const user = await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, password_hash) VALUES ($1, 'owner', 'Owner', $2)
       RETURNING id`,
      [tenant, await hashPassword(PASSWORD)],
    );
    await c.query('INSERT INTO erp.user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
      tenant,
      user.rows[0]!.id,
      role.rows[0]!.id,
    ]);
    shopLocation = (await c.query<{ id: string }>("SELECT id FROM erp.locations WHERE code = 'SHOP'"))
      .rows[0]!.id;
    category = (await c.query<{ id: string }>("SELECT id FROM erp.categories WHERE code = 'ABEA'")).rows[0]!
      .id;
    unit = (await c.query<{ id: string }>("SELECT id FROM erp.units WHERE code = 'PCS'")).rows[0]!.id;
    bearing = (await c.query<{ id: string }>("SELECT id FROM erp.items WHERE code = 'ABEA001'")).rows[0]!.id;
  });
  const login = await app().inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { tenantCode: SHOP, username: 'owner', password: PASSWORD },
  });
  cookie = login.cookies.find((x) => x.name === 'erp_session')!.value;
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.drop();
});

it('a supplier, a receipt draft, a return draft and a new item exist by the time their 201 arrives', async () => {
  const supplier = await send('POST', '/api/purchasing/suppliers', { code: 'S1', name: 'Naveed Glass' });
  expect(supplier.statusCode).toBe(201);
  const supplierId = supplier.json<{ id: string }>().id;
  expect(await exists('parties', supplierId)).toBe(true);

  const receipt = await send('POST', '/api/purchasing/receipts', {
    supplierId,
    billNo: 'INV-1',
    billDate: '2026-11-05',
    receivedOn: '2026-11-06',
    locationId: shopLocation,
    paidFrom: null,
    billDiscount: 0,
    billTotal: null,
    notes: null,
    lines: [{ itemId: bearing, qty: 1000, unitCost: 100, lineDiscount: 0 }],
  });
  expect(receipt.statusCode).toBe(201);
  expect(await exists('goods_receipts', receipt.json<{ id: string }>().id)).toBe(true);

  const back = await send('POST', '/api/purchasing/returns', {
    supplierId,
    locationId: shopLocation,
    returnedOn: '2026-11-06',
    reason: null,
    note: null,
    lines: [{ itemId: bearing, receiptLineId: null, qty: 1000, unitCost: 100 }],
  });
  expect(back.statusCode).toBe(201);
  expect(await exists('purchase_returns', back.json<{ id: string }>().id)).toBe(true);

  const item = await send('POST', '/api/catalog/items', {
    code: 'ABEA002',
    name: 'BEARING 2',
    categoryId: category,
    unitId: unit,
  });
  expect(item.statusCode).toBe(201);
  expect(await exists('items', item.json<{ id: string }>().id)).toBe(true);

  const brand = await send('POST', '/api/catalog/brands', { name: 'CHINA' });
  expect(brand.statusCode).toBe(201);
  expect(await exists('brands', brand.json<{ id: string }>().id)).toBe(true);
});
