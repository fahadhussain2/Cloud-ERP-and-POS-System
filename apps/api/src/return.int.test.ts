import {
  exportPublicKey,
  generateDeviceKey,
  signCanonical,
  TenantSpec,
  uuidv7,
  type DocumentFamily,
  type PushDocument,
  type PushRequest,
  type PushResponse,
} from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import {
  addReturn,
  buildHandoverDocument,
  buildReturnDocument,
  buildSaleDocument,
  buildSessionDocument,
  emptyBill,
  money,
  qty,
  ROLE_TEMPLATES,
  type Bill,
  type CashHandoverDocument,
  type CashSessionDocument,
  type DeskSession,
  type PaymentMethodInfo,
  type ReturnApprovalBy,
  type ReturnApprovalKind,
  type ReturnCondition,
  type ReturnDocument,
  type RoleGrant,
  type SaleDocument,
  type Tender,
} from '@erp/domain';
import { checkRebuild, postPending } from '@erp/posting';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Returns and exchanges on the server (W1-13, sync spec §6.2, posting rules §4.2–§4.3): a counter's return of a bill
// (V2) is stored with each returned line linked to the line it returns, a defective line in Damaged, and posted: the
// refund to SALES_RETURNS, the stock back at the original line's cost (D-044). A refund is in the desk's queue and is
// paid out there. Findings, never refusals: more back than sold, an approval missing. A return waits for its bill to
// post. The branch's 90-day bills reach every counter (SYN-01). The rebuild replays it all.

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
  { code: 'card', isCash: false, requiresReference: true },
];
const ITEMS = [
  { code: 'OIL001', name: 'ENGINE OIL 4L', category: 'OIL', floor: 100000, prices: { RETAIL: 120000 } },
  { code: 'PAD001', name: 'BRAKE PADS', category: 'OIL', floor: 300000, prices: { RETAIL: 450000 } },
];
const CASHIER_GRANTS: RoleGrant[] = [{ ...ROLE_TEMPLATES.cashier, branchId: null }];

let db: TestDatabase;
let pool: pg.Pool;
let shop: Shop;
let counter: Device;
let other: Device;
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

const next = (d: Device, family: DocumentFamily) => (d.seq[family] = (d.seq[family] ?? 0) + 1);
const context = (d: Device, family: DocumentFamily, atMs = Date.now() - 60_000) => ({
  id: uuidv7(),
  seq: next(d, family),
  deviceId: d.deviceId,
  deviceCode: d.code,
  branchId: shop.branchId,
  createdAtMs: atMs,
  timeZone: 'Asia/Karachi',
  cutoffHour: 4,
  clientVersion: '0.10.0',
  increment: money(100),
});

const line = (id: string, item: string, units: number, price: number) => ({
  id,
  itemId: shop.items[item]!,
  qty: qty(units * 1000),
  allowsFraction: false,
  list: money(price),
  floor: null,
  unitPrice: money(price),
  approval: null,
});

/** A sale on `device`: lines of [item, units, price], paid by `method`. */
function sale(
  device: Device,
  lines: [string, number, number][],
  method: 'cash' | 'card' = 'cash',
  atMs = Date.now() - 120_000,
): SaleDocument {
  const bill: Bill = {
    ...emptyBill(shop.seller, shop.retail),
    lines: lines.map(([item, units, price], i) => line(`l${i}`, item, units, price)),
  };
  const total = lines.reduce((s, [, units, price]) => s + units * price, 0);
  return buildSaleDocument({
    bill,
    tender: {
      payments: [{ method, amount: money(total), reference: method === 'cash' ? null : 'SLIP1' }],
      cashReceived: null,
    },
    methods: METHODS,
    sellerMaxDiscountBp: 0,
    customer: { id: null, walkinPhone: null },
    credit: null,
    creditApproval: null,
    context: context(device, 'S', atMs),
  });
}

interface Back {
  lineNo: number;
  units: number;
  condition?: ReturnCondition;
}

