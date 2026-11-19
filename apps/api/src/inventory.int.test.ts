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

// Stock operations (W1-18 plan; INV-04, INV-05, INV-07; owner answers 1–4; D-107), under RLS and permissions, in
// one shop's order: the purchaser drafts a transfer and the manager posts it; a route that needs receiving sends and
// receives, the shortfall a loss; adjustments post at once or wait for the owner above the limit; the stock card,
// Transfer needed, and the rebuild finding nothing to change.

const SHOP = 'stock-shop';
const OTHER = 'stock-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let pool: pg.Pool;
let tenant: string;
let items: Record<string, string>;
const loc: Record<string, string> = {};
const cookies: Record<string, string> = {};
// The morning of 9 November: the transfer below is received that day, never after the shop's business date (W2-05).
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

const send = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who: string, payload?: unknown) =>
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

const sql = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) =>
  withTenant(pool, { tenantId: tenant }, async (_db, c) => (await c.query<T>(text, params)).rows);

/** Thousandths by location code for an item. */
async function stock(code: string): Promise<Record<string, number>> {
  const rows = await sql<{ code: string; q: string }>(
    `SELECT l.code, (b.qty * 1000)::bigint::text AS q FROM erp.stock_balances b
     JOIN erp.locations l ON l.id = b.location_id WHERE b.item_id = $1 AND b.qty <> 0`,
    [items[code]],
  );
  return Object.fromEntries(rows.map((r) => [r.code, Number(r.q)]));
}

type Made = { id: string; rowVersion: string };

const transferDraft = (lines: { itemId: string; qty: number }[], from = 'GODOWN', to = 'SHOP') => ({
  fromLocationId: loc[from],
  toLocationId: loc[to],
  movedOn: '2026-11-08',
  note: null,
  lines,
});
const adjustmentDraft = (reason: string, lines: { itemId: string; qty: number }[], at = 'SHOP') => ({
  locationId: loc[at],
  adjustedOn: '2026-11-08',
  reason,
  note: null,
  lines,
});

