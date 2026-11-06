import {
  exportPublicKey,
  generateDeviceKey,
  signCanonical,
  TenantSpec,
  uuidv7,
  type BillStatusResponse,
  type DocumentFamily,
  type PushDocument,
  type PushRequest,
  type PushResponse,
} from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import {
  buildHandoverDocument,
  buildSaleDocument,
  buildSessionDocument,
  buildVoidDocument,
  businessDate,
  money,
  ROLE_TEMPLATES,
  type Bill,
  type CashHandoverDocument,
  type CashSessionDocument,
  type DeskSession,
  type PaymentMethodInfo,
  type Qty,
  type RoleGrant,
  type SaleDocument,
  type SaleVoidDocument,
} from '@erp/domain';
import { checkRebuild, postPending } from '@erp/posting';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Voids on the server (W1-12, sync spec §6.2, posting rules §4.4): a counter's void of its own bill is stored, the bill
// marked voided with an override and an audit row, and the bill's posting reversed; a void that arrives first waits
// for its bill. Findings, never refusals: an approver the server doesn't allow, a second void, cash at the desk for a
// voided bill (D-059). The live cash desk check a counter asks before a void. The rebuild replays it all.

type DeviceKeys = Awaited<ReturnType<typeof generateDeviceKey>>;
interface Shop {
  code: string;
  tenantId: string;
  branchId: string;
  seller: string;
  manager: string;
  cashier: string;
  retail: string;
  items: Record<string, string>;
}
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
const ITEMS = [
  { code: 'OIL001', name: 'ENGINE OIL 4L', category: 'OIL', floor: 100000, prices: { RETAIL: 120000 } },
];
const MANAGER_GRANTS: RoleGrant[] = [{ ...ROLE_TEMPLATES.manager, branchId: null }];
const CASHIER_GRANTS: RoleGrant[] = [{ ...ROLE_TEMPLATES.cashier, branchId: null }];

let db: TestDatabase;
let pool: pg.Pool;
let shop: Shop;
let counter: Device;
let desk: Device;
let session: DeskSession;
const app = () => buildApp({ pool, now: () => new Date() });

const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  withTenant(pool, { tenantId: shop.tenantId }, async (_db, c) => (await c.query<T>(sql, params)).rows);

async function makeShop(code: string): Promise<Shop> {
  const { tenantId } = await setupTenant(
    db.ownerUrl,
    TenantSpec.parse({ ...deluxSpec, code, name: `${code} shop` }),
    { ownerPasswordHash: await hashPassword(PASSWORD), mustChangePassword: false },
  );
  return withTenant(pool, { tenantId }, async (_db, c) => {
    const one = async (sql: string) => (await c.query<{ id: string }>(sql)).rows[0]!.id;
    const person = async (username: string, template: string) => {
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
    };
    return {
      code,
      tenantId,
      branchId: await one('SELECT id FROM erp.branches'),
      seller: await person('sara', 'salesman'),
      manager: await person('tariq', 'manager'),
      cashier: await person('ali', 'cashier'),
      retail: await one("SELECT id FROM erp.price_tiers WHERE code = 'RETAIL'"),
      items: await seedCatalog(c, tenantId, ITEMS),
    };
  });
}

const httpPost = (url: string, payload: unknown, cookie?: string) =>
  app().inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, host: HOST },
    payload: payload as Record<string, unknown>,
    ...(cookie ? { cookies: { erp_session: cookie } } : {}),
  });

