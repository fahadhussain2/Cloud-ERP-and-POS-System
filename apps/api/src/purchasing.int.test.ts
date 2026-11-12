import { TenantSpec } from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTenant, createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@erp/domain';
import { checkRebuild } from '@erp/posting';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Purchasing in the back office (W1-16 plan; PUR-01, PUR-02, PUR-03, PUR-09): suppliers, a goods receipt typed as a
// draft and posted once its lines equal the supplier's bill, a purchase return limited by what was received, a
// supplier payment by bank, and the supplier's ledger. Under RLS, with the permissions of owner answer 2.

const SHOP = 'buy-shop';
const OTHER = 'buy-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Client;
let tenant: string;
let items: Record<string, string>;
let shopLocation: string;
let godown: string;
let hbl: string;
const cookies: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date('2026-11-06T06:00:00.000Z') });

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

const send = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  who: string,
  payload?: unknown,
) =>
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

const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  (await admin.query<T>(sql, params)).rows;

type Ledger = {
  supplier: { id: string; code: string; name: string; termsDays: number | null; labelAbbr: string | null };
  balance: number;
  ledger: { kind: string; number: string; amount: number; balance: number; dueDate: string }[];
};
const ledgerOf = async (id: string, who = 'owner') =>
  (await send('GET', `/api/purchasing/suppliers/${id}`, who)).json<Ledger>();

let naveed = '';
let receiptId = '';

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
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
    ]);
    await c.query(
      `UPDATE erp.categories SET pricing_rule = '{"floor_min_margin_bp": 500}' WHERE code = 'ABEA'`,
    );
    return ids;
  });
  [shopLocation, godown, hbl] = await withTenant(pool, { tenantId: tenant }, async (_db, c) => [
    (await c.query<{ id: string }>("SELECT id FROM erp.locations WHERE code = 'SHOP'")).rows[0]!.id,
    (await c.query<{ id: string }>("SELECT id FROM erp.locations WHERE code = 'GODOWN'")).rows[0]!.id,
    (await c.query<{ id: string }>("SELECT id FROM erp.bank_accounts WHERE code = 'hbl'")).rows[0]!.id,
  ]);
  await addUser('owner', 'owner');
  await addUser('maria', 'manager');
  await addUser('sara', 'salesman');
  await addUser('adil', 'accountant');
  await addUser('otto', 'owner', other);
  for (const u of ['owner', 'maria', 'sara', 'adil']) await login(u);
  await login('otto', OTHER);
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.drop();
});

describe('suppliers (PUR-01)', () => {
  it('are added with terms and a label abbreviation, listed with what the shop owes, and edited', async () => {
    const res = await send('POST', '/api/purchasing/suppliers', 'maria', {
      code: '0210',
      name: 'Naveed Glass',
      contactPerson: 'Naveed',
      phones: ['0300 1234567'],
      address: 'Plaza Market',
      termsDays: 30,
      labelAbbr: 'NG',
    });
    expect(res.statusCode).toBe(201);
    naveed = res.json<{ id: string }>().id;
    const list = (await send('GET', '/api/purchasing/suppliers', 'maria')).json<{
      suppliers: { code: string; name: string; balance: number }[];
    }>();
    expect(list.suppliers).toEqual([
      expect.objectContaining({ code: '0210', name: 'Naveed Glass', balance: 0 }),
    ]);
    const s = (await send('GET', `/api/purchasing/suppliers/${naveed}`, 'maria')).json<{
      supplier: { rowVersion: string };
    }>();
    const edit = await send('PATCH', `/api/purchasing/suppliers/${naveed}`, 'maria', {
      rowVersion: s.supplier.rowVersion,
      labelAbbr: 'NGL',
    });
    expect(edit.statusCode).toBe(200);
    expect((await ledgerOf(naveed)).supplier).toMatchObject({ termsDays: 30, labelAbbr: 'NGL' });
  });

  it("refuse a salesman, and never show another shop's", async () => {
    expect((await send('GET', '/api/purchasing/suppliers', 'sara')).statusCode).toBe(403);
    expect((await send('GET', `/api/purchasing/suppliers/${naveed}`, 'otto')).statusCode).toBe(404);
  });
});

