import {
  exportPublicKey,
  generateDeviceKey,
  signCanonical,
  TenantSpec,
  uuidv7,
  type AgeingView,
  type BillTraceView,
  type DiagnosticsRow,
  type DocumentFamily,
  type ExceptionsView,
  type OverridesView,
  type PushDocument,
  type PushRequest,
  type PushResponse,
  type SalesRegisterView,
  type StockView,
  type VoidsReturnsView,
} from '@erp/contracts';
import { pruneDiagnostics, setupTenant, withTenant } from '@erp/db';
import { createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import {
  addReturn,
  buildHandoverDocument,
  buildReturnDocument,
  buildSaleDocument,
  buildSessionDocument,
  buildVoidDocument,
  businessDate,
  emptyBill,
  money,
  qty,
  ROLE_TEMPLATES,
  type Bill,
  type CashHandoverDocument,
  type CashSessionDocument,
  type DeskSession,
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

// The W1-20 reports and support (RPT-01, RPT-03, RPT-04, RPT-05, RPT-06, RPT-10, PLT-12, D-110), on a shop with known
// documents: a goods receipt of 10 cans of oil at Rs 1,000 on the supplier's account; three counter sales at Rs 1,200
// a can (2 cans cash, 1 by Raast, 3 cash then voided); a return of 1 can without a receipt, approved by the manager;
// the first sale handed over at the desk, and pushed twice. Each report is read under RLS with its permission, and
// its totals checked against the books.

type DeviceKeys = Awaited<ReturnType<typeof generateDeviceKey>>;
interface Device {
  token: string;
  deviceId: string;
  code: string;
  keys: DeviceKeys;
  seq: Partial<Record<DocumentFamily, number>>;
}

const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';
const METHODS: PaymentMethodInfo[] = [
  { code: 'cash', isCash: true, requiresReference: false },
  { code: 'raast', isCash: false, requiresReference: true },
];
const MANAGER_GRANTS: RoleGrant[] = [{ ...ROLE_TEMPLATES.manager, branchId: null }];
const CASHIER_GRANTS: RoleGrant[] = [{ ...ROLE_TEMPLATES.cashier, branchId: null }];

let db: TestDatabase;
let pool: pg.Pool;
let tenantId: string;
let branchId: string;
let seller: string;
let manager: string;
let cashier: string;
let retail: string;
let oil: string;
let counter: Device;
let desk: Device;
let session: DeskSession;
const cookies: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date() });
const today = () => businessDate(Date.now(), 'Asia/Karachi', 4);

const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  withTenant(pool, { tenantId }, async (_db, c) => (await c.query<T>(sql, params)).rows);

const post = (url: string, payload: unknown, cookie?: string) =>
  app().inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, host: HOST },
    payload: payload as Record<string, unknown>,
    ...(cookie ? { cookies: { erp_session: cookie } } : {}),
  });