async function newAdjustment(who: string, body: ReturnType<typeof adjustmentDraft>) {
  const made = await send('POST', '/api/inventory/adjustments', who, body);
  expect(made.statusCode, made.body).toBe(201);
  return made.json<Made>();
}

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  ({ tenantId: tenant } = await setupTenant(db.ownerUrl, TenantSpec.parse({ ...deluxSpec, code: SHOP }), {
    ownerPasswordHash: 'x',
    mustChangePassword: false,
  }));
  const other = await createTenant(db.ownerUrl, 'Other Shop', OTHER);
  items = await withTenant(pool, { tenantId: tenant }, async (_db, c) =>
    seedCatalog(c, tenant, [
      { code: 'ABEA001', name: 'ADJUSTER BEARING SALOON', category: 'ABEA', prices: { RETAIL: 600000 } },
      {
        code: 'OIL050',
        name: 'ENGINE OIL',
        category: 'OILS',
        unit: 'LITRE',
        fractional: true,
        prices: { RETAIL: 15000 },
      },
    ]),
  );
  for (const r of await sql<{ id: string; code: string }>('SELECT id, code FROM erp.locations'))
    loc[r.code] = r.id;
  await addUser('owner', 'owner');
  await addUser('maria', 'manager');
  await addUser('pete', 'purchaser');
  await addUser('sara', 'salesman');
  await addUser('otto', 'owner', other);
  for (const u of ['owner', 'maria', 'pete', 'sara']) await login(u);
  await login('otto', OTHER);

  // 10 bearings at Rs 4,000 and 20.5 litres of oil at Rs 100 into the Godown.
  const supplier = (
    await send('POST', '/api/purchasing/suppliers', 'owner', { code: '0210', name: 'Naveed Glass' })
  ).json<{ id: string }>().id;
  const receipt = (
    await send('POST', '/api/purchasing/receipts', 'owner', {
      supplierId: supplier,
      billNo: 'INV-1',
      billDate: '2026-11-07',
      receivedOn: '2026-11-07',
      locationId: loc['GODOWN'],
      paidFrom: null,
      billDiscount: 0,
      billTotal: 4205000,
      notes: null,
      lines: [
        { itemId: items['ABEA001'], qty: 10000, unitCost: 400000, lineDiscount: 0 },
        { itemId: items['OIL050'], qty: 20500, unitCost: 10000, lineDiscount: 0 },
      ],
    })
  ).json<Made>();
  const posted = await send('POST', `/api/purchasing/receipts/${receipt.id}/post`, 'owner', {
    rowVersion: receipt.rowVersion,
  });
  if (posted.statusCode !== 200) throw new Error(`receipt failed: ${posted.body}`);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('lookups and settings', () => {
  it('lists the locations to move between (not In transit), the limit and what each person may do', async () => {
    const res = await send('GET', '/api/inventory/lookups', 'pete');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      locations: { code: string; kind: string }[];
      adjustmentApprovalLimit: number;
      reasons: string[];
      routes: unknown[];
      can: Record<string, boolean>;
    }>();
    expect(body.locations.map((l) => l.code)).toEqual(['DAMAGED', 'GODOWN', 'SHOP']);
    expect(body.adjustmentApprovalLimit).toBe(1000000);
    expect(body.reasons).toContain('write_off');
    expect(body.routes).toEqual([]);
    // The lock date, for the screens to grey out Post on a locked date (D-108); none set in this shop.
    expect(res.json<{ lockDate: string | null }>().lockDate).toBeNull();
    expect(body.can).toEqual({
      transfer: true,
      postTransfer: false,
      adjust: false,
      approve: false,
      viewCost: true,
      settings: false,
    });
    expect((await send('GET', '/api/inventory/lookups', 'maria')).json<{ can: unknown }>().can).toEqual({
      transfer: true,
      postTransfer: true,
      adjust: true,
      approve: false,
      viewCost: true,
      settings: false,
    });
    expect((await send('GET', '/api/inventory/lookups', 'sara')).statusCode).toBe(403);
  });

  it('only the owner changes the settings', async () => {
    const body = { adjustmentApprovalLimit: 1000000, routes: [] };
    expect((await send('PUT', '/api/inventory/settings', 'maria', body)).statusCode).toBe(403);
    expect((await send('PUT', '/api/inventory/settings', 'owner', body)).statusCode).toBe(200);
  });

  it('finds items with their stock per location', async () => {
    const res = await send('GET', '/api/inventory/items?q=abea', 'pete');
    const found = res.json<{
      items: { code: string; stock: Record<string, number>; avgCost: number | null }[];
    }>();
    expect(found.items).toEqual([
      expect.objectContaining({ code: 'ABEA001', stock: { [loc['GODOWN']!]: 10000 }, avgCost: 400000 }),
    ]);
  });
});

