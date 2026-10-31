import {
  CASH_DESK_COLUMNS,
  exportPublicKey,
  generateDeviceKey,
  signCanonical,
  TenantSpec,
  uuidv7,
  type DocumentFamily,
  type PullResponse,
  type PushDocument,
  type PushRequest,
  type PushResponse,
} from '@erp/contracts';
import { createChangeFeed, queueKey, setupTenant, withTenant } from '@erp/db';
import { createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import {
  buildHandoverDocument,
  buildSaleDocument,
  buildSessionDocument,
  money,
  type Bill,
  type CashHandoverDocument,
  type CashSessionDocument,
  type DeskSession,
  type HandoverTarget,
  type PaymentMethodCode,
  type PaymentMethodInfo,
  type Qty,
  type RoleGrant,
  type SaleDocument,
} from '@erp/domain';
import { checkRebuild } from '@erp/posting';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';

// The cash desk on the server (W1-10, sync spec §3, §6.2, §8): the queue a desk pulls, handovers and sessions pushed,
// a handover linked to its bill now or when the bill arrives, reviewed (a different amount, a second handover) and
// posted Dr CASH_DRAWER / Cr CASH_IN_TRANSIT; cash in transit is back to 0 once every cash bill is handed over.

type DeviceKeys = Awaited<ReturnType<typeof generateDeviceKey>>;
interface Shop {
  code: string;
  tenantId: string;
  branchId: string;
  seller: string;
  cashier: string;
  retail: string;
  items: Record<string, string>;
}
interface Device {
  shop: Shop;
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
// The cashier role's permissions (W0-09), as the desk would read them from its pulled roles.
const CASHIER_GRANTS: RoleGrant[] = [
  {
    permissions: ['cash.handover.receive', 'cash.refund.pay', 'cash.session.close'],
    limits: { maxDiscountBp: 0, voidWindow: 'none' },
    branchId: null,
  },
];

let db: TestDatabase;
let pool: pg.Pool;
let shop: Shop;
let counter: Device;
let desk: Device;
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
  return { shop, token, deviceId: enrolled.deviceId, code: enrolled.code, keys, seq: {} };
}

const next = (d: Device, family: DocumentFamily) => (d.seq[family] = (d.seq[family] ?? 0) + 1);
const context = (d: Device, family: DocumentFamily) => ({
  id: uuidv7(),
  seq: next(d, family),
  deviceId: d.deviceId,
  deviceCode: d.code,
  branchId: shop.branchId,
  createdAtMs: Date.now() - 1000,
  timeZone: 'Asia/Karachi',
  cutoffHour: 4,
  clientVersion: '0.8.0',
});

/** A bill of `units` cans of oil at Rs 1,200, paid in cash (or by Raast), sold on `device`. */
function sale(device: Device, units: number, method: PaymentMethodCode = 'cash'): SaleDocument {
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
      cashReceived: method === 'cash' ? money(Math.ceil((units * 120000) / 500000) * 500000) : null,
    },
    methods: METHODS,
    sellerMaxDiscountBp: 0,
    customer: { id: null, walkinPhone: null },
    credit: null,
    creditApproval: null,
    context: { ...context(device, 'S'), increment: money(100) },
  });
}

let session: DeskSession;

function openSession(): CashSessionDocument {
  const z = buildSessionDocument({
    event: 'open',
    current: null,
    userId: shop.cashier,
    grants: CASHIER_GRANTS,
    openingFloat: money(500000),
    handovers: [],
    context: { ...context(desk, 'Z'), increment: money(100) },
  });
  session = { id: z.id, cashierId: shop.cashier, openingFloat: money(500000), status: 'open' };
  return z;
}