/**
 * A return of `original`'s lines on `device` (another counter of the branch), refunded in cash or by `refund`,
 * optionally with sold lines (an exchange), as the counter builds it. `returned` is what earlier returns took.
 */
function returnOf(
  device: Device,
  original: SaleDocument,
  back: Back[],
  opts: {
    sold?: [string, number, number][];
    returned?: Record<number, { qty: number; refund: number }>;
    tender?: Tender;
    refundApproval?: ReturnApprovalBy;
  } = {},
): ReturnDocument {
  let bill = addReturn(emptyBill(shop.seller, shop.retail), {
    source: {
      kind: 'bill',
      id: original.id,
      number: original.number,
      businessDate: original.businessDate,
      customerId: null,
    },
    lines: back.map((b, i) => {
      const l = original.lines.find((x) => x.lineNo === b.lineNo)!;
      const r = opts.returned?.[b.lineNo] ?? { qty: 0, refund: 0 };
      return {
        id: `r${i}`,
        itemId: l.itemId,
        qty: qty(b.units * 1000),
        allowsFraction: false,
        reason: b.condition === 'defective' ? 'defective' : 'wrong_part',
        note: null,
        condition: b.condition ?? 'resellable',
        original: { line: l, returned: { qty: qty(r.qty), refund: money(r.refund) } },
        price: null,
        suggested: null,
      };
    }),
    needs: [],
    approval: null,
  });
  if (opts.sold)
    bill = { ...bill, lines: opts.sold.map(([item, units, price], i) => line(`s${i}`, item, units, price)) };
  const refund = (bill.returns?.lines ?? []).reduce((s, l) => s + l.refund, 0);
  const sold = (opts.sold ?? []).reduce((s, [, units, price]) => s + units * price, 0);
  const net = sold - refund;
  return buildReturnDocument({
    bill,
    tender: opts.tender ?? {
      payments: net === 0 ? [] : [{ method: 'cash', amount: money(net), reference: null }],
      cashReceived: null,
    },
    methods: METHODS,
    sellerMaxDiscountBp: 0,
    customer: { id: null, walkinPhone: null },
    credit: null,
    creditApproval: null,
    refundApproval: opts.refundApproval ?? null,
    context: context(device, 'S'),
  });
}

/** A return without a receipt, at `price`, approved by `approver` (or not approved at all). */
function noReceipt(device: Device, units: number, price: number, approver: string | null): ReturnDocument {
  const needs: ReturnApprovalKind[] = ['no_receipt_return'];
  const bill = addReturn(emptyBill(shop.seller, shop.retail), {
    source: { kind: 'none', ref: '023956' },
    lines: [
      {
        id: 'r0',
        itemId: shop.items['OIL001']!,
        qty: qty(units * 1000),
        allowsFraction: false,
        reason: 'changed_mind',
        note: null,
        condition: 'resellable',
        original: null,
        price: money(price),
        suggested: money(120000),
      },
    ],
    needs: approver === null ? [] : needs,
    approval:
      approver === null
        ? null
        : { approvedBy: approver, reason: 'before_go_live', note: null, at: new Date().toISOString() },
  });
  return buildReturnDocument({
    bill,
    tender: {
      payments: [{ method: 'cash', amount: money(-units * price), reference: null }],
      cashReceived: null,
    },
    methods: METHODS,
    sellerMaxDiscountBp: 0,
    customer: { id: null, walkinPhone: null },
    credit: null,
    creditApproval: null,
    refundApproval: null,
    context: context(device, 'S'),
  });
}

function openSession(): CashSessionDocument {
  const z = buildSessionDocument({
    event: 'open',
    current: null,
    userId: shop.cashier,
    grants: CASHIER_GRANTS,
    openingFloat: money(0),
    handovers: [],
    context: context(desk, 'Z', Date.now() - 600_000),
  });
  session = { id: z.id, cashierId: shop.cashier, openingFloat: money(0), status: 'open' };
  return z;
}