describe('a transfer that moves at once (INV-04, owner answer 2)', () => {
  let made: Made;

  it('an empty transfer or adjustment draft is refused (owner review of W1-19)', async () => {
    const transfer = await send('POST', '/api/inventory/transfers', 'pete', transferDraft([]));
    expect(transfer.statusCode).toBe(400);
    expect(transfer.json()).toEqual({ error: 'empty_draft' });
    const adjustment = await send('POST', '/api/inventory/adjustments', 'maria', adjustmentDraft('lost', []));
    expect(adjustment.statusCode).toBe(400);
    expect(adjustment.json()).toEqual({ error: 'empty_draft' });
  });

  it('the purchaser types it, but only the manager or the owner posts it', async () => {
    const res = await send(
      'POST',
      '/api/inventory/transfers',
      'pete',
      transferDraft([{ itemId: items['ABEA001']!, qty: 5000 }]),
    );
    expect(res.statusCode, res.body).toBe(201);
    made = res.json<Made>();
    expect(
      (
        await send('POST', `/api/inventory/transfers/${made.id}/post`, 'pete', {
          rowVersion: made.rowVersion,
        })
      ).statusCode,
    ).toBe(403);
    expect((await send('POST', '/api/inventory/transfers', 'sara', transferDraft([]))).statusCode).toBe(403);
  });

  it('posts with the next number, moves the stock and writes no journal', async () => {
    const res = await send('POST', `/api/inventory/transfers/${made.id}/post`, 'maria', {
      rowVersion: made.rowVersion,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ number: 'TR000001', status: 'posted' });
    expect(await stock('ABEA001')).toEqual({ GODOWN: 5000, SHOP: 5000 });
    expect(await sql("SELECT 1 FROM erp.journal_entries WHERE source_type = 'stock_transfer'")).toEqual([]);
  });

  it('is never changed once posted', async () => {
    const view = (await send('GET', `/api/inventory/transfers/${made.id}`, 'pete')).json<{
      transfer: { status: string; rowVersion: string };
    }>();
    expect(view.transfer.status).toBe('posted');
    const res = await send('PUT', `/api/inventory/transfers/${made.id}`, 'maria', {
      ...transferDraft([{ itemId: items['ABEA001']!, qty: 1000 }]),
      rowVersion: view.transfer.rowVersion,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'posted' });
  });

  it('refuses one that does not check out, saying why', async () => {
    const bad = (
      await send(
        'POST',
        '/api/inventory/transfers',
        'maria',
        transferDraft([{ itemId: items['ABEA001']!, qty: 1000 }], 'SHOP', 'SHOP'),
      )
    ).json<Made>();
    const res = await send('POST', `/api/inventory/transfers/${bad.id}/post`, 'maria', {
      rowVersion: bad.rowVersion,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'invalid',
      problems: [{ problem: 'same_location', row: null }],
    });
    expect((await send('DELETE', `/api/inventory/transfers/${bad.id}`, 'maria')).statusCode).toBe(200);
  });

  it("is another shop's 404", async () => {
    expect((await send('GET', `/api/inventory/transfers/${made.id}`, 'otto')).statusCode).toBe(404);
  });
});

describe('a route that needs receiving (owner answer 4)', () => {
  let made: Made;

  it('sends: out of the Godown into In transit, on the way', async () => {
    await send('PUT', '/api/inventory/settings', 'owner', {
      adjustmentApprovalLimit: 1000000,
      routes: [{ fromLocationId: loc['GODOWN'], toLocationId: loc['SHOP'], needsReceiving: true }],
    });
    made = (
      await send(
        'POST',
        '/api/inventory/transfers',
        'maria',
        transferDraft([{ itemId: items['ABEA001']!, qty: 3000 }]),
      )
    ).json<Made>();
    const res = await send('POST', `/api/inventory/transfers/${made.id}/post`, 'maria', {
      rowVersion: made.rowVersion,
    });
    expect(res.json()).toEqual({ number: 'TR000002', status: 'in_transit' });
    expect(await stock('ABEA001')).toEqual({ GODOWN: 2000, SHOP: 5000, TRANSIT: 3000 });
    const onTheWay = (await send('GET', '/api/inventory/transfers?status=in_transit', 'pete')).json<{
      transfers: { number: string }[];
    }>();
    expect(onTheWay.transfers.map((t) => t.number)).toEqual(['TR000002']);
  });

  it('receives what arrived; the one short is a loss out of In transit', async () => {
    const view = (await send('GET', `/api/inventory/transfers/${made.id}`, 'maria')).json<{
      transfer: { rowVersion: string };
      lines: { id: string }[];
    }>();
    const body = {
      rowVersion: view.transfer.rowVersion,
      receivedOn: '2026-11-09',
      lines: [{ lineId: view.lines[0]!.id, receivedQty: 2000 }],
    };
    expect((await send('POST', `/api/inventory/transfers/${made.id}/receive`, 'pete', body)).statusCode).toBe(
      403,
    );
    const tooMany = await send('POST', `/api/inventory/transfers/${made.id}/receive`, 'maria', {
      ...body,
      lines: [{ lineId: view.lines[0]!.id, receivedQty: 4000 }],
    });
    expect(tooMany.json()).toMatchObject({
      error: 'invalid',
      problems: [{ problem: 'more_than_sent', row: 0 }],
    });
    const res = await send('POST', `/api/inventory/transfers/${made.id}/receive`, 'maria', body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'received',
      shortfall: { number: 'AD000001', status: 'posted' },
    });
    expect(await stock('ABEA001')).toEqual({ GODOWN: 2000, SHOP: 7000 });
    const after = (await send('GET', `/api/inventory/transfers/${made.id}`, 'maria')).json<{
      transfer: { status: string; receivedOn: string };
      shortfallAdjustment: { number: string };
    }>();
    expect(after.transfer).toMatchObject({ status: 'received', receivedOn: '2026-11-09' });
    expect(after.shortfallAdjustment.number).toBe('AD000001');
    await send('PUT', '/api/inventory/settings', 'owner', { adjustmentApprovalLimit: 1000000, routes: [] });
  });
});