async function enroll(kind: 'counter' | 'cash_desk'): Promise<Device> {
  const login = await httpPost('/api/auth/login', {
    tenantCode: shop.code,
    username: 'fahad',
    password: PASSWORD,
  });
  const cookie = login.cookies.find((x) => x.name === 'erp_session')!.value;
  const code = (
    await httpPost('/api/devices/enrollment-codes', { branchId: shop.branchId, kind }, cookie)
  ).json<{ code: string }>().code;
  const keys = await generateDeviceKey();
  const publicKey = await exportPublicKey(keys.publicKey);
  const signature = await signCanonical(keys.privateKey, { tenantCode: shop.code, code, publicKey });
  const enrolled = (
    await httpPost('/api/devices/enroll', { tenantCode: shop.code, code, publicKey, signature })
  ).json<{ deviceId: string; code: string }>();
  const { nonce } = (
    await httpPost('/api/devices/challenge', { tenantId: shop.tenantId, deviceId: enrolled.deviceId })
  ).json<{ nonce: string }>();
  const token = (
    await httpPost('/api/devices/token', {
      tenantId: shop.tenantId,
      deviceId: enrolled.deviceId,
      nonce,
      signature: await signCanonical(keys.privateKey, {
        tenantId: shop.tenantId,
        deviceId: enrolled.deviceId,
        nonce,
      }),
    })
  ).json<{ accessToken: string }>().accessToken;
  return { token, deviceId: enrolled.deviceId, code: enrolled.code, keys, seq: {} };
}

/**
 * The test's clock: now, unless the shop's business day (04:00 Karachi) began less than 15 minutes ago; then 20
 * minutes earlier, so a bill made minutes before its void is never on the day before (CI ran at 23:01 UTC).
 */
const clock = () => {
  const t = Date.now();
  const day = (ms: number) => businessDate(ms, 'Asia/Karachi', 4);
  return day(t - 15 * 60_000) === day(t) ? t : t - 20 * 60_000;
};

const next = (d: Device, family: DocumentFamily) => (d.seq[family] = (d.seq[family] ?? 0) + 1);
const context = (d: Device, family: DocumentFamily, atMs = clock() - 60_000) => ({
  id: uuidv7(),
  seq: next(d, family),
  deviceId: d.deviceId,
  deviceCode: d.code,
  branchId: shop.branchId,
  createdAtMs: atMs,
  timeZone: 'Asia/Karachi',
  cutoffHour: 4,
  clientVersion: '0.9.0',
});

/** A bill of `units` cans of oil at Rs 1,200, in cash (or by Raast), on the counter. */
function sale(units: number, method: 'cash' | 'raast' = 'cash', reissueOf?: SaleDocument): SaleDocument {
  const bill: Bill = {
    version: 1,
    sellerId: shop.seller,
    tierId: shop.retail,
    lines: [
      {
        id: 'l1',
        itemId: shop.items['OIL001']!,
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
    reissueOf: reissueOf ? { id: reissueOf.id, number: reissueOf.number } : null,
    context: { ...context(counter, 'S', clock() - 120_000), increment: money(100) },
  });
}

/** The manager voids `bill` on the counter, as the counter writes it. */
const voidOf = (bill: SaleDocument, deskStatus: 'pending' | 'unknown' | 'not_applicable' = 'pending') =>
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
    branchId: shop.branchId,
    deskStatus: bill.cashDue === 0 ? 'not_applicable' : deskStatus,
    approverId: shop.manager,
    approverGrants: MANAGER_GRANTS,
    reason: 'wrong_price',
    note: null,
    userId: shop.seller,
    context: context(counter, 'V'),
  });

function openSession(): CashSessionDocument {
  const z = buildSessionDocument({
    event: 'open',
    current: null,
    userId: shop.cashier,
    grants: CASHIER_GRANTS,
    openingFloat: money(0),
    handovers: [],
    context: { ...context(desk, 'Z', clock() - 600_000), increment: money(100) },
  });
  session = { id: z.id, cashierId: shop.cashier, openingFloat: money(0), status: 'open' };
  return z;
}

/** The desk scans a bill's code (known only by its number and cash due), at `atMs`. */
const scan = (bill: SaleDocument, atMs: number): CashHandoverDocument =>
  buildHandoverDocument({
    session,
    cashierId: shop.cashier,
    grants: CASHIER_GRANTS,
    branchId: shop.branchId,
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
    context: context(desk, 'H', atMs),
  });

type AnyDocument = SaleDocument | SaleVoidDocument | CashHandoverDocument | CashSessionDocument;

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
const results = (r: PushResponse) => r.results.map((x) => [x.status, x.error, x.exceptions]);