/** The desk pays a refund out from its queue. */
const payout = (r: ReturnDocument): CashHandoverDocument =>
  buildHandoverDocument({
    session,
    cashierId: shop.cashier,
    grants: CASHIER_GRANTS,
    branchId: shop.branchId,
    increment: money(100),
    target: {
      number: r.number,
      cashDue: money(r.cashDue),
      saleDocumentId: r.id,
      cashReceived: null,
      handoverStatus: 'pending',
    },
    cashReceived: null,
    existing: [],
    method: 'queue',
    context: context(desk, 'H'),
  });

type AnyDocument = SaleDocument | ReturnDocument | CashHandoverDocument | CashSessionDocument;

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
    clientVersion: '0.10.0',
    schemaVersion: 11,
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

const exceptionsOf = (id: string) =>
  q<{ kind: string; details: Record<string, unknown> }>(
    'SELECT kind, details FROM erp.exceptions WHERE document_id = $1 ORDER BY kind',
    [id],
  );
const journalOf = (id: string) =>
  q<{ code: string; debit: number; credit: number }>(
    `SELECT a.code, l.debit::int AS debit, l.credit::int AS credit
     FROM erp.journal_entries e JOIN erp.journal_lines l ON l.entry_id = e.id JOIN erp.accounts a ON a.id = l.account_id
     WHERE e.source_type = 'sale' AND e.source_id = $1 ORDER BY l.line_no`,
    [id],
  );
const posted = async (id: string) =>
  (await q("SELECT 1 FROM erp.postings WHERE source_type = 'sale' AND source_id = $1", [id])).length === 1;
const shelf = async (item: string, kind: 'shop' | 'damaged') =>
  Number(
    (
      await q<{ qty: string }>(
        `SELECT coalesce(sum(b.qty * 1000), 0)::bigint AS qty FROM erp.stock_balances b
         JOIN erp.locations l ON l.id = b.location_id WHERE b.item_id = $1 AND l.kind = $2`,
        [shop.items[item], kind],
      )
    )[0]!.qty,
  );
/** An item's average cost, set by hand. */
const setCost = (item: string, avg: number) =>
  q(
    `INSERT INTO erp.item_costs (tenant_id, item_id, avg_cost, on_hand) VALUES ($1, $2, $3, 100)
     ON CONFLICT (tenant_id, item_id) DO UPDATE SET avg_cost = $3`,
    [shop.tenantId, shop.items[item], avg],
  );
const averageOf = async (item: string) =>
  Number(
    (
      await q<{ avg: string }>('SELECT avg_cost AS avg FROM erp.item_costs WHERE item_id = $1', [
        shop.items[item],
      ])
    )[0]!.avg,
  );
const pull = async (device: Device, datasets: string) =>
  (
    await app().inject({
      method: 'GET',
      url: `/api/sync/pull?datasets=${datasets}&limit=1000`,
      headers: { authorization: `Device ${device.token}` },
    })
  ).json<{ changes: Record<string, Record<string, unknown>[]> }>().changes;

/** A shop with two counters and a desk with its session open. */
async function openShop(code: string) {
  shop = await makeShop(code);
  counter = await enroll('counter');
  other = await enroll('counter');
  desk = await enroll('cash_desk');
  expect(results(await push(desk, [openSession()]))).toEqual([['accepted', null, []]]);
}

