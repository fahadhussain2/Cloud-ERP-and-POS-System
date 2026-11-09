import { exportPublicKey, generateDeviceKey, signCanonical, TenantSpec } from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTenant, createTestDatabase, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Customers in the back office (W1-22 plan, D-109; POS-05, POS-07, CAT-04, PUR-01, ACC-03): add, edit, credit terms,
// deactivate, delete one never used, the ledger; under RLS, with cust.edit (owner, manager, accountant) and
// cust.terms.edit (owner only). A customer added or changed here reaches the counters through the W1-09 pull.

const SHOP = 'cust-shop';
const OTHER = 'cust-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Client;
let tenant: string;
let branch: string;
let hbl: string;
const tier: Record<string, string> = {};
const account: Record<string, string> = {};
const cookies: Record<string, string> = {};
let device = '';
const app = () => buildApp({ pool, now: () => new Date('2026-11-09T06:00:00.000Z') });

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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  who: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  app().inject({
    method,
    url,
    headers: { origin: ORIGIN, host: HOST, ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    ...(who === '' ? {} : { cookies: { erp_session: cookies[who]! } }),
  });

async function login(username: string, shop = SHOP) {
  const res = await send('POST', '/api/auth/login', '', { tenantCode: shop, username, password: PASSWORD });
  const c = res.cookies.find((x) => x.name === 'erp_session')?.value;
  if (!c) throw new Error(`login failed for ${username}: ${res.body}`);
  cookies[username] = c;
}

/** Enrolls a counter for the shop's branch and returns its device token (W0-10 flow). */
async function enrolledToken() {
  const code = (
    await send('POST', '/api/devices/enrollment-codes', 'owner', { branchId: branch, kind: 'counter' })
  ).json<{ code: string }>().code;
  const keys = await generateDeviceKey();
  const publicKey = await exportPublicKey(keys.publicKey);
  const signature = await signCanonical(keys.privateKey, { tenantCode: SHOP, code, publicKey });
  const enrolled = await send('POST', '/api/devices/enroll', '', {
    tenantCode: SHOP,
    code,
    publicKey,
    signature,
  });
  const { deviceId } = enrolled.json<{ deviceId: string }>();
  const { nonce } = (await send('POST', '/api/devices/challenge', '', { tenantId: tenant, deviceId })).json<{
    nonce: string;
  }>();
  const sig = await signCanonical(keys.privateKey, { tenantId: tenant, deviceId, nonce });
  const res = await send('POST', '/api/devices/token', '', {
    tenantId: tenant,
    deviceId,
    nonce,
    signature: sig,
  });
  return res.json<{ accessToken: string }>().accessToken;
}

type Changes = Record<string, Record<string, unknown>[]>;
/** The counter's customer pull from `cursor` (sync spec §3, W1-09). */
async function pullCustomers(cursor?: string): Promise<{ changes: Changes; cursor: string }> {
  const res = await app().inject({
    method: 'GET',
    url: `/api/sync/pull?datasets=customers,customer_accounts,customer_balances${cursor ? `&cursor=${cursor}` : ''}`,
    headers: { authorization: `Device ${device}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

type Row = {
  id: string;
  code: string;
  name: string;
  phones: string[];
  city: string | null;
  tierId: string;
  creditAllowed: boolean;
  creditLimit: number | null;
  offlineDailyCap: number;
  status: string;
  balance: number;
  deletable: boolean;
  imported: boolean;
  supplier: boolean;
};
type Detail = {
  customer: Row & {
    rowVersion: string;
    accountVersion: string;
    address: string | null;
    notes: string | null;
  };
  balance: number;
  ledger: { kind: string; number: string; amount: number; balance: number }[];
};
const list = async (query = '', who = 'owner') =>
  (await send('GET', `/api/customers${query}`, who)).json<{ customers: Row[] }>().customers;
const detail = async (id: string, who = 'owner') =>
  (await send('GET', `/api/customers/${id}`, who)).json<Detail>();
const create = async (body: Record<string, unknown>, who = 'owner') => {
  const res = await send('POST', '/api/customers', who, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
};
const terms = (over: Record<string, unknown> = {}) => ({
  tierId: tier['RETAIL'],
  creditAllowed: false,
  creditLimit: null,
  offlineDailyCap: 2_500_000,
  termsDays: null,
  ...over,
});

/** Posts a balanced journal voucher: Dr the customer on AR, Cr opening balance equity. */
async function owes(customer: string, amount: number) {
  const draft = await send('POST', '/api/accounting/vouchers', 'owner', {
    date: '2026-11-09',
    narration: 'Old dues',
    lines: [
      { accountId: account['1200'], partyId: customer, debit: amount, credit: 0, memo: null },
      { accountId: account['3300'], partyId: null, debit: 0, credit: amount, memo: null },
    ],
  });
  expect(draft.statusCode, draft.body).toBe(201);
  const id = draft.json<{ id: string }>().id;
  const v = (await send('GET', `/api/accounting/vouchers/${id}`, 'owner')).json<{ rowVersion: string }>();
  const posted = await send('POST', `/api/accounting/vouchers/${id}/post`, 'owner', {
    rowVersion: v.rowVersion,
  });
  expect(posted.statusCode, posted.body).toBe(200);
}

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
  await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    branch = (await c.query<{ id: string }>('SELECT id FROM erp.branches LIMIT 1')).rows[0]!.id;
    hbl = (await c.query<{ id: string }>("SELECT id FROM erp.bank_accounts WHERE code = 'hbl'")).rows[0]!.id;
    for (const r of (await c.query<{ id: string; code: string }>('SELECT id, code FROM erp.price_tiers'))
      .rows)
      tier[r.code] = r.id;
    for (const r of (await c.query<{ id: string; code: string }>('SELECT id, code FROM erp.accounts')).rows)
      account[r.code] = r.id;
  });
  await addUser('owner', 'owner');
  await addUser('maria', 'manager');
  await addUser('adil', 'accountant');
  await addUser('sara', 'salesman');
  await addUser('otto', 'owner', other);
  for (const u of ['owner', 'maria', 'adil', 'sara']) await login(u);
  await login('otto', OTHER);
  device = await enrolledToken();
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.drop();
});

describe('adding customers', () => {
  it('suggests C0001 on a shop without customers', async () => {
    const res = await send('GET', '/api/customers/next-code', 'maria');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ code: 'C0001' });
  });

  it('adds one with normalized phones, listed with a zero balance, and suggests the next code', async () => {
    const id = await create({
      code: 'C0041',
      name: 'Khan Motors',
      phones: ['0300-1234567', '+92 321 7654321'],
      city: 'Karachi',
      address: 'Shop 3, Plaza',
      terms: terms({ tierId: tier['MECHANIC'], creditAllowed: true, creditLimit: 10_000_000 }),
    });
    expect((await list()).find((r) => r.id === id)).toMatchObject({
      code: 'C0041',
      name: 'Khan Motors',
      phones: ['03001234567', '03217654321'],
      city: 'Karachi',
      tierId: tier['MECHANIC'],
      creditAllowed: true,
      creditLimit: 10_000_000,
      offlineDailyCap: 2_500_000,
      status: 'active',
      balance: 0,
      deletable: true,
      imported: false,
      supplier: false,
    });
    expect((await send('GET', '/api/customers/next-code', 'owner')).json()).toEqual({ code: 'C0042' });
  });

  it('refuses a code already taken in another case, also by a supplier, and a phone that is not one', async () => {
    const sup = await send('POST', '/api/purchasing/suppliers', 'maria', {
      code: 'S0001',
      name: 'Naveed Traders',
    });
    expect(sup.statusCode, sup.body).toBe(201);
    for (const code of ['c0041', 's0001']) {
      const res = await send('POST', '/api/customers', 'owner', { code, name: 'Twin' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'code_taken' });
    }
    const bad = await send('POST', '/api/customers', 'owner', { code: 'C0050', name: 'Bad', phones: ['12'] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'phone_invalid' });
  });

  it('gives a manager’s customer the default tier, no credit and the Rs 25,000 cap, and refuses their terms', async () => {
    const id = await create({ code: 'C0043', name: 'Bilal Autos' }, 'maria');
    expect((await detail(id, 'maria')).customer).toMatchObject({
      tierId: tier['RETAIL'],
      creditAllowed: false,
      creditLimit: null,
      offlineDailyCap: 2_500_000,
    });
    const withTerms = await send('POST', '/api/customers', 'maria', {
      code: 'C0044',
      name: 'Cheap Mechanic',
      terms: terms({ tierId: tier['WHOLESALE'] }),
    });
    expect(withTerms.statusCode).toBe(403);
    const c = (await detail(id, 'maria')).customer;
    const change = await send('PATCH', `/api/customers/${id}`, 'maria', {
      rowVersion: c.rowVersion,
      accountVersion: c.accountVersion,
      terms: terms({ creditAllowed: true, noLimit: true }),
    });
    expect(change.statusCode).toBe(403);
    // An accountant edits details too, but not terms.
    const accountant = await send('PATCH', `/api/customers/${id}`, 'adil', {
      rowVersion: c.rowVersion,
      city: 'Hyderabad',
    });
    expect(accountant.statusCode, accountant.body).toBe(200);
  });

  it('refuses credit without a limit unless No limit is ticked on purpose', async () => {
    const res = await send('POST', '/api/customers', 'owner', {
      code: 'C0045',
      name: 'No Limit Yet',
      terms: terms({ creditAllowed: true }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'limit_required' });
    const id = await create({
      code: 'C0045',
      name: 'No Limit Yet',
      terms: terms({ creditAllowed: true, noLimit: true }),
    });
    expect((await detail(id)).customer).toMatchObject({ creditAllowed: true, creditLimit: null });
  });

  it('makes an existing supplier a customer on the same party, once', async () => {
    const supplier = (await send('GET', '/api/purchasing/suppliers?q=S0001', 'maria')).json<{
      suppliers: { id: string }[];
    }>().suppliers[0]!.id;
    const lookups = (await send('GET', '/api/customers/lookups', 'owner')).json<{
      suppliers: { id: string }[];
      can: { edit: boolean; terms: boolean };
      defaultOfflineDailyCap: number;
    }>();
    expect(lookups.suppliers.map((s) => s.id)).toEqual([supplier]);
    expect(lookups.can).toEqual({ edit: true, terms: true });
    expect(lookups.defaultOfflineDailyCap).toBe(2_500_000);
    const id = await create({ partyId: supplier }, 'maria');
    expect(id).toBe(supplier);
    expect((await detail(id)).customer).toMatchObject({ code: 'S0001', supplier: true });
    const again = await send('POST', '/api/customers', 'maria', { partyId: supplier });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'already_customer' });
  });
});

describe('editing, searching, deactivating and deleting', () => {
  it('finds customers by code, name word, phone digits and city, and filters by status', async () => {
    expect((await list('?q=khan')).map((r) => r.code)).toEqual(['C0041']);
    expect((await list('?q=7654321')).map((r) => r.code)).toEqual(['C0041']);
    expect((await list('?q=0321-765')).map((r) => r.code)).toEqual(['C0041']);
    expect((await list('?q=c0043')).map((r) => r.code)).toEqual(['C0043']);
    expect((await list('?q=hyderabad')).map((r) => r.code)).toEqual(['C0043']);
  });

  it('refuses a stale save and says who saved in between', async () => {
    const id = (await list('?q=C0043'))[0]!.id;
    const c = (await detail(id)).customer;
    const first = await send('PATCH', `/api/customers/${id}`, 'owner', {
      rowVersion: c.rowVersion,
      name: 'Bilal',
    });
    expect(first.statusCode, first.body).toBe(200);
    const stale = await send('PATCH', `/api/customers/${id}`, 'maria', {
      rowVersion: c.rowVersion,
      name: 'B.',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'stale', by: 'Owner' });
  });

  it('refuses to deactivate a customer who owes, and deactivates and reactivates at zero', async () => {
    const id = (await list('?q=C0041'))[0]!.id;
    await owes(id, 450_000);
    let c = (await detail(id)).customer;
    const refused = await send('PATCH', `/api/customers/${id}`, 'owner', {
      rowVersion: c.rowVersion,
      status: 'inactive',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'balance_open', balance: 450_000 });
    const other = (await list('?q=C0043'))[0]!.id;
    c = (await detail(other)).customer;
    const off = await send('PATCH', `/api/customers/${other}`, 'maria', {
      rowVersion: c.rowVersion,
      status: 'inactive',
    });
    expect(off.statusCode, off.body).toBe(200);
    expect((await list('?status=active')).map((r) => r.code)).not.toContain('C0043');
    expect((await list('?status=inactive')).map((r) => r.code)).toEqual(['C0043']);
    c = (await detail(other)).customer;
    const on = await send('PATCH', `/api/customers/${other}`, 'maria', {
      rowVersion: c.rowVersion,
      status: 'active',
    });
    expect(on.statusCode, on.body).toBe(200);
  });

  it('deletes one never used, refuses one that was, and keeps the supplier of a party that is both', async () => {
    const unused = await create({ code: 'C0060', name: 'Typo Customer' }, 'maria');
    expect((await send('DELETE', `/api/customers/${unused}`, 'maria')).statusCode).toBe(200);
    expect((await list()).map((r) => r.id)).not.toContain(unused);
    const used = (await list('?q=C0041'))[0]!.id;
    const refused = await send('DELETE', `/api/customers/${used}`, 'owner');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'in_use' });
    const both = (await list('?q=S0001'))[0]!.id;
    expect((await send('DELETE', `/api/customers/${both}`, 'maria')).statusCode).toBe(200);
    const sup = await send('GET', `/api/purchasing/suppliers/${both}`, 'maria');
    expect(sup.statusCode, sup.body).toBe(200);
  });

  it('keeps a party active while the shop owes it as a supplier', async () => {
    const sup = await send('POST', '/api/purchasing/suppliers', 'maria', {
      code: 'S0004',
      name: 'Owed Supplier',
    });
    const id = sup.json<{ id: string }>().id;
    await create({ partyId: id }, 'maria');
    const draft = await send('POST', '/api/accounting/vouchers', 'owner', {
      date: '2026-11-09',
      narration: 'Owed to supplier',
      lines: [
        { accountId: account['3300'], partyId: null, debit: 20_000, credit: 0, memo: null },
        { accountId: account['2100'], partyId: id, debit: 0, credit: 20_000, memo: null },
      ],
    });
    const v = (
      await send('GET', `/api/accounting/vouchers/${draft.json<{ id: string }>().id}`, 'owner')
    ).json<{
      id: string;
      rowVersion: string;
    }>();
    await send('POST', `/api/accounting/vouchers/${draft.json<{ id: string }>().id}/post`, 'owner', {
      rowVersion: v.rowVersion,
    });
    const c = (await detail(id)).customer;
    const refused = await send('PATCH', `/api/customers/${id}`, 'maria', {
      rowVersion: c.rowVersion,
      status: 'inactive',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'supplier_balance_open' });
    expect(Math.abs(refused.json<{ balance: number }>().balance)).toBe(20_000);
  });

  it('keeps the supplier delete refusing a party that still has a customer account', async () => {
    const sup = await send('POST', '/api/purchasing/suppliers', 'maria', {
      code: 'S0002',
      name: 'Both Ways',
    });
    const id = sup.json<{ id: string }>().id;
    await create({ partyId: id }, 'maria');
    const refused = await send('DELETE', `/api/purchasing/suppliers/${id}`, 'maria');
    expect(refused.statusCode).toBe(409);
  });
});

describe('the customer ledger (ACC-03)', () => {
  it('shows a voucher and a bank receipt in order with the running balance', async () => {
    const id = (await list('?q=C0041'))[0]!.id;
    const receipt = await send('POST', '/api/accounting/receipts', 'owner', {
      customerId: id,
      bankAccountId: hbl,
      amount: 100_000,
      receivedOn: '2026-11-09',
      reference: 'HBL 7781',
      note: null,
    });
    expect(receipt.statusCode, receipt.body).toBe(201);
    const d = await detail(id);
    expect(d.balance).toBe(350_000);
    expect(d.ledger.map((e) => [e.kind, e.number.slice(0, 2), e.amount, e.balance])).toEqual([
      ['journal_voucher', 'JV', 450_000, 450_000],
      ['customer_receipt', 'CR', -100_000, 350_000],
    ]);
    expect((await list('?q=C0041'))[0]).toMatchObject({ balance: 350_000, deletable: false });
  });
});

describe('permissions and RLS', () => {
  it('refuses a salesman everywhere', async () => {
    const id = (await list('?q=C0041'))[0]!.id;
    for (const [method, url] of [
      ['GET', '/api/customers'],
      ['GET', '/api/customers/lookups'],
      ['GET', `/api/customers/${id}`],
      ['POST', '/api/customers'],
      ['PATCH', `/api/customers/${id}`],
      ['DELETE', `/api/customers/${id}`],
    ] as const)
      expect(
        (await send(method, url, 'sara', method === 'GET' || method === 'DELETE' ? undefined : {}))
          .statusCode,
      ).toBe(403);
  });

  it("never shows or changes another shop's customers", async () => {
    const id = (await list('?q=C0041'))[0]!.id;
    expect((await send('GET', `/api/customers/${id}`, 'otto')).statusCode).toBe(404);
    expect((await send('DELETE', `/api/customers/${id}`, 'otto')).statusCode).toBe(404);
    expect((await send('GET', '/api/customers', 'otto')).json<{ customers: Row[] }>().customers).toEqual([]);
  });
});

describe('reaching the counters (the W1-09 pull)', () => {
  it('sends a new customer, a changed limit, a deactivation and a delete on the next pulls', async () => {
    const start = await pullCustomers();
    const id = await create({
      code: 'C0070',
      name: 'Counter Test',
      phones: ['0333 1112223'],
      city: 'Karachi',
      notes: 'never on the counter',
      terms: terms({ creditAllowed: true, creditLimit: 5_000_000 }),
    });
    const added = await pullCustomers(start.cursor);
    expect(added.changes['customers']!.find((p) => p['id'] === id)).toEqual({
      id,
      code: 'C0070',
      name: 'Counter Test',
      phones: ['03331112223'],
      city: 'Karachi',
      status: 'active',
      row_version: expect.any(String) as unknown,
      deleted_at: null,
    });
    expect(added.changes['customer_accounts']!.find((a) => a['party_id'] === id)).toMatchObject({
      price_tier_id: tier['RETAIL'],
      credit_allowed: true,
      credit_limit: '5000000',
      offline_daily_cap: '2500000',
    });

    let c = (await detail(id)).customer;
    const limit = await send('PATCH', `/api/customers/${id}`, 'owner', {
      rowVersion: c.rowVersion,
      accountVersion: c.accountVersion,
      terms: terms({ creditAllowed: true, creditLimit: 7_500_000 }),
    });
    expect(limit.statusCode, limit.body).toBe(200);
    const changed = await pullCustomers(added.cursor);
    expect(changed.changes['customer_accounts']!.map((a) => a['credit_limit'])).toEqual(['7500000']);

    c = (await detail(id)).customer;
    await send('PATCH', `/api/customers/${id}`, 'owner', { rowVersion: c.rowVersion, status: 'inactive' });
    const inactive = await pullCustomers(changed.cursor);
    expect(inactive.changes['customers']!.map((p) => [p['id'], p['status']])).toEqual([[id, 'inactive']]);

    expect((await send('DELETE', `/api/customers/${id}`, 'owner')).statusCode).toBe(200);
    const removed = await pullCustomers(inactive.cursor);
    expect(
      removed.changes['customer_accounts']!.map((a) => [a['party_id'], a['deleted_at'] !== null]),
    ).toEqual([[id, true]]);
  });

  it('re-sends a supplier made a customer', async () => {
    const start = await pullCustomers();
    const sup = await send('POST', '/api/purchasing/suppliers', 'maria', {
      code: 'S0003',
      name: 'Oil Depot',
    });
    const id = sup.json<{ id: string }>().id;
    const before = await pullCustomers(start.cursor);
    expect((before.changes['customers'] ?? []).map((p) => p['id'])).not.toContain(id);
    await create({ partyId: id }, 'maria');
    const after = await pullCustomers(before.cursor);
    expect(after.changes['customers']!.map((p) => p['id'])).toEqual([id]);
  });
});