describe('items for a receipt line', () => {
  it('are found by code or name words, with their unit rule, last cost and Retail', async () => {
    const r = (await send('GET', '/api/purchasing/items?q=bearing%20every', 'maria')).json<{
      items: { code: string; allowsFraction: boolean; retail: number | null }[];
    }>();
    expect(r.items).toEqual([
      expect.objectContaining({ code: 'ABEA002', allowsFraction: false, retail: 60000 }),
    ]);
    expect((await send('GET', '/api/purchasing/items?q=oil', 'sara')).statusCode).toBe(403);
  });
});

describe('a goods receipt (PUR-02)', () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    supplierId: naveed,
    billNo: 'INV-4471',
    billDate: '2026-11-05',
    receivedOn: '2026-11-06',
    locationId: shopLocation,
    paidFrom: null,
    billDiscount: 0,
    billTotal: 1340000,
    notes: null,
    lines: [
      { itemId: items['ABEA001'], qty: 10000, unitCost: 125000, lineDiscount: 0 },
      { itemId: items['ABEA002'], qty: 2000, unitCost: 45050, lineDiscount: 0 },
    ],
    ...over,
  });

  it('an empty receipt or return draft is refused (owner review of W1-19)', async () => {
    const receipt = await send('POST', '/api/purchasing/receipts', 'maria', draft({ lines: [] }));
    expect(receipt.statusCode).toBe(400);
    expect(receipt.json()).toEqual({ error: 'empty_draft' });
    const back = await send('POST', '/api/purchasing/returns', 'maria', {
      supplierId: naveed,
      locationId: shopLocation,
      returnedOn: '2026-11-06',
      reason: null,
      note: null,
      lines: [],
    });
    expect(back.statusCode).toBe(400);
    expect(back.json()).toEqual({ error: 'empty_draft' });
  });

  it('is saved as a draft without a number, and shows the difference from the bill', async () => {
    const res = await send('POST', '/api/purchasing/receipts', 'maria', draft());
    expect(res.statusCode).toBe(201);
    receiptId = res.json<{ id: string }>().id;
    const r = (await send('GET', `/api/purchasing/receipts/${receiptId}`, 'maria')).json<{
      receipt: { status: string; number: string | null };
      check: { total: number; difference: number; problems: { problem: string }[] };
    }>();
    expect(r.receipt).toMatchObject({ status: 'draft', number: null });
    expect(r.check).toMatchObject({
      total: 1340100,
      difference: -100,
      problems: [{ problem: 'total_mismatch' }],
    });
  });

  it('is refused at Post while the lines differ from the bill, then posted once they match', async () => {
    const before = (await send('GET', `/api/purchasing/receipts/${receiptId}`, 'maria')).json<{
      receipt: { rowVersion: string };
    }>();
    const refused = await send('POST', `/api/purchasing/receipts/${receiptId}/post`, 'maria', {
      rowVersion: before.receipt.rowVersion,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'invalid', problems: [{ problem: 'total_mismatch' }] });
    const saved = await send('PUT', `/api/purchasing/receipts/${receiptId}`, 'maria', {
      rowVersion: before.receipt.rowVersion,
      ...draft({ billTotal: 1340100 }),
    });
    expect(saved.statusCode).toBe(200);
    const posted = await send('POST', `/api/purchasing/receipts/${receiptId}/post`, 'maria', {
      rowVersion: saved.json<{ rowVersion: string }>().rowVersion,
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json()).toMatchObject({ number: 'GR000001' });
  });

  it('moves the stock, the average, the last purchase and the floor, and the supplier is owed it from the due date', async () => {
    expect(
      await q<{ qty: string }>(
        'SELECT qty::text FROM erp.stock_balances WHERE item_id = $1 AND location_id = $2',
        [items['ABEA001'], shopLocation],
      ),
    ).toEqual([{ qty: '10.000' }]);
    expect(
      await q(
        'SELECT avg_cost::int, last_cost::int, last_supplier_id FROM erp.item_costs WHERE item_id = $1',
        [items['ABEA001']],
      ),
    ).toEqual([{ avg_cost: 125000, last_cost: 125000, last_supplier_id: naveed }]);
    // Rs 1,250 + 5 % = Rs 1,312.50.
    expect(await q('SELECT floor::int FROM erp.item_floors WHERE item_id = $1', [items['ABEA001']])).toEqual([
      { floor: 131250 },
    ]);
    const l = await ledgerOf(naveed);
    expect(l.balance).toBe(1340100);
    expect(l.ledger).toEqual([
      expect.objectContaining({
        kind: 'goods_receipt',
        number: 'GR000001',
        amount: 1340100,
        dueDate: '2026-12-05',
      }),
    ]);
  });

  it('is never changed or deleted once posted', async () => {
    const r = (await send('GET', `/api/purchasing/receipts/${receiptId}`, 'owner')).json<{
      receipt: { rowVersion: string };
    }>();
    const put = await send('PUT', `/api/purchasing/receipts/${receiptId}`, 'owner', {
      rowVersion: r.receipt.rowVersion,
      ...draft({ billTotal: 1340100 }),
    });
    expect(put.statusCode).toBe(409);
    expect(put.json()).toMatchObject({ error: 'posted' });
    expect((await send('DELETE', `/api/purchasing/receipts/${receiptId}`, 'owner')).statusCode).toBe(409);
    await expect(
      withTenant(pool, { tenantId: tenant }, (_db, c) =>
        c.query('UPDATE erp.goods_receipt_lines SET qty = 1 WHERE receipt_id = $1', [receiptId]),
      ),
    ).rejects.toThrow();
  });

  it('with a bill discount into Godown: the values add up to the bill exactly; a draft can be deleted', async () => {
    const res = await send(
      'POST',
      '/api/purchasing/receipts',
      'owner',
      draft({
        billNo: 'INV-4480',
        locationId: godown,
        billDiscount: 1001,
        billTotal: 48000,
        lines: [
          { itemId: items['ABEA001'], qty: 3000, unitCost: 10000, lineDiscount: 1000 },
          { itemId: items['ABEA002'], qty: 1000, unitCost: 20001, lineDiscount: 0 },
        ],
      }),
    );
    const id = res.json<{ id: string }>().id;
    const rv = (await send('GET', `/api/purchasing/receipts/${id}`, 'owner')).json<{
      receipt: { rowVersion: string };
    }>().receipt.rowVersion;
    expect(
      (await send('POST', `/api/purchasing/receipts/${id}/post`, 'owner', { rowVersion: rv })).json(),
    ).toMatchObject({
      number: 'GR000002',
    });
    expect(
      await q<{ total: string }>(
        `SELECT sum(value_delta)::text AS total FROM erp.stock_movements WHERE source_type = 'goods_receipt' AND source_id = $1`,
        [id],
      ),
    ).toEqual([{ total: '48000' }]);
    const spare = (await send('POST', '/api/purchasing/receipts', 'owner', draft({ billNo: 'SPARE' }))).json<{
      id: string;
    }>().id;
    expect((await send('DELETE', `/api/purchasing/receipts/${spare}`, 'owner')).statusCode).toBe(200);
    expect((await send('GET', `/api/purchasing/receipts/${spare}`, 'owner')).statusCode).toBe(404);
  });

  it('paid by bank: the bill and its payment, so the supplier is owed nothing more for it', async () => {
    const before = (await ledgerOf(naveed)).balance;
    const res = await send(
      'POST',
      '/api/purchasing/receipts',
      'owner',
      draft({
        billNo: 'INV-4490',
        paidFrom: hbl,
        billTotal: 4998,
        lines: [{ itemId: items['OIL050'], qty: 2500, unitCost: 1999, lineDiscount: 0 }],
      }),
    );
    const id = res.json<{ id: string }>().id;
    const rv = (await send('GET', `/api/purchasing/receipts/${id}`, 'owner')).json<{
      receipt: { rowVersion: string };
    }>().receipt.rowVersion;
    expect(
      (await send('POST', `/api/purchasing/receipts/${id}/post`, 'owner', { rowVersion: rv })).statusCode,
    ).toBe(200);
    expect((await ledgerOf(naveed)).balance).toBe(before);
  });
});

