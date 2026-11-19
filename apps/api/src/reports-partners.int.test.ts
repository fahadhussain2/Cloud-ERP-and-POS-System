import {
  exportPublicKey,
  generateDeviceKey,
  signCanonical,
  TenantSpec,
  uuidv7,
  type BalanceTrendView,
  type CashFlowView,
  type CollectionsView,
  type DocumentFamily,
  type OverdueView,
  type OverLimitView,
  type PartnerLedgerView,
  type PushDocument,
  type PushRequest,
  type StatementsView,
  type UserActivityView,
} from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import {
  buildCashMovementDocument,
  buildCollectionDocument,
  buildSaleDocument,
  buildSessionDocument,
  buildVoidDocument,
  businessDate,
  money,
  ROLE_TEMPLATES,
  trendDates,
  type Bill,
  type CashMovementDocument,
  type CashSessionDocument,
  type CustomerCollectionDocument,
  type DeskSession,
  type PaymentMethodInfo,
  type Qty,
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

// The customer, supplier and control reports and the cash flow (W2-04 plan; RPT-16, RPT-17, ACC-07; D-116), on a shop
// with known documents. Khan Motors (30 days' terms, a Rs 1,200 limit) buys 2 cans on account 60 days ago and 1 more
// 40 days ago, pays Rs 2,000 into the bank 20 days ago and Rs 500 at the desk today; Butt Autos (no terms, no limit)
// buys 1 can on account 45 days ago and 1 today that is voided. Oil Co's goods: 5 cans on account 50 days ago, 2 paid
// from the bank 10 days ago; Oil Co is paid Rs 3,000 by bank 5 days ago and Rs 300 at the desk today. Today also: a
// cash sale, the drawer opened Rs 15 short, an expense at the desk and one from the bank, cash deposited, a transfer
// between banks with charges, and drawings by voucher. Each report is read under RLS and tied to the books.

type DeviceKeys = Awaited<ReturnType<typeof generateDeviceKey>>;
interface Device {
  token: string;
  deviceId: string;
  code: string;
  keys: DeviceKeys;
  seq: Partial<Record<DocumentFamily, number>>;
}

const SHOP = 'ptn-shop';
const OTHER = 'ptn-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';
const CAN = 120000;
const METHODS: PaymentMethodInfo[] = [
  { code: 'cash', isCash: true, requiresReference: false },
  { code: 'on_account', isCash: false, requiresReference: false },
];
const MANAGER_GRANTS: RoleGrant[] = [{ ...ROLE_TEMPLATES.manager, branchId: null }];
const DESK_GRANTS: RoleGrant[] = [
  {
    permissions: [
      'cash.handover.receive',
      'cash.refund.pay',
      'cash.collection.receive',
      'cash.movement.create',
      'cash.session.close',
    ],
    limits: { maxDiscountBp: 0, voidWindow: 'none' },
    branchId: null,
  },
];

let db: TestDatabase;
let pool: pg.Pool;
let tenantId: string;
let otherId: string;
let branchId: string;
let retail: string;
let oil: string;
let seller: string;
let manager: string;
let cashier: string;
let khan: string;
let butt: string;
let oilCo: string;
let counter: Device;
let desk: Device;
let session: DeskSession;
let voided: SaleDocument;
const account: Record<string, string> = {};
const bank: Record<string, string> = {};
const cookies: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date() });
const today = () => businessDate(Date.now(), 'Asia/Karachi', 4);
const daysAgo = (n: number) =>
  new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

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

const send = async (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  who: string,
  payload?: unknown,
  shop?: string,
) =>
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

async function enroll(kind: 'counter' | 'cash_desk'): Promise<Device> {
  const cookie = await login('fahad');
  const code = (await post('/api/devices/enrollment-codes', { branchId, kind }, cookie)).json<{
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
/** On the device at noon `at` days ago (0: a minute ago). */
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

/** `units` cans of oil, `at` days ago, on `customer`'s account (or in cash for a walk-in). */
function sale(units: number, customer: string | null, at = 0): SaleDocument {
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
        list: money(CAN),
        floor: null,
        unitPrice: money(CAN),
        approval: null,
      },
    ],
    billDiscount: money(0),
    billApproval: null,
  };
  const total = money(units * CAN);
  return buildSaleDocument({
    bill,
    tender: {
      payments: [{ method: customer ? 'on_account' : 'cash', amount: total, reference: null }],
      cashReceived: null,
    },
    methods: METHODS,
    sellerMaxDiscountBp: 0,
    customer: { id: customer, walkinPhone: null },
    credit: customer
      ? {
          account: { creditAllowed: true, creditLimit: money(100_000_000), offlineDailyCap: money(0) },
          balance: money(0),
          balanceAsOf: new Date().toISOString(),
          unsynced: money(0),
          offline: false,
          offlineToday: money(0),
        }
      : null,
    creditApproval: null,
    reissueOf: null,
    context: { ...context(counter, 'S', at), increment: money(100) },
  });
}