async function login(username: string, shop = 'rpt-shop'): Promise<string> {
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
const view = async <T>(url: string, who = 'fahad') => {
  const res = await send('GET', url, who);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<T>();
};

async function person(c: pg.ClientBase, username: string, template: string | null, permissions?: string[]) {
  const id = (
    await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, email, password_hash)
       VALUES ($1, $2, $2, $3, $4) RETURNING id`,
      [tenantId, username, `${username}@example.test`, await hashPassword(PASSWORD)],
    )
  ).rows[0]!.id;
  if (template)
    await c.query(
      `INSERT INTO erp.user_roles (tenant_id, user_id, role_id, branch_id)
       SELECT $1, $2, id, NULL FROM erp.roles WHERE template_key = $3`,
      [tenantId, id, template],
    );
  else {
    const role = (
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
  }
  return id;
}

async function enroll(kind: 'counter' | 'cash_desk'): Promise<Device> {
  const cookie = await login('fahad');
  const code = (await post('/api/devices/enrollment-codes', { branchId, kind }, cookie)).json<{
    code: string;
  }>().code;
  const keys = await generateDeviceKey();
  const publicKey = await exportPublicKey(keys.publicKey);
  const signature = await signCanonical(keys.privateKey, { tenantCode: 'rpt-shop', code, publicKey });
  const enrolled = (
    await post('/api/devices/enroll', { tenantCode: 'rpt-shop', code, publicKey, signature })
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
const context = (d: Device, family: DocumentFamily, atMs = Date.now() - 60_000) => ({
  id: uuidv7(),
  seq: next(d, family),
  deviceId: d.deviceId,
  deviceCode: d.code,
  branchId,
  createdAtMs: atMs,
  timeZone: 'Asia/Karachi',
  cutoffHour: 4,
  clientVersion: '0.9.0',
});

/** `units` cans of oil at Rs 1,200, in cash or by Raast. */
function sale(units: number, method: 'cash' | 'raast' = 'cash'): SaleDocument {
  const bill: Bill = {
    version: 1,
    sellerId: seller,
    tierId: retail,
    lines: [
      {
        id: 'l1',
        itemId: oil,
        qty: (units * 1000) as Qty,
        allowsFraction: false,
        list: money(120000),
        floor: null,
        unitPrice: money(120000),
        approval: null,
      },
    ],
    billDiscount: money(0),
    billApproval: null,
  };
  return buildSaleDocument({
    bill,
    tender: {
      payments: [{ method, amount: money(units * 120000), reference: method === 'cash' ? null : 'RAAST1' }],
      cashReceived: null,
    },
    methods: METHODS,
    sellerMaxDiscountBp: 0,
    customer: { id: null, walkinPhone: null },
    credit: null,
    creditApproval: null,
    reissueOf: null,
    context: { ...context(counter, 'S', Date.now() - 120_000), increment: money(100) },
  });
}

const voidOf = (bill: SaleDocument) =>
  buildVoidDocument({
    bill: {
      id: bill.id,
      number: bill.number,
      deviceId: bill.deviceId,
      businessDate: bill.businessDate,
      total: bill.amounts.total,
      cashDue: bill.cashDue,
      status: 'finalized',
    },
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

/** One can back without a receipt, at Rs 1,200, approved by the manager. */
function noReceiptReturn(): ReturnDocument {
  const bill = addReturn(emptyBill(seller, retail), {
    source: { kind: 'none', ref: '023956' },
    lines: [
      {
        id: 'r0',
        itemId: oil,
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

function openSession(): CashSessionDocument {
  const z = buildSessionDocument({
    event: 'open',
    current: null,
    userId: cashier,
    grants: CASHIER_GRANTS,
    openingFloat: money(0),
    handovers: [],
    context: { ...context(desk, 'Z', Date.now() - 600_000), increment: money(100) },
  });
  session = { id: z.id, cashierId: cashier, openingFloat: money(0), status: 'open' };
  return z;
}

const scan = (bill: SaleDocument): CashHandoverDocument =>
  buildHandoverDocument({
    session,
    cashierId: cashier,
    grants: CASHIER_GRANTS,
    branchId,
    increment: money(100),
    target: {
      number: bill.number,
      cashDue: money(bill.cashDue),
      saleDocumentId: null,
      cashReceived: null,
      handoverStatus: 'pending',
    },
    cashReceived: null,
    existing: [],
    method: 'scan',
    context: context(desk, 'H', Date.now() - 30_000),
  });

type AnyDocument =
  SaleDocument | SaleVoidDocument | ReturnDocument | CashHandoverDocument | CashSessionDocument;

async function push(device: Device, docs: AnyDocument[]): Promise<PushResponse> {
  const documents: PushDocument[] = await Promise.all(
    docs.map(async (d) => ({
      id: d.id,
      family: d.family,
      seq: d.seq,
      payload: d,
      signature: await signCanonical(device.keys.privateKey, d),
    })),
  );
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
    headers: { authorization: `Device ${device.token}` },
    payload: body as unknown as Record<string, unknown>,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<PushResponse>();
}

let first: SaleDocument;
let raast: SaleDocument;
let voided: SaleDocument;
let back: ReturnDocument;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  const made: string[] = [];
  for (const code of ['rpt-shop', 'rpt-other'])
    made.push(
      (
        await setupTenant(db.ownerUrl, TenantSpec.parse({ ...deluxSpec, code, name: `${code} shop` }), {
          ownerPasswordHash: await hashPassword(PASSWORD),
          mustChangePassword: false,
        })
      ).tenantId,
    );
  tenantId = made[0]!;
  await withTenant(pool, { tenantId }, async (_db, c) => {
    branchId = (await c.query<{ id: string }>('SELECT id FROM erp.branches')).rows[0]!.id;
    retail = (await c.query<{ id: string }>("SELECT id FROM erp.price_tiers WHERE code = 'RETAIL'")).rows[0]!
      .id;
    seller = await person(c, 'sara', 'salesman');
    manager = await person(c, 'tariq', 'manager');
    cashier = await person(c, 'ali', 'cashier');
    // Reports but no cost.view: sees quantities, never values or floors (owner answer 1).
    await person(c, 'noor', null, ['reports.view']);
    oil = (
      await seedCatalog(c, tenantId, [
        { code: 'OIL001', name: 'ENGINE OIL 4L', category: 'OIL', floor: 100000, prices: { RETAIL: 120000 } },
      ])
    )['OIL001']!;
  });

  // 10 cans at Rs 1,000 on the supplier's account, received today.
  const supplier = (
    await send('POST', '/api/purchasing/suppliers', 'fahad', { code: 'S1', name: 'Oil Co', termsDays: 30 })
  ).json<{ id: string }>().id;
  const shopLocation = (await q<{ id: string }>("SELECT id FROM erp.locations WHERE code = 'SHOP'"))[0]!.id;
  const receipt = await send('POST', '/api/purchasing/receipts', 'fahad', {
    supplierId: supplier,
    billNo: 'OC-1',
    billDate: today(),
    receivedOn: today(),
    locationId: shopLocation,
    paidFrom: null,
    billDiscount: 0,
    billTotal: 1000000,
    notes: null,
    lines: [{ itemId: oil, qty: 10000, unitCost: 100000, lineDiscount: 0 }],
  });
  expect(receipt.statusCode, receipt.body).toBe(201);
  const r = receipt.json<{ id: string; rowVersion: string }>();
  expect(
    (await send('POST', `/api/purchasing/receipts/${r.id}/post`, 'fahad', { rowVersion: r.rowVersion }))
      .statusCode,
  ).toBe(200);

  counter = await enroll('counter');
  desk = await enroll('cash_desk');
  first = sale(2);
  raast = sale(1, 'raast');
  voided = sale(3);
  await push(counter, [first, raast, voided]);
  // The first bill pushed again: a duplicate, answered from the inbox and never counted as a new attempt (rule 7).
  await push(counter, [first]);
  await push(counter, [voidOf(voided)]);
  back = noReceiptReturn();
  await push(counter, [back]);
  await push(desk, [openSession(), scan(first)]);
  await postPending(pool, tenantId, { now: () => new Date() });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const range = () => `from=${today()}&to=${today()}`;

describe('the sales register (RPT-01)', () => {
  it('lists every bill, nets the return, leaves the void out of the totals and splits by salesman, counter and tender', async () => {
    const r = await view<SalesRegisterView>(`/api/reports/sales-register?${range()}`);
    expect(r.bills.map((b) => [b.number, b.status, b.total])).toEqual(
      [first, raast, voided, back].map((d) => [
        d.number,
        d === voided ? 'voided' : 'finalized',
        d.amounts.total,
      ]),
    );
    expect(r.bills.find((b) => b.number === voided.number)).toMatchObject({ voidReason: 'wrong_price' });
    expect(r.totals).toEqual({
      bills: 3,
      voided: 1,
      total: 240000 + 120000 - 120000,
      bySalesperson: [{ id: seller, name: 'sara', bills: 3, total: 240000 }],
      byCounter: [{ code: counter.code, bills: 3, total: 240000 }],
      byTender: [
        { code: 'cash', name: expect.any(String) as string, amount: 240000 - 120000 },
        { code: 'raast', name: expect.any(String) as string, amount: 120000 },
      ],
    });
  });

  it('downloads the same bills as CSV', async () => {
    const res = await send('GET', `/api/reports/sales-register?${range()}&format=csv`, 'fahad');
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.body.trim().split('\r\n');
    expect(lines).toHaveLength(1 + 4);
    expect(lines[0]).toMatch(/^number,/);
  });

  it('refuses a cashier, a range over 92 days and a range the wrong way round', async () => {
    expect((await send('GET', `/api/reports/sales-register?${range()}`, 'ali')).statusCode).toBe(403);
    expect(
      (await send('GET', '/api/reports/sales-register?from=2026-01-01&to=2026-04-03', 'fahad')).json(),
    ).toEqual({
      error: 'range_too_long',
    });
    expect(
      (await send('GET', '/api/reports/sales-register?from=2026-02-01&to=2026-01-01', 'fahad')).statusCode,
    ).toBe(400);
  });

  it("never shows another shop's bills", async () => {
    const res = await send('GET', `/api/reports/sales-register?${range()}`, 'fahad', undefined, 'rpt-other');
    expect(res.json<SalesRegisterView>().bills).toEqual([]);
  });
});

describe('overrides, voids and returns (RPT-03, RPT-04)', () => {
  it('lists the void and the return without a receipt, by who asked and who approved', async () => {
    const r = await view<OverridesView>(`/api/reports/overrides?${range()}`);
    expect(r.overrides.map((o) => [o.kind, o.approvedByName]).sort()).toEqual([
      ['no_receipt_return', 'tariq'],
      ['void', 'tariq'],
    ]);
    expect(r.byApprover).toEqual([{ name: 'tariq', count: 2 }]);
  });

  it('lists the void with its reason, and the returned can by reason and condition', async () => {
    const r = await view<VoidsReturnsView>(`/api/reports/voids-returns?${range()}`);
    expect(r.voids).toMatchObject([
      { saleNumber: voided.number, reasonCode: 'wrong_price', approvedByName: 'tariq' },
    ]);
    expect(r.returns).toMatchObject([
      { billNumber: back.number, itemCode: 'OIL001', qty: 1000, amount: 120000, reasonCode: 'changed_mind' },
    ]);
    expect(r.returnsByCondition).toEqual([{ condition: 'resellable', count: 1, amount: 120000 }]);
    expect(r.voidsByReason).toEqual([{ reason: 'wrong_price', count: 1 }]);
  });
});

describe('stock and valuation (RPT-05)', () => {
  it('shows 8 cans at Rs 1,000, equal to the Inventory account', async () => {
    const r = await view<StockView>('/api/reports/stock');
    expect(r.rows).toMatchObject([
      { itemCode: 'OIL001', locationCode: 'SHOP', qty: 8000, avgCost: 100000, value: 800000 },
    ]);
    expect(r.total).toEqual({ qty: 8000, value: 800000 });
    const inventory = (
      await q<{ b: string }>(
        `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM erp.journal_lines l
         JOIN erp.accounts a ON a.id = l.account_id WHERE a.system_role = 'INVENTORY'`,
      )
    )[0]!.b;
    expect(Number(inventory)).toBe(r.total.value);
  });

  it('leaves the value out for someone without cost.view', async () => {
    const r = await view<StockView>('/api/reports/stock', 'noor');
    expect(r.values).toBe(false);
    expect(r.rows[0]).toMatchObject({ qty: 8000, avgCost: null, value: null });
    expect(r.total.value).toBeNull();
  });
});

describe('outstanding and ageing (RPT-06)', () => {
  it("shows the supplier's bill not yet due, equal to Accounts payable", async () => {
    const r = await view<AgeingView>('/api/reports/ageing?side=suppliers');
    expect(r.rows).toMatchObject([{ code: 'S1', balance: 1000000, notDue: 1000000, termsDays: 30 }]);
    expect(r.totals.balance).toBe(r.controlBalance);
  });

  it('has no customers owing: every sale was paid', async () => {
    const r = await view<AgeingView>('/api/reports/ageing?side=customers');
    expect(r.rows).toEqual([]);
    expect(r.controlBalance).toBe(0);
  });
});

describe('exceptions (RPT-10)', () => {
  let id: string;
  beforeAll(async () => {
    id = (
      await q<{ id: string }>(
        `INSERT INTO erp.exceptions (tenant_id, kind, severity, document_type, document_id, device_id, business_date,
           details, created_at, updated_at)
         VALUES ($1, 'negative_stock', 'high', 'sale', $2, $3, $4, '{"item":"OIL001"}', now(), now()) RETURNING id`,
        [tenantId, first.id, counter.deviceId, today()],
      )
    )[0]!.id;
  });

  it('lists an open one with its bill, and counts the open high ones', async () => {
    const r = await view<ExceptionsView>(`/api/reports/exceptions?${range()}&status=open`);
    expect(r.exceptions.find((e) => e.id === id)).toMatchObject({
      kind: 'negative_stock',
      severity: 'high',
      documentNumber: first.number,
      deviceCode: counter.code,
    });
    expect((await view<{ high: number }>('/api/reports/exceptions/open-count')).high).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('the manager reviews it with a note: audited, the exception itself unchanged; a cashier is refused', async () => {
    expect(
      (await send('POST', `/api/reports/exceptions/${id}/review`, 'ali', { status: 'reviewed', note: null }))
        .statusCode,
    ).toBe(403);
    const res = await send('POST', `/api/reports/exceptions/${id}/review`, 'tariq', {
      status: 'reviewed',
      note: 'Counted: 8 on the shelf',
    });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await q<{ kind: string; details: unknown; status: string; review_note: string }>(
      'SELECT kind, details, status, review_note FROM erp.exceptions WHERE id = $1',
      [id],
    );
    expect(row).toEqual({
      kind: 'negative_stock',
      details: { item: 'OIL001' },
      status: 'reviewed',
      review_note: 'Counted: 8 on the shelf',
    });
    expect(
      await q('SELECT 1 FROM erp.audit_log WHERE action = $1 AND entity_id = $2', ['exception.reviewed', id]),
    ).toHaveLength(1);
    const open = await view<ExceptionsView>(`/api/reports/exceptions?${range()}&status=open`);
    expect(open.exceptions.some((e) => e.id === id)).toBe(false);
  });
});

describe('Trace a bill (PLT-12)', () => {
  it('shows the first bill from the counter to the desk and the books, accepted once though pushed twice', async () => {
    const r = await view<BillTraceView>(`/api/support/bills/${encodeURIComponent(first.number)}`);
    expect(r.bill).toMatchObject({ number: first.number, status: 'finalized', handoverStatus: 'received' });
    const steps = r.steps.map((s) => s.step);
    expect(steps).toEqual(expect.arrayContaining(['created', 'accepted', 'posted', 'handed_over']));
    expect(r.steps.find((s) => s.step === 'accepted')!.detail).toMatchObject({
      attempts: 1,
      status: 'accepted',
    });
    expect([...r.steps].sort((a, b) => (a.at < b.at ? -1 : 1))).toEqual(r.steps);
  });

  it('shows the voided bill with its void', async () => {
    const r = await view<BillTraceView>(`/api/support/bills/${encodeURIComponent(voided.number)}`);
    expect(r.steps.map((s) => s.step)).toContain('voided');
  });

  it("is the owner's only, and never finds another shop's bill", async () => {
    expect(
      (await send('GET', `/api/support/bills/${encodeURIComponent(first.number)}`, 'tariq')).statusCode,
    ).toBe(403);
    const other = await send(
      'GET',
      `/api/support/bills/${encodeURIComponent(first.number)}`,
      'fahad',
      undefined,
      'rpt-other',
    );
    expect(other.statusCode).toBe(404);
  });
});

describe('Send diagnostics (PLT-12)', () => {
  const upload = (sentByUserId: string) => ({
    sentByUserId,
    atDevice: new Date().toISOString(),
    health: { outboxCount: 0, appVersion: '0.9.0' },
    events: [
      { at: new Date().toISOString(), kind: 'bill.print_failed', detail: { number: first.number } },
      { at: new Date().toISOString(), kind: 'sync.push', detail: { accepted: 1 } },
    ],
  });
  const fromCounter = (body: unknown, token = counter.token) =>
    app().inject({
      method: 'POST',
      url: '/api/sync/diagnostics',
      headers: { authorization: `Device ${token}` },
      payload: body as Record<string, unknown>,
    });

  it("is stored for the counter, listed on its page, and shows in the bill's trace", async () => {
    const res = await fromCounter(upload(manager));
    expect(res.statusCode, res.body).toBe(201);
    const list = await view<{ diagnostics: DiagnosticsRow[] }>(
      `/api/devices/${counter.deviceId}/diagnostics`,
    );
    expect(list.diagnostics).toMatchObject([{ sentByName: 'tariq', eventCount: 2 }]);
    const trace = await view<BillTraceView>(`/api/support/bills/${encodeURIComponent(first.number)}`);
    expect(trace.steps.find((s) => s.step === 'print_failed')).toMatchObject({ source: 'diagnostics' });
    expect(await q('SELECT 1 FROM erp.audit_log WHERE action = $1', ['diagnostics.sent'])).toHaveLength(1);
  });

  it('is refused from someone who may not manage counters, and without a device token', async () => {
    expect((await fromCounter(upload(seller))).statusCode).toBe(403);
    expect((await fromCounter(upload(manager), 'not-a-token')).statusCode).toBe(401);
  });

  it('is removed after 30 days', async () => {
    await q(`UPDATE erp.device_diagnostics SET received_at = now() - interval '31 days'`);
    await fromCounter(upload(manager));
    const removed = await pruneDiagnostics(pool, tenantId, new Date());
    expect(removed).toBe(1);
    expect(await q('SELECT 1 FROM erp.device_diagnostics')).toHaveLength(1);
  });
});
