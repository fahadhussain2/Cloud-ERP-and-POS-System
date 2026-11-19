import {
  exportPublicKey,
  generateDeviceKey,
  signCanonical,
  TenantSpec,
  uuidv7,
  type DocumentFamily,
  type PurchaseRegisterView,
  type PushDocument,
  type PushRequest,
  type RatesView,
  type SalesChoicesView,
  type SalesOverTimeView,
  type SalesProfitView,
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
  type BillLine,
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

// The sales and purchase reports (W2-03 plan; RPT-07, RPT-09, RPT-15; D-116), on a shop with known documents: the
// opening (oil in the Shop) 40 days ago; pads and belts received 35 days ago (the belts with a bill discount); 34 days
// ago Sara sells two pads to a walk-in and Imran oil and a belt to Khan Motors with a bill discount; today oil received
// and one sent back, hose received, Sara sells three cans with one below list, a metre of hose then voided, takes back
// Khan's can (a return of Imran's bill) and a can with no receipt. Each report is read under RLS with reports.view and
// tied to the books: sales and cost to net sales and cost of goods sold, the purchase register to Inventory.

type DeviceKeys = Awaited<ReturnType<typeof generateDeviceKey>>;
interface Device {
  token: string;
  deviceId: string;
  code: string;
  keys: DeviceKeys;
  seq: Partial<Record<DocumentFamily, number>>;
}

const SHOP = 'sls-shop';
const OTHER = 'sls-other';
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
let sara: string;
let imran: string;
let manager: string;
let retail: string;
let khan: string;
let oilCo: string;
let beltCo: string;
let counter: Device;
let items: Record<string, string> = {};
const loc: Record<string, string> = {};
const bills: Record<string, string> = {};
const cookies: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date() });
const today = () => businessDate(Date.now(), 'Asia/Karachi', 4);
const daysAgo = (n: number) =>
  new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
/** The opening; the pads' and belts' receipts; the first bills. */
const D0 = () => daysAgo(40);
const D1 = () => daysAgo(35);
const D2 = () => daysAgo(34);
const ALL = () => `from=${D0()}&to=${today()}`;

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
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        tenantId,
        username,
        username[0]!.toUpperCase() + username.slice(1),
        `${username}@example.test`,
        await hashPassword(PASSWORD),
      ],
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
  ).json<{ deviceId: string; code: string }>();
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
/** On the counter at noon `at` days ago (0: a minute ago). */
const context = (d: Device, family: DocumentFamily, at = 0) => ({
  id: uuidv7(),
  seq: next(d, family),
  deviceId: d.deviceId,
  deviceCode: d.code,
  branchId,
  createdAtMs: at === 0 ? Date.now() - 60_000 : Date.parse(`${daysAgo(at)}T07:00:00Z`),
  timeZone: 'Asia/Karachi',
  cutoffHour: 4,
  clientVersion: '0.9.0',
});

const line = (id: string, item: string, units: number, list: number, price = list): BillLine => ({
  id,
  itemId: items[item]!,
  qty: (units * 1000) as Qty,
  allowsFraction: item === 'HOSE001',
  list: money(list),
  // A known floor below the price: an unknown floor is the list price, and a lower price would be below it.
  floor: money(Math.floor(list * 0.8)),
  unitPrice: money(price),
  approval:
    price < list
      ? {
          kind: 'below_list',
          requestedBy: sara,
          approvedBy: manager,
          reason: 'customer_bargain',
          note: null,
          at: new Date().toISOString(),
          values: { list: money(list), floor: money(Math.floor(list * 0.8)), price: money(price) },
        }
      : null,
});

