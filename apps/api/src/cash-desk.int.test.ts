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
  buildCashMovementDocument,
  buildCollectionDocument,
  buildHandoverDocument,
  buildSaleDocument,
  buildSessionDocument,
  money,
  type Bill,
  type CashHandoverDocument,
  type CashMovementDocument,
  type CashSessionDocument,
  type CustomerCollectionDocument,
  type Money,
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

type AnyDocument =
  | SaleDocument
  | CashHandoverDocument
  | CashSessionDocument
  | CustomerCollectionDocument
  | CashMovementDocument;

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
      // Counted exactly (W1-11): the float, as nothing was counted in by this document.
      close: {
        currency: 'PKR',
        counts: { '500000': 1 },
        reason: null,
        note: null,
        acknowledger: null,
        leftInDrawer: null,
      },
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

// W1-11 (cash desk spec, sync spec §3, §6.2, posting rules §4.5): what a desk's cash-out names, collections and cash
// movements pushed and posted, the float checked at open, and the counted close with its variance and the safe.
describe('collections, cash-out and the counted close (W1-11)', () => {
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
  let customer: string;
  let supplier: string;
  let owner: string;
  let methods: Record<string, string>;
  let tea: string;
  let soneri: string;
  let current: DeskSession;

  beforeAll(async () => {
    await withTenant(pool, { tenantId: shop.tenantId }, async (_db, c) => {
      const party = async (
        code: string,
        name: string,
        account: 'customer_accounts' | 'supplier_accounts',
      ) => {
        const id = (
          await c.query<{ id: string }>(
            'INSERT INTO erp.parties (tenant_id, code, name) VALUES ($1, $2, $3) RETURNING id',
            [shop.tenantId, code, name],
          )
        ).rows[0]!.id;
        if (account === 'customer_accounts')
          await c.query(
            'INSERT INTO erp.customer_accounts (tenant_id, party_id, price_tier_id, offline_daily_cap) VALUES ($1, $2, $3, 0)',
            [shop.tenantId, id, shop.retail],
          );
        else
          await c.query('INSERT INTO erp.supplier_accounts (tenant_id, party_id) VALUES ($1, $2)', [
            shop.tenantId,
            id,
          ]);
        return id;
      };
      customer = await party('C0042', 'Ali Autos', 'customer_accounts');
      supplier = await party('S0007', 'Addi Traders', 'supplier_accounts');
    });
    owner = (await q<{ id: string }>("SELECT id FROM erp.users WHERE username = 'fahad'"))[0]!.id;
    methods = Object.fromEntries(
      (await q<{ code: string; id: string }>('SELECT code, id FROM erp.payment_methods')).map((m) => [
        m.code,
        m.id,
      ]),
    );
    tea = (await q<{ id: string }>("SELECT id FROM erp.expense_categories WHERE code = 'GENERAL'"))[0]!.id;
    soneri = (await q<{ id: string }>("SELECT id FROM erp.bank_accounts WHERE code = 'soneri'"))[0]!.id;
  });

  const journal = (type: string, id: string) =>
    q<{ code: string; party_id: string | null; debit: number; credit: number }>(
      `SELECT a.code, l.party_id, l.debit::int AS debit, l.credit::int AS credit
       FROM erp.journal_entries e JOIN erp.journal_lines l ON l.entry_id = e.id
       JOIN erp.accounts a ON a.id = l.account_id
       WHERE e.source_type = $1 AND e.source_id = $2 ORDER BY l.line_no`,
      [type, id],
    );

  function open(float: number, floatExpected: number | null): CashSessionDocument {
    const z = buildSessionDocument({
      event: 'open',
      current: null,
      userId: shop.cashier,
      grants: DESK_GRANTS,
      openingFloat: money(float),
      floatExpected: floatExpected === null ? null : money(floatExpected),
      handovers: [],
      context: { ...context(desk, 'Z'), increment: money(100) },
    });
    current = { id: z.id, cashierId: shop.cashier, openingFloat: money(float), status: 'open' };
    return z;
  }

  function collect(
    amount: number,
    method: 'cash' | 'raast',
    cashierId = shop.cashier,
  ): CustomerCollectionDocument {
    return buildCollectionDocument({
      session: { ...current, cashierId },
      cashierId,
      grants: DESK_GRANTS,
      branchId: shop.branchId,
      increment: money(100),
      customer: { partyId: customer, code: 'C0042', name: 'Ali Autos', balance: money(0) },
      method: {
        id: methods[method]!,
        code: method,
        isCash: method === 'cash',
        requiresReference: method !== 'cash',
        isActive: true,
      },
      amount: money(amount),
      reference: method === 'cash' ? null : 'TX-55120',
      note: null,
      context: context(desk, 'R'),
    });
  }

  function cashOut(
    kind: 'expense' | 'supplier_payment' | 'bank_deposit' | 'to_safe',
    amount: number,
  ): CashMovementDocument {
    return buildCashMovementDocument({
      session: current,
      cashierId: shop.cashier,
      grants: DESK_GRANTS,
      branchId: shop.branchId,
      increment: money(100),
      kind,
      amount: money(amount),
      expenseCategory: kind === 'expense' ? { id: tea, name: 'General expenses', isActive: true } : null,
      supplier:
        kind === 'supplier_payment' ? { partyId: supplier, code: 'S0007', name: 'Addi Traders' } : null,
      bankAccount:
        kind === 'bank_deposit' ? { id: soneri, name: 'Bank: Soneri', kind: 'bank', isActive: true } : null,
      note: kind === 'to_safe' ? null : 'for the test',
      reference: null,
      expected: money(100_000_000),
      overDrawerConfirmed: false,
      context: context(desk, 'M'),
    });
  }

  it('sends a desk its suppliers, their balances, expense categories and bank accounts, never their accounts', async () => {
    const res = await pull(desk, 'suppliers,supplier_balances,expense_categories,bank_accounts');
    expect(res.statusCode, res.body).toBe(200);
    const { changes } = res.json<PullResponse>();
    for (const dataset of ['suppliers', 'expense_categories', 'bank_accounts'] as const) {
      const rows = changes[dataset]!;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows)
        expect(Object.keys(r).sort()).toEqual(
          [...Object.keys(CASH_DESK_COLUMNS[dataset]), 'row_version', 'deleted_at'].sort(),
        );
    }
    expect(changes.suppliers!.map((s) => s['code'])).toEqual(['S0007']);
    expect((await pull(counter, 'expense_categories')).statusCode).toBe(403);
  });

  it('opens with the float that stayed: nothing posts', async () => {
    const z = open(500000, 500000);
    expect((await push(desk, [z])).results[0]).toMatchObject({ status: 'accepted', exceptions: [] });
    expect(await journal('cash_session', z.id)).toEqual([]);
    const [row] = await q<{ float_expected: string }>(
      'SELECT float_expected FROM erp.cash_sessions WHERE id = $1',
      [z.id],
    );
    expect(row!.float_expected).toBe('500000');
  });

  it('posts a cash collection Dr 1110 / Cr 1200 and lowers what the customer owes', async () => {
    const r = collect(500000, 'cash');
    expect((await push(desk, [r])).results[0]).toMatchObject({ status: 'accepted', exceptions: [] });
    expect(await journal('payment', r.id)).toEqual([
      { code: '1110', party_id: null, debit: 500000, credit: 0 },
      { code: '1200', party_id: customer, debit: 0, credit: 500000 },
    ]);
    const [balance] = await q<{ balance: string }>(
      "SELECT balance FROM erp.party_balances WHERE party_id = $1 AND role = 'customer'",
      [customer],
    );
    expect(balance!.balance).toBe('-500000');
    expect((await push(desk, [r])).results[0]).toMatchObject({ status: 'duplicate' });
  });

  it('posts a Raast collection to HBL (D-095)', async () => {
    const r = collect(1250000, 'raast');
    expect((await push(desk, [r])).results[0]).toMatchObject({ status: 'accepted' });
    expect((await journal('payment', r.id)).map((l) => l.code)).toEqual(['1160', '1200']);
  });

  it('flags a collection by someone the server says may not take one, and keeps it', async () => {
    const r = collect(100000, 'cash', shop.seller);
    expect((await push(desk, [r])).results[0]).toMatchObject({
      status: 'accepted',
      exceptions: ['cash_not_permitted'],
    });
    expect(await exceptionsOf(r.id)).toEqual([
      expect.objectContaining({ kind: 'cash_not_permitted', document_type: 'payment' }),
    ]);
  });

  it('posts each cash-out from the drawer: the category, the supplier (with its ledger), the bank, the safe', async () => {
    const docs = [
      cashOut('expense', 20000),
      cashOut('supplier_payment', 800000),
      cashOut('bank_deposit', 1000000),
      cashOut('to_safe', 200000),
    ];
    expect((await push(desk, docs)).results.map((r) => r.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'accepted',
    ]);
    const lines = await Promise.all(docs.map((d) => journal('cash_movement', d.id)));
    expect(lines.map((l) => l.map((x) => x.code))).toEqual([
      ['6310', '1110'],
      ['2100', '1110'],
      ['1150', '1110'],
      ['1130', '1110'],
    ]);
    expect(lines[1]![0]!.party_id).toBe(supplier);
    const [ap] = await q<{ balance: string }>(
      "SELECT balance FROM erp.party_balances WHERE party_id = $1 AND role = 'supplier'",
      [supplier],
    );
    expect(ap!.balance).toBe('-800000');
  });

  it("refuses a counter's collection: only a cash desk keeps a drawer", async () => {
    const r = { ...collect(100000, 'cash'), deviceId: counter.deviceId };
    const res = await app().inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { authorization: `Device ${counter.token}` },
      payload: {
        clientVersion: '0.8.0',
        schemaVersion: 9,
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
        documents: [
          {
            id: r.id,
            family: 'R',
            seq: r.seq,
            payload: r,
            signature: await signCanonical(counter.keys.privateKey, r),
          },
        ],
        events: [],
      },
    });
    expect(res.json<PushResponse>().results[0]).toMatchObject({ status: 'rejected', error: 'wrong_device' });
  });

  it('closes Rs 300 short, acknowledged by the owner: Dr 6500 / Cr 1110, and what did not stay goes to the safe', async () => {
    // The expected cash is what the desk's documents say (with a Rs 25,000 handover); count it Rs 300 short.
    const handovers: { kind: 'in' | 'payout'; amount: Money }[] = [{ kind: 'in', amount: money(2500000) }];
    const collections = [
      { cash: true, amount: money(500000) },
      { cash: false, amount: money(1250000) },
      { cash: true, amount: money(100000) },
    ];
    const movements = [
      { kind: 'expense' as const, amount: money(20000) },
      { kind: 'supplier_payment' as const, amount: money(800000) },
      { kind: 'bank_deposit' as const, amount: money(1000000) },
      { kind: 'to_safe' as const, amount: money(200000) },
    ];
    // 5,000 + 25,000 + 5,000 + 1,000 − 200 − 8,000 − 10,000 − 2,000 = 15,800 expected; 15,500 counted.
    const z = buildSessionDocument({
      event: 'close',
      current,
      userId: shop.cashier,
      grants: DESK_GRANTS,
      openingFloat: null,
      handovers,
      collections,
      movements,
      close: {
        currency: 'PKR',
        counts: { '500000': 3, '50000': 1 },
        reason: 'change_error',
        note: null,
        acknowledger: {
          userId: owner,
          grants: [
            { permissions: ['*'], limits: { maxDiscountBp: 10_000, voidWindow: 'same_day' }, branchId: null },
          ],
        },
        leftInDrawer: money(500000),
      },
      context: { ...context(desk, 'Z'), increment: money(100) },
    });
    expect(z.expectedCash).toBe(1580000);
    expect(z.variance).toBe(-30000);
    expect((await push(desk, [z])).results[0]).toMatchObject({ status: 'accepted', exceptions: [] });
    const [row] = await q<{
      counted_cash: string;
      variance: string;
      variance_reason_code: string;
      left_in_drawer: string;
      acknowledged_by_user_id: string;
    }>(
      `SELECT counted_cash, variance, variance_reason_code, left_in_drawer, acknowledged_by_user_id
       FROM erp.cash_sessions WHERE id = $1`,
      [current.id],
    );
    expect(row).toEqual({
      counted_cash: '1550000',
      variance: '-30000',
      variance_reason_code: 'change_error',
      left_in_drawer: '500000',
      acknowledged_by_user_id: owner,
    });
    expect(await journal('cash_session', z.id)).toEqual([
      { code: '6500', party_id: null, debit: 30000, credit: 0 },
      { code: '1110', party_id: null, debit: 0, credit: 30000 },
      { code: '1130', party_id: null, debit: 1050000, credit: 0 },
      { code: '1110', party_id: null, debit: 0, credit: 1050000 },
    ]);
  });

  it('opens below what stayed: posts the difference to 6500 and flags float_mismatch', async () => {
    const z = open(480000, 500000);
    expect((await push(desk, [z])).results[0]).toMatchObject({
      status: 'accepted',
      exceptions: ['float_mismatch'],
    });
    expect(await journal('cash_session', z.id)).toEqual([
      { code: '6500', party_id: null, debit: 20000, credit: 0 },
      { code: '1110', party_id: null, debit: 0, credit: 20000 },
    ]);
  });

  it("doesn't store an acknowledgement by the session's own cashier: the variance waits, flagged", async () => {
    const ownGrants: RoleGrant[] = [
      {
        permissions: [...DESK_GRANTS[0]!.permissions, 'cash.variance.approve'],
        limits: DESK_GRANTS[0]!.limits,
        branchId: null,
      },
    ];
    const z = buildSessionDocument({
      event: 'close',
      current,
      userId: shop.cashier,
      grants: DESK_GRANTS,
      openingFloat: null,
      handovers: [],
      close: {
        currency: 'PKR',
        counts: { '100000': 4 },
        reason: 'unknown',
        note: null,
        // The desk let a different id through; the server judges it again.
        acknowledger: { userId: shop.seller, grants: ownGrants },
        leftInDrawer: null,
      },
      context: { ...context(desk, 'Z'), increment: money(100) },
    });
    const own = { ...z, acknowledgedByUserId: shop.cashier };
    expect((await push(desk, [own])).results[0]).toMatchObject({
      status: 'accepted',
      exceptions: ['cash_not_permitted'],
    });
    const [row] = await q<{ acknowledged_by_user_id: string | null; variance: string }>(
      'SELECT acknowledged_by_user_id, variance FROM erp.cash_sessions WHERE id = $1',
      [current.id],
    );
    expect(row).toEqual({ acknowledged_by_user_id: null, variance: '-80000' });
    expect((await exceptionsOf(z.id))[0]!.details).toMatchObject({ ownVariance: true });
  });

  it('keeps every desk document in the rebuild check', async () => {
    expect((await checkRebuild(pool, shop.tenantId)).differences).toEqual([]);
  });
});