describe('adjustments (INV-05, owner answers 1 and 3)', () => {
  it('are the owner’s and the manager’s', async () => {
    expect(
      (await send('POST', '/api/inventory/adjustments', 'pete', adjustmentDraft('lost', []))).statusCode,
    ).toBe(403);
  });

  it('a small loss posts at once against Inventory adjustments', async () => {
    const made = await newAdjustment(
      'maria',
      adjustmentDraft('damaged', [{ itemId: items['ABEA001']!, qty: -1000 }]),
    );
    const res = await send('POST', `/api/inventory/adjustments/${made.id}/post`, 'maria', {
      rowVersion: made.rowVersion,
    });
    expect(res.json()).toEqual({ number: 'AD000002', status: 'posted' });
    expect(await stock('ABEA001')).toEqual({ GODOWN: 2000, SHOP: 6000 });
    const journal = await sql<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, l.debit::text, l.credit::text FROM erp.journal_lines l
       JOIN erp.journal_entries e ON e.id = l.entry_id JOIN erp.accounts a ON a.id = l.account_id
       WHERE e.memo = 'AD000002' ORDER BY l.line_no`,
    );
    expect(journal).toEqual([
      { code: '5200', debit: '400000', credit: '0' },
      { code: '1300', debit: '0', credit: '400000' },
    ]);
  });

  it("the manager's Rs 12,000 loss waits for the owner, who sends it back, then approves it", async () => {
    const made = await newAdjustment(
      'maria',
      adjustmentDraft('lost', [{ itemId: items['ABEA001']!, qty: -3000 }]),
    );
    const waiting = await send('POST', `/api/inventory/adjustments/${made.id}/post`, 'maria', {
      rowVersion: made.rowVersion,
    });
    expect(waiting.json()).toEqual({ number: null, status: 'awaiting_approval' });
    expect(await stock('ABEA001')).toEqual({ GODOWN: 2000, SHOP: 6000 });
    const list = (await send('GET', '/api/inventory/adjustments?status=awaiting_approval', 'owner')).json<{
      adjustments: { id: string; lossValue: number }[];
    }>();
    expect(list.adjustments).toEqual([expect.objectContaining({ id: made.id, lossValue: 1200000 })]);

    const view = async () =>
      (await send('GET', `/api/inventory/adjustments/${made.id}`, 'owner')).json<{
        adjustment: { status: string; rowVersion: string; rejection: { note: string } | null };
      }>().adjustment;
    let rv = (await view()).rowVersion;
    expect(
      (await send('POST', `/api/inventory/adjustments/${made.id}/approve`, 'maria', { rowVersion: rv }))
        .statusCode,
    ).toBe(403);
    const rejected = await send('POST', `/api/inventory/adjustments/${made.id}/reject`, 'owner', {
      rowVersion: rv,
      note: 'Count again first',
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await view()).toMatchObject({ status: 'draft', rejection: { note: 'Count again first' } });

    rv = (await view()).rowVersion;
    await send('POST', `/api/inventory/adjustments/${made.id}/post`, 'maria', { rowVersion: rv });
    rv = (await view()).rowVersion;
    const approved = await send('POST', `/api/inventory/adjustments/${made.id}/approve`, 'owner', {
      rowVersion: rv,
    });
    expect(approved.json()).toEqual({ number: 'AD000003', status: 'posted' });
    expect(await stock('ABEA001')).toEqual({ GODOWN: 2000, SHOP: 3000 });
  });

  it("the owner's own large loss posts at once", async () => {
    const made = await newAdjustment(
      'owner',
      adjustmentDraft('theft', [{ itemId: items['ABEA001']!, qty: -3000 }]),
    );
    const res = await send('POST', `/api/inventory/adjustments/${made.id}/post`, 'owner', {
      rowVersion: made.rowVersion,
    });
    expect(res.json()).toEqual({ number: 'AD000004', status: 'posted' });
    expect(await stock('ABEA001')).toEqual({ GODOWN: 2000 });
  });

  it('a loss of more than the shop has warns and still posts', async () => {
    const made = await newAdjustment(
      'maria',
      adjustmentDraft('lost', [{ itemId: items['OIL050']!, qty: -2000 }]),
    );
    const view = (await send('GET', `/api/inventory/adjustments/${made.id}`, 'maria')).json<{
      check: { warnings: unknown[] };
      value: { gain: number; loss: number };
      needsApproval: boolean;
    }>();
    expect(view.check.warnings).toEqual([{ warning: 'below_zero', row: 0 }]);
    expect(view.value).toEqual({ gain: 0, loss: 20000 });
    expect(view.needsApproval).toBe(false);
    const res = await send('POST', `/api/inventory/adjustments/${made.id}/post`, 'maria', {
      rowVersion: made.rowVersion,
    });
    expect(res.json()).toEqual({ number: 'AD000005', status: 'posted' });
    expect(await stock('OIL050')).toEqual({ GODOWN: 20500, SHOP: -2000 });
  });
});

describe('reading the stock (INV-07, PRD W13)', () => {
  it('Transfer needed lists what the Shop is short of while the Godown has it', async () => {
    const res = await send('GET', '/api/inventory/transfer-needed', 'pete');
    expect(res.json()).toEqual({
      rows: [
        {
          itemId: items['OIL050'],
          code: 'OIL050',
          name: 'ENGINE OIL',
          shop: -2000,
          godown: 20500,
          suggested: 2000,
        },
      ],
    });
  });

  it("the item's stock card shows every movement, newest first, with running balances", async () => {
    const res = await send('GET', `/api/inventory/items/${items['ABEA001']}/card`, 'pete');
    expect(res.statusCode, res.body).toBe(200);
    const card = res.json<{
      balances: Record<string, number>;
      movements: {
        kind: string;
        number: string;
        locationId: string;
        qty: number;
        balance: number;
        total: number;
        unitCost: number | null;
      }[];
      next: number | null;
    }>();
    expect(card.balances).toEqual({ [loc['GODOWN']!]: 2000 });
    expect(card.next).toBeNull();
    const rows = card.movements.map((m) => [
      m.number,
      m.locationId === loc['GODOWN'] ? 'G' : m.locationId === loc['SHOP'] ? 'S' : 'T',
      m.qty,
      m.balance,
      m.total,
    ]);
    expect(rows).toEqual([
      ['AD000004', 'S', -3000, 0, 2000],
      ['AD000003', 'S', -3000, 3000, 5000],
      ['AD000002', 'S', -1000, 6000, 8000],
      ['AD000001', 'T', -1000, 0, 9000],
      ['TR000002', 'S', 2000, 7000, 10000],
      ['TR000002', 'T', -2000, 1000, 10000],
      ['TR000002', 'T', 3000, 3000, 10000],
      ['TR000002', 'G', -3000, 2000, 10000],
      ['TR000001', 'S', 5000, 5000, 10000],
      ['TR000001', 'G', -5000, 5000, 10000],
      ['GR000001', 'G', 10000, 10000, 10000],
    ]);
    expect(card.movements[0]!.unitCost).toBe(400000);
    expect((await send('GET', `/api/inventory/items/${items['ABEA001']}/card`, 'sara')).statusCode).toBe(403);
  });

  it('the rebuild arrives at the same ledgers', async () => {
    expect((await checkRebuild(pool, tenant)).differences).toEqual([]);
  });
});