describe('a purchase return (PUR-03)', () => {
  it("can't return more than the receipt still has, and takes stock out and the debt down when posted", async () => {
    const lines = (await send('GET', `/api/purchasing/receipts/${receiptId}`, 'maria')).json<{
      lines: { id: string; itemId: string; qty: number; netUnitCost: number }[];
    }>().lines;
    const line = lines.find((l) => l.itemId === items['ABEA001'])!;
    const create = (qty: number) =>
      send('POST', '/api/purchasing/returns', 'maria', {
        supplierId: naveed,
        goodsReceiptId: receiptId,
        locationId: shopLocation,
        returnedOn: '2026-11-06',
        reason: 'damaged',
        note: null,
        lines: [{ itemId: line.itemId, receiptLineId: line.id, qty, unitCost: line.netUnitCost }],
      });
    const tooMany = (await create(11000)).json<{ id: string }>().id;
    const rvOf = async (id: string) =>
      (await send('GET', `/api/purchasing/returns/${id}`, 'maria')).json<{
        purchaseReturn: { rowVersion: string };
      }>().purchaseReturn.rowVersion;
    const refused = await send('POST', `/api/purchasing/returns/${tooMany}/post`, 'maria', {
      rowVersion: await rvOf(tooMany),
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ problems: [{ problem: 'more_than_received', row: 0 }] });
    const ok = (await create(2000)).json<{ id: string }>().id;
    const posted = await send('POST', `/api/purchasing/returns/${ok}/post`, 'maria', {
      rowVersion: await rvOf(ok),
    });
    expect(posted.json()).toMatchObject({ number: 'PR000001' });
    expect(
      await q<{ qty: string }>(
        'SELECT qty::text FROM erp.stock_balances WHERE item_id = $1 AND location_id = $2',
        [items['ABEA001'], shopLocation],
      ),
    ).toEqual([{ qty: '8.000' }]);
    const l = await ledgerOf(naveed);
    expect(l.ledger.at(-1)).toMatchObject({ kind: 'purchase_return', number: 'PR000001', amount: -250000 });
  });
});