/** A handover from the queue (the bill known) or from a scanned code (only its number and cash due). */
function handover(
  target: SaleDocument | { number: string; cashDue: number },
  method: 'queue' | 'scan' = 'queue',
) {
  const known = 'id' in target;
  const t: HandoverTarget = {
    number: target.number,
    cashDue: money(target.cashDue),
    saleDocumentId: known ? target.id : null,
    cashReceived: known ? (target.payments[0]!.cashReceived ?? null) : null,
    handoverStatus: 'pending',
  };
  return buildHandoverDocument({
    session,
    cashierId: shop.cashier,
    grants: CASHIER_GRANTS,
    branchId: shop.branchId,
    increment: money(100),
    target: t,
    cashReceived: null,
    existing: [],
    method,
    context: context(desk, 'H'),
  });
}

type AnyDocument = SaleDocument | CashHandoverDocument | CashSessionDocument;

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
    clientVersion: '0.8.0',
    schemaVersion: 8,
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

const pull = (device: Device, datasets: string, cursor = '') =>
  app().inject({
    method: 'GET',
    url: `/api/sync/pull?datasets=${datasets}${cursor ? `&cursor=${cursor}` : ''}`,
    headers: { authorization: `Device ${device.token}` },
  });

const handoverRow = async (id: string) =>
  (
    await q<{ sales_document_id: string | null; duplicate_of_id: string | null; exception_count: number }>(
      'SELECT sales_document_id, duplicate_of_id, exception_count FROM erp.cash_handovers WHERE id = $1',
      [id],
    )
  )[0];
const billStatus = async (id: string) =>
  (
    await q<{ handover_status: string }>('SELECT handover_status FROM erp.sales_documents WHERE id = $1', [
      id,
    ])
  )[0]!.handover_status;
const exceptionsOf = (id: string) =>
  q<{ kind: string; document_type: string; details: Record<string, unknown> }>(
    'SELECT kind, document_type, details FROM erp.exceptions WHERE document_id = $1 ORDER BY kind',
    [id],
  );
const journalOf = (id: string) =>
  q<{ code: string; debit: number; credit: number }>(
    `SELECT a.code, l.debit::int AS debit, l.credit::int AS credit
     FROM erp.journal_entries e JOIN erp.journal_lines l ON l.entry_id = e.id JOIN erp.accounts a ON a.id = l.account_id
     WHERE e.source_type = 'cash_handover' AND e.source_id = $1 ORDER BY l.line_no`,
    [id],
  );
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

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 6 });
  shop = await makeShop('cash');
  counter = await enroll('counter');
  desk = await enroll('cash_desk');
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('the cash queue (sync spec §3)', () => {
  it("sends the branch's bills with cash to move, only the listed columns, and only to a cash desk", async () => {
    const cash = sale(counter, 2);
    const raast = sale(counter, 1, 'raast');
    expect((await push(counter, [cash, raast])).results.map((r) => r.status)).toEqual([
      'accepted',
      'accepted',
    ]);

    const refused = await pull(counter, 'cash_queue');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'not_cash_desk' });

    const res = await pull(desk, 'cash_queue');
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json<PullResponse>().changes.cash_queue!;
    const row = rows.find((r) => r['id'] === cash.id)!;
    expect(Object.keys(row).sort()).toEqual(
      [...Object.keys(CASH_DESK_COLUMNS.cash_queue), 'row_version', 'deleted_at'].sort(),
    );
    expect(row).toMatchObject({
      number: cash.number,
      cash_due: '240000',
      cash_received: '500000',
      change_due: '260000',
      handover_status: 'pending',
      salesperson_user_id: shop.seller,
    });
    expect(rows.some((r) => r['id'] === raast.id)).toBe(false);
  });

  it("tells only the branch's cash desks when a bill with cash arrives (queue-changed)", async () => {
    const feed = createChangeFeed(pool, { minIntervalMs: 0 });
    try {
      let queue = 0;
      const heard = new Promise<void>((resolve) =>
        feed.subscribe(queueKey(shop.tenantId, shop.branchId), () => {
          queue += 1;
          resolve();
        }),
      );
      // The feed connects on its first subscriber; give LISTEN a moment before the bill commits.
      await new Promise((r) => setTimeout(r, 300));
      await push(counter, [sale(counter, 1)]);
      await heard;
      expect(queue).toBeGreaterThan(0);
    } finally {
      await feed.close();
    }
  });
});

