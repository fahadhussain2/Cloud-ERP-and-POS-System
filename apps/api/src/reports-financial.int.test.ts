import {
  exportPublicKey,
  generateDeviceKey,
  signCanonical,
  TenantSpec,
  uuidv7,
  type AccountBalanceRow,
  type AgeingView,
  type BalanceSheetView,
  type CashBookView,
  type DayBookView,
  type DocumentFamily,
  type ExpensesView,
  type ProfitLossView,
  type PushDocument,
  type PushRequest,
  type StockView,
  type TrialBalanceView,
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
  fiscalYearOf,
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

// The financial statements and the day book (W2-01 plan; ACC-07, RPT-11; D-116), on a shop with a known month: the
// opening stock (W1-14), a goods receipt on the supplier's account and a purchase return, counter sales (one on a
// customer's account) with a void and a return, a stock adjustment, an expense, a customer's bank receipt, a supplier
// payment, a journal voucher and its reversal. Each statement is read under RLS with reports.financial and tied to the
// numbers the shop already has: W1-19's account balances, W1-20's stock value and ageing.

type DeviceKeys = Awaited<ReturnType<typeof generateDeviceKey>>;
interface Device {
  token: string;
  deviceId: string;
  code: string;
  keys: DeviceKeys;
  seq: Partial<Record<DocumentFamily, number>>;
}

const SHOP = 'fin-shop';
const OTHER = 'fin-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';
const METHODS: PaymentMethodInfo[] = [
  { code: 'cash', isCash: true, requiresReference: false },
  { code: 'raast', isCash: false, requiresReference: true },
  { code: 'on_account', isCash: false, requiresReference: false },
];
const MANAGER_GRANTS: RoleGrant[] = [{ ...ROLE_TEMPLATES.manager, branchId: null }];

let db: TestDatabase;
let pool: pg.Pool;
let tenantId: string;
let otherId: string;
let branchId: string;
let seller: string;
let manager: string;
let retail: string;
let oil: string;
let customer: string;
let counter: Device;
const account: Record<string, string> = {};
const cookies: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date() });
const today = () => businessDate(Date.now(), 'Asia/Karachi', 4);
const monthStart = () => `${today().slice(0, 8)}01`;

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