// The first shop has costs seeded by hand (receipts come with W1-16), so its ledgers aren't all derived and it is
// never rebuilt; the last describe uses a shop whose ledgers come only from postings, and checks the rebuild.
beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 6 });
  await openShop('returns');
  await setCost('OIL001', 80000);
  await setCost('PAD001', 310000);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('a return (sync spec §6.2, posting rules §4.2)', () => {
  it("is stored with its lines linked to the bill's, posted at the original cost, and paid out at the desk", async () => {
    const s = sale(counter, [['OIL001', 2, 120000]]);
    expect(results(await push(counter, [s]))).toEqual([['accepted', null, []]]);
    // The average moves on after the sale; the return comes back at the sale's own cost (D-044).
    await setCost('OIL001', 90000);
    const shopBefore = await shelf('OIL001', 'shop');

    const r = returnOf(other, s, [{ lineNo: 1, units: 1 }]);
    expect(results(await push(other, [r]))).toEqual([['accepted', null, []]]);
    const doc = (
      await q<{
        kind: string;
        return_of_id: string;
        return_of_number: string;
        no_receipt: boolean;
        cash_due: string;
      }>(
        'SELECT kind, return_of_id, return_of_number, no_receipt, cash_due FROM erp.sales_documents WHERE id = $1',
        [r.id],
      )
    )[0];
    expect(doc).toEqual({
      kind: 'return',
      return_of_id: s.id,
      return_of_number: s.number,
      no_receipt: false,
      cash_due: '-120000',
    });
    const lines = await q<{ qty: string; original_line_id: string; reason: string; condition: string }>(
      `SELECT r.qty::text, r.original_line_id, r.return_reason_code AS reason, r.return_condition AS condition
       FROM erp.sales_lines r WHERE r.document_id = $1`,
      [r.id],
    );
    const sold = await q<{ id: string }>('SELECT id FROM erp.sales_lines WHERE document_id = $1', [s.id]);
    expect(lines).toEqual([
      { qty: '-1.000', original_line_id: sold[0]!.id, reason: 'wrong_part', condition: 'resellable' },
    ]);

    expect(await journalOf(r.id)).toEqual([
      { code: '1120', debit: 0, credit: 120000 },
      { code: '4110', debit: 120000, credit: 0 },
      { code: '5100', debit: 0, credit: 80000 },
      { code: '1300', debit: 80000, credit: 0 },
    ]);
    expect(await shelf('OIL001', 'shop')).toBe(shopBefore + 1000);

    // The refund is in the desk's queue, paid out there, and leaves it.
    const queued = (await pull(desk, 'cash_queue')).cash_queue!.find((x) => x.number === r.number);
    expect(queued).toMatchObject({ cash_due: '-120000', handover_status: 'pending' });
    const h = payout(r);
    expect(results(await push(desk, [h]))).toEqual([['accepted', null, []]]);
    expect(
      (
        await q<{ handover_status: string }>(
          'SELECT handover_status FROM erp.sales_documents WHERE id = $1',
          [r.id],
        )
      )[0],
    ).toEqual({ handover_status: 'paid_out' });

    // Sent again: the stored result (rule 7).
    expect((await push(other, [r])).results[0]!.status).toBe('duplicate');
  });

  it('puts a defective line into Damaged', async () => {
    const s = sale(counter, [['PAD001', 1, 450000]]);
    await push(counter, [s]);
    const damaged = await shelf('PAD001', 'damaged');
    const r = returnOf(other, s, [{ lineNo: 1, units: 1, condition: 'defective' }]);
    expect(results(await push(other, [r]))).toEqual([['accepted', null, []]]);
    expect(await shelf('PAD001', 'damaged')).toBe(damaged + 1000);
  });

  it('as an exchange is one entry, and only the net is settled', async () => {
    const s = sale(counter, [['OIL001', 1, 120000]]);
    await push(counter, [s]);
    const r = returnOf(other, s, [{ lineNo: 1, units: 1 }], { sold: [['PAD001', 1, 450000]] });
    expect(r.kind).toBe('exchange');
    expect(results(await push(other, [r]))).toEqual([['accepted', null, []]]);
    const journal = await journalOf(r.id);
    expect(journal.find((l) => l.code === '1120')).toEqual({ code: '1120', debit: 330000, credit: 0 });
    expect(journal.find((l) => l.code === '4100')).toEqual({ code: '4100', debit: 0, credit: 450000 });
    expect(journal.find((l) => l.code === '4110')).toEqual({ code: '4110', debit: 120000, credit: 0 });
  });

  it('by transfer posts to the bank with the manager’s approval', async () => {
    const s = sale(counter, [['OIL001', 1, 120000]]);
    await push(counter, [s]);
    const r = returnOf(other, s, [{ lineNo: 1, units: 1 }], {
      tender: {
        payments: [{ method: 'raast', amount: money(-120000), reference: 'RAAST-9' }],
        cashReceived: null,
      },
      refundApproval: {
        approvedBy: shop.manager,
        reason: 'regular_customer',
        note: null,
        at: new Date().toISOString(),
      },
    });
    expect(results(await push(other, [r]))).toEqual([['accepted', null, []]]);
    expect((await journalOf(r.id))[0]).toEqual({ code: '1160', debit: 0, credit: 120000 });
    const overrides = await q<{ kind: string; approved_by_user_id: string }>(
      'SELECT kind, approved_by_user_id FROM erp.overrides WHERE document_id = $1',
      [r.id],
    );
    expect(overrides).toEqual([{ kind: 'refund_transfer', approved_by_user_id: shop.manager }]);
  });

  it('of more than is left, from two counters offline, is kept and flagged, never refused (rule 7)', async () => {
    const s = sale(counter, [['OIL001', 1, 120000]]);
    await push(counter, [s]);
    const a = returnOf(counter, s, [{ lineNo: 1, units: 1 }]);
    const b = returnOf(other, s, [{ lineNo: 1, units: 1 }]);
    expect(results(await push(counter, [a]))).toEqual([['accepted', null, []]]);
    expect(results(await push(other, [b]))).toEqual([['accepted', null, ['return_over_quantity']]]);
    expect(await exceptionsOf(b.id)).toEqual([
      { kind: 'return_over_quantity', details: { lineNo: 1, sold: 1000, returnedBefore: 1000, qty: 1000 } },
    ]);
  });

  it('without a receipt: approved, at the manager’s price; not approved, flagged', async () => {
    const avg = await averageOf('OIL001');
    const ok = noReceipt(other, 1, 110000, shop.manager);
    expect(results(await push(other, [ok]))).toEqual([['accepted', null, []]]);
    // At the current average: no original cost to come back at.
    expect((await journalOf(ok.id)).find((l) => l.code === '1300')).toEqual({
      code: '1300',
      debit: avg,
      credit: 0,
    });
    const flagged = noReceipt(other, 1, 110000, null);
    expect(results(await push(other, [flagged]))).toEqual([
      ['accepted', null, ['return_price_mismatch', 'return_not_permitted']],
    ]);
  });

  it('waits for its bill to post, and posts right after it', async () => {
    // A card with no bank account can't be posted (D-095): the bill stays unposted.
    await q("UPDATE erp.payment_methods SET bank_account_id = NULL WHERE code = 'card'");
    const s = sale(counter, [['OIL001', 1, 120000]], 'card');
    await push(counter, [s]);
    expect(await posted(s.id)).toBe(false);
    const r = returnOf(other, s, [{ lineNo: 1, units: 1 }], {
      tender: { payments: [{ method: 'cash', amount: money(-120000), reference: null }], cashReceived: null },
    });
    expect(results(await push(other, [r]))).toEqual([['accepted', null, []]]);
    expect(await posted(r.id)).toBe(false);

    await q(
      `UPDATE erp.payment_methods SET bank_account_id = (SELECT id FROM erp.bank_accounts WHERE code = 'card')
       WHERE code = 'card'`,
    );
    await postPending(pool, shop.tenantId, { now: () => new Date() });
    expect(await posted(s.id)).toBe(true);
    expect(await posted(r.id)).toBe(true);
    // Back at the cost the bill's line left at.
    const left = await q<{ unit_cost: string }>(
      `SELECT m.unit_cost FROM erp.stock_movements m JOIN erp.sales_lines l ON l.id = m.source_line_id
       WHERE l.document_id = $1`,
      [s.id],
    );
    expect((await journalOf(r.id)).find((l) => l.code === '1300')).toEqual({
      code: '1300',
      debit: Number(left[0]!.unit_cost),
      credit: 0,
    });
  });

  it('of a bill version 1 counters still push: a plain sale stays V1', async () => {
    const s = sale(counter, [['OIL001', 1, 120000]]);
    expect(s.version).toBe(1);
    expect(results(await push(counter, [s]))).toEqual([['accepted', null, []]]);
  });
});

