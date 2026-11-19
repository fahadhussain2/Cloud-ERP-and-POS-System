import {
  exportPublicKey,
  generateDeviceKey,
  signCanonical,
  TenantSpec,
  uuidv7,
  type AnalysisView,
  type DeadStockView,
  type DocumentFamily,
  type PushDocument,
  type PushRequest,
  type ReorderView,
  type StockAtView,
  type StockChoicesView,
  type StockLedgerView,
  type StockMovementView,
  type StockView,
} from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import {
  addReturn,
  buildReturnDocument,
  buildSaleDocument,
  buildVoidDocument,
  businessDate,
  emptyBill,
  money,
  qty,
  ROLE_TEMPLATES,
  type Bill,
  type PaymentMethodInfo,
  type Qty,
  type ReturnDocument,
  type RoleGrant,
  type SaleDocument,
  type SaleVoidDocument,
} from '@erp/domain';
import { postPending } from '@erp/posting';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';
import { seedGeneratedOpening } from './generated-opening';

// The stock reports (W2-02 plan; RPT-08, RPT-12, RPT-13, RPT-14, PUR-07 list; D-116), on a shop with known stock
// documents over six weeks: the opening (oil in the Shop) 40 days ago; brake pads received into the Godown and 6 moved
// to the Shop 35 days ago; today oil received and one sent back, counter sales (oil, a pad) with a void and a return,
// a damaged can, and 1.5 m of hose received. Each report is read under RLS with reports.view and tied to the stock
// ledger and the books: stock at a date to Inventory on that date, the movement's opening and closing to stock at a
// date, the ledger's closing to the movement's.

type DeviceKeys = Awaited<ReturnType<typeof generateDeviceKey>>;
interface Device {
  token: string;
  deviceId: string;
  code: string;
  keys: DeviceKeys;
  seq: Partial<Record<DocumentFamily, number>>;
}

const SHOP = 'stk-shop';
const OTHER = 'stk-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';
const METHODS: PaymentMethodInfo[] = [{ code: 'cash', isCash: true, requiresReference: false }];
const MANAGER_GRANTS: RoleGrant[] = [{ ...ROLE_TEMPLATES.manager, branchId: null }];

let db: TestDatabase;
let pool: pg.Pool;
let tenantId: string;
let otherId: string;
let branchId: string;
let seller: string;
let manager: string;
let retail: string;
let counter: Device;
let items: Record<string, string> = {};
const loc: Record<string, string> = {};
let openingQty = 0;
const cookies: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date() });
const today = () => businessDate(Date.now(), 'Asia/Karachi', 4);
const daysAgo = (n: number) =>
  new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
/** The opening, and the pads' receipt and transfer. */
const D0 = () => daysAgo(40);
const D1 = () => daysAgo(35);

const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = [], tenant = tenantId) =>
  withTenant(pool, { tenantId: tenant }, async (_db, c) => (await c.query<T>(sql, params)).rows);

const post = (url: string, payload: unknown, cookie?: string) =>
  app().inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, host: HOST },
    payload: payload as Record<string, unknown>,
    ...(cookie ? { cookies: { erp_session: cookie } } : {}),
  });

async function login(username: string, shop = SHOP): Promise<string> {
  const key = `${shop}/${username}`;
  if (cookies[key]) return cookies[key];
  const res = await post('/api/auth/login', { tenantCode: shop, username, password: PASSWORD });
  expect(res.statusCode, res.body).toBe(200);
  return (cookies[key] = res.cookies.find((x) => x.name === 'erp_session')!.value);
}