const bill = async (id: string) =>
  (
    await q<{
      status: string;
      void_document_id: string | null;
      void_reason_code: string | null;
      voided_by_user_id: string | null;
      void_approved_by_user_id: string | null;
      reissue_of_id: string | null;
      reissue_of_number: string | null;
    }>(
      `SELECT status, void_document_id, void_reason_code, voided_by_user_id, void_approved_by_user_id, reissue_of_id,
         reissue_of_number FROM erp.sales_documents WHERE id = $1`,
      [id],
    )
  )[0]!;
const exceptionsOf = (id: string) =>
  q<{ kind: string; document_type: string; details: Record<string, unknown> }>(
    'SELECT kind, document_type, details FROM erp.exceptions WHERE document_id = $1 ORDER BY kind',
    [id],
  );
const journalOf = (type: string, id: string) =>
  q<{ code: string; debit: number; credit: number }>(
    `SELECT a.code, l.debit::int AS debit, l.credit::int AS credit
     FROM erp.journal_entries e JOIN erp.journal_lines l ON l.entry_id = e.id JOIN erp.accounts a ON a.id = l.account_id
     WHERE e.source_type = $1 AND e.source_id = $2 ORDER BY l.line_no`,
    [type, id],
  );
const posted = async (type: string, id: string) =>
  (await q('SELECT 1 FROM erp.postings WHERE source_type = $1 AND source_id = $2', [type, id])).length === 1;
/** Debits minus credits on an account, by code. */
const balanceOf = async (code: string) =>
  Number(
    (
      await q<{ balance: string }>(
        `SELECT coalesce(sum(l.debit - l.credit), 0) AS balance
         FROM erp.journal_lines l JOIN erp.accounts a ON a.id = l.account_id WHERE a.code = $1`,
        [code],
      )
    )[0]!.balance,
  );
const shelf = async () =>
  Number(
    (
      await q<{ qty: string }>(
        'SELECT coalesce(sum(qty * 1000), 0)::bigint AS qty FROM erp.stock_balances WHERE item_id = $1',
        [shop.items['OIL001']],
      )
    )[0]!.qty,
  );