describe('a supplier payment by bank (PUR-09)', () => {
  it('is for the owner and the accountant only, and shows on the ledger with the running balance', async () => {
    const pay = (who: string) =>
      send('POST', '/api/purchasing/payments', who, {
        supplierId: naveed,
        bankAccountId: hbl,
        amount: 500000,
        paidOn: '2026-11-06',
        reference: 'CHQ 1001',
      });
    expect((await pay('maria')).statusCode).toBe(403);
    const before = (await ledgerOf(naveed)).balance;
    const res = await pay('adil');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ number: 'SP000001' });
    const l = await ledgerOf(naveed);
    expect(l.balance).toBe(before - 500000);
    expect(l.ledger.at(-1)).toMatchObject({
      kind: 'supplier_payment',
      number: 'SP000001',
      amount: -500000,
      balance: l.balance,
    });
  });
});

describe('deactivating and deleting a supplier', () => {
  const add = async (code: string) =>
    (await send('POST', '/api/purchasing/suppliers', 'maria', { code, name: `Supplier ${code}` })).json<{
      id: string;
    }>().id;
  const rowVersion = async (id: string) =>
    (await send('GET', `/api/purchasing/suppliers/${id}`, 'maria')).json<{
      supplier: { rowVersion: string };
    }>().supplier.rowVersion;
  const status = (id: string, value: 'active' | 'inactive') =>
    rowVersion(id).then((rv) =>
      send('PATCH', `/api/purchasing/suppliers/${id}`, 'maria', { rowVersion: rv, status: value }),
    );

  it('is refused while the shop owes the supplier anything', async () => {
    const res = await status(naveed, 'inactive');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'balance_open' });
  });

  it('a supplier owed nothing is deactivated, left out of the pickers, and active again', async () => {
    const id = await add('0300');
    expect((await status(id, 'inactive')).statusCode).toBe(200);
    const pickers = (await send('GET', '/api/purchasing/lookups', 'maria')).json<{
      suppliers: { id: string }[];
    }>();
    expect(pickers.suppliers.map((x) => x.id)).not.toContain(id);
    const list = (await send('GET', '/api/purchasing/suppliers', 'maria')).json<{
      suppliers: { id: string; status: string }[];
    }>();
    expect(list.suppliers.find((x) => x.id === id)).toMatchObject({ status: 'inactive' });
    expect((await status(id, 'active')).statusCode).toBe(200);
  });

  it('only a supplier never used can be deleted; the list says which can', async () => {
    const unused = await add('0301');
    const list = (await send('GET', '/api/purchasing/suppliers', 'maria')).json<{
      suppliers: { id: string; deletable: boolean }[];
    }>();
    expect(list.suppliers.find((x) => x.id === unused)?.deletable).toBe(true);
    expect(list.suppliers.find((x) => x.id === naveed)?.deletable).toBe(false);
    const used = await send('DELETE', `/api/purchasing/suppliers/${naveed}`, 'maria');
    expect(used.statusCode).toBe(409);
    expect(used.json()).toMatchObject({ error: 'in_use' });
    expect((await send('DELETE', `/api/purchasing/suppliers/${unused}`, 'maria')).statusCode).toBe(200);
    expect((await send('GET', `/api/purchasing/suppliers/${unused}`, 'maria')).statusCode).toBe(404);
    // Kept in the database, marked deleted (parties are synced: never removed, rule 8).
    expect(await q('SELECT deleted_at IS NOT NULL AS gone FROM erp.parties WHERE id = $1', [unused])).toEqual(
      [{ gone: true }],
    );
  });

  it("a supplier that is some item's default supplier can't be deleted", async () => {
    const id = await add('0302');
    await withTenant(pool, { tenantId: tenant }, (_db, c) =>
      c.query('UPDATE erp.items SET default_supplier_id = $1 WHERE id = $2', [id, items['OIL050']]),
    );
    expect((await send('DELETE', `/api/purchasing/suppliers/${id}`, 'maria')).statusCode).toBe(409);
  });

  it('a salesman may do neither', async () => {
    const id = await add('0303');
    expect((await send('DELETE', `/api/purchasing/suppliers/${id}`, 'sara')).statusCode).toBe(403);
  });
});