/** A bill of `lines` by `seller` (to `customer`), with a bill discount approved by the manager, paid in cash. */
function sale(
  seller: string,
  lines: BillLine[],
  opts: { at?: number; customer?: string; billDiscount?: number } = {},
): SaleDocument {
  const discount = opts.billDiscount ?? 0;
  const bill: Bill = {
    version: 1,
    sellerId: seller,
    tierId: retail,
    lines,
    billDiscount: money(discount),
    billApproval:
      discount === 0
        ? null
        : {
            kind: 'below_list',
            requestedBy: seller,
            approvedBy: manager,
            reason: 'regular_customer',
            note: null,
            at: new Date().toISOString(),
            values: {
              billDiscount: money(discount),
              lines: lines.map((l) => ({ id: l.id, qty: l.qty, unitPrice: l.unitPrice })),
            },
          },
  };
  const total = lines.reduce((s, l) => s + (l.qty * l.unitPrice) / 1000, 0) - discount;
  return buildSaleDocument({
    bill,
    tender: { payments: [{ method: 'cash', amount: money(total), reference: null }], cashReceived: null },
    methods: METHODS,
    sellerMaxDiscountBp: 0,
    customer: { id: opts.customer ?? null, walkinPhone: null },
    credit: null,
    creditApproval: null,
    reissueOf: null,
    context: { ...context(counter, 'S', opts.at), increment: money(100) },
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
    userId: sara,
    context: context(counter, 'V'),
  });

/** Line `lineNo` of `original` back, taken by Sara: the refund is what was paid for it. */
function returnOf(original: SaleDocument, lineNo: number): ReturnDocument {
  const l = original.lines.find((x) => x.lineNo === lineNo)!;
  const bill = addReturn(emptyBill(sara, retail), {
    source: {
      kind: 'bill',
      id: original.id,
      number: original.number,
      businessDate: original.businessDate,
      customerId: null,
    },
    lines: [
      {
        id: 'r0',
        itemId: l.itemId,
        qty: qty(l.qty),
        allowsFraction: false,
        reason: 'wrong_part',
        note: null,
        condition: 'resellable',
        original: { line: l, returned: { qty: qty(0), refund: money(0) } },
        price: null,
        suggested: null,
      },
    ],
    needs: [],
    approval: null,
  });
  const refund = (bill.returns?.lines ?? []).reduce((s, x) => s + x.refund, 0);
  return buildReturnDocument({
    bill,
    tender: { payments: [{ method: 'cash', amount: money(-refund), reference: null }], cashReceived: null },
    methods: METHODS,
    sellerMaxDiscountBp: 0,
    customer: { id: null, walkinPhone: null },
    credit: null,
    creditApproval: null,
    refundApproval: null,
    context: { ...context(counter, 'S'), increment: money(100) },
  });
}

/** A can of oil back without a receipt, taken by Sara. */
function oilBack(): ReturnDocument {
  const bill = addReturn(emptyBill(sara, retail), {
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
  item: string,
  units: number,
  cost: number,
  billDiscount = 0,
  post = true,
) {
  const r = await created('/api/purchasing/receipts', {
    supplierId,
    billNo: `B-${item}-${on}`,
    billDate: on,
    receivedOn: on,
    locationId: loc['SHOP'],
    paidFrom: null,
    billDiscount,
    billTotal: Math.round((units * cost) / 1000) - billDiscount,
    notes: null,
    lines: [{ itemId: items[item], qty: units, unitCost: cost, lineDiscount: 0 }],
  });
  if (post) await postDraft('/api/purchasing/receipts', r.id, r.rowVersion);
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
    sara = await person(c, 'sara', 'salesman');
    imran = await person(c, 'imran', 'salesman');
    manager = await person(c, 'tariq', 'manager');
    await person(c, 'kashif', 'cashier');
    // Reports but no cost.view: no cost, profit or purchase amounts.
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
    for (const r of (await c.query<{ id: string; code: string }>('SELECT id, code FROM erp.locations')).rows)
      loc[r.code] = r.id;
    khan = (
      await c.query<{ id: string }>(
        "INSERT INTO erp.parties (tenant_id, code, name) VALUES ($1, 'KHAN', 'Khan Motors') RETURNING id",
        [tenantId],
      )
    ).rows[0]!.id;
    await c.query(
      `INSERT INTO erp.customer_accounts (tenant_id, party_id, price_tier_id, credit_allowed, credit_limit,
         offline_daily_cap, payment_terms_days) VALUES ($1, $2, $3, true, 10000000, 0, 30)`,
      [tenantId, khan, retail],
    );
  });

  // The opening (W1-14), 40 days ago: the oil in the Shop.
  await seedGeneratedOpening(db.ownerUrl, {
    environment: 'test',
    tenantId,
    now: new Date(`${D0()}T12:00:00Z`),
  });

  // 35 days ago: 8 pads at Rs 500 from Oil Co; 6 belts at Rs 200 from Belt Co, Rs 20 off the bill.
  oilCo = (
    await send('POST', '/api/purchasing/suppliers', 'fahad', { code: 'S1', name: 'Oil Co', termsDays: 30 })
  ).json<{ id: string }>().id;
  beltCo = (
    await send('POST', '/api/purchasing/suppliers', 'fahad', { code: 'S2', name: 'Belt Co', termsDays: 0 })
  ).json<{ id: string }>().id;
  await receive(oilCo, D1(), 'PAD001', 8000, 50000);
  await receive(beltCo, D1(), 'BELT001', 6000, 20000, 2000);

  // Today: 10 cans in at Rs 1,000 and one sent back; 1.5 m of hose; and a receipt still a draft.
  const receipt = await receive(oilCo, today(), 'OIL001', 10000, 100000);
  const rl = (
    await view<{ lines: { id: string; netUnitCost: number }[] }>(`/api/purchasing/receipts/${receipt}`)
  ).lines[0]!;
  const back = await created('/api/purchasing/returns', {
    supplierId: oilCo,
    goodsReceiptId: receipt,
    locationId: loc['SHOP'],
    returnedOn: today(),
    reason: 'damaged',
    note: null,
    lines: [{ itemId: items['OIL001'], receiptLineId: rl.id, qty: 1000, unitCost: rl.netUnitCost }],
  });
  const backRv = (
    await view<{ purchaseReturn: { rowVersion: string } }>(`/api/purchasing/returns/${back.id}`)
  ).purchaseReturn.rowVersion;
  await postDraft('/api/purchasing/returns', back.id, backRv);
  await receive(oilCo, today(), 'HOSE001', 1500, 20000);
  await receive(oilCo, today(), 'PAD001', 2000, 50000, 0, false);

  // On the counter, in the order they were made (each takes the counter's next number).
  counter = await enroll();
  const b1 = sale(sara, [line('l1', 'PAD001', 2, 90000)], { at: 34 });
  const b2 = sale(imran, [line('l1', 'OIL001', 1, 120000), line('l2', 'BELT001', 1, 30000)], {
    at: 34,
    customer: khan,
    billDiscount: 5000,
  });
  const b3 = sale(sara, [line('l1', 'OIL001', 1, 120000), line('l2', 'OIL001', 2, 120000, 110000)]);
  const b4 = sale(sara, [line('l1', 'HOSE001', 1, 25000)]);
  await push([b1, b2, b3, b4]);
  await push([voidOf(b4)]);
  const b5 = returnOf(b2, 1);
  const b6 = oilBack();
  await push([b5, b6]);
  Object.assign(bills, {
    b1: b1.number,
    b2: b2.number,
    b3: b3.number,
    b4: b4.number,
    b5: b5.number,
    b6: b6.number,
  });

  await postPending(pool, tenantId, { now: () => new Date() });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

/** Σ debit − credit of the accounts with these roles, between two dates. */
const books = async (roles: string[], from: string, to: string) =>
  Number(
    (
      await q<{ b: string }>(
        `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM erp.journal_lines l
         JOIN erp.journal_entries e ON e.id = l.entry_id JOIN erp.accounts a ON a.id = l.account_id
         WHERE a.system_role = ANY($1) AND e.entry_date BETWEEN $2 AND $3`,
        [roles, from, to],
      )
    )[0]!.b,
  );

describe('sales and gross profit (RPT-07, owner answers 1-3)', () => {
  it('over the period, equals net sales and cost of goods sold in the books', async () => {
    const r = await view<SalesProfitView>(`/api/reports/sales-profit?${ALL()}`);
    // 180,000 + 145,000 + 340,000 − 116,000 (Khan's can, after its share of the discount) − 120,000; the void is out.
    expect(r.total.cells.sales).toBe(429000);
    expect(r.total.cells.sales).toBe(
      -(await books(['SALES', 'SALES_RETURNS', 'SALES_DISCOUNT'], D0(), today())),
    );
    expect(r.total.cells.cost).toBe(await books(['COGS'], D0(), today()));
    expect(r.total.cells.profit).toBe(r.total.cells.sales - r.total.cells.cost!);
    expect(r.total.cells.bills).toBe(5);
    expect(r.group).toBe('category');
  });

  it('every grouping adds up to the same totals', async () => {
    const whole = await view<SalesProfitView>(`/api/reports/sales-profit?${ALL()}`);
    for (const group of [
      'category',
      'item',
      'brand',
      'make',
      'salesman',
      'customer',
      'bill',
      'day',
      'month',
    ]) {
      const r = await view<SalesProfitView>(`/api/reports/sales-profit?${ALL()}&group=${group}`);
      const sum = (k: 'sales' | 'cost' | 'qty' | 'discount') =>
        r.rows.reduce((t, x) => t + (x.cells[k] ?? 0), 0);
      expect([group, sum('sales'), sum('cost'), sum('qty'), sum('discount')]).toEqual([
        group,
        whole.total.cells.sales,
        whole.total.cells.cost,
        whole.total.cells.qty,
        whole.total.cells.discount,
      ]);
    }
  });

  it("a return counts on its day against the original bill's salesman and customer; the void is nowhere", async () => {
    const bySalesman = await view<SalesProfitView>(`/api/reports/sales-profit?${ALL()}&group=salesman`);
    expect(bySalesman.rows.map((x) => [x.name, x.cells.sales])).toEqual([
      ['Sara', 400000],
      ['Imran', 29000],
    ]);
    const byCustomer = await view<SalesProfitView>(`/api/reports/sales-profit?${ALL()}&group=customer`);
    expect(byCustomer.rows.map((x) => [x.key === khan ? 'Khan Motors' : x.key, x.cells.sales])).toEqual([
      ['', 400000],
      ['Khan Motors', 29000],
    ]);
    const byBill = await view<SalesProfitView>(`/api/reports/sales-profit?${ALL()}&group=bill`);
    expect(byBill.rows.map((x) => x.code)).toEqual(['b1', 'b2', 'b3', 'b5', 'b6'].map((b) => bills[b]));
    expect(byBill.rows.find((x) => x.code === bills['b3'])!.cells).toMatchObject({
      sales: 340000,
      discount: 20000,
    });
    expect(byBill.rows.find((x) => x.code === bills['b2'])!.cells).toMatchObject({
      sales: 145000,
      discount: 5000,
    });
    const byDay = await view<SalesProfitView>(`/api/reports/sales-profit?${ALL()}&group=day`);
    expect(byDay.rows.map((x) => [x.key, x.cells.sales])).toEqual([
      [D2(), 325000],
      [today(), 104000],
    ]);
  });

  it('filters by category, salesman, customer and walk-in, and opens a category into its items', async () => {
    const oil = (await q<{ id: string }>("SELECT id FROM erp.categories WHERE name = 'OIL'"))[0]!.id;
    const items_ = await view<SalesProfitView>(
      `/api/reports/sales-profit?${ALL()}&group=item&categoryId=${oil}`,
    );
    expect(items_.rows.map((x) => [x.code, x.cells.qty, x.cells.sales])).toEqual([['OIL001', 2000, 220000]]);
    const imrans = await view<SalesProfitView>(
      `/api/reports/sales-profit?${ALL()}&group=bill&salesmanId=${imran}`,
    );
    expect(imrans.rows.map((x) => x.code)).toEqual([bills['b2'], bills['b5']]);
    const walkIns = await view<SalesProfitView>(`/api/reports/sales-profit?${ALL()}&customerId=walk-in`);
    expect(walkIns.total.cells.sales).toBe(400000);
    const khans = await view<SalesProfitView>(`/api/reports/sales-profit?${ALL()}&customerId=${khan}`);
    expect(khans.total.cells.sales).toBe(29000);
    const words = await view<SalesProfitView>(`/api/reports/sales-profit?${ALL()}&group=item&q=brake`);
    expect(words.rows.map((x) => x.code)).toEqual(['PAD001']);
  });

  it('compares with the previous period, as the report run on it', async () => {
    const from = daysAgo(33);
    const r = await view<SalesProfitView>(
      `/api/reports/sales-profit?from=${from}&to=${today()}&compare=previous&group=item`,
    );
    expect(r.before).toEqual({ from: daysAgo(67), to: D2() });
    const earlier = await view<SalesProfitView>(
      `/api/reports/sales-profit?from=${daysAgo(67)}&to=${D2()}&group=item&compare=none`,
    );
    expect(r.total.before!.sales).toBe(earlier.total.cells.sales);
    expect(r.total.before!.sales).toBe(325000);
    expect(r.total.before!.salesChange.amount).toBe(r.total.cells.sales - 325000);
    const pads = r.rows.find((x) => x.code === 'PAD001');
    expect(pads).toBeUndefined();
    expect(r.since).toBe(D0());
    const none = await view<SalesProfitView>(`/api/reports/sales-profit?${ALL()}&compare=none`);
    expect([none.before, none.total.before]).toEqual([null, null]);
  });

  it('without cost.view: no cost, profit or margin; a cashier is refused; another shop sees none of it', async () => {
    const noor = await view<SalesProfitView>(`/api/reports/sales-profit?${ALL()}&group=item`, 'noor');
    expect(noor.values).toBe(false);
    expect(noor.total.cells).toMatchObject({ sales: 429000, cost: null, profit: null, marginBp: null });
    expect(noor.rows.every((x) => x.cells.cost === null && x.before?.profit == null)).toBe(true);
    expect((await send('GET', '/api/reports/sales-profit', 'kashif')).statusCode).toBe(403);
    const other = await view<SalesProfitView>(`/api/reports/sales-profit?${ALL()}`, 'fahad', OTHER);
    expect([other.rows, other.total.cells.sales]).toEqual([[], 0]);
  });

  it('by bill takes 92 days, the rest a year; the CSV has every row and the total', async () => {
    const bill = await send(
      'GET',
      `/api/reports/sales-profit?group=bill&from=${daysAgo(92)}&to=${today()}`,
      'fahad',
    );
    expect([bill.statusCode, bill.json()]).toEqual([400, { error: 'range_too_long' }]);
    const year = await send('GET', `/api/reports/sales-profit?from=${daysAgo(366)}&to=${today()}`, 'fahad');
    expect(year.json()).toEqual({ error: 'range_too_long' });
    expect((await send('GET', '/api/reports/sales-profit?group=nope', 'fahad')).statusCode).toBe(400);
    const res = await send('GET', `/api/reports/sales-profit?${ALL()}&group=item&format=csv`, 'fahad');
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toMatch(/^code,item,bills,qty,sales,discount,cost,profit,margin_percent,before_sales/);
    expect(lines).toHaveLength(1 + 3 + 1);
    expect(lines.at(-1)).toContain(',total,5,');
  });

  it('lists the salesmen and the customers for the filters', async () => {
    const c = await view<SalesChoicesView>('/api/reports/sales-choices');
    expect(c.salesmen.map((x) => x.name)).toEqual(['Imran', 'Sara']);
    expect(c.customers.map((x) => x.name)).toEqual(['Khan Motors']);
    const found = await view<{ items: { code: string }[] }>('/api/reports/parties?q=co');
    expect(found.items.map((x) => x.code)).toEqual(['S2', 'S1']);
    expect((await view<{ items: unknown[] }>('/api/reports/parties?q=khan')).items).toHaveLength(1);
  });
});

describe('the purchase register (RPT-09)', () => {
  it('lists posted receipts and returns by supplier, tied to Inventory; drafts are left out', async () => {
    const r = await view<PurchaseRegisterView>(`/api/reports/purchase-register?from=${D1()}&to=${today()}`);
    expect(r.rows.map((x) => [x.supplier, x.kind, x.date, x.qty, x.total])).toEqual([
      ['Belt Co', 'receipt', D1(), 6000, 118000],
      ['Oil Co', 'receipt', D1(), 8000, 400000],
      ['Oil Co', 'receipt', today(), 10000, 1000000],
      ['Oil Co', 'receipt', today(), 1500, 30000],
      ['Oil Co', 'return', today(), -1000, -100000],
    ]);
    // Receipts are Inventory's debits from them; a return is what the supplier credits (its stock leaves at the
    // average, the difference to price variance), so receipts and returns together are what the suppliers are owed.
    const received = Number(
      (
        await q<{ v: string }>(
          "SELECT sum(value_delta)::text AS v FROM erp.stock_movements WHERE source_type = 'goods_receipt'",
        )
      )[0]!.v,
    );
    expect(r.total.receipts).toBe(received);
    expect(r.total.net).toBe(-(await books(['AP_CONTROL'], D1(), today())));
    expect(r.total).toMatchObject({ count: 5, receipts: 1548000, returns: -100000 });
    expect(r.suppliers.map((s) => [s.name, s.count, s.total])).toEqual([
      ['Belt Co', 1, 118000],
      ['Oil Co', 4, 1330000],
    ]);
    expect(r.rows[0]).toMatchObject({ supplierBillNo: `B-BELT001-${D1()}`, paidBy: 'account', lines: null });
  });

  it("shows each document's lines, filters by supplier, and leaves amounts out without cost.view", async () => {
    const r = await view<PurchaseRegisterView>(
      `/api/reports/purchase-register?from=${D1()}&to=${today()}&supplierId=${beltCo}&lines=1`,
    );
    expect(r.rows.map((x) => x.lines)).toEqual([
      [
        {
          itemId: items['BELT001'],
          code: 'BELT001',
          name: 'FAN BELT',
          qty: 6000,
          rate: 20000,
          value: 118000,
        },
      ],
    ]);
    const noor = await view<PurchaseRegisterView>(
      `/api/reports/purchase-register?from=${D1()}&to=${today()}&lines=1`,
      'noor',
    );
    expect(noor.total.net).toBeNull();
    expect(noor.rows.every((x) => x.total === null && x.lines!.every((l) => l.value === null))).toBe(true);
    const long = await send(
      'GET',
      `/api/reports/purchase-register?from=${daysAgo(92)}&to=${today()}`,
      'fahad',
    );
    expect(long.json()).toEqual({ error: 'range_too_long' });
    const res = await send(
      'GET',
      `/api/reports/purchase-register?from=${D1()}&to=${today()}&format=csv`,
      'fahad',
    );
    expect(res.body.trim().split('\n')).toHaveLength(1 + 5 + 1);
  });
});

describe('purchase and sale rates (RPT-09, owner answer 4)', () => {
  it('for an item: each purchase and sale with its net rate, the averages and the spread', async () => {
    const r = await view<RatesView>(`/api/reports/rates?itemId=${items['OIL001']}&${ALL()}`);
    expect(r.purchases!.map((x) => [x.party, x.qty, x.rate, x.netRate])).toEqual([
      ['Oil Co', 10000, 100000, 100000],
    ]);
    // Khan's can at Rs 1,200 less its Rs 40 share of the discount; Sara's at 1,200 and two at 1,100.
    expect(r.sales.map((x) => [x.number, x.salesman, x.party, x.qty, x.rate, x.netRate])).toEqual([
      [bills['b2'], 'Imran', 'Khan Motors', 1000, 120000, 116000],
      [bills['b3'], 'Sara', null, 1000, 120000, 120000],
      [bills['b3'], 'Sara', null, 2000, 110000, 110000],
    ]);
    // (116,000 + 120,000 + 220,000) ÷ 4 = 114,000.
    expect(r.saleStats).toEqual({
      count: 3,
      qty: 4000,
      value: 456000,
      average: 114000,
      lowest: 110000,
      highest: 120000,
      last: 110000,
    });
    // 14,000 ÷ 114,000 = 12.28%.
    expect(r.spread).toEqual({ amount: 14000, marginBp: 1228 });
  });

  it('for a supplier or a customer; none without cost.view on the purchase side; one of them is needed', async () => {
    const belts = await view<RatesView>(`/api/reports/rates?partyId=${beltCo}&${ALL()}`);
    // Rs 200 less its share of the Rs 20 off: 1,180 ÷ 6 = 196.67.
    expect(belts.purchases!.map((x) => [x.code, x.rate, x.netRate])).toEqual([['BELT001', 20000, 19667]]);
    expect([belts.saleStats, belts.purchaseStats, belts.spread]).toEqual([null, null, null]);
    const khans = await view<RatesView>(`/api/reports/rates?partyId=${khan}&${ALL()}`);
    expect(khans.sales.map((x) => [x.code, x.netRate])).toEqual([
      ['OIL001', 116000],
      ['BELT001', 29000],
    ]);
    const noor = await view<RatesView>(`/api/reports/rates?itemId=${items['OIL001']}&${ALL()}`, 'noor');
    expect([noor.purchases, noor.purchaseStats, noor.spread]).toEqual([null, null, null]);
    expect(noor.saleStats!.average).toBe(114000);
    expect((await send('GET', '/api/reports/rates', 'fahad')).statusCode).toBe(400);
    const year = await send(
      'GET',
      `/api/reports/rates?itemId=${items['OIL001']}&from=${daysAgo(365)}&to=${today()}`,
      'fahad',
    );
    expect(year.statusCode).toBe(200);
  });
});

describe('sales over time (RPT-15, owner answers 5 and 6)', () => {
  it('the trend, the busy hours and the top items add up to the period', async () => {
    const r = await view<SalesOverTimeView>(`/api/reports/sales-over-time?${ALL()}`);
    expect(r.step).toBe('day');
    expect(r.trend).toHaveLength(41);
    expect(r.trend.reduce((t, x) => t + x.sales, 0)).toBe(429000);
    expect(r.trend.reduce((t, x) => t + x.bills, 0)).toBe(5);
    expect(r.trend.find((x) => x.from === D2())).toMatchObject({ bills: 2, sales: 325000 });
    expect(r.grid.bills.flat().reduce((t, x) => t + x, 0)).toBe(5);
    expect(r.grid.sales.flat().reduce((t, x) => t + x, 0)).toBe(429000);
    // 34 days ago at noon in Karachi.
    const weekday = (new Date(`${D2()}T00:00:00Z`).getUTCDay() + 6) % 7;
    expect(r.grid.bills[weekday]![12]).toBe(2);
    expect(r.top.map((x) => [x.code, x.sales])).toEqual([
      ['OIL001', 220000],
      ['PAD001', 180000],
      ['BELT001', 29000],
    ]);
    expect(r.bottom).toEqual([]);
    const byQty = await view<SalesOverTimeView>(`/api/reports/sales-over-time?${ALL()}&by=qty`);
    expect(byQty.top.map((x) => [x.code, x.qty])).toEqual([
      ['OIL001', 2000],
      ['PAD001', 2000],
      ['BELT001', 1000],
    ]);
  });

  it('discounts given are list − paid, by salesman and by day, with the price approvals', async () => {
    const r = await view<SalesOverTimeView>(`/api/reports/sales-over-time?${ALL()}&compare=none`);
    expect(r.beforeTrend).toBeNull();
    const approvals = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM erp.overrides o JOIN erp.sales_documents d ON d.id = o.document_id
       WHERE d.status = 'finalized' AND o.kind IN ('below_list', 'below_floor')`,
    );
    expect(r.discounts.total.approvals).toBe(Number(approvals[0]!.n));
    expect(r.discounts.total.approvals).toBeGreaterThanOrEqual(2);
    const sara_ = r.discounts.bySalesman.find((x) => x.name === 'Sara')!;
    expect(sara_.sales).toBe(400000);
    expect(sara_.discount).toBe(sara_.listSales - 400000);
    expect(r.discounts.byDay.find((x) => x.key === D2())).toMatchObject({ sales: 325000, discount: 5000 });
    expect(r.discounts.total.discount).toBe(r.discounts.bySalesman.reduce((t, x) => t + x.discount, 0));
  });

  it('compares with the previous period bucket by bucket; profit only with cost.view', async () => {
    const r = await view<SalesOverTimeView>(`/api/reports/sales-over-time?from=${daysAgo(33)}&to=${today()}`);
    expect(r.beforeTrend).toHaveLength(r.trend.length);
    expect(r.beforeTrend!.reduce((t, x) => t + x.sales, 0)).toBe(325000);
    const noor = await view<SalesOverTimeView>(`/api/reports/sales-over-time?${ALL()}&by=profit`, 'noor');
    expect(noor.by).toBe('sales');
    expect(noor.trend.every((x) => x.profit === null)).toBe(true);
    expect(noor.top.every((x) => x.profit === null)).toBe(true);
    const long = await send(
      'GET',
      `/api/reports/sales-over-time?from=${daysAgo(200)}&to=${today()}`,
      'fahad',
    );
    expect(long.json<SalesOverTimeView>().step).toBe('week');
    const csv = await send('GET', `/api/reports/sales-over-time?${ALL()}&format=csv`, 'fahad');
    expect(csv.body.trim().split('\n')).toHaveLength(1 + 41);
  });
});

describe('a year of sales', () => {
  it('answers each report for 19,500 items and 300 lines a day in under 2 s', async () => {
    // A year of a busy counter, straight into the other shop's bills and stock ledger: 60 bills a day of 5 lines.
    const owner = new pg.Client({ connectionString: db.ownerUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query("SELECT set_config('app.tenant_id', $1, true)", [otherId]);
      const one = async (sql: string) => (await owner.query<{ id: string }>(sql, [otherId])).rows[0]!.id;
      const shop = await one("SELECT id FROM erp.locations WHERE tenant_id = $1 AND code = 'SHOP'");
      const branch = await one('SELECT id FROM erp.branches WHERE tenant_id = $1');
      const tier = await one("SELECT id FROM erp.price_tiers WHERE tenant_id = $1 AND code = 'RETAIL'");
      const user = await one('SELECT id FROM erp.users WHERE tenant_id = $1 LIMIT 1');
      const device = (
        await owner.query<{ id: string }>(
          `INSERT INTO erp.devices (tenant_id, branch_id, code, kind, public_key, enrolled_at)
           VALUES ($1, $2, 'C09', 'counter', '\\x00', now()) RETURNING id`,
          [otherId, branch],
        )
      ).rows[0]!.id;
      const seeded = await seedCatalog(owner, otherId, [
        { code: 'G00000', name: 'GENERATED 0', category: 'GEN' },
      ]);
      await owner.query(
        `INSERT INTO erp.items (tenant_id, code, name, category_id, unit_id, status)
         SELECT $1, 'G' || lpad(g::text, 5, '0'), 'GENERATED ' || g, i.category_id, i.unit_id, 'active'
         FROM erp.items i, generate_series(1, 19499) g WHERE i.id = $2`,
        [otherId, seeded['G00000']],
      );
      await owner.query(
        `CREATE TEMP TABLE gen_docs ON COMMIT DROP AS
         SELECT erp.uuid_v7() AS id, n AS seq, (current_date - 364 + (n - 1) / 60)::date AS day
         FROM generate_series(1, 365 * 60) n`,
      );
      await owner.query(
        `INSERT INTO erp.sales_documents (id, tenant_id, branch_id, device_id, number, seq, kind, status, business_date,
           created_at_device, received_at, salesperson_user_id, price_tier_id, subtotal, line_discount_total,
           bill_discount, rounding, tax_total, total, cash_due, handover_status, payload, payload_hash, signature,
           client_version)
         SELECT d.id, $1, $2, $3, 'C09-S' || lpad(d.seq::text, 6, '0'), d.seq, 'sale', 'finalized', d.day,
           d.day + interval '5 hours' + (d.seq % 60) * interval '10 minutes', now(), $4, $5, 50000, 0, 0, 0, 0, 50000,
           50000, 'received', '{}', '\\x00', '\\x00', 'gen'
         FROM gen_docs d`,
        [otherId, branch, device, user, tier],
      );
      await owner.query(
        `CREATE TEMP TABLE gen_lines ON COMMIT DROP AS
         SELECT erp.uuid_v7() AS id, d.id AS doc_id, d.day, b AS line_no, it.id AS item_id
         FROM gen_docs d CROSS JOIN generate_series(1, 5) b
         JOIN (SELECT id, row_number() OVER (ORDER BY code) - 1 AS k FROM erp.items WHERE tenant_id = $1) it
           ON it.k = (d.seq * 5 + b) % 19500`,
        [otherId],
      );
      await owner.query(
        `INSERT INTO erp.sales_lines (id, tenant_id, document_id, line_no, item_id, qty, list_price, unit_price,
           line_discount, bill_share, line_total, location_id)
         SELECT l.id, $1, l.doc_id, l.line_no, l.item_id, 1, 11000, 10000, 1000, 0, 10000, $2 FROM gen_lines l`,
        [otherId, shop],
      );
      await owner.query(
        `WITH posted AS (
           INSERT INTO erp.postings (tenant_id, seq, source_type, source_id, entry_date, posted_at, context)
           SELECT $1, g + 1, 'opening', erp.uuid_v7(), current_date - 364 + g, now(), '{}'
           FROM generate_series(0, 364) g RETURNING seq, entry_date)
         INSERT INTO erp.stock_movements (tenant_id, posting_seq, item_id, location_id, qty_delta, unit_cost,
           value_delta, source_type, source_id, source_line_id, business_date, posted_at)
         SELECT $1::uuid, p.seq, l.item_id, $2::uuid, -1, 7000, -7000, 'sale', l.doc_id, l.id, l.day, now()
         FROM gen_lines l JOIN posted p ON p.entry_date = l.day`,
        [otherId, shop],
      );
      await owner.query('COMMIT');
      // As autovacuum does after a load this size (W2-01's lesson).
      await owner.query('ANALYZE erp.items, erp.sales_documents, erp.sales_lines, erp.stock_movements');
    } finally {
      await owner.end();
    }
    const timed = async <T>(url: string) => {
      const started = performance.now();
      const res = await send('GET', url, 'fahad', undefined, OTHER);
      expect(res.statusCode, res.body).toBe(200);
      return { ms: performance.now() - started, body: res.json<T>() };
    };
    const year = `from=${daysAgo(364)}&to=${today()}`;
    const lines = 365 * 60 * 5;
    const byCategory = await timed<SalesProfitView>(`/api/reports/sales-profit?${year}&compare=none`);
    const byItem = await timed<SalesProfitView>(`/api/reports/sales-profit?${year}&group=item`);
    const overTime = await timed<SalesOverTimeView>(`/api/reports/sales-over-time?${year}`);
    const rates = await timed<RatesView>(`/api/reports/rates?itemId=${byItem.body.rows[0]!.key}&${year}`);
    expect(byCategory.body.total.cells).toMatchObject({
      bills: 365 * 60,
      qty: lines * 1000,
      sales: lines * 10000,
      cost: lines * 7000,
      discount: lines * 1000,
    });
    expect(byItem.body.total.count).toBe(19500);
    expect(byItem.body.truncated).toBe(true);
    expect(overTime.body.trend.reduce((t, x) => t + x.sales, 0)).toBe(lines * 10000);
    expect(rates.body.sales.length).toBeGreaterThan(0);
    for (const [name, t] of Object.entries({ byCategory, byItem, overTime, rates }))
      expect([name, t.ms < 2000], `${name} took ${Math.round(t.ms)} ms`).toEqual([name, true]);
  }, 600_000);
});