const status = (device: Device, number: string) =>
  app().inject({
    method: 'GET',
    url: `/api/sync/bills/status?number=${number}`,
    headers: { authorization: `Device ${device.token}` },
  });

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 6 });
  shop = await makeShop('voids');
  counter = await enroll('counter');
  desk = await enroll('cash_desk');
  expect(results(await push(desk, [openSession()]))).toEqual([['accepted', null, []]]);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('a void (sync spec §6.2, posting rules §4.4)', () => {
  it('marks the bill voided, keeps the approval and the audit, and reverses its posting', async () => {
    const transit = await balanceOf('1120');
    const before = await shelf();
    const s = sale(2);
    expect((await push(counter, [s])).results[0]!.status).toBe('accepted');
    expect(await balanceOf('1120')).toBe(transit + 240000);
    expect(await shelf()).toBe(before - 2000);

    const v = voidOf(s);
    expect(results(await push(counter, [v]))).toEqual([['accepted', null, []]]);
    expect(await bill(s.id)).toEqual({
      status: 'voided',
      void_document_id: v.id,
      void_reason_code: 'wrong_price',
      voided_by_user_id: shop.seller,
      void_approved_by_user_id: shop.manager,
      reissue_of_id: null,
      reissue_of_number: null,
    });
    const overrides = await q<{ kind: string; approved_by_user_id: string; values: Record<string, unknown> }>(
      "SELECT kind, approved_by_user_id, values FROM erp.overrides WHERE document_id = $1 AND kind = 'void'",
      [s.id],
    );
    expect(overrides).toEqual([
      {
        kind: 'void',
        approved_by_user_id: shop.manager,
        values: { voidNumber: v.number, total: 240000, cashDue: 240000, seen: 'pending' },
      },
    ]);
    const audit = await q<{ action: string; user_id: string; device_id: string }>(
      "SELECT action, user_id, device_id FROM erp.audit_log WHERE action = 'sale.voided' AND entity_id = $1",
      [s.id],
    );
    expect(audit).toEqual([{ action: 'sale.voided', user_id: shop.manager, device_id: counter.deviceId }]);

    // Every line of the sale swapped; cash in transit and the shelf as they were.
    const sold = await journalOf('sale', s.id);
    expect(await journalOf('sales_void', v.id)).toEqual(
      sold.map((l) => ({ code: l.code, debit: l.credit, credit: l.debit })),
    );
    expect(await balanceOf('1120')).toBe(transit);
    expect(await shelf()).toBe(before);
    expect((await checkRebuild(pool, shop.tenantId)).differences).toEqual([]);

    // Sent again: the stored result (rule 7).
    expect((await push(counter, [v])).results[0]!.status).toBe('duplicate');
  });

  it('that arrives before its bill waits, and applies and posts when the bill comes', async () => {
    const s = sale(1);
    const v = voidOf(s);
    expect(results(await push(counter, [v]))).toEqual([['accepted', null, []]]);
    const waiting = await q<{ sale_document_id: string | null }>(
      'SELECT sale_document_id FROM erp.sales_voids WHERE id = $1',
      [v.id],
    );
    expect(waiting).toEqual([{ sale_document_id: null }]);
    expect(await posted('sales_void', v.id)).toBe(false);

    expect((await push(counter, [s])).results[0]!.status).toBe('accepted');
    expect((await bill(s.id)).status).toBe('voided');
    expect(await posted('sale', s.id)).toBe(true);
    expect(await posted('sales_void', v.id)).toBe(true);
    expect((await checkRebuild(pool, shop.tenantId)).differences).toEqual([]);
  });

  it("is refused from a device that didn't make the bill, and for an unknown approver", async () => {
    const s = sale(1, 'raast');
    await push(counter, [s]);
    const fromDesk: SaleVoidDocument = { ...voidOf(s), deviceId: desk.deviceId, seq: next(desk, 'V') };
    expect(results(await push(desk, [fromDesk]))).toEqual([['rejected', 'wrong_device', []]]);
    const stranger = { ...voidOf(s), approvedBy: uuidv7() };
    expect(results(await push(counter, [stranger]))).toEqual([['rejected', 'unknown_reference', []]]);
    expect((await bill(s.id)).status).toBe('finalized');
  });

  it('by an approver the server says may not void, still stands, flagged', async () => {
    const s = sale(1, 'raast');
    await push(counter, [s]);
    const v: SaleVoidDocument = { ...voidOf(s), approvedBy: shop.seller };
    expect(results(await push(counter, [v]))).toEqual([['accepted', null, ['void_not_permitted']]]);
    expect((await bill(s.id)).status).toBe('voided');
    expect(await exceptionsOf(v.id)).toEqual([
      {
        kind: 'void_not_permitted',
        document_type: 'sales_void',
        details: expect.objectContaining({ cause: 'not_permitted', billNumber: s.number }) as unknown,
      },
    ]);
    expect(await posted('sales_void', v.id)).toBe(true);
  });

  it('a second time is a duplicate, kept and never posted', async () => {
    const s = sale(1, 'raast');
    await push(counter, [s]);
    const first = voidOf(s);
    await push(counter, [first]);
    const second = voidOf(s);
    expect(results(await push(counter, [second]))).toEqual([['accepted', null, ['duplicate_void']]]);
    expect(await posted('sales_void', second.id)).toBe(false);
    expect((await bill(s.id)).void_document_id).toBe(first.id);
    await postPending(pool, shop.tenantId, { now: () => new Date() });
    expect(await posted('sales_void', second.id)).toBe(false);
  });
});