const send = async (method: 'GET' | 'POST', url: string, who: string, payload?: unknown, shop?: string) =>
  app().inject({
    method,
    url,
    headers: { origin: ORIGIN, host: HOST },
    cookies: { erp_session: await login(who, shop) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
const view = async <T>(url: string, who = 'fahad', shop?: string) => {
  const res = await send('GET', url, who, undefined, shop);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<T>();
};
const created = async (url: string, payload: unknown) => {
  const res = await send('POST', url, 'fahad', payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string; rowVersion: string }>();
};
async function postDraft(base: string, id: string, rowVersion: string) {
  const res = await send('POST', `${base}/${id}/post`, 'fahad', { rowVersion });
  expect(res.statusCode, res.body).toBe(200);
}

async function person(c: pg.ClientBase, username: string, template: string | null, permissions?: string[]) {
  const id = (
    await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, email, password_hash)
       VALUES ($1, $2, $2, $3, $4) RETURNING id`,
      [tenantId, username, `${username}@example.test`, await hashPassword(PASSWORD)],
    )
  ).rows[0]!.id;
  const role = template
    ? (await c.query<{ id: string }>('SELECT id FROM erp.roles WHERE template_key = $1', [template])).rows[0]!
        .id
    : (
        await c.query<{ id: string }>(
          `INSERT INTO erp.roles (tenant_id, name, permissions, limits) VALUES ($1, $2, $3, $4) RETURNING id`,
          [tenantId, `${username} role`, permissions, ROLE_TEMPLATES.manager.limits],
        )
      ).rows[0]!.id;
  await c.query('INSERT INTO erp.user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
    tenantId,
    id,
    role,
  ]);
  return id;
}

async function enroll(): Promise<Device> {
  const cookie = await login('fahad');
  const code = (await post('/api/devices/enrollment-codes', { branchId, kind: 'counter' }, cookie)).json<{
    code: string;
  }>().code;
  const keys = await generateDeviceKey();
  const publicKey = await exportPublicKey(keys.publicKey);
  const signature = await signCanonical(keys.privateKey, { tenantCode: SHOP, code, publicKey });
  const enrolled = (
    await post('/api/devices/enroll', { tenantCode: SHOP, code, publicKey, signature })
  ).json<{
    deviceId: string;
    code: string;
  }>();
  const { nonce } = (await post('/api/devices/challenge', { tenantId, deviceId: enrolled.deviceId })).json<{
    nonce: string;
  }>();
  const token = (
    await post('/api/devices/token', {
      tenantId,
      deviceId: enrolled.deviceId,
      nonce,
      signature: await signCanonical(keys.privateKey, { tenantId, deviceId: enrolled.deviceId, nonce }),
    })
  ).json<{ accessToken: string }>().accessToken;
  return { token, deviceId: enrolled.deviceId, code: enrolled.code, keys, seq: {} };
}

const next = (d: Device, family: DocumentFamily) => (d.seq[family] = (d.seq[family] ?? 0) + 1);
const context = (d: Device, family: DocumentFamily) => ({
  id: uuidv7(),
  seq: next(d, family),
  deviceId: d.deviceId,
  deviceCode: d.code,
  branchId,
  createdAtMs: Date.now() - 60_000,
  timeZone: 'Asia/Karachi',
  cutoffHour: 4,
  clientVersion: '0.9.0',
});

/** `units` of an item at `price`, in cash. */
function sale(item: string, units: number, price: number): SaleDocument {
  const bill: Bill = {
    version: 1,
    sellerId: seller,
    tierId: retail,
    lines: [
      {
        id: 'l1',
        itemId: item,
        qty: (units * 1000) as Qty,
        allowsFraction: false,
        list: money(price),
        floor: null,
        unitPrice: money(price),
        approval: null,
      },
    ],
    billDiscount: money(0),
    billApproval: null,
  };
  return buildSaleDocument({
    bill,
    tender: {
      payments: [{ method: 'cash', amount: money(units * price), reference: null }],
      cashReceived: null,
    },
    methods: METHODS,
    sellerMaxDiscountBp: 0,
    customer: { id: null, walkinPhone: null },
    credit: null,
    creditApproval: null,
    reissueOf: null,
    context: { ...context(counter, 'S'), increment: money(100) },
  });
}

const voidOf = (bill: SaleDocument): SaleVoidDocument =>
  buildVoidDocument({
    bill: {
      id: bill.id,
      number: bill.number,
      deviceId: bill.deviceId,
      businessDate: bill.businessDate,
      total: bill.amounts.total,
      cashDue: bill.cashDue,
      status: 'finalized',
      payments: bill.payments,
    },
    answers: Object.fromEntries(bill.payments.map((p) => [p.method, 'not_arrived' as const])),
    deviceId: counter.deviceId,
    branchId,
    deskStatus: 'pending',
    approverId: manager,
    approverGrants: MANAGER_GRANTS,
    reason: 'wrong_price',
    note: null,
    userId: seller,
    context: context(counter, 'V'),
  });

/** A can of oil back without a receipt. */
function oilBack(): ReturnDocument {
  const bill = addReturn(emptyBill(seller, retail), {
    source: { kind: 'none', ref: '1' },
    lines: [
      {
        id: 'r0',
        itemId: items['OIL001']!,
        qty: qty(1000),
        allowsFraction: false,
        reason: 'changed_mind',
        note: null,
        condition: 'resellable',
        original: null,
        price: money(120000),
        suggested: money(120000),
      },
    ],
    needs: ['no_receipt_return'],
    approval: { approvedBy: manager, reason: 'before_go_live', note: null, at: new Date().toISOString() },
  });
  return buildReturnDocument({
    bill,
    tender: { payments: [{ method: 'cash', amount: money(-120000), reference: null }], cashReceived: null },
    methods: METHODS,
    sellerMaxDiscountBp: 0,
    customer: { id: null, walkinPhone: null },
    credit: null,
    creditApproval: null,
    refundApproval: null,
    context: { ...context(counter, 'S'), increment: money(100) },
  });
}

async function push(docs: (SaleDocument | SaleVoidDocument | ReturnDocument)[]) {
  const documents: PushDocument[] = [];
  for (const d of docs)
    documents.push({
      id: d.id,
      family: d.family,
      seq: d.seq,
      payload: d,
      signature: await signCanonical(counter.keys.privateKey, d),
    });
  const body: PushRequest = {
    clientVersion: '0.9.0',
    schemaVersion: 10,
    deviceClock: new Date().toISOString(),
    health: {
      outboxCount: documents.length,
      oldestUnsyncedAt: null,
      quarantinedCount: 0,
      storagePersisted: true,
      storageUsage: 1,
      storageQuota: 2,
      lastPullAt: null,
    },
    documents,
    events: [],
  };
  const res = await app().inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: { authorization: `Device ${counter.token}` },
    payload: body as unknown as Record<string, unknown>,
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function receive(
  supplierId: string,
  on: string,
  at: string,
  item: string,
  units: number,
  cost: number,
) {
  const r = await created('/api/purchasing/receipts', {
    supplierId,
    billNo: `B-${item}-${on}`,
    billDate: on,
    receivedOn: on,
    locationId: loc[at],
    paidFrom: null,
    billDiscount: 0,
    billTotal: Math.round((units * cost) / 1000),
    notes: null,
    lines: [{ itemId: items[item], qty: units, unitCost: cost, lineDiscount: 0 }],
  });
  await postDraft('/api/purchasing/receipts', r.id, r.rowVersion);
  return r.id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  const made: string[] = [];
  for (const code of [SHOP, OTHER])
    made.push(
      (
        await setupTenant(db.ownerUrl, TenantSpec.parse({ ...deluxSpec, code, name: `${code} shop` }), {
          ownerPasswordHash: await hashPassword(PASSWORD),
          mustChangePassword: false,
        })
      ).tenantId,
    );
  [tenantId, otherId] = made as [string, string];
  await withTenant(pool, { tenantId }, async (_db, c) => {
    branchId = (await c.query<{ id: string }>('SELECT id FROM erp.branches')).rows[0]!.id;
    retail = (await c.query<{ id: string }>("SELECT id FROM erp.price_tiers WHERE code = 'RETAIL'")).rows[0]!
      .id;
    seller = await person(c, 'sara', 'salesman');
    manager = await person(c, 'tariq', 'manager');
    // Reports but no cost.view: quantities only (owner answer 8).
    await person(c, 'noor', null, ['reports.view']);
    items = await seedCatalog(c, tenantId, [
      {
        code: 'OIL001',
        name: 'ENGINE OIL 4L',
        category: 'OIL',
        brand: 'Shell',
        floor: 100000,
        prices: { RETAIL: 120000 },
        vehicles: [{ make: 'Toyota' }],
      },
      { code: 'PAD001', name: 'BRAKE PAD CIVIC', category: 'BRAKES', vehicles: [{ make: 'Honda' }] },
      { code: 'BELT001', name: 'FAN BELT', category: 'BELTS' },
      { code: 'HOSE001', name: 'FUEL HOSE', category: 'HOSES', unit: 'METER', fractional: true },
    ]);
    // Reorder levels (owner answer 4): the pads at 8 / 20, the belt with its maximum below its minimum, the hose
    // in metres; the oil has none.
    for (const [code, min, max] of [
      ['PAD001', 8, 20],
      ['BELT001', 4, 3],
      ['HOSE001', 2, 10.5],
    ] as const)
      await c.query('UPDATE erp.items SET min_qty = $2, max_qty = $3 WHERE id = $1', [items[code], min, max]);
    for (const r of (await c.query<{ id: string; code: string }>('SELECT id, code FROM erp.locations')).rows)
      loc[r.code] = r.id;
  });

  // The opening (W1-14), 40 days ago: the oil in the Shop at 70% of Retail.
  await seedGeneratedOpening(db.ownerUrl, {
    environment: 'test',
    tenantId,
    now: new Date(`${D0()}T12:00:00Z`),
  });
  openingQty = Number(
    (
      await q<{ q: string }>(
        "SELECT (sum(qty_delta) * 1000)::bigint::text AS q FROM erp.stock_movements WHERE source_type = 'opening'",
      )
    )[0]!.q,
  );

  // 35 days ago: 8 pads into the Godown at Rs 500, and 6 moved to the Shop.
  const supplier = (
    await send('POST', '/api/purchasing/suppliers', 'fahad', { code: 'S1', name: 'Oil Co', termsDays: 30 })
  ).json<{ id: string }>().id;
  await receive(supplier, D1(), 'GODOWN', 'PAD001', 8000, 50000);
  const transfer = await created('/api/inventory/transfers', {
    fromLocationId: loc['GODOWN'],
    toLocationId: loc['SHOP'],
    movedOn: D1(),
    note: null,
    lines: [{ itemId: items['PAD001'], qty: 6000 }],
  });
  await postDraft('/api/inventory/transfers', transfer.id, transfer.rowVersion);

  // Today: 10 cans in at Rs 1,000 and 1 sent back; 1.5 m of hose.
  const receipt = await receive(supplier, today(), 'SHOP', 'OIL001', 10000, 100000);
  const line = (
    await view<{ lines: { id: string; netUnitCost: number }[] }>(`/api/purchasing/receipts/${receipt}`)
  ).lines[0]!;
  const back = await created('/api/purchasing/returns', {
    supplierId: supplier,
    goodsReceiptId: receipt,
    locationId: loc['SHOP'],
    returnedOn: today(),
    reason: 'damaged',
    note: null,
    lines: [{ itemId: items['OIL001'], receiptLineId: line.id, qty: 1000, unitCost: line.netUnitCost }],
  });
  const backRv = (
    await view<{ purchaseReturn: { rowVersion: string } }>(`/api/purchasing/returns/${back.id}`)
  ).purchaseReturn.rowVersion;
  await postDraft('/api/purchasing/returns', back.id, backRv);
  await receive(supplier, today(), 'SHOP', 'HOSE001', 1500, 20000);

  // On the counter: 2 cans and a pad; 3 cans then voided; a can back.
  counter = await enroll();
  // Built in the order they were made: each takes the counter's next number.
  const bills = [
    sale(items['OIL001']!, 2, 120000),
    sale(items['PAD001']!, 1, 90000),
    sale(items['OIL001']!, 3, 120000),
  ];
  const voided = bills[2]!;
  await push(bills);
  await push([voidOf(voided)]);
  await push([oilBack()]);

  // A damaged can.
  const adjustment = await created('/api/inventory/adjustments', {
    locationId: loc['SHOP'],
    adjustedOn: today(),
    reason: 'damaged',
    note: null,
    lines: [{ itemId: items['OIL001'], qty: -1000 }],
  });
  await postDraft('/api/inventory/adjustments', adjustment.id, adjustment.rowVersion);

  await postPending(pool, tenantId, { now: () => new Date() });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

/** Inventory in the books on a date. */
const inventoryAt = async (at: string) =>
  Number(
    (
      await q<{ b: string }>(
        `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM erp.journal_lines l
         JOIN erp.journal_entries e ON e.id = l.entry_id JOIN erp.accounts a ON a.id = l.account_id
         WHERE a.system_role = 'INVENTORY' AND e.entry_date <= $1`,
        [at],
      )
    )[0]!.b,
  );
const rowsOf = <C>(lines: StockAtView['lines'] | StockMovementView['lines']) =>
  lines.filter((l): l is Extract<typeof l, { kind: 'row' }> => l.kind === 'row') as unknown as ({
    code: string;
    location: string | null;
    cells: C;
  } & { kind: 'row' })[];

describe('stock at a date (RPT-13, owner answers 2 and 3)', () => {
  it("today, per location, is the stock on hand; each date's value is Inventory in the books", async () => {
    const now = await view<StockAtView>('/api/reports/stock-at?group=location');
    const balances = await q<{ code: string; loc: string; q: string }>(
      `SELECT i.code, l.code AS loc, (b.qty * 1000)::bigint::text AS q FROM erp.stock_balances b
       JOIN erp.items i ON i.id = b.item_id JOIN erp.locations l ON l.id = b.location_id WHERE b.qty <> 0`,
    );
    expect(
      rowsOf<{ qty: number }>(now.lines)
        .map((r) => [r.code, r.location, r.cells.qty])
        .sort(),
    ).toEqual(balances.map((b) => [b.code, b.loc, Number(b.q)]).sort());
    expect(rowsOf<{ qty: number }>(now.lines).find((r) => r.code === 'OIL001')!.cells.qty).toBe(
      openingQty + 7000,
    );
    for (const at of [daysAgo(41), D0(), D1(), today()]) {
      const s = await view<StockAtView>(`/api/reports/stock-at?at=${at}`);
      expect([at, s.total.value]).toEqual([at, await inventoryAt(at)]);
    }
    expect((await view<StockAtView>(`/api/reports/stock-at?at=${D1()}`)).total.qty).toBe(openingQty + 8000);
  });

  it('the stock report (W1-20) now shows the same value as the books (owner answer 2)', async () => {
    const stock = await view<StockView>('/api/reports/stock');
    expect(stock.total.value).toBe(await inventoryAt(today()));
  });

  it('groups by category, then make, with subtotals that add up to the total', async () => {
    const s = await view<StockAtView>('/api/reports/stock-at');
    expect(s.group).toBe('category');
    const tops = s.lines.filter((l) => l.kind === 'group' && l.depth === 0);
    expect(tops.map((l) => l.name)).toEqual(['BRAKES', 'HOSES', 'OIL']);
    expect(tops.reduce((t, l) => t + l.cells.qty, 0)).toBe(s.total.qty);
    const brakes = s.lines.findIndex((l) => l.kind === 'group' && l.name === 'BRAKES');
    expect(
      s.lines.slice(brakes, brakes + 3).map((l) => [l.kind, l.kind === 'row' ? l.code : l.name]),
    ).toEqual([
      ['group', 'BRAKES'],
      ['group', 'Honda'],
      ['row', 'PAD001'],
    ]);
  });

  it('filters by category, make and words; only below zero shows nothing here', async () => {
    const choices = await view<StockChoicesView>('/api/reports/stock-choices');
    const brakes = choices.categories.find((x) => x.name === 'BRAKES')!.id;
    const toyota = choices.makes.find((x) => x.name === 'Toyota')!.id;
    expect(choices.suppliers.map((x) => x.name)).toEqual(['Oil Co']);
    expect(choices.locations.map((x) => x.code)).toEqual(expect.arrayContaining(['SHOP', 'GODOWN']));
    const codes = async (filter: string) =>
      rowsOf((await view<StockAtView>(`/api/reports/stock-at?group=none&${filter}`)).lines).map(
        (r) => r.code,
      );
    expect(await codes(`categoryId=${brakes}`)).toEqual(['PAD001']);
    expect(await codes(`makeId=${toyota}`)).toEqual(['OIL001']);
    expect(await codes('q=fuel%20hose')).toEqual(['HOSE001']);
    expect(await codes('negative=only')).toEqual([]);
  });

  it('leaves values out without cost.view, and downloads every row as CSV', async () => {
    const s = await view<StockAtView>('/api/reports/stock-at', 'noor');
    expect(s.values).toBe(false);
    expect(s.total.value).toBeNull();
    expect(s.lines.every((l) => l.cells.value === null)).toBe(true);
    const res = await send('GET', '/api/reports/stock-at?format=csv', 'fahad');
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe('item,name,category,make,brand,supplier,location,qty,value');
    expect(lines).toHaveLength(3 + 2);
    const noor = await send('GET', '/api/reports/stock-at?format=csv', 'noor');
    expect(noor.body.split('\r\n')[0]).toBe('item,name,category,make,brand,supplier,location,qty');
  });
});

describe('stock movement (RPT-13)', () => {
  const range = () => `from=${D0()}&to=${today()}`;

  it("puts each item's documents in their columns; opening and closing are stock at those dates", async () => {
    const m = await view<StockMovementView>(`/api/reports/stock-movement?${range()}&group=none`);
    const row = (code: string) =>
      rowsOf<StockMovementView['total']>(m.lines).find((r) => r.code === code)!.cells;
    const oil = row('OIL001');
    expect([
      oil.opening.qty,
      oil.openings.qty,
      oil.purchases.qty,
      oil.purchaseReturns.qty,
      oil.sales.qty,
      oil.salesReturns.qty,
      oil.adjustments.qty,
      oil.closing.qty,
    ]).toEqual([0, openingQty, 10000, -1000, -2000, 1000, -1000, openingQty + 7000]);
    const pads = row('PAD001');
    expect([
      pads.purchases.qty,
      pads.transfersIn.qty,
      pads.transfersOut.qty,
      pads.sales.qty,
      pads.closing.qty,
    ]).toEqual([8000, 6000, -6000, -1000, 7000]);
    const before = await view<StockAtView>(`/api/reports/stock-at?at=${daysAgo(41)}&group=none`);
    const after = await view<StockAtView>(`/api/reports/stock-at?group=none`);
    expect(m.total.opening).toEqual({ qty: before.total.qty, value: before.total.value });
    expect(m.total.closing).toEqual({ qty: after.total.qty, value: after.total.value });
  });

  it('per location, the transfer is out of the Godown and into the Shop', async () => {
    const m = await view<StockMovementView>(`/api/reports/stock-movement?${range()}&group=location`);
    const pads = rowsOf<StockMovementView['total']>(m.lines).filter((r) => r.code === 'PAD001');
    expect(
      pads.map((r) => [r.location, r.cells.transfersIn.qty, r.cells.transfersOut.qty, r.cells.closing.qty]),
    ).toEqual([
      ['GODOWN', 0, -6000, 2000],
      ['SHOP', 6000, 0, 5000],
    ]);
  });

  it('refuses more than a year', async () => {
    const res = await send('GET', `/api/reports/stock-movement?from=${daysAgo(366)}&to=${today()}`, 'fahad');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'range_too_long' });
  });
});

describe('the stock ledger (RPT-12, owner answer 6)', () => {
  it("one item's documents with the opening and the running balance, each opening its document", async () => {
    const l = await view<StockLedgerView>(
      `/api/reports/stock-ledger?itemId=${items['PAD001']}&from=${D1()}&to=${today()}`,
    );
    expect(l.opening.qty).toBe(0);
    expect(l.lines.map((x) => [x.kind, x.locationCode, x.qty, x.balance])).toEqual([
      ['goods_receipt', 'GODOWN', 8000, 8000],
      ['stock_transfer', 'GODOWN', -6000, 2000],
      ['stock_transfer', 'SHOP', 6000, 8000],
      ['sale', 'SHOP', -1000, 7000],
    ]);
    expect(l.lines.every((x) => x.number !== null && x.documentId)).toBe(true);
    expect(l.closing).toEqual({ qty: 7000, value: l.lines.at(-1)!.balanceValue });
    expect([l.in.qty, l.out.qty]).toEqual([14000, -7000]);
    const godown = await view<StockLedgerView>(
      `/api/reports/stock-ledger?itemId=${items['PAD001']}&from=${D1()}&to=${today()}&locationId=${loc['GODOWN']}`,
    );
    expect(godown.closing.qty).toBe(2000);
  });

  it("opens with the stock before the period, and closes on the movement's closing", async () => {
    const l = await view<StockLedgerView>(`/api/reports/stock-ledger?itemId=${items['OIL001']}&preset=today`);
    expect(l.opening.qty).toBe(openingQty);
    expect(l.closing.qty).toBe(openingQty + 7000);
  });

  it('needs an item, takes up to 92 days, and finds items by code or words', async () => {
    expect((await send('GET', '/api/reports/stock-ledger', 'fahad')).statusCode).toBe(400);
    const long = await send(
      'GET',
      `/api/reports/stock-ledger?itemId=${items['PAD001']}&from=${daysAgo(92)}&to=${today()}`,
      'fahad',
    );
    expect(long.json()).toEqual({ error: 'range_too_long' });
    const found = await view<{ items: { code: string }[] }>('/api/reports/items?q=brake%20civic');
    expect(found.items.map((x) => x.code)).toEqual(['PAD001']);
  });
});

describe('the reorder list (PUR-07 list, owner answer 4)', () => {
  it('lists items at or below their minimum, up to the maximum, by supplier', async () => {
    const r = await view<ReorderView>('/api/reports/reorder');
    expect(r.rows.map((x) => [x.supplier, x.code, x.onHand, x.order, x.levelsNeedFixing])).toEqual([
      ['Oil Co', 'HOSE001', 1500, 9000, false],
      ['Oil Co', 'PAD001', 7000, 13000, false],
      [null, 'BELT001', 0, 4000, true],
    ]);
    const pads = r.rows.find((x) => x.code === 'PAD001')!;
    expect(pads).toMatchObject({
      sold30: 1000,
      sold90: 1000,
      lastCost: 50000,
      orderValue: 650000,
      lastReceipt: D1(),
    });
    expect(pads.daysOfCover).toBe(7 * 41);
    expect(r.suppliers.map((s) => [s.supplier, s.count])).toEqual([
      ['Oil Co', 2],
      [null, 1],
    ]);
    expect(r.total.count).toBe(3);
    const noor = await view<ReorderView>('/api/reports/reorder', 'noor');
    expect(noor.rows.every((x) => x.lastCost === null && x.orderValue === null)).toBe(true);
  });
});

describe('dead and slow stock (RPT-08, owner answers 1 and 5)', () => {
  it('the hose never sold is dead after 30 days; the oil and the pads are slow', async () => {
    const d = await view<DeadStockView>('/api/reports/dead-stock?days=30');
    expect(d.since).toBe(D0());
    expect(d.rows.map((x) => [x.code, x.kind]).sort()).toEqual([
      ['HOSE001', 'dead'],
      ['OIL001', 'slow'],
      ['PAD001', 'slow'],
    ]);
    expect(d.totals.dead.count).toBe(1);
    expect(d.totals.dead.value).toBe(d.rows.find((x) => x.code === 'HOSE001')!.value);
  });

  it('within 90 days of go-live, never sold is "not sold since go-live"; N must be one of the choices', async () => {
    const d = await view<DeadStockView>('/api/reports/dead-stock');
    expect(d.days).toBe(90);
    expect(d.rows.find((x) => x.code === 'HOSE001')!.kind).toBe('notSoldSinceGoLive');
    expect((await send('GET', '/api/reports/dead-stock?days=45', 'fahad')).statusCode).toBe(400);
  });
});

describe('inventory analysis (RPT-14, owner answer 7)', () => {
  it('ranks by sales and profit, with turnover from the cost of sales and the stock values', async () => {
    const a = await view<AnalysisView>(`/api/reports/inventory-analysis?from=${D0()}&to=${today()}`);
    expect(a.rows.map((x) => [x.code, x.qtySold, x.sales, x.salesClass])).toEqual([
      ['OIL001', 1000, 120000, 'A'],
      ['PAD001', 1000, 90000, 'A'],
    ]);
    for (const x of a.rows) expect(x.profit).not.toBeNull();
    expect(a.costOfSales).toBe(a.rows.reduce((t, x) => t + x.sales - x.profit!, 0));
    expect(a.unsold.count).toBe(1);
    expect(a.closingValue).toBe(await inventoryAt(today()));
    expect(a.turnover).not.toBeNull();
    const noor = await view<AnalysisView>(
      `/api/reports/inventory-analysis?from=${D0()}&to=${today()}`,
      'noor',
    );
    expect([noor.costOfSales, noor.turnover, noor.rows[0]!.profit, noor.rows[0]!.profitClass]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});

describe('who sees the stock reports', () => {
  const urls = [
    '/api/reports/stock-at',
    '/api/reports/stock-movement',
    `/api/reports/stock-ledger?itemId=${'00000000-0000-7000-8000-000000000000'}`,
    '/api/reports/reorder',
    '/api/reports/dead-stock',
    '/api/reports/inventory-analysis',
    '/api/reports/stock-choices',
  ];

  it('a salesman sees none of them', async () => {
    for (const url of urls) expect([url, (await send('GET', url, 'sara')).statusCode]).toEqual([url, 403]);
  });

  it("another shop never sees this shop's stock (RLS)", async () => {
    const s = await view<StockAtView>('/api/reports/stock-at', 'fahad', OTHER);
    expect(s.lines).toEqual([]);
    const r = await view<ReorderView>('/api/reports/reorder', 'fahad', OTHER);
    expect(r.rows).toEqual([]);
  });
});

describe('a year of stock', () => {
  it('answers stock at a date, the movement and the reorder list for 19,500 items in under 2 s', async () => {
    // A year of a busy counter, straight into the other shop's stock ledger: 19,500 items with 20 each at the
    // opening, then 300 lines sold a day.
    const owner = new pg.Client({ connectionString: db.ownerUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query("SELECT set_config('app.tenant_id', $1, true)", [otherId]);
      const shop = (
        await owner.query<{ id: string }>(
          "SELECT id FROM erp.locations WHERE tenant_id = $1 AND code = 'SHOP'",
          [otherId],
        )
      ).rows[0]!.id;
      const seeded = await seedCatalog(owner, otherId, [
        { code: 'G00000', name: 'GENERATED 0', category: 'GEN' },
      ]);
      await owner.query(
        `INSERT INTO erp.items (tenant_id, code, name, category_id, unit_id, status, min_qty, max_qty)
         SELECT $1, 'G' || lpad(g::text, 5, '0'), 'GENERATED ' || g, i.category_id, i.unit_id, 'active', 15, 30
         FROM erp.items i, generate_series(1, 19499) g WHERE i.id = $2`,
        [otherId, seeded['G00000']],
      );
      await owner.query(
        `WITH days AS (SELECT (current_date - 364 + g)::date AS day, g + 1 AS n FROM generate_series(0, 364) g),
         posted AS (
           INSERT INTO erp.postings (tenant_id, seq, source_type, source_id, entry_date, posted_at, context)
           SELECT $1, n, 'opening', erp.uuid_v7(), day, now(), '{}' FROM days RETURNING seq, entry_date),
         it AS (SELECT id, row_number() OVER (ORDER BY code) - 1 AS k FROM erp.items WHERE tenant_id = $1)
         INSERT INTO erp.stock_movements (tenant_id, posting_seq, item_id, location_id, qty_delta, unit_cost, value_delta,
           source_type, source_id, business_date, posted_at)
         SELECT $1::uuid, p.seq, it.id, $2::uuid, 20, 1000, 20000, 'opening', erp.uuid_v7(), p.entry_date, now()
         FROM posted p, it WHERE p.seq = 1
         UNION ALL
         SELECT $1::uuid, p.seq, it.id, $2::uuid, -1, 1000, -1000, 'sale', erp.uuid_v7(), p.entry_date, now()
         FROM posted p, generate_series(0, 299) b, it WHERE it.k = (p.seq * 300 + b) % 19500`,
        [otherId, shop],
      );
      await owner.query('COMMIT');
      // As autovacuum does after a load this size (W2-01's lesson).
      await owner.query(
        'ANALYZE erp.items, erp.stock_movements, erp.postings, erp.item_costs, erp.item_compatibility',
      );
    } finally {
      await owner.end();
    }
    const timed = async <T>(url: string) => {
      const started = performance.now();
      const res = await send('GET', url, 'fahad', undefined, OTHER);
      expect(res.statusCode, res.body).toBe(200);
      return { ms: performance.now() - started, body: res.json<T>() };
    };
    const at = await timed<StockAtView>('/api/reports/stock-at');
    const moved = await timed<StockMovementView>(
      `/api/reports/stock-movement?from=${daysAgo(365)}&to=${today()}`,
    );
    const reorder = await timed<ReorderView>('/api/reports/reorder');
    expect(at.body.total).toEqual({
      count: 19500,
      qty: 19500 * 20000 - 365 * 300 * 1000,
      value: 19500 * 20000 - 365 * 300 * 1000,
    });
    expect(at.body.truncated).toBe(true);
    expect(moved.body.total.closing.qty).toBe(at.body.total.qty);
    expect(reorder.body.total.count).toBeGreaterThan(0);
    expect(at.ms).toBeLessThan(2000);
    expect(moved.ms).toBeLessThan(2000);
    expect(reorder.ms).toBeLessThan(2000);
  }, 300_000);
});