const voidOf = (b: SaleDocument): SaleVoidDocument =>
  buildVoidDocument({
    bill: {
      id: b.id,
      number: b.number,
      deviceId: b.deviceId,
      businessDate: b.businessDate,
      total: b.amounts.total,
      cashDue: b.cashDue,
      status: 'finalized',
      payments: b.payments,
    },
    answers: Object.fromEntries(b.payments.map((p) => [p.method, 'not_arrived' as const])),
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

/** The drawer opened with Rs 4,985 where Rs 5,000 stayed: Rs 15 short. */
function openShort(): CashSessionDocument {
  const z = buildSessionDocument({
    event: 'open',
    current: null,
    userId: cashier,
    grants: DESK_GRANTS,
    openingFloat: money(498500),
    floatExpected: money(500000),
    handovers: [],
    context: { ...context(desk, 'Z'), increment: money(100) },
  });
  session = { id: z.id, cashierId: cashier, openingFloat: money(498500), status: 'open' };
  return z;
}

function collect(amount: number, cashMethod: string): CustomerCollectionDocument {
  return buildCollectionDocument({
    session,
    cashierId: cashier,
    grants: DESK_GRANTS,
    branchId,
    increment: money(100),
    customer: { partyId: khan, code: 'KHAN', name: 'Khan Motors', balance: money(0) },
    method: { id: cashMethod, code: 'cash', isCash: true, requiresReference: false, isActive: true },
    amount: money(amount),
    reference: null,
    note: null,
    context: context(desk, 'R'),
  });
}

function cashOut(
  kind: 'expense' | 'supplier_payment' | 'bank_deposit',
  amount: number,
  category: string,
): CashMovementDocument {
  return buildCashMovementDocument({
    session,
    cashierId: cashier,
    grants: DESK_GRANTS,
    branchId,
    increment: money(100),
    kind,
    amount: money(amount),
    expenseCategory: kind === 'expense' ? { id: category, name: 'Tea', isActive: true } : null,
    supplier: kind === 'supplier_payment' ? { partyId: oilCo, code: 'S1', name: 'Oil Co' } : null,
    bankAccount:
      kind === 'bank_deposit' ? { id: bank['hbl']!, name: 'Bank: HBL', kind: 'bank', isActive: true } : null,
    note: 'for the test',
    reference: null,
    expected: money(100_000_000),
    overDrawerConfirmed: false,
    context: context(desk, 'M'),
  });
}

type Pushed =
  SaleDocument | SaleVoidDocument | CashSessionDocument | CustomerCollectionDocument | CashMovementDocument;
async function push(d: Device, docs: Pushed[]) {
  const documents: PushDocument[] = await Promise.all(
    docs.map(async (x) => ({
      id: x.id,
      family: x.family,
      seq: x.seq,
      payload: x,
      signature: await signCanonical(d.keys.privateKey, x),
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
    headers: { authorization: `Device ${d.token}` },
    payload: body as unknown as Record<string, unknown>,
  });
  expect(res.statusCode, res.body).toBe(200);
  for (const r of res.json<{ results: { status: string }[] }>().results) expect(r.status).toBe('accepted');
}

/** The balance of the accounts with these system roles (debit − credit) up to a date. */
const roleBalance = async (role: string, at: string) =>
  Number(
    (
      await q<{ b: string }>(
        `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM erp.journal_lines l
         JOIN erp.journal_entries e ON e.id = l.entry_id JOIN erp.accounts a ON a.id = l.account_id
         WHERE a.system_role = $1 AND e.entry_date <= $2`,
        [role, at],
      )
    )[0]!.b,
  );

/** Cash and bank (the cash book's accounts) up to a date. */
const cashAt = async (at: string) =>
  Number(
    (
      await q<{ b: string }>(
        `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM erp.journal_lines l
         JOIN erp.journal_entries e ON e.id = l.entry_id JOIN erp.accounts a ON a.id = l.account_id
         WHERE e.entry_date <= $1 AND (a.system_role IN ('CASH_DRAWER', 'CASH_IN_TRANSIT', 'CASH_SAFE')
           OR EXISTS (SELECT 1 FROM erp.bank_accounts b WHERE b.gl_account_id = a.id))`,
        [at],
      )
    )[0]!.b,
  );

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
    cashier = await person(c, 'nadia', 'cashier');
    await person(c, 'alia', 'accountant');
    await person(c, 'viewer', null, ['reports.view']);
    oil = (
      await seedCatalog(c, tenantId, [
        { code: 'OIL001', name: 'ENGINE OIL 4L', category: 'OIL', floor: 100000, prices: { RETAIL: CAN } },
      ])
    )['OIL001']!;
    const customer = async (code: string, name: string, terms: number | null, limit: number | null) => {
      const id = (
        await c.query<{ id: string }>(
          'INSERT INTO erp.parties (tenant_id, code, name, phones) VALUES ($1, $2, $3, $4) RETURNING id',
          [tenantId, code, name, ['0300 1234567']],
        )
      ).rows[0]!.id;
      await c.query(
        `INSERT INTO erp.customer_accounts (tenant_id, party_id, price_tier_id, credit_allowed, credit_limit,
           offline_daily_cap, payment_terms_days) VALUES ($1, $2, $3, true, $4, 0, $5)`,
        [tenantId, id, retail, limit, terms],
      );
      return id;
    };
    khan = await customer('KHAN', 'Khan Motors', 30, 120000);
    butt = await customer('BUTT', 'Butt Autos', null, null);
    for (const r of (await c.query<{ id: string; code: string }>('SELECT id, code FROM erp.accounts')).rows)
      account[r.code] = r.id;
    for (const r of (await c.query<{ id: string; code: string }>('SELECT id, code FROM erp.bank_accounts'))
      .rows)
      bank[r.code] = r.id;
  });

  // The opening stock (W1-14), before everything else.
  await seedGeneratedOpening(db.ownerUrl, {
    environment: 'test',
    tenantId,
    now: new Date(`${daysAgo(70)}T12:00:00Z`),
  });

  // Oil Co: 5 cans on account 50 days ago; 2 paid from the bank at once 10 days ago.
  oilCo = (
    await send('POST', '/api/purchasing/suppliers', 'fahad', { code: 'S1', name: 'Oil Co', termsDays: 30 })
  ).json<{ id: string }>().id;
  const shopLocation = (await q<{ id: string }>("SELECT id FROM erp.locations WHERE code = 'SHOP'"))[0]!.id;
  for (const [n, at, paidFrom] of [
    [5, 50, null],
    [2, 10, bank['hbl']!],
  ] as const) {
    const r = await created('/api/purchasing/receipts', {
      supplierId: oilCo,
      billNo: `OC-${at}`,
      billDate: daysAgo(at),
      receivedOn: daysAgo(at),
      locationId: shopLocation,
      paidFrom,
      billDiscount: 0,
      billTotal: n * 100000,
      notes: null,
      lines: [{ itemId: oil, qty: n * 1000, unitCost: 100000, lineDiscount: 0 }],
    });
    await postDraft('/api/purchasing/receipts', r.id, r.rowVersion);
  }

  // The counter: Khan 2 cans 60 days ago and 1 40 days ago; Butt 1 can 45 days ago and 1 today, voided; a cash sale.
  counter = await enroll('counter');
  const bills = [sale(2, khan, 60), sale(1, butt, 45), sale(1, khan, 40), sale(1, butt), sale(1, null)];
  voided = bills[3]!;
  await push(counter, bills);
  await push(counter, [voidOf(voided)]);

  // The bank: Khan pays Rs 2,000 20 days ago; Oil Co is paid Rs 3,000 5 days ago; an expense; a transfer with
  // charges; drawings.
  const categories = await q<{ id: string; code: string }>(
    'SELECT id, code FROM erp.expense_categories ORDER BY code',
  );
  await created('/api/accounting/receipts', {
    customerId: khan,
    bankAccountId: bank['soneri'],
    amount: 200000,
    receivedOn: daysAgo(20),
    reference: 'SON 1',
    note: null,
  });
  await created('/api/purchasing/payments', {
    supplierId: oilCo,
    bankAccountId: bank['hbl'],
    amount: 300000,
    paidOn: daysAgo(5),
    reference: 'CHQ 1',
  });
  await created('/api/accounting/expenses', {
    categoryId: categories[0]!.id,
    paidFrom: bank['hbl'],
    amount: 185000,
    paidOn: today(),
    reference: 'K-Electric',
    note: null,
  });
  await created('/api/accounting/transfers', {
    from: bank['hbl'],
    to: bank['soneri'],
    amount: 100000,
    charges: 500,
    chargesCategoryId: categories[1]!.id,
    movedOn: today(),
    reference: 'IBFT',
    note: null,
  });
  const hblAccount = (
    await q<{ id: string }>('SELECT gl_account_id AS id FROM erp.bank_accounts WHERE code = $1', ['hbl'])
  )[0]!.id;
  const voucher = await created('/api/accounting/vouchers', {
    date: today(),
    narration: 'Drawings',
    lines: [
      { accountId: account['3110'], partyId: null, debit: 100000, credit: 0, memo: null },
      { accountId: hblAccount, partyId: null, debit: 0, credit: 100000, memo: null },
    ],
  });
  const vrv = (await view<{ rowVersion: string }>(`/api/accounting/vouchers/${voucher.id}`)).rowVersion;
  await postDraft('/api/accounting/vouchers', voucher.id, vrv);

  // The desk today: opened short, Khan pays Rs 500, Oil Co gets Rs 300, tea, cash to the bank.
  desk = await enroll('cash_desk');
  const cashMethod = (await q<{ id: string }>("SELECT id FROM erp.payment_methods WHERE code = 'cash'"))[0]!
    .id;
  await push(desk, [openShort()]);
  await push(desk, [
    collect(50000, cashMethod),
    cashOut('supplier_payment', 30000, ''),
    cashOut('expense', 20000, categories[2]!.id),
    cashOut('bank_deposit', 10000, ''),
  ]);

  // A failed sign-in, and a temporary password for Sara (audited, never its hash).
  const failed = await post('/api/auth/login', { tenantCode: SHOP, username: 'sara', password: 'wrong one' });
  expect(failed.statusCode).toBe(401);
  const reset = await send('PUT', `/api/users/${seller}/password`, 'fahad', {
    temporaryPassword: 'another horse battery',
  });
  expect(reset.statusCode, reset.body).toBe(204);

  await postPending(pool, tenantId, { now: () => new Date() });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('the partner ledger and the statement (RPT-16, owner answers 1 and 2)', () => {
  it("opens with the balance before the range and closes on the customer's balance in the books", async () => {
    const r = await view<PartnerLedgerView>(
      `/api/reports/partner-ledger?role=customer&partyId=${khan}&from=${daysAgo(45)}&to=${today()}`,
    );
    expect(r.party).toMatchObject({ code: 'KHAN', termsDays: 30, limit: 120000 });
    expect(r.opening).toBe(2 * CAN);
    expect(r.lines.map((l) => [l.date, l.kind, l.debit, l.credit, l.balance])).toEqual([
      [daysAgo(40), 'sale', CAN, 0, 3 * CAN],
      [daysAgo(20), 'customer_receipt', 0, 200000, 3 * CAN - 200000],
      [today(), 'payment', 0, 50000, 3 * CAN - 250000],
    ]);
    expect(r.closing).toBe(110000);
    expect(r.byKind).toEqual([
      { kind: 'customer_receipt', count: 1, debit: 0, credit: 200000 },
      { kind: 'payment', count: 1, debit: 0, credit: 50000 },
      { kind: 'sale', count: 1, debit: CAN, credit: 0 },
    ]);
    // The oldest bills paid first: the 40-day bill's Rs 1,100 left, 10 days past its due date.
    expect(r.ageing).toEqual({
      balance: 110000,
      notDue: 0,
      days1to30: 110000,
      days31to60: 0,
      days61to90: 0,
      over90: 0,
    });
    expect(r.header.name).toBe(`${SHOP} shop`);
  });

  it("ties every customer's and supplier's closing to the control accounts", async () => {
    let customers = 0;
    for (const id of [khan, butt])
      customers += (
        await view<PartnerLedgerView>(
          `/api/reports/partner-ledger?role=customer&partyId=${id}&from=${daysAgo(90)}&to=${today()}`,
        )
      ).closing;
    expect(customers).toBe(await roleBalance('AR_CONTROL', today()));
    const supplier = await view<PartnerLedgerView>(
      `/api/reports/partner-ledger?role=supplier&partyId=${oilCo}&from=${daysAgo(90)}&to=${today()}`,
    );
    expect(supplier.closing).toBe(500000 - 300000 - 30000);
    expect(supplier.closing).toBe(-(await roleBalance('AP_CONTROL', today())));
    // A supplier's bill is a credit, a payment a debit.
    expect(supplier.lines.find((l) => l.kind === 'supplier_payment')).toMatchObject({
      debit: 300000,
      credit: 0,
    });
    expect(supplier.lines.find((l) => l.date === daysAgo(50))).toMatchObject({ debit: 0, credit: 500000 });
  });

  it('marks the voided bill and its void on screen, and leaves them off the statement', async () => {
    const url = `/api/reports/partner-ledger?role=customer&partyId=${butt}&from=${today()}&to=${today()}`;
    const screen = await view<PartnerLedgerView>(url);
    expect(screen.lines.map((l) => [l.kind, l.voided])).toEqual([
      ['sale', true],
      ['sales_void', true],
    ]);
    const statement = await view<PartnerLedgerView>(`${url}&statement=1&items=1`);
    expect(statement.lines).toEqual([]);
    expect(statement.closing).toBe(screen.closing);
    expect(statement.closing).toBe(CAN);
  });

  it("lists a bill's items on a statement with items", async () => {
    const r = await view<PartnerLedgerView>(
      `/api/reports/partner-ledger?role=customer&partyId=${khan}&from=${daysAgo(60)}&to=${daysAgo(60)}&items=1`,
    );
    expect(r.lines[0]!.items).toEqual([
      { code: 'OIL001', name: 'ENGINE OIL 4L', qty: 2000, price: CAN, total: 2 * CAN },
    ]);
  });

  it('prints a statement for every customer with a balance or a document, by name', async () => {
    const r = await view<StatementsView>(`/api/reports/statements?from=${today()}&to=${today()}`);
    expect(r.statements.map((s) => [s.party.code, s.closing, s.lines.length])).toEqual([
      ['BUTT', CAN, 0],
      ['KHAN', 110000, 1],
    ]);
  });

  it("finds only customers, or only suppliers, for the ledger's picker", async () => {
    const names = async (url: string) =>
      (await view<{ items: { code: string }[] }>(url)).items.map((x) => x.code);
    expect(await names('/api/reports/customers?q=o')).toEqual(['BUTT', 'KHAN']);
    expect(await names('/api/reports/suppliers?q=o')).toEqual(['S1']);
    expect(await names('/api/reports/parties?q=o')).toEqual(['BUTT', 'KHAN', 'S1']);
  });

  it('goes back a year at most, and downloads as CSV', async () => {
    const base = `/api/reports/partner-ledger?role=customer&partyId=${khan}`;
    const long = await send('GET', `${base}&from=${daysAgo(366)}&to=${today()}`, 'fahad');
    expect(long.statusCode).toBe(400);
    expect(long.json()).toEqual({ error: 'range_too_long' });
    const res = await send('GET', `${base}&from=${daysAgo(90)}&to=${today()}&format=csv`, 'fahad');
    expect(res.statusCode).toBe(200);
    const rows = res.body.trim().split('\r\n');
    expect(rows[0]).toBe('customer,name,date,kind,number,memo,debit,credit,balance');
    expect(rows.at(-1)).toBe('KHAN,Khan Motors,,closing,,,360000,250000,110000');
  });
});

describe('the balance trend (RPT-16, owner answer 3)', () => {
  it("shows each party's balance at the legacy points, totals equal to the control account", async () => {
    const r = await view<BalanceTrendView>(`/api/reports/balance-trend?role=customer`);
    expect(r.dates).toEqual(trendDates(today()));
    const k = r.rows.find((x) => x.code === 'KHAN')!;
    // Today; 15 days ago (after the bank receipt); a month ago; 2 months ago (after the first bill, 60 days ago? only
    // when the month is shorter); 3 and 6 months ago: before go-live (the opening was 70 days ago).
    expect(k.balances[0]).toBe(110000);
    expect(k.balances[1]).toBe(160000);
    expect(k.balances[2]).toBe(3 * CAN);
    expect(k.balances.slice(4)).toEqual([null, null]);
    expect(k.change).toBe(110000 - 3 * CAN);
    expect(r.since).toBe(daysAgo(70));
    for (const [i, d] of r.dates.entries())
      expect(r.totals[i]).toBe(d < daysAgo(70) ? null : await roleBalance('AR_CONTROL', d));
    expect(r.control).toEqual(r.totals);
  });
});

describe('overdue and over the limit (RPT-17, owner answer 4)', () => {
  it('lists customers overdue by more than N days, the oldest bills paid first', async () => {
    const thirty = await view<OverdueView>('/api/reports/overdue');
    expect(thirty.days).toBe(30);
    expect(thirty.rows.map((r) => [r.code, r.overdue, r.oldestDate, r.oldestLate])).toEqual([
      ['BUTT', CAN, daysAgo(45), 45],
    ]);
    const all = await view<OverdueView>('/api/reports/overdue?days=0');
    // The most overdue first.
    expect(all.rows.map((r) => [r.code, r.overdue, r.oldestLate])).toEqual([
      ['BUTT', CAN, 45],
      ['KHAN', 110000, 10],
    ]);
    expect(all.rows[1]!.lastPayment).toEqual({ date: today(), amount: 50000 });
    expect(all.rows[1]).toMatchObject({ limit: 120000, termsDays: 30, phones: ['0300 1234567'] });
    expect((await send('GET', '/api/reports/overdue?days=7', 'fahad')).statusCode).toBe(400);
  });

  it("counts a voided bill's void against that bill, not the oldest one", async () => {
    // Butt Autos: the 45-day bill is still owed; today's bill and its void cancel each other out.
    const ageing = await view<{
      rows: { code: string; days1to30: number; days31to60: number; notDue: number }[];
    }>('/api/reports/ageing?side=customers');
    expect(ageing.rows.find((r) => r.code === 'BUTT')).toMatchObject({
      notDue: 0,
      days1to30: 0,
      days31to60: CAN,
    });
    const statement = await view<PartnerLedgerView>(
      `/api/reports/partner-ledger?role=customer&partyId=${butt}&from=${today()}&to=${today()}&statement=1`,
    );
    expect(statement.ageing).toMatchObject({ notDue: 0, days31to60: CAN });
  });

  it('agrees with the ageing report at 30 days', async () => {
    const ageing = await view<{
      rows: { code: string; days31to60: number; days61to90: number; over90: number }[];
    }>('/api/reports/ageing?side=customers');
    const overdue = await view<OverdueView>('/api/reports/overdue?days=30');
    for (const a of ageing.rows)
      expect(overdue.rows.find((r) => r.code === a.code)?.overdue ?? 0).toBe(
        a.days31to60 + a.days61to90 + a.over90,
      );
  });

  it('lists a customer within 10% of their limit, not one without a limit', async () => {
    const r = await view<OverLimitView>('/api/reports/over-limit');
    expect(r.withLimit).toBe(1);
    expect(r.rows.map((x) => [x.code, x.state, x.balance, x.left])).toEqual([
      ['KHAN', 'near', 110000, 10000],
    ]);
  });
});

describe('collections and payments (RPT-17, owner answer 5)', () => {
  it("lists money received and ties it to the customers' ledger", async () => {
    const r = await view<CollectionsView>(`/api/reports/collections?from=${daysAgo(60)}&to=${today()}`);
    expect(r.rows.map((x) => [x.date, x.kind, x.partyCode, x.amount, x.counter !== null])).toEqual([
      [daysAgo(20), 'customer_receipt', 'KHAN', 200000, false],
      [today(), 'payment', 'KHAN', 50000, true],
    ]);
    expect(r.total).toBe(250000);
    expect(r.byPerson.find((p) => p.name === 'Nadia')).toEqual({ name: 'Nadia', count: 1, amount: 50000 });
    const [tie] = await q<{ s: string }>(
      `SELECT (-sum(amount))::text AS s FROM erp.party_ledger_entries
       WHERE role = 'customer' AND source_type IN ('payment', 'customer_receipt') AND entry_date BETWEEN $1 AND $2`,
      [daysAgo(60), today()],
    );
    expect(r.total).toBe(Number(tie!.s));
  });

  it("lists money paid to suppliers and ties it to the suppliers' ledger", async () => {
    const r = await view<CollectionsView>(
      `/api/reports/collections?side=paid&from=${daysAgo(60)}&to=${today()}`,
    );
    expect(r.rows.map((x) => [x.date, x.kind, x.amount])).toEqual([
      [daysAgo(10), 'goods_receipt', 200000],
      [daysAgo(5), 'supplier_payment', 300000],
      [today(), 'cash_movement', 30000],
    ]);
    const [tie] = await q<{ s: string }>(
      `SELECT (-sum(amount))::text AS s FROM erp.party_ledger_entries
       WHERE role = 'supplier' AND amount < 0 AND entry_date BETWEEN $1 AND $2
         AND source_type IN ('supplier_payment', 'cash_movement', 'goods_receipt')`,
      [daysAgo(60), today()],
    );
    expect(r.total).toBe(Number(tie!.s));
  });

  it('keeps to 92 days, and the paid side needs cost.view', async () => {
    const long = await send('GET', `/api/reports/collections?from=${daysAgo(92)}&to=${today()}`, 'fahad');
    expect(long.json()).toEqual({ error: 'range_too_long' });
    expect((await send('GET', '/api/reports/collections?side=paid', 'viewer')).statusCode).toBe(403);
    expect((await send('GET', '/api/reports/collections', 'viewer')).statusCode).toBe(200);
  });
});

describe('user activity (RPT-17, owner answer 6)', () => {
  it('shows who did what, a bill once, the import never, a password never', async () => {
    const r = await view<UserActivityView>(`/api/reports/user-activity?from=${daysAgo(90)}&to=${today()}`);
    const rows = r.rows;
    expect(
      rows.some((x) => x.action === 'login.failed' && x.userName === 'Sara' && x.kind === 'sign_in'),
    ).toBe(true);
    expect(rows.some((x) => x.action === 'password.set_by_admin' && x.kind === 'sign_in')).toBe(true);
    expect(rows.some((x) => x.action === 'sale.voided' && x.kind === 'sales')).toBe(true);
    const receipt = rows.find((x) => x.entity === 'customer_receipts')!;
    const [owner] = await q<{ id: string }>("SELECT id FROM erp.users WHERE username = 'fahad'");
    expect(receipt).toMatchObject({ userId: owner!.id, kind: 'money', action: 'create', device: null });
    expect(receipt.label).toMatch(/^CR/);
    expect(rows.some((x) => x.entity === 'sales_lines' || x.entity === 'sales_payments')).toBe(false);
    expect(JSON.stringify(rows)).not.toMatch(/password_hash|pin_verifier/);
    // Newest first; filtered by kind and by user.
    expect([...rows].sort((a, b) => (a.at < b.at ? 1 : -1)).map((x) => x.at)).toEqual(rows.map((x) => x.at));
    const signIns = await view<UserActivityView>(`/api/reports/user-activity?kind=sign_in&userId=${seller}`);
    expect(signIns.rows.length).toBeGreaterThan(0);
    expect(signIns.rows.every((x) => x.kind === 'sign_in' && x.userId === seller)).toBe(true);
  });

  it('is for the owner only', async () => {
    expect((await send('GET', '/api/reports/user-activity', 'tariq')).statusCode).toBe(403);
    expect((await send('GET', '/api/reports/user-activity', 'alia')).statusCode).toBe(403);
  });
});

describe('the cash flow (ACC-07, owner answer 7)', () => {
  it('ties every month to the cash book, by what the money was for, transfers left out', async () => {
    const r = await view<CashFlowView>(`/api/reports/cash-flow?from=${daysAgo(60)}&to=${today()}`, 'alia');
    for (const col of r.columns) {
      expect(col.opening).toBe(
        await cashAt(new Date(Date.parse(`${col.from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)),
      );
      expect(col.closing).toBe(await cashAt(col.to));
    }
    const total = (cls: string) => r.rows.filter((x) => x.cls === cls).reduce((t, x) => t + x.total, 0);
    expect(total('sales')).toBe(CAN);
    expect(total('customers')).toBe(250000);
    expect(total('suppliers')).toBe(-(200000 + 300000 + 30000));
    expect(total('expenses')).toBe(-(185000 + 20000 + 500));
    expect(r.rows.filter((x) => x.cls === 'expenses').every((x) => x.account !== null)).toBe(true);
    expect(total('owner')).toBe(-100000);
    expect(total('shortOver')).toBe(-1500);
    expect(total('other')).toBe(0);
    expect(r.total.closing - r.total.opening).toBe(r.total.net);
    expect(r.total.net).toBe(CAN + 250000 - 530000 - 205500 - 100000 - 1500);
  });

  it('is for the financial reports, and downloads as CSV', async () => {
    expect((await send('GET', '/api/reports/cash-flow', 'tariq')).statusCode).toBe(403);
    const res = await send(
      'GET',
      `/api/reports/cash-flow?from=${daysAgo(60)}&to=${today()}&format=csv`,
      'alia',
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.split('\r\n')[1]).toMatch(/^opening,,/);
  });
});

describe('who may read them', () => {
  it("never shows another shop's parties, refuses a cashier, and needs cost.view for suppliers", async () => {
    const other = await view<OverdueView>('/api/reports/overdue?days=0', 'fahad', OTHER);
    expect(other.rows).toEqual([]);
    const theirs = await send(
      'GET',
      `/api/reports/partner-ledger?role=customer&partyId=${khan}`,
      'fahad',
      undefined,
      OTHER,
    );
    expect(theirs.json()).toEqual({ error: 'not_found' });
    expect((await send('GET', '/api/reports/overdue', 'nadia')).statusCode).toBe(403);
    const supplier = await send(
      'GET',
      `/api/reports/partner-ledger?role=supplier&partyId=${oilCo}`,
      'viewer',
    );
    expect(supplier.statusCode).toBe(403);
    expect((await send('GET', `/api/reports/balance-trend?role=supplier`, 'viewer')).statusCode).toBe(403);
  });
});

describe('a year of a busy shop', () => {
  it('answers each report in under 2 s, and 131 statements in under 5 s', async () => {
    // Straight into the other shop's books: 300 cash bills a day, 100 bills a day on 131 customers' accounts, 10
    // collections a day, and 500,000 audit rows (catalog edits) over the year.
    const owner = new pg.Client({ connectionString: db.ownerUrl });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query("SELECT set_config('app.tenant_id', $1, true)", [otherId]);
      const one = async (sql: string) => (await owner.query<{ id: string }>(sql, [otherId])).rows[0]!.id;
      const branch = await one('SELECT id FROM erp.branches WHERE tenant_id = $1');
      const tier = await one("SELECT id FROM erp.price_tiers WHERE tenant_id = $1 AND code = 'RETAIL'");
      const user = await one('SELECT id FROM erp.users WHERE tenant_id = $1 LIMIT 1');
      const drawer = await one(
        "SELECT id FROM erp.accounts WHERE tenant_id = $1 AND system_role = 'CASH_DRAWER'",
      );
      const sales = await one("SELECT id FROM erp.accounts WHERE tenant_id = $1 AND system_role = 'SALES'");
      const ar = await one("SELECT id FROM erp.accounts WHERE tenant_id = $1 AND system_role = 'AR_CONTROL'");
      await owner.query(
        `INSERT INTO erp.parties (tenant_id, code, name, created_at, updated_at, row_version, txid)
         SELECT $1::uuid, 'C' || lpad(g::text, 4, '0'), 'Customer ' || g, now(), now(), 1, pg_current_xact_id()
         FROM generate_series(1, 131) g`,
        [otherId],
      );
      await owner.query(
        `INSERT INTO erp.customer_accounts (tenant_id, party_id, price_tier_id, credit_allowed, credit_limit,
           offline_daily_cap, created_at, updated_at, row_version, txid)
         SELECT $1::uuid, p.id, $2::uuid, true, CASE WHEN p.code < 'C0045' THEN 5000000 END, 0, now(), now(), 1,
           pg_current_xact_id()
         FROM erp.parties p WHERE p.tenant_id = $1`,
        [otherId, tier],
      );
      await owner.query(
        `INSERT INTO erp.postings (tenant_id, seq, source_type, source_id, entry_date, posted_at, context)
         SELECT $1::uuid, g + 1, 'opening', erp.uuid_v7(), current_date - 364 + g, now(), '{}'
         FROM generate_series(0, 364) g`,
        [otherId],
      );
      // 300 cash bills and 10 collections a day: one journal entry each.
      await owner.query(
        `CREATE TEMP TABLE gen_entries ON COMMIT DROP AS
         SELECT erp.uuid_v7() AS id, n, (n - 1) / 310 AS day, ((n - 1) % 310) >= 300 AS collection
         FROM generate_series(1, 365 * 310) n`,
      );
      await owner.query(
        `INSERT INTO erp.journal_entries (id, tenant_id, number, entry_date, source_type, source_id, posting_seq,
           posted_at)
         SELECT g.id, $1, 'JG' || g.n, current_date - 364 + g.day, CASE WHEN g.collection THEN 'payment' ELSE 'sale' END,
           erp.uuid_v7(), g.day + 1, now()
         FROM gen_entries g`,
        [otherId],
      );
      await owner.query(
        `INSERT INTO erp.journal_lines (tenant_id, entry_id, line_no, account_id, party_id, branch_id, debit, credit)
         SELECT $1::uuid, g.id, 1, $3::uuid, NULL::uuid, $2::uuid, 50000, 0 FROM gen_entries g
         UNION ALL
         SELECT $1::uuid, g.id, 2, CASE WHEN g.collection THEN $5::uuid ELSE $4::uuid END, NULL::uuid, $2::uuid, 0, 50000 FROM gen_entries g`,
        [otherId, branch, drawer, sales, ar],
      );
      // 100 bills a day on account and the 10 collections, in the customers' sub-ledger.
      await owner.query(
        `INSERT INTO erp.party_ledger_entries (tenant_id, posting_seq, party_id, role, entry_date, due_date, amount,
           source_type, source_id, posted_at)
         SELECT $1::uuid, d + 1, p.id, 'customer', current_date - 364 + d, current_date - 364 + d,
           CASE WHEN k < 100 THEN 50000 ELSE -400000 END, CASE WHEN k < 100 THEN 'sale' ELSE 'payment' END,
           erp.uuid_v7(), now()
         FROM generate_series(0, 364) d CROSS JOIN generate_series(0, 109) k
         JOIN (SELECT id, row_number() OVER (ORDER BY code) - 1 AS r FROM erp.parties WHERE tenant_id = $1) p
           ON p.r = (d * 110 + k) % 131`,
        [otherId],
      );
      await owner.query(
        `INSERT INTO erp.audit_log (tenant_id, at, user_id, action, entity, entity_id, before, after)
         SELECT $1::uuid, now() - (g % 365) * interval '1 day' - (g % 600) * interval '1 minute', $2::uuid, 'update',
           'item_prices', erp.uuid_v7(), jsonb_build_object('price', g, 'row_version', 1),
           jsonb_build_object('price', g + 100, 'row_version', 2)
         FROM generate_series(1, 500000) g`,
        [otherId, user],
      );
      // Statistics before the commit: each journal line's balance check runs then, on a plan made for these sizes.
      await owner.query('ANALYZE erp.journal_entries, erp.journal_lines');
      await owner.query('COMMIT');
      await owner.query(
        'ANALYZE erp.journal_entries, erp.journal_lines, erp.party_ledger_entries, erp.audit_log, erp.parties',
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
    const year = `from=${daysAgo(364)}&to=${today()}`;
    const quarter = `from=${daysAgo(91)}&to=${today()}`;
    const [someone] = await q<{ id: string }>("SELECT id FROM erp.parties WHERE code = 'C0001'", [], otherId);
    const ledger = await timed<PartnerLedgerView>(
      `/api/reports/partner-ledger?role=customer&partyId=${someone!.id}&${year}`,
    );
    const statements = await timed<StatementsView>(
      `/api/reports/statements?from=${daysAgo(30)}&to=${today()}`,
    );
    const trend = await timed<BalanceTrendView>('/api/reports/balance-trend?role=customer');
    const overdue = await timed<OverdueView>('/api/reports/overdue');
    const limits = await timed<OverLimitView>('/api/reports/over-limit');
    const activity = await timed<UserActivityView>(`/api/reports/user-activity?${quarter}`);
    const flow = await timed<CashFlowView>(`/api/reports/cash-flow?${year}`);
    expect(ledger.body.lines.length).toBeGreaterThan(250);
    expect(statements.body.statements).toHaveLength(131);
    expect(trend.body.rows).toHaveLength(131);
    expect(limits.body.withLimit).toBe(44);
    expect(activity.body.rows).toHaveLength(2000);
    expect(activity.body.count).toBeGreaterThan(100_000);
    expect(flow.body.total.net).toBe(365 * 310 * 50000);
    const times = {
      ledger: ledger.ms,
      trend: trend.ms,
      overdue: overdue.ms,
      limits: limits.ms,
      activity: activity.ms,
      flow: flow.ms,
    };
    console.log('W2-04 timings (ms):', { ...times, statements: statements.ms });
    for (const [name, ms] of Object.entries(times)) expect(ms, name).toBeLessThan(2000);
    expect(statements.ms).toBeLessThan(5000);
  }, 300_000);
});