describe("the desk's queue (sync spec §3)", () => {
  it('sends a voided bill again with its status, so every desk drops it', async () => {
    const s = sale(1);
    await push(counter, [s]);
    const pull = async () =>
      (
        await app().inject({
          method: 'GET',
          url: '/api/sync/pull?datasets=cash_queue&limit=1000',
          headers: { authorization: `Device ${desk.token}` },
        })
      ).json<{ changes: { cash_queue?: { number: string; status: string }[] } }>().changes.cash_queue ?? [];
    expect((await pull()).find((r) => r.number === s.number)?.status).toBe('finalized');
    await push(counter, [voidOf(s)]);
    expect((await pull()).find((r) => r.number === s.number)?.status).toBe('voided');
  });
});

describe('cash at the desk for a voided bill (D-059)', () => {
  it('a void after an offline scan of the bill is flagged, the scan made before it', async () => {
    const s = sale(1);
    await push(counter, [s]);
    const h = scan(s, clock() - 90_000);
    await push(desk, [h]);
    const v = voidOf(s, 'unknown');
    expect(results(await push(counter, [v]))).toEqual([['accepted', null, ['cash_received_for_void']]]);
    expect((await exceptionsOf(v.id))[0]).toMatchObject({
      kind: 'cash_received_for_void',
      details: { handoverId: h.id, order: 'before_void' },
    });
  });

  it('a scan after the void is flagged on the handover, and still posted (the cash is in the drawer)', async () => {
    const s = sale(1);
    await push(counter, [s]);
    const v = voidOf(s);
    await push(counter, [v]);
    const h = scan(s, clock());
    expect(results(await push(desk, [h]))).toEqual([['accepted', null, ['cash_received_for_void']]]);
    expect((await exceptionsOf(h.id))[0]).toMatchObject({
      kind: 'cash_received_for_void',
      details: { voidId: v.id, order: 'after_void' },
    });
    expect(await posted('cash_handover', h.id)).toBe(true);
    expect((await checkRebuild(pool, shop.tenantId)).differences).toEqual([]);
  });
});

describe('a reissue', () => {
  it('names the voided bill it replaces', async () => {
    const s = sale(1, 'raast');
    await push(counter, [s]);
    await push(counter, [voidOf(s)]);
    const again = sale(1, 'raast', s);
    expect((await push(counter, [again])).results[0]!.status).toBe('accepted');
    expect(await bill(again.id)).toMatchObject({ reissue_of_id: s.id, reissue_of_number: s.number });
  });
});

describe('the live cash desk check (GET /api/sync/bills/status)', () => {
  it('says a bill is pending, then handed over with when and by whom', async () => {
    const s = sale(1);
    await push(counter, [s]);
    const pending = await status(counter, s.number);
    expect(pending.statusCode).toBe(200);
    expect(pending.json<BillStatusResponse>()).toEqual({
      known: true,
      status: 'finalized',
      handoverStatus: 'pending',
      handedOverAt: null,
      cashierName: null,
    });
    const h = scan(s, clock() - 30_000);
    await push(desk, [h]);
    expect((await status(counter, s.number)).json<BillStatusResponse>()).toEqual({
      known: true,
      status: 'finalized',
      handoverStatus: 'received',
      handedOverAt: h.createdAt,
      cashierName: 'ali',
    });
  });

  it("sees an offline scan whose bill hasn't arrived, and knows nothing of a bill never seen", async () => {
    const s = sale(1);
    const h = scan(s, clock() - 30_000);
    await push(desk, [h]);
    expect((await status(counter, s.number)).json<BillStatusResponse>()).toMatchObject({
      known: false,
      status: null,
      handoverStatus: 'received',
    });
    const unseen = sale(1);
    expect((await status(counter, unseen.number)).json<BillStatusResponse>()).toEqual({
      known: false,
      status: null,
      handoverStatus: null,
      handedOverAt: null,
      cashierName: null,
    });
  });

  it("answers only for the device's own bills, and only a bill number", async () => {
    const s = sale(1);
    await push(counter, [s]);
    expect((await status(desk, s.number)).statusCode).toBe(403);
    expect((await status(counter, 'nonsense')).statusCode).toBe(400);
    const anonymous = await app().inject({ method: 'GET', url: `/api/sync/bills/status?number=${s.number}` });
    expect(anonymous.statusCode).toBe(401);
  });
});
