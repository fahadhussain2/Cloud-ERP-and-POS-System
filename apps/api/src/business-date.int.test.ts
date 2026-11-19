import { TenantSpec } from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Back-office documents on the shop's business date (W2-05 plan, D-108): at 00:30 Karachi the shop's day is still
// the day before (04:00 cut-off), so every back-office screen gets that day from the API, and a purchasing or stock
// document dated after it is refused on post, as accounting documents already are. At 04:00 the next day opens.

const SHOP = 'day-shop';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';
/** 00:30 on 20 November in Karachi (UTC+5): the business date is still 19 November. */
const HALF_PAST_MIDNIGHT = new Date('2026-11-19T19:30:00.000Z');
/** 04:00 on 20 November in Karachi: the cut-off, 20 November opens. */
const CUT_OFF = new Date('2026-11-19T23:00:00.000Z');
const TODAY = '2026-11-19';
const TOMORROW = '2026-11-20';

let db: TestDatabase;
let pool: pg.Pool;
let tenant: string;
let clock = HALF_PAST_MIDNIGHT;
let cookie = '';
let item = '';
let supplier = '';
let hbl = '';
const loc: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => clock });

const send = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app().inject({
    method,
    url,
    headers: { origin: ORIGIN, host: HOST },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    cookies: { erp_session: cookie },
  });

type Made = { id: string; rowVersion: string };
const future = { error: 'date_in_future', today: TODAY };