describe('the books', () => {
  it('rebuild from the documents without a difference', async () => {
    expect((await checkRebuild(pool, tenant)).differences).toEqual([]);
  });

  it('the lookups say the shop is not live yet, with its locations and banks', async () => {
    const l = (await send('GET', '/api/purchasing/lookups', 'maria')).json<{
      live: boolean;
      locations: { code: string }[];
      bankAccounts: { id: string }[];
      can: { receive: boolean; payByBank: boolean };
    }>();
    expect(l.live).toBe(false);
    expect(l.locations.map((x) => x.code)).toEqual(expect.arrayContaining(['SHOP', 'GODOWN']));
    expect(l.bankAccounts.map((b) => b.id)).toContain(hbl);
    expect(l.can).toEqual({ receive: true, payByBank: false });
  });

  it('the lookups carry the lock date, so the screen greys out Post for a locked date (D-108)', async () => {
    const lockDate = async () =>
      (await send('GET', '/api/purchasing/lookups', 'maria')).json<{ lockDate: string | null }>().lockDate;
    expect(await lockDate()).toBeNull();
    await q('UPDATE erp.tenants SET lock_date = $2 WHERE id = $1', [tenant, '2026-10-31']);
    try {
      expect(await lockDate()).toBe('2026-10-31');
    } finally {
      await q('UPDATE erp.tenants SET lock_date = NULL WHERE id = $1', [tenant]);
    }
  });
});