describe("the branch's 90-day bills (SYN-01, sync spec §3)", () => {
  it('send only their columns, the returns with their original line, and leave out older bills', async () => {
    const old = sale(counter, [['OIL001', 1, 120000]], 'cash', Date.now() - 100 * 86_400_000);
    await push(counter, [old]);
    const s = sale(counter, [['OIL001', 1, 120000]]);
    await push(counter, [s]);
    const r = returnOf(other, s, [{ lineNo: 1, units: 1 }]);
    await push(other, [r]);

    const changes = await pull(other, 'bills,bill_lines,bill_payments');
    const bills = changes.bills!;
    expect(bills.some((b) => b.id === old.id)).toBe(false);
    const mine = bills.find((b) => b.id === r.id)!;
    expect(Object.keys(mine).sort()).toEqual(
      [
        'id',
        'number',
        'device_id',
        'kind',
        'status',
        'business_date',
        'created_at_device',
        'customer_party_id',
        'walkin_phone',
        'total',
        'return_of_id',
        'row_version',
        'deleted_at',
      ].sort(),
    );
    expect(mine).toMatchObject({ kind: 'return', return_of_id: s.id, total: '-120000' });
    const soldLine = changes.bill_lines!.find((l) => l.document_id === s.id)!;
    const back = changes.bill_lines!.find((l) => l.document_id === r.id)!;
    expect(back).toMatchObject({ qty: '-1.000', line_total: '-120000', original_line_id: soldLine.id });
    expect(changes.bill_lines!.some((l) => l.document_id === old.id)).toBe(false);
    expect(Object.keys(changes.bill_payments![0]!).sort()).toEqual(
      ['id', 'document_id', 'method_id', 'amount', 'row_version', 'deleted_at'].sort(),
    );
    expect(changes.bill_payments!.some((p) => p.document_id === old.id)).toBe(false);
  });

  it("sends the tenant's return window", async () => {
    expect((await pull(counter, 'tenant')).tenant![0]).toMatchObject({ return_window_days: 30 });
  });
});