async function person(c: pg.ClientBase, username: string, template: string) {
  const id = (
    await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, email, password_hash)
       VALUES ($1, $2, $2, $3, $4) RETURNING id`,
      [tenantId, username, `${username}@example.test`, await hashPassword(PASSWORD)],
    )
  ).rows[0]!.id;
  await c.query(
    `INSERT INTO erp.user_roles (tenant_id, user_id, role_id, branch_id)
     SELECT $1, $2, id, NULL FROM erp.roles WHERE template_key = $3`,
    [tenantId, id, template],
  );
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

/** `units` cans of oil at Rs 1,200, in cash, by Raast or on the customer's account. */
function sale(units: number, how: 'cash' | 'raast' | 'account' = 'cash'): SaleDocument {
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
  const total = money(units * 120000);
  return buildSaleDocument({
    bill,
    tender: {
      payments: [
        {
          method: how === 'account' ? 'on_account' : how,
          amount: total,
          reference: how === 'raast' ? 'RAAST1' : null,
        },
      ],
      cashReceived: null,
    },
    methods: METHODS,
    sellerMaxDiscountBp: 0,
    customer: { id: how === 'account' ? customer : null, walkinPhone: null },
    credit:
      how === 'account'
        ? {
            account: { creditAllowed: true, creditLimit: money(10_000_000), offlineDailyCap: money(0) },
            balance: money(0),
            balanceAsOf: new Date().toISOString(),
            unsynced: money(0),
            offline: false,
            offlineToday: money(0),
          }
        : null,
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

function noReceiptReturn(): ReturnDocument {
  const bill = addReturn(emptyBill(seller, retail), {
    source: { kind: 'none', ref: '1' },
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

async function push(docs: (SaleDocument | SaleVoidDocument | ReturnDocument)[]) {
  const documents: PushDocument[] = await Promise.all(
    docs.map(async (d) => ({
      id: d.id,
      family: d.family,
      seq: d.seq,
      payload: d,
      signature: await signCanonical(counter.keys.privateKey, d),
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
    headers: { authorization: `Device ${counter.token}` },
    payload: body as unknown as Record<string, unknown>,
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Posts a back-office draft (receipt, return, adjustment) by its rowVersion, as the owner. */
async function postDraft(base: string, id: string, rowVersion: string) {
  const res = await send('POST', `${base}/${id}/post`, 'fahad', { rowVersion });
  expect(res.statusCode, res.body).toBe(200);
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
    await person(c, 'alia', 'accountant');
    oil = (
      await seedCatalog(c, tenantId, [
        { code: 'OIL001', name: 'ENGINE OIL 4L', category: 'OIL', floor: 100000, prices: { RETAIL: 120000 } },
      ])
    )['OIL001']!;
    customer = (
      await c.query<{ id: string }>(
        "INSERT INTO erp.parties (tenant_id, code, name) VALUES ($1, 'KHAN', 'Khan Motors') RETURNING id",
        [tenantId],
      )
    ).rows[0]!.id;
    await c.query(
      `INSERT INTO erp.customer_accounts (tenant_id, party_id, price_tier_id, credit_allowed, credit_limit,
         offline_daily_cap, payment_terms_days) VALUES ($1, $2, $3, true, 10000000, 0, 30)`,
      [tenantId, customer, retail],
    );
    for (const r of (await c.query<{ id: string; code: string }>('SELECT id, code FROM erp.accounts')).rows)
      account[r.code] = r.id;
  });

  // The opening stock (W1-14): the oil in Shop at 70% of Retail.
  await seedGeneratedOpening(db.ownerUrl, { environment: 'test', tenantId });

  // 10 cans at Rs 1,000 on the supplier's account; 1 sent back.
  const supplier = (
    await send('POST', '/api/purchasing/suppliers', 'fahad', { code: 'S1', name: 'Oil Co', termsDays: 30 })
  ).json<{ id: string }>().id;
  const shopLocation = (await q<{ id: string }>("SELECT id FROM erp.locations WHERE code = 'SHOP'"))[0]!.id;
  const receipt = await created('/api/purchasing/receipts', {
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
  await postDraft('/api/purchasing/receipts', receipt.id, receipt.rowVersion);
  const line = (
    await view<{ lines: { id: string; itemId: string; netUnitCost: number }[] }>(
      `/api/purchasing/receipts/${receipt.id}`,
    )
  ).lines[0]!;
  const back = await created('/api/purchasing/returns', {
    supplierId: supplier,
    goodsReceiptId: receipt.id,
    locationId: shopLocation,
    returnedOn: today(),
    reason: 'damaged',
    note: null,
    lines: [{ itemId: oil, receiptLineId: line.id, qty: 1000, unitCost: line.netUnitCost }],
  });
  const backRv = (
    await view<{ purchaseReturn: { rowVersion: string } }>(`/api/purchasing/returns/${back.id}`)
  ).purchaseReturn.rowVersion;
  await postDraft('/api/purchasing/returns', back.id, backRv);

  // On the counter: 2 cans cash, 1 by Raast, 1 on Khan Motors' account, 3 cash then voided; 1 can back.
  counter = await enroll();
  const bills = [sale(2), sale(1, 'raast'), sale(1, 'account'), sale(3)];
  const voided = bills[3]!;
  await push(bills);
  await push([voidOf(voided)]);
  await push([noReceiptReturn()]);

  // A can found damaged.
  const adjustment = await created('/api/inventory/adjustments', {
    locationId: shopLocation,
    adjustedOn: today(),
    reason: 'damaged',
    note: null,
    lines: [{ itemId: oil, qty: -1000 }],
  });
  await postDraft('/api/inventory/adjustments', adjustment.id, adjustment.rowVersion);

  // Money: an expense from the bank, Khan Motors pays by bank, the supplier is paid part.
  const bank = (await q<{ id: string }>('SELECT id FROM erp.bank_accounts ORDER BY code LIMIT 1'))[0]!.id;
  const category = (
    await q<{ id: string }>('SELECT id FROM erp.expense_categories ORDER BY code LIMIT 1')
  )[0]!.id;
  await created('/api/accounting/expenses', {
    categoryId: category,
    paidFrom: bank,
    amount: 185000,
    paidOn: today(),
    reference: 'K-Electric',
    note: null,
  });
  await created('/api/accounting/receipts', {
    customerId: customer,
    bankAccountId: bank,
    amount: 50000,
    receivedOn: today(),
    reference: 'HBL 1',
    note: null,
  });
  await created('/api/purchasing/payments', {
    supplierId: supplier,
    bankAccountId: bank,
    amount: 400000,
    paidOn: today(),
    reference: 'CHQ 1',
  });

  // A voucher posted by mistake, then reversed.
  const voucher = await created('/api/accounting/vouchers', {
    date: today(),
    narration: 'Wrong month',
    lines: [
      { accountId: account['3300'], partyId: null, debit: 7000, credit: 0, memo: null },
      { accountId: account['3100'], partyId: null, debit: 0, credit: 7000, memo: null },
    ],
  });
  const vrv = (await view<{ rowVersion: string }>(`/api/accounting/vouchers/${voucher.id}`)).rowVersion;
  await postDraft('/api/accounting/vouchers', voucher.id, vrv);
  await created('/api/accounting/reverse', { type: 'journal_voucher', id: voucher.id, date: today() });

  await postPending(pool, tenantId, { now: () => new Date() });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const range = () => `from=${monthStart()}&to=${today()}`;
const balancesAt = async (at: string) =>
  new Map(
    (await view<AccountBalanceRow[]>(`/api/accounting/accounts?at=${at}`)).map((a) => [a.id, a.balance]),
  );

describe('the trial balance (ACC-07)', () => {
  it('balances, and every closing equals the account balance on Accounts (W1-19)', async () => {
    const tb = await view<TrialBalanceView>(`/api/reports/trial-balance?${range()}&empty=show`);
    expect(tb.balanced).toBe(true);
    expect(tb.totals.movement.debit).toBeGreaterThan(0);
    const balances = await balancesAt(today());
    for (const r of tb.rows)
      expect([r.code, r.closing.debit - r.closing.credit]).toEqual([r.code, balances.get(r.id) ?? 0]);
  });

  it('shows groups only, and hides the empty accounts unless asked', async () => {
    const all = await view<TrialBalanceView>(`/api/reports/trial-balance?${range()}&empty=show`);
    const used = await view<TrialBalanceView>(`/api/reports/trial-balance?${range()}`);
    const groups = await view<TrialBalanceView>(`/api/reports/trial-balance?${range()}&level=groups`);
    expect(used.rows.length).toBeLessThan(all.rows.length);
    expect(groups.rows.every((r) => r.group || r.depth === 0)).toBe(true);
    expect(groups.totals).toEqual(used.totals);
  });

  it('downloads the same rows and totals as CSV', async () => {
    const tb = await view<TrialBalanceView>(`/api/reports/trial-balance?${range()}`);
    const res = await send('GET', `/api/reports/trial-balance?${range()}&format=csv`, 'fahad');
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.trim().split('\r\n');
    expect(lines).toHaveLength(tb.rows.length + 2);
    expect(lines.at(-1)).toBe(
      [
        '',
        'total',
        '',
        tb.totals.opening.debit,
        tb.totals.opening.credit,
        tb.totals.movement.debit,
        tb.totals.movement.credit,
        tb.totals.closing.debit,
        tb.totals.closing.credit,
      ].join(','),
    );
  });
});

describe('the profit and loss and the balance sheet (ACC-07)', () => {
  const yearStart = async () => {
    const m = (await q<{ m: number }>('SELECT fiscal_year_start_month AS m FROM erp.tenants'))[0]!.m;
    return fiscalYearOf(today(), m).start;
  };

  it("the year's net profit is the balance sheet's profit for the year, and the balance sheet balances", async () => {
    const pl = await view<ProfitLossView>(
      `/api/reports/profit-loss?from=${await yearStart()}&to=${today()}&compare=none`,
    );
    const bs = await view<BalanceSheetView>(`/api/reports/balance-sheet?at=${today()}&compareAt=none`);
    expect(pl.revenue.total[0]).toBe(4 * 120000 - 120000);
    expect(pl.netProfit).toEqual(bs.profitForYear);
    expect(bs.difference).toEqual([0]);
    expect(bs.assets.total[0]).toBe(bs.liabilitiesAndEquity[0]);
  });

  it('the stock and purchases panel agrees with the cost of goods sold', async () => {
    const pl = await view<ProfitLossView>(`/api/reports/profit-loss?${range()}`);
    expect(pl.stock.difference).toBe(0);
    expect(pl.stock.stockUsed).toBeGreaterThan(0);
    expect(pl.stock.purchases).toBe(1000000);
    expect(pl.stock.purchaseReturns).toBeLessThan(0);
    expect(pl.stock.adjustments).toBeLessThan(0);
  });

  it('compares with the previous period, the same period last year, or month by month', async () => {
    const prev = await view<ProfitLossView>(`/api/reports/profit-loss?${range()}`);
    expect(prev.compare).toBe('previous');
    expect(prev.periods).toHaveLength(2);
    expect(prev.netProfit[1]).toBe(0);
    const months = await view<ProfitLossView>(
      `/api/reports/profit-loss?from=${await yearStart()}&to=${today()}&compare=months`,
    );
    expect(months.periods.at(-1)!.to).toBe(today());
    expect(months.netProfit.at(-1)).toBe(prev.netProfit[0]);
  });

  it('Inventory equals the stock value, and the customer and supplier accounts equal the ageing', async () => {
    const bs = await view<BalanceSheetView>(`/api/reports/balance-sheet?at=${today()}`);
    expect(bs.columns).toHaveLength(2);
    const amount = (role: string) =>
      [...bs.assets.rows, ...bs.liabilities.rows].find((r) => r.role === role)?.amounts[0] ?? 0;
    // Inventory is the stock ledger's value to the paisa (rule 4), and so is the stock report since W2-02 (owner
    // answer 2): it no longer values each item at its rounded average cost.
    const [{ value }] = (await q<{ value: string }>(
      'SELECT sum(value_delta)::text AS value FROM erp.stock_movements',
    )) as [{ value: string }];
    expect(amount('INVENTORY')).toBe(Number(value));
    const stock = await view<StockView>('/api/reports/stock');
    expect(stock.total.value).toBe(amount('INVENTORY'));
    const customers = await view<AgeingView>('/api/reports/ageing?side=customers');
    const suppliers = await view<AgeingView>('/api/reports/ageing?side=suppliers');
    expect(amount('AR_CONTROL')).toBe(customers.totals.balance);
    expect(amount('AP_CONTROL')).toBe(suppliers.totals.balance);
    expect(suppliers.totals.balance).toBe(900000 - 400000);
  });

  it('the expenses by month add up to the profit and loss expenses', async () => {
    const pl = await view<ProfitLossView>(`/api/reports/profit-loss?${range()}&compare=none`);
    const ex = await view<ExpensesView>(`/api/reports/expenses?${range()}`);
    expect(ex.months).toHaveLength(1);
    expect(ex.total.at(-1)).toBe(pl.expenses.total[0]);
  });
});

describe('the cash book (ACC-07)', () => {
  it("each cash and bank account's closing is its balance, and a transfer between them shows in both", async () => {
    const book = await view<CashBookView>(`/api/reports/cash-book?${range()}`);
    const balances = await balancesAt(today());
    expect(book.accounts.length).toBeGreaterThanOrEqual(4);
    for (const a of book.accounts) expect([a.code, a.closing]).toEqual([a.code, balances.get(a.id) ?? 0]);
    const bank = book.accounts.find((a) => a.lines.some((l) => l.sourceType === 'expense'))!;
    expect(bank.out).toBe(185000 + 400000);
    const one = await view<CashBookView>(`/api/reports/cash-book?${range()}&accountId=${bank.id}`);
    expect(one.accounts.map((a) => a.id)).toEqual([bank.id]);
  });
});

describe('the day book (RPT-11)', () => {
  it('lists every journal entry once, with its lines, reversals marked', async () => {
    const book = await view<DayBookView>(`/api/reports/day-book?${range()}`);
    const [{ n }] = (await q<{ n: number }>(
      'SELECT count(*)::int AS n FROM erp.journal_entries WHERE entry_date BETWEEN $1 AND $2',
      [monthStart(), today()],
    )) as [{ n: number }];
    expect(book.entries).toHaveLength(n);
    expect(new Set(book.entries.map((e) => e.id)).size).toBe(n);
    expect(book.totals).toEqual({ entries: n, debit: book.totals.credit, credit: book.totals.credit });
    for (const e of book.entries) expect(e.debit).toBe(e.credit);
    expect(book.entries.filter((e) => e.sourceType === 'journal_voucher').every((e) => e.reversal)).toBe(
      true,
    );
    const vouchers = await view<DayBookView>(`/api/reports/day-book?${range()}&type=journal_voucher`);
    expect(vouchers.entries).toHaveLength(2);
  });
});

describe('who sees what, and the limits', () => {
  const urls = ['trial-balance', 'profit-loss', 'balance-sheet', 'cash-book', 'day-book', 'expenses'].map(
    (r) => `/api/reports/${r}`,
  );

  it('the accountant reads them; the manager (no reports.financial) is refused', async () => {
    for (const url of urls) {
      expect((await send('GET', url, 'alia')).statusCode, url).toBe(200);
      expect((await send('GET', url, 'tariq')).statusCode, url).toBe(403);
    }
  });

  it("another shop's postings never appear", async () => {
    const tb = await view<TrialBalanceView>(`/api/reports/trial-balance?${range()}`, 'fahad', OTHER);
    expect(tb.rows).toEqual([]);
    const book = await view<DayBookView>(`/api/reports/day-book?${range()}`, 'fahad', OTHER);
    expect(book.entries).toEqual([]);
    expect((await q('SELECT 1 FROM erp.journal_entries', [], otherId)).length).toBe(0);
  });

  it('a range over the limit is refused: 92 days for a list, 366 for a summary', async () => {
    const at = (from: string, to: string, r: string) =>
      send('GET', `/api/reports/${r}?from=${from}&to=${to}`, 'fahad');
    expect((await at('2027-01-01', '2027-04-02', 'day-book')).statusCode).toBe(200);
    const long = await at('2027-01-01', '2027-04-03', 'day-book');
    expect([long.statusCode, long.json()]).toEqual([400, { error: 'range_too_long' }]);
    expect((await at('2027-07-01', '2028-06-30', 'trial-balance')).statusCode).toBe(200);
    expect((await at('2027-07-01', '2028-07-01', 'trial-balance')).json()).toEqual({
      error: 'range_too_long',
    });
    expect((await at('2027-07-02', '2027-07-01', 'cash-book')).json()).toEqual({ error: 'bad_request' });
    expect((await send('GET', '/api/reports/day-book?type=nonsense', 'fahad')).statusCode).toBe(400);
    expect((await send('GET', '/api/reports/trial-balance?preset=fortnight', 'fahad')).statusCode).toBe(400);
    // A preset is worked out on the shop's today: a saved link to "this month" stays this month.
    const month = await view<TrialBalanceView>('/api/reports/trial-balance?preset=thisMonth');
    expect(month.from).toBe(monthStart());
    expect((await send('GET', '/api/reports/balance-sheet?at=2027-02-30', 'fahad')).statusCode).toBe(400);
  });

  it('every report downloads as CSV, the account ledger too; /auth/me names the shop', async () => {
    for (const url of urls) {
      const res = await send('GET', `${url}?format=csv`, 'fahad');
      expect([url, res.statusCode, res.headers['content-type']]).toEqual([
        url,
        200,
        'text/csv; charset=utf-8',
      ]);
    }
    const ledger = await send(
      'GET',
      `/api/accounting/accounts/${account['1300']}/ledger?${range()}&format=csv`,
      'fahad',
    );
    expect(ledger.body.split('\r\n')[0]).toBe('date,journal,document,source,memo,party,debit,credit,balance');
    const month = await view<{ from: string }>(
      `/api/accounting/accounts/${account['1300']}/ledger?preset=thisMonth`,
    );
    expect(month.from).toBe(monthStart());
    expect((await view<{ shopName: string }>('/api/auth/me')).shopName).toBe(`${SHOP} shop`);
  });
});

describe('a year of postings', () => {
  it('answers the trial balance and the profit and loss month by month in under 2 s', async () => {
    // A year of a busy counter, straight into the other shop's journal: 100 bills a day, each a sale and its cost.
    const roles = await q<{ id: string; system_role: string }>(
      "SELECT id, system_role FROM erp.accounts WHERE system_role IN ('CASH_IN_TRANSIT', 'SALES', 'COGS', 'INVENTORY')",
      [],
      otherId,
    );
    const id = (r: string) => roles.find((x) => x.system_role === r)!.id;
    const owner = new pg.Client({ connectionString: db.ownerUrl });
    await owner.connect();
    try {
      // RLS is forced for the owner too (rule 5): the rows are written as the other shop.
      await owner.query('BEGIN');
      await owner.query("SELECT set_config('app.tenant_id', $1, true)", [otherId]);
      const branch = (
        await owner.query<{ id: string }>('SELECT id FROM erp.branches WHERE tenant_id = $1', [otherId])
      ).rows[0]!.id;
      await owner.query(
        `WITH days AS (SELECT d::date AS day, row_number() OVER (ORDER BY d) AS n
                       FROM generate_series('2027-01-01'::date, '2027-12-31'::date, '1 day') d),
         posted AS (
           INSERT INTO erp.postings (tenant_id, seq, source_type, source_id, entry_date, posted_at, context)
           SELECT $1, n, 'opening', erp.uuid_v7(), day, now(), '{}' FROM days RETURNING seq, entry_date),
         entries AS (
           INSERT INTO erp.journal_entries (tenant_id, number, entry_date, source_type, source_id, posting_seq, posted_at)
           SELECT $1, 'G' || p.seq || '-' || b, p.entry_date, 'opening', erp.uuid_v7(), p.seq, now()
           FROM posted p, generate_series(1, 100) b RETURNING id, entry_date)
         INSERT INTO erp.journal_lines (tenant_id, entry_id, line_no, account_id, branch_id, debit, credit)
         SELECT $1, e.id, l.no, l.account, $2, l.debit, l.credit FROM entries e,
           (VALUES (1, $3::uuid, 120000, 0), (2, $4::uuid, 0, 120000), (3, $5::uuid, 84000, 0), (4, $6::uuid, 0, 84000))
             AS l (no, account, debit, credit)`,
        [otherId, branch, id('CASH_IN_TRANSIT'), id('SALES'), id('COGS'), id('INVENTORY')],
      );
      await owner.query('COMMIT');
      // As autovacuum does after a load this size: without statistics the planner guesses one row a table.
      await owner.query('ANALYZE erp.postings, erp.journal_entries, erp.journal_lines');
    } finally {
      await owner.end();
    }
    const timed = async (url: string) => {
      const started = performance.now();
      const res = await send('GET', url, 'fahad', undefined, OTHER);
      expect(res.statusCode, res.body).toBe(200);
      return { ms: performance.now() - started, body: res.json<unknown>() };
    };
    const tb = await timed('/api/reports/trial-balance?from=2027-01-01&to=2027-12-31');
    const pl = await timed('/api/reports/profit-loss?from=2027-01-01&to=2027-12-31&compare=months');
    expect((tb.body as TrialBalanceView).balanced).toBe(true);
    expect((pl.body as ProfitLossView).netProfit.reduce((s, v) => s + v, 0)).toBe(365 * 100 * 36000);
    expect(tb.ms).toBeLessThan(2000);
    expect(pl.ms).toBeLessThan(2000);
  }, 300_000);
});