describe('handovers and sessions in push (sync spec §6.2, posting rules §4.5)', () => {
  it('opens a session from its Z document', async () => {
    const z = openSession();
    expect((await push(desk, [z])).results[0]).toMatchObject({ status: 'accepted', exceptions: [] });
    const [row] = await q<{ cashier_user_id: string; opening_float: string; status: string; number: string }>(
      'SELECT cashier_user_id, opening_float, status, number FROM erp.cash_sessions WHERE id = $1',
      [z.id],
    );
    expect(row).toEqual({
      cashier_user_id: shop.cashier,
      opening_float: '500000',
      status: 'open',
      number: z.number,
    });
  });

  it('links a handover to its stored bill, marks it received and posts Dr 1110 / Cr 1120', async () => {
    const bill = sale(counter, 3);
    await push(counter, [bill]);
    const h = handover(bill);
    expect((await push(desk, [h])).results[0]).toMatchObject({ status: 'accepted', exceptions: [] });
    expect(await handoverRow(h.id)).toMatchObject({ sales_document_id: bill.id, duplicate_of_id: null });
    expect(await billStatus(bill.id)).toBe('received');
    expect(await journalOf(h.id)).toEqual([
      { code: '1110', debit: 360000, credit: 0 },
      { code: '1120', debit: 0, credit: 360000 },
    ]);

    // The bill comes again in the queue with its new status, so every desk drops it.
    const rows = (await pull(desk, 'cash_queue')).json<PullResponse>().changes.cash_queue!;
    expect(rows.find((r) => r['id'] === bill.id)).toMatchObject({ handover_status: 'received' });
  });

  it('stores an offline scan before its bill arrives, and links it when the bill does', async () => {
    const bill = sale(counter, 1);
    const h = handover({ number: bill.number, cashDue: bill.cashDue }, 'scan');
    expect((await push(desk, [h])).results[0]).toMatchObject({ status: 'accepted', exceptions: [] });
    expect(await handoverRow(h.id)).toMatchObject({ sales_document_id: null });
    expect(await journalOf(h.id)).toHaveLength(2);

    await push(counter, [bill]);
    expect(await handoverRow(h.id)).toMatchObject({ sales_document_id: bill.id });
    expect(await billStatus(bill.id)).toBe('received');
    expect(await exceptionsOf(h.id)).toEqual([]);
    const postings = await q('SELECT 1 FROM erp.postings WHERE source_type = $1 AND source_id = $2', [
      'cash_handover',
      h.id,
    ]);
    expect(postings).toHaveLength(1);
  });

  it('links a scan and its bill pushed at the same moment, whichever commits first (e2e found the race)', async () => {
    const bills = Array.from({ length: 12 }, () => sale(counter, 1));
    const scans = bills.map((b) => handover({ number: b.number, cashDue: b.cashDue }, 'scan'));
    // Each pair in parallel, so the two transactions overlap as when a desk and a counter reconnect together.
    for (const [i, b] of bills.entries()) await Promise.all([push(counter, [b]), push(desk, [scans[i]!])]);
    for (const h of scans)
      expect(await handoverRow(h.id), h.billNumber).toMatchObject({
        sales_document_id: expect.any(String) as string,
      });
    for (const b of bills) expect(await billStatus(b.id)).toBe('received');
  });

  it("accepts a handover naming a bill that hasn't arrived yet (the desk's own sale, pushed after it), and links it", async () => {
    // The desk's outbox goes by family, so a sale's automatic handover (H) is sent before the sale (S) itself.
    const bill = sale(desk, 1);
    const h = handover(bill);
    const r = await push(desk, [h, bill]);
    expect(r.results.map((x) => x.status)).toEqual(['accepted', 'accepted']);
    expect(await handoverRow(h.id)).toMatchObject({ sales_document_id: bill.id });
    expect(await billStatus(bill.id)).toBe('received');
  });

  it('flags an offline scan whose amount differs from the bill when it arrives (D-059)', async () => {
    const bill = sale(counter, 2);
    const h = handover({ number: bill.number, cashDue: bill.cashDue - 10000 }, 'scan');
    await push(desk, [h]);
    await push(counter, [bill]);
    const found = await exceptionsOf(h.id);
    expect(found).toEqual([
      {
        kind: 'handover_amount_mismatch',
        document_type: 'cash_handover',
        details: expect.objectContaining({
          amount: 230000,
          billCashDue: 240000,
          billNumber: bill.number,
        }) as object,
      },
    ]);
  });

  it('keeps a second handover of a bill as a duplicate, flagged and never posted', async () => {
    const bill = sale(counter, 1);
    await push(counter, [bill]);
    const first = handover(bill);
    const again = handover({ number: bill.number, cashDue: bill.cashDue }, 'scan');
    await push(desk, [first]);
    expect((await push(desk, [again])).results[0]).toMatchObject({
      status: 'accepted',
      exceptions: ['duplicate_handover'],
    });
    expect(await handoverRow(again.id)).toMatchObject({ duplicate_of_id: first.id, exception_count: 1 });
    expect(await journalOf(again.id)).toEqual([]);
  });

  it('answers a re-sent handover as a duplicate (rule 7)', async () => {
    const bill = sale(counter, 1);
    await push(counter, [bill]);
    const h = handover(bill);
    await push(desk, [h]);
    expect((await push(desk, [h])).results[0]).toMatchObject({ status: 'duplicate' });
  });

  it("refuses a counter's handover as wrong_device: only a cash desk keeps a drawer", async () => {
    const h = { ...handover({ number: 'C99-S000001', cashDue: 10000 }, 'scan'), deviceId: counter.deviceId };
    const documents = [
      {
        id: h.id,
        family: 'H' as const,
        seq: h.seq,
        payload: h,
        signature: await signCanonical(counter.keys.privateKey, h),
      },
    ];
    const res = await app().inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { authorization: `Device ${counter.token}` },
      payload: {
        clientVersion: '0.8.0',
        schemaVersion: 8,
        deviceClock: new Date().toISOString(),
        health: {
          outboxCount: 1,
          oldestUnsyncedAt: null,
          quarantinedCount: 0,
          storagePersisted: true,
          storageUsage: 1,
          storageQuota: 2,
          lastPullAt: null,
        },
        documents,
        events: [],
      },
    });
    expect(res.json<PushResponse>().results[0]).toMatchObject({ status: 'rejected', error: 'wrong_device' });
  });

  it('closes the session with its expected cash', async () => {
    const z = buildSessionDocument({
      event: 'close',
      current: session,
      userId: shop.cashier,
      grants: CASHIER_GRANTS,
      openingFloat: null,
      handovers: [],
      context: { ...context(desk, 'Z'), increment: money(100) },
    });
    expect((await push(desk, [z])).results[0]).toMatchObject({ status: 'accepted' });
    const [row] = await q<{ status: string; closed_by_user_id: string; close_number: string }>(
      'SELECT status, closed_by_user_id, close_number FROM erp.cash_sessions WHERE id = $1',
      [session.id],
    );
    expect(row).toEqual({ status: 'closed', closed_by_user_id: shop.cashier, close_number: z.number });
  });

  it('leaves cash in transit at the bills not yet handed over, and the rebuild check matches', async () => {
    // Every cash bill sold above was handed over except the first test's two (Rs 2,400) and the nudge test's
    // (Rs 1,200); the mismatched scan posted Rs 2,300 for a Rs 2,400 bill, leaving Rs 100 in transit.
    expect(await balanceOf('1120')).toBe(240000 + 120000 + 10000);
    expect((await checkRebuild(pool, shop.tenantId)).differences).toEqual([]);
  });
});