describe('the rebuild (ACC-02, rule 4)', () => {
  beforeAll(async () => openShop('rebuilt'));

  it('replays sales, returns, exchanges, payouts and a return that waited, with no difference', async () => {
    const s = sale(counter, [
      ['OIL001', 3, 120000],
      ['PAD001', 1, 450000],
    ]);
    await push(counter, [s]);
    const r = returnOf(other, s, [{ lineNo: 1, units: 1 }]);
    await push(other, [r]);
    await push(desk, [payout(r)]);
    const e = returnOf(other, s, [{ lineNo: 2, units: 1, condition: 'defective' }], {
      returned: {},
      sold: [['OIL001', 1, 120000]],
    });
    await push(other, [e]);
    const rest = returnOf(counter, s, [{ lineNo: 1, units: 2 }], {
      returned: { 1: { qty: 1000, refund: 120000 } },
    });
    expect(results(await push(counter, [rest]))).toEqual([['accepted', null, []]]);

    await q("UPDATE erp.payment_methods SET bank_account_id = NULL WHERE code = 'card'");
    const late = sale(counter, [['OIL001', 1, 120000]], 'card');
    await push(counter, [late]);
    await push(other, [returnOf(other, late, [{ lineNo: 1, units: 1 }])]);
    await q(
      `UPDATE erp.payment_methods SET bank_account_id = (SELECT id FROM erp.bank_accounts WHERE code = 'card')
       WHERE code = 'card'`,
    );
    await postPending(pool, shop.tenantId, { now: () => new Date() });
    expect((await checkRebuild(pool, shop.tenantId)).differences).toEqual([]);
  });
});