const receipt = (receivedOn: string, billNo: string) => ({
  supplierId: supplier,
  billNo,
  billDate: receivedOn,
  receivedOn,
  locationId: loc['GODOWN'],
  paidFrom: null,
  billDiscount: 0,
  billTotal: 1000000,
  notes: null,
  lines: [{ itemId: item, qty: 10000, unitCost: 100000, lineDiscount: 0 }],
});

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  ({ tenantId: tenant } = await setupTenant(db.ownerUrl, TenantSpec.parse({ ...deluxSpec, code: SHOP }), {
    ownerPasswordHash: 'x',
    mustChangePassword: false,
  }));
  item = await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    const ids = await seedCatalog(c, tenant, [
      { code: 'ABEA001', name: 'ADJUSTER BEARING SALOON', category: 'ABEA', prices: { RETAIL: 160000 } },
    ]);
    for (const r of (await c.query<{ id: string; code: string }>('SELECT id, code FROM erp.locations')).rows)
      loc[r.code] = r.id;
    hbl = (await c.query<{ id: string }>("SELECT id FROM erp.bank_accounts WHERE code = 'hbl'")).rows[0]!.id;
    const hash = await hashPassword(PASSWORD);
    const role = await c.query<{ id: string }>(
      `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits) VALUES ($1, 'owner role', NULL, $2, $3)
       RETURNING id`,
      [tenant, ROLE_TEMPLATES.owner.permissions, ROLE_TEMPLATES.owner.limits],
    );
    const user = await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, password_hash) VALUES ($1, 'owner', 'Owner', $2)
       RETURNING id`,
      [tenant, hash],
    );
    await c.query('INSERT INTO erp.user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
      tenant,
      user.rows[0]!.id,
      role.rows[0]!.id,
    ]);
    return ids['ABEA001']!;
  });
  const login = await app().inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { tenantCode: SHOP, username: 'owner', password: PASSWORD },
  });
  cookie = login.cookies.find((x) => x.name === 'erp_session')!.value;
  supplier = (await send('POST', '/api/purchasing/suppliers', { code: '0210', name: 'Naveed Glass' })).json<{
    id: string;
  }>().id;
  // Godown → Shop needs receiving, so a transfer has a sending and a receiving date.
  await send('PUT', '/api/inventory/settings', {
    adjustmentApprovalLimit: 1000000,
    routes: [{ fromLocationId: loc['GODOWN'], toLocationId: loc['SHOP'], needsReceiving: true }],
  });
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('at 00:30 Karachi the shop is still on the day before', () => {
  it('every back-office screen gets that day from the API', async () => {
    for (const url of ['/api/purchasing/lookups', '/api/inventory/lookups', '/api/accounting/lookups']) {
      const res = await send('GET', url);
      expect(res.statusCode, url).toBe(200);
      expect(res.json<{ today: string }>().today, url).toBe(TODAY);
    }
  });

  it('a goods receipt dated tomorrow is kept as a draft but refused on post; dated today it posts', async () => {
    const draft = (await send('POST', '/api/purchasing/receipts', receipt(TOMORROW, 'INV-1'))).json<Made>();
    const refused = await send('POST', `/api/purchasing/receipts/${draft.id}/post`, {
      rowVersion: draft.rowVersion,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual(future);
    const saved = await send('PUT', `/api/purchasing/receipts/${draft.id}`, {
      rowVersion: draft.rowVersion,
      ...receipt(TODAY, 'INV-1'),
    });
    expect(saved.statusCode).toBe(200);
    const posted = await send('POST', `/api/purchasing/receipts/${draft.id}/post`, {
      rowVersion: saved.json<{ rowVersion: string }>().rowVersion,
    });
    expect(posted.statusCode, posted.body).toBe(200);
    // In stock "as on today" straight away, with that night's counter bills (W2-02).
    const at = (await send('GET', '/api/reports/stock-at')).json<{ at: string; total: { qty: number } }>();
    expect(at).toMatchObject({ at: TODAY, total: { qty: 10000 } });
  });

  it('a purchase return dated tomorrow is refused on post; dated today it posts', async () => {
    const make = async (returnedOn: string) => {
      const id = (
        await send('POST', '/api/purchasing/returns', {
          supplierId: supplier,
          locationId: loc['GODOWN'],
          returnedOn,
          reason: 'damaged',
          note: null,
          lines: [{ itemId: item, qty: 1000, unitCost: 100000 }],
        })
      ).json<{ id: string }>().id;
      const rowVersion = (await send('GET', `/api/purchasing/returns/${id}`)).json<{
        purchaseReturn: { rowVersion: string };
      }>().purchaseReturn.rowVersion;
      return send('POST', `/api/purchasing/returns/${id}/post`, { rowVersion });
    };
    const refused = await make(TOMORROW);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual(future);
    expect((await make(TODAY)).statusCode).toBe(200);
  });

  it('a supplier payment dated tomorrow is refused and nothing is written; dated today it is paid', async () => {
    const pay = (paidOn: string) =>
      send('POST', '/api/purchasing/payments', {
        supplierId: supplier,
        bankAccountId: hbl,
        amount: 100000,
        paidOn,
        reference: null,
      });
    const refused = await pay(TOMORROW);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual(future);
    const count = await withTenant(pool, { tenantId: tenant }, async (_db, c) =>
      Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM erp.supplier_payments')).rows[0]!.n),
    );
    expect(count).toBe(0);
    expect((await pay(TODAY)).statusCode).toBe(201);
  });

  it('a transfer is refused on a date after today, sending or receiving', async () => {
    const make = (movedOn: string) =>
      send('POST', '/api/inventory/transfers', {
        fromLocationId: loc['GODOWN'],
        toLocationId: loc['SHOP'],
        movedOn,
        note: null,
        lines: [{ itemId: item, qty: 2000 }],
      });
    const ahead = (await make(TOMORROW)).json<Made>();
    const refused = await send('POST', `/api/inventory/transfers/${ahead.id}/post`, {
      rowVersion: ahead.rowVersion,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual(future);
    const made = (await make(TODAY)).json<Made>();
    const sent = await send('POST', `/api/inventory/transfers/${made.id}/post`, {
      rowVersion: made.rowVersion,
    });
    expect(sent.json()).toMatchObject({ status: 'in_transit' });
    const view = (await send('GET', `/api/inventory/transfers/${made.id}`)).json<{
      transfer: { rowVersion: string };
      lines: { id: string }[];
    }>();
    const receive = (receivedOn: string) =>
      send('POST', `/api/inventory/transfers/${made.id}/receive`, {
        rowVersion: view.transfer.rowVersion,
        receivedOn,
        lines: [{ lineId: view.lines[0]!.id, receivedQty: 2000 }],
      });
    const late = await receive(TOMORROW);
    expect(late.statusCode).toBe(400);
    expect(late.json()).toEqual(future);
    expect((await receive(TODAY)).statusCode).toBe(200);
  });

  it('a stock adjustment dated tomorrow is refused on post; dated today it posts', async () => {
    const make = async (adjustedOn: string) => {
      const a = (
        await send('POST', '/api/inventory/adjustments', {
          locationId: loc['SHOP'],
          adjustedOn,
          reason: 'found',
          note: null,
          lines: [{ itemId: item, qty: 1000 }],
        })
      ).json<Made>();
      return send('POST', `/api/inventory/adjustments/${a.id}/post`, { rowVersion: a.rowVersion });
    };
    const refused = await make(TOMORROW);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual(future);
    expect((await make(TODAY)).statusCode).toBe(200);
  });
});

describe('at 04:00 Karachi the next day opens', () => {
  it('the screens get the new day and a document dated on it posts', async () => {
    clock = CUT_OFF;
    for (const url of ['/api/purchasing/lookups', '/api/inventory/lookups', '/api/accounting/lookups'])
      expect((await send('GET', url)).json<{ today: string }>().today, url).toBe(TOMORROW);
    const draft = (await send('POST', '/api/purchasing/receipts', receipt(TOMORROW, 'INV-2'))).json<Made>();
    const posted = await send('POST', `/api/purchasing/receipts/${draft.id}/post`, {
      rowVersion: draft.rowVersion,
    });
    expect(posted.statusCode, posted.body).toBe(200);
  });
});
