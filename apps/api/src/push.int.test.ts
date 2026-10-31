import {
  exportPublicKey,
  generateDeviceKey,
  signCanonical,
  uuidv7,
  type PushDocument,
  type PushEvent,
  type PushRequest,
  type PushResponse,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import { createTenant, createTestDatabase, seedCatalog, seedChart, type TestDatabase } from '@erp/db/testing';
import {
  buildSaleDocument,
  money,
  ROLE_TEMPLATES,
  type Bill,
  type PaymentMethodInfo,
  type Qty,
  type RoleTemplateKey,
  type SaleDocument,
  type Tender,
} from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Push (sync spec §6.2–§8, W1-07): server acceptance and exceptions (SYN-02, SYN-03), sequence gaps and re-push
// after a restore (SYN-05), audit events, device health (PLT-09), revoked devices, and the SSE nudge (SYN-04).

type DeviceKeys = Awaited<ReturnType<typeof generateDeviceKey>>;
interface Counter {
  token: string;
  deviceId: string;
  code: string;
  branchId: string;
  keys: DeviceKeys;
}

const SHOP = 'push-shop';
const OTHER = 'push-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';
const TZ = 'Asia/Karachi';
const METHODS: PaymentMethodInfo[] = [
  { code: 'cash', isCash: true, requiresReference: false },
  { code: 'raast', isCash: false, requiresReference: true },
];

let db: TestDatabase;
let pool: pg.Pool;
let tenant: string;
let other: string;
let branch: string;
let secondBranch: string;
let otherBranch: string;
let shopLocation: string;
let boss: string;
let sara: string;
let retail: string;
let pads: string;
let cashMethod: string;
const app = () => buildApp({ pool, now: () => new Date() });

async function addUser(username: string, role: RoleTemplateKey, tenantId = tenant) {
  const hash = await hashPassword(PASSWORD);
  return withTenant(pool, { tenantId }, async (_db, c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, email, password_hash)
       VALUES ($1, $2, $2, $2 || '@example.test', $3) RETURNING id`,
      [tenantId, username, hash],
    );
    const t = ROLE_TEMPLATES[role];
    const r = await c.query<{ id: string }>(
      `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [tenantId, role, role, t.permissions, t.limits],
    );
    await c.query(
      'INSERT INTO erp.user_roles (tenant_id, user_id, role_id, branch_id) VALUES ($1, $2, $3, NULL)',
      [tenantId, rows[0]!.id, r.rows[0]!.id],
    );
    return rows[0]!.id;
  });
}

const post = (url: string, payload: unknown, cookie?: string) =>
  app().inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, host: HOST },
    payload: payload as Record<string, unknown>,
    ...(cookie ? { cookies: { erp_session: cookie } } : {}),
  });

async function login(username: string, shop = SHOP) {
  const res = await post('/api/auth/login', { tenantCode: shop, username, password: PASSWORD });
  const c = res.cookies.find((x) => x.name === 'erp_session');
  if (!c) throw new Error(`login failed for ${username}: ${res.body}`);
  return c.value;
}

/** A fresh access token from the device's key (platform spec §2); the raw answer when it is refused. */
async function tokenFor(tenantId: string, deviceId: string, keys: DeviceKeys) {
  const challenge = await post('/api/devices/challenge', { tenantId, deviceId });
  if (challenge.statusCode !== 200) return { status: challenge.statusCode, body: challenge.json<object>() };
  const { nonce } = challenge.json<{ nonce: string }>();
  const signature = await signCanonical(keys.privateKey, { tenantId, deviceId, nonce });
  const res = await post('/api/devices/token', { tenantId, deviceId, nonce, signature });
  if (res.statusCode !== 200) return { status: res.statusCode, body: res.json<object>() };
  return { status: 200, token: res.json<{ accessToken: string }>().accessToken };
}

async function enroll(cookie: string, branchId: string, shop = SHOP, tenantId = tenant): Promise<Counter> {
  const code = (await post('/api/devices/enrollment-codes', { branchId, kind: 'counter' }, cookie)).json<{
    code: string;
  }>().code;
  const keys = await generateDeviceKey();
  const publicKey = await exportPublicKey(keys.publicKey);
  const signature = await signCanonical(keys.privateKey, { tenantCode: shop, code, publicKey });
  const enrolled = (
    await post('/api/devices/enroll', { tenantCode: shop, code, publicKey, signature })
  ).json<{
    deviceId: string;
    code: string;
  }>();
  const t = await tokenFor(tenantId, enrolled.deviceId, keys);
  return { token: t.token!, deviceId: enrolled.deviceId, code: enrolled.code, branchId, keys };
}

interface SaleOptions {
  /** Minor units per unit; the list price is Rs 4,500 and the floor Rs 4,000. */
  price?: number;
  item?: string;
  createdAtMs?: number;
  tender?: Tender;
  id?: string;
}

/** A finalized sale of one item on `counter`, as the counter builds it (W1-06). Below the floor, boss approved it. */
function sale(counter: Counter, seq: number, o: SaleOptions = {}): SaleDocument {
  const price = money(o.price ?? 450000);
  const bill: Bill = {
    version: 1,
    sellerId: sara,
    tierId: retail,
    lines: [
      {
        id: 'l1',
        itemId: o.item ?? pads,
        qty: 1000 as Qty,
        allowsFraction: false,
        list: money(450000),
        floor: money(400000),
        unitPrice: price,
        approval:
          price < 400000
            ? {
                kind: 'below_floor',
                requestedBy: sara,
                approvedBy: boss,
                reason: 'customer_bargain',
                note: null,
                at: new Date().toISOString(),
                values: { list: money(450000), floor: money(400000), price },
              }
            : null,
      },
    ],
    billDiscount: money(0),
    billApproval: null,
  };
  return buildSaleDocument({
    bill,
    tender: o.tender ?? {
      payments: [{ method: 'cash', amount: price, reference: null }],
      cashReceived: null,
    },
    methods: METHODS,
    sellerMaxDiscountBp: 10000,
    hasCreditCustomer: false,
    context: {
      id: o.id ?? uuidv7(),
      seq,
      deviceId: counter.deviceId,
      deviceCode: counter.code,
      branchId: counter.branchId,
      createdAtMs: o.createdAtMs ?? Date.now() - 1000,
      timeZone: TZ,
      cutoffHour: 4,
      increment: money(100),
      clientVersion: '0.7.0',
    },
  });
}

/** An outbox row for `document`, signed by `keys` (the document's own device by default). */
async function signed(counter: Counter, document: unknown, keys = counter.keys): Promise<PushDocument> {
  const d = document as SaleDocument;
  return {
    id: d.id,
    family: 'S',
    seq: d.seq,
    payload: document,
    signature: await signCanonical(keys.privateKey, document),
  };
}

const request = (documents: PushDocument[], over: Partial<PushRequest> = {}): PushRequest => ({
  clientVersion: '0.7.0',
  schemaVersion: 6,
  deviceClock: new Date().toISOString(),
  health: {
    outboxCount: documents.length,
    oldestUnsyncedAt: null,
    quarantinedCount: 0,
    storagePersisted: true,
    storageUsage: 41_000_000,
    storageQuota: 2_000_000_000,
    lastPullAt: null,
  },
  documents,
  events: [],
  ...over,
});

const pushRaw = (counter: Counter | string, body: unknown) =>
  app().inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: { authorization: `Device ${typeof counter === 'string' ? counter : counter.token}` },
    payload: body as Record<string, unknown>,
  });

async function push(counter: Counter, documents: PushDocument[], over: Partial<PushRequest> = {}) {
  const res = await pushRaw(counter, request(documents, over));
  expect(res.statusCode, res.body).toBe(200);
  return res.json<PushResponse>();
}

const statuses = (r: PushResponse) => r.results.map((x) => (x.error ? `${x.status}:${x.error}` : x.status));

const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = [], tenantId = tenant) =>
  withTenant(pool, { tenantId }, async (_db, c) => (await c.query<T>(sql, params)).rows);

const exceptionsOf = (documentId: string) =>
  q<{ kind: string; status: string; device_id: string }>(
    'SELECT kind, status, device_id FROM erp.exceptions WHERE document_id = $1 ORDER BY kind',
    [documentId],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 6 });
  tenant = await createTenant(db.ownerUrl, 'Push Shop', SHOP);
  other = await createTenant(db.ownerUrl, 'Other Shop', OTHER);
  await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    await c.query('UPDATE erp.tenants SET cash_rounding_increment = 100');
    const a = await c.query<{ id: string }>(
      "INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'MAIN', 'Main') RETURNING id",
      [tenant],
    );
    const b = await c.query<{ id: string }>(
      "INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'TWO', 'Two') RETURNING id",
      [tenant],
    );
    [branch, secondBranch] = [a.rows[0]!.id, b.rows[0]!.id];
    shopLocation = (
      await c.query<{ id: string }>(
        `INSERT INTO erp.locations (tenant_id, branch_id, code, name, kind, is_sellable)
         VALUES ($1, $2, 'SHOP', 'Shop', 'shop', true) RETURNING id`,
        [tenant, branch],
      )
    ).rows[0]!.id;
    // Pushed sales are posted (W1-08), so the shop has a chart and Raast has a bank.
    const { bankId } = await seedChart(c, tenant);
    const methods = await c.query<{ id: string; code: string }>(
      `INSERT INTO erp.payment_methods (tenant_id, code, name, is_cash, requires_reference, bank_account_id, sort)
       VALUES ($1, 'cash', 'Cash', true, false, NULL, 1), ($1, 'raast', 'Raast', false, true, $2, 2)
       RETURNING id, code`,
      [tenant, bankId],
    );
    cashMethod = methods.rows.find((m) => m.code === 'cash')!.id;
    const ids = await seedCatalog(c, tenant, [
      {
        code: 'BRPD001',
        name: 'BRAKE PADS FRONT COROLLA',
        category: 'BRPD',
        floor: 400000,
        prices: { RETAIL: 450000 },
      },
    ]);
    pads = ids['BRPD001']!;
    // A cost and plenty on the shelf, so posting adds no no_cost or negative_stock exceptions here (W1-08).
    await c.query(
      'INSERT INTO erp.item_costs (tenant_id, item_id, avg_cost, on_hand) VALUES ($1, $2, 310000, 1000)',
      [tenant, pads],
    );
    await c.query(
      'INSERT INTO erp.stock_balances (tenant_id, item_id, location_id, qty) VALUES ($1, $2, $3, 1000)',
      [tenant, pads, shopLocation],
    );
    retail = (await c.query<{ id: string }>("SELECT id FROM erp.price_tiers WHERE code = 'RETAIL'")).rows[0]!
      .id;
  });
  otherBranch = await withTenant(
    pool,
    { tenantId: other },
    async (_db, c) =>
      (
        await c.query<{ id: string }>(
          "INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'MAIN', 'Main') RETURNING id",
          [other],
        )
      ).rows[0]!.id,
  );
  boss = await addUser('boss', 'manager');
  sara = await addUser('sara', 'salesman');
  await addUser('otherboss', 'manager', other);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('push: acceptance (SYN-02, SYN-03)', () => {
  let c: Counter;

  beforeAll(async () => {
    c = await enroll(await login('boss'), branch);
  });

  it('accepts a new sale and stores the document, its lines and payments with money as integers', async () => {
    const doc = sale(c, 1);
    const r = await push(c, [await signed(c, doc)]);
    expect(r.results).toEqual([{ id: doc.id, status: 'accepted', exceptions: [], error: null }]);
    expect(r.series).toEqual([{ family: 'S', through: 1, missing: [] }]);

    const [d] = await q<Record<string, unknown>>('SELECT * FROM erp.sales_documents WHERE id = $1', [doc.id]);
    expect(d).toMatchObject({
      tenant_id: tenant,
      branch_id: branch,
      device_id: c.deviceId,
      number: `${c.code}-S000001`,
      seq: 1,
      kind: 'sale',
      status: 'finalized',
      salesperson_user_id: sara,
      price_tier_id: retail,
      customer_party_id: null,
      subtotal: '450000',
      line_discount_total: '0',
      bill_discount: '0',
      rounding: '0',
      tax_total: '0',
      total: '450000',
      cash_due: '450000',
      handover_status: 'pending',
      client_version: '0.7.0',
      exception_count: 0,
      payload: doc,
    });
    expect(d!['received_at']).toBeInstanceOf(Date);
    expect((d!['created_at_device'] as Date).toISOString()).toBe(doc.createdAt);

    const lines = await q('SELECT * FROM erp.sales_lines WHERE document_id = $1', [doc.id]);
    expect(lines).toEqual([
      expect.objectContaining({
        line_no: 1,
        item_id: pads,
        qty: '1.000',
        list_price: '450000',
        unit_price: '450000',
        line_discount: '0',
        line_total: '450000',
        floor_price_at_sale: '400000',
        location_id: shopLocation,
      }),
    ]);
    const payments = await q('SELECT * FROM erp.sales_payments WHERE document_id = $1', [doc.id]);
    expect(payments).toEqual([
      expect.objectContaining({
        method_id: cashMethod,
        amount: '450000',
        cash_received: null,
        reference: null,
      }),
    ]);
    const [inbox] = await q('SELECT * FROM erp.sync_inbox WHERE document_id = $1', [doc.id]);
    expect(inbox).toMatchObject({ device_id: c.deviceId, family: 'S', seq: 1, status: 'accepted' });
  });

  it('answers a re-sent document as a duplicate with the first result, storing nothing twice (rule 7)', async () => {
    const doc = sale(c, 2);
    const row = await signed(c, doc);
    expect(statuses(await push(c, [row]))).toEqual(['accepted']);
    expect(statuses(await push(c, [row]))).toEqual(['duplicate']);
    const [n] = await q<{ n: string }>('SELECT count(*) AS n FROM erp.sales_documents WHERE id = $1', [
      doc.id,
    ]);
    expect(n!.n).toBe('1');
  });

  it('two pushes of the same document at once: one accepted, one duplicate', async () => {
    const row = await signed(c, sale(c, 3));
    const [a, b] = await Promise.all([pushRaw(c, request([row])), pushRaw(c, request([row]))]);
    const both = [a, b].map((x) => x.json<PushResponse>().results[0]!.status).sort();
    expect(both).toEqual(['accepted', 'duplicate']);
  });

  it('refuses the same id with another payload (id_conflict) and keeps the first', async () => {
    const doc = sale(c, 4);
    await push(c, [await signed(c, doc)]);
    const changed = { ...doc, clientVersion: '0.7.1' };
    expect(statuses(await push(c, [await signed(c, changed)]))).toEqual(['rejected:id_conflict']);
    const [d] = await q<{ client_version: string }>(
      'SELECT client_version FROM erp.sales_documents WHERE id = $1',
      [doc.id],
    );
    expect(d!.client_version).toBe('0.7.0');
  });

  it('refuses another id with a number already taken (seq_conflict)', async () => {
    expect(statuses(await push(c, [await signed(c, sale(c, 4))]))).toEqual(['rejected:seq_conflict']);
  });

  it('refuses an unsigned or wrongly signed document, records bad_signature, and stores nothing', async () => {
    const unsigned = sale(c, 5);
    const r1 = await push(c, [{ ...(await signed(c, unsigned)), signature: null }]);
    expect(statuses(r1)).toEqual(['rejected:unsigned']);

    const forged = sale(c, 5);
    const stranger = await generateDeviceKey();
    const r2 = await push(c, [await signed(c, forged, stranger)]);
    expect(r2.results[0]).toEqual({
      id: forged.id,
      status: 'rejected',
      exceptions: ['bad_signature'],
      error: 'bad_signature',
    });
    expect(await exceptionsOf(forged.id)).toEqual([
      { kind: 'bad_signature', status: 'open', device_id: c.deviceId },
    ]);

    const tampered = await signed(c, sale(c, 5));
    (tampered.payload as SaleDocument).amounts.total = money(1);
    expect(statuses(await push(c, [tampered]))).toEqual(['rejected:bad_signature']);

    const stored = await q('SELECT id FROM erp.sales_documents WHERE id = ANY($1)', [
      [unsigned.id, forged.id],
    ]);
    expect(stored).toEqual([]);
  });

  it('a rejected document is checked again when it comes back fixed', async () => {
    const doc = sale(c, 5);
    expect(statuses(await push(c, [{ ...(await signed(c, doc)), signature: null }]))).toEqual([
      'rejected:unsigned',
    ]);
    expect(statuses(await push(c, [await signed(c, doc)]))).toEqual(['accepted']);
  });

  it('refuses a malformed payload (bad_schema), an unknown version and an id that isn’t this tenant’s', async () => {
    const v2 = { ...sale(c, 6), version: 2 };
    const noLines = { ...sale(c, 6), lines: [] };
    const strangeItem = sale(c, 6, { item: uuidv7() });
    expect(statuses(await push(c, [await signed(c, v2)]))).toEqual(['rejected:bad_schema']);
    expect(statuses(await push(c, [await signed(c, noLines)]))).toEqual(['rejected:bad_schema']);
    expect(statuses(await push(c, [await signed(c, strangeItem)]))).toEqual(['rejected:unknown_reference']);
  });

  it('accepts a below-floor sale without an approval and records the exception (SYN-03, D-011)', async () => {
    const doc = sale(c, 6, { price: 350000 });
    doc.overrides = [];
    const r = await push(c, [await signed(c, doc)]);
    expect(r.results[0]).toEqual({
      id: doc.id,
      status: 'accepted',
      exceptions: ['below_floor_no_override'],
      error: null,
    });
    expect(await exceptionsOf(doc.id)).toEqual([
      { kind: 'below_floor_no_override', status: 'open', device_id: c.deviceId },
    ]);
    const [d] = await q<{ exception_count: number }>(
      'SELECT exception_count FROM erp.sales_documents WHERE id = $1',
      [doc.id],
    );
    expect(d!.exception_count).toBe(1);
  });

  it('accepts a bill paid by a method removed in the back office while the counter was offline (SYN-03)', async () => {
    const raast = {
      payments: [{ method: 'raast', amount: money(450000), reference: 'RST-1' }],
      cashReceived: null,
    };
    const own = await enroll(await login('boss'), branch);
    const doc = sale(own, 1, { tender: raast });
    await q("UPDATE erp.payment_methods SET deleted_at = now() WHERE code = 'raast'");
    try {
      expect(statuses(await push(own, [await signed(own, doc)]))).toEqual(['accepted']);
    } finally {
      await q("UPDATE erp.payment_methods SET deleted_at = NULL WHERE code = 'raast'");
    }
  });

  it('stores the approval of a below-floor sale as an override', async () => {
    const doc = sale(c, 7, { price: 380000 });
    expect(statuses(await push(c, [await signed(c, doc)]))).toEqual(['accepted']);
    const overrides = await q('SELECT * FROM erp.overrides WHERE document_id = $1', [doc.id]);
    expect(overrides).toEqual([
      expect.objectContaining({
        kind: 'below_floor',
        requested_by_user_id: sara,
        approved_by_user_id: boss,
        reason_code: 'customer_bargain',
      }),
    ]);
  });

  it('one bad document in a batch doesn’t hold back the others', async () => {
    const [a, b, d] = [sale(c, 8), sale(c, 9), sale(c, 10)];
    const r = await push(c, [
      await signed(c, a),
      { ...(await signed(c, b)), signature: null },
      await signed(c, d),
    ]);
    expect(statuses(r)).toEqual(['accepted', 'rejected:unsigned', 'accepted']);
    // A rejected document counts as arrived: it waits on the counter, it isn't a gap.
    expect(r.series).toEqual([{ family: 'S', through: 10, missing: [] }]);
  });

  it('records clock skew over 5 minutes once per device and day', async () => {
    const skewed = new Date(Date.now() - 10 * 60_000).toISOString();
    await push(c, [await signed(c, sale(c, 11))], { deviceClock: skewed });
    await push(c, [await signed(c, sale(c, 12))], { deviceClock: skewed });
    const rows = await q("SELECT id FROM erp.exceptions WHERE kind = 'clock_skew' AND device_id = $1", [
      c.deviceId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('refuses a document from a device of another branch (wrong_device)', async () => {
    const elsewhere = await enroll(await login('boss'), secondBranch);
    const doc = sale(elsewhere, 1);
    expect(statuses(await push(c, [await signed(elsewhere, doc)]))).toEqual(['rejected:wrong_device']);
  });

  it('refuses a malformed request and a missing or bad device token', async () => {
    expect((await pushRaw(c, { ...request([]), documents: 'none' })).statusCode).toBe(400);
    expect((await pushRaw('nope', request([]))).statusCode).toBe(401);
  });

  it("keeps each tenant's documents, inbox and exceptions to itself (rule 5)", async () => {
    const theirs = await q('SELECT id FROM erp.sales_documents', [], other);
    const inbox = await q('SELECT document_id FROM erp.sync_inbox', [], other);
    const exceptions = await q('SELECT id FROM erp.exceptions', [], other);
    expect([theirs, inbox, exceptions]).toEqual([[], [], []]);
  });
});

describe('sequence gaps and re-push after a restore (SYN-05)', () => {
  let c: Counter;
  let docs: PushDocument[];

  beforeAll(async () => {
    c = await enroll(await login('boss'), branch);
    docs = await Promise.all([1, 2, 3, 4].map(async (seq) => signed(c, sale(c, seq))));
  });

  it('a missing number is listed, recorded as a gap and a seq_gap exception, and resolved when it arrives', async () => {
    const r = await push(c, [docs[0]!, docs[1]!, docs[3]!]);
    expect(statuses(r)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(r.series).toEqual([{ family: 'S', through: 2, missing: [[3, 3]] }]);
    const gaps = await q<{ from_seq: number; to_seq: number; resolved_at: Date | null }>(
      'SELECT from_seq, to_seq, resolved_at FROM erp.sequence_gaps WHERE device_id = $1',
      [c.deviceId],
    );
    expect(gaps).toEqual([{ from_seq: 3, to_seq: 3, resolved_at: null }]);
    const seqGaps = await q("SELECT id FROM erp.exceptions WHERE kind = 'seq_gap' AND device_id = $1", [
      c.deviceId,
    ]);
    expect(seqGaps).toHaveLength(1);

    const filled = await push(c, [docs[2]!]);
    expect(filled.series).toEqual([{ family: 'S', through: 4, missing: [] }]);
    const after = await q<{ resolved_at: Date | null }>(
      'SELECT resolved_at FROM erp.sequence_gaps WHERE device_id = $1',
      [c.deviceId],
    );
    expect(after[0]!.resolved_at).toBeInstanceOf(Date);
  });

  it('after a restore the handshake shows what the server lost, and re-pushing it is accepted', async () => {
    // A restore to a point before these documents: the server simply no longer has them.
    const admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();
    try {
      await admin.query("SET session_replication_role = 'replica'");
      const ids = docs.map((d) => d.id);
      for (const table of ['sales_payments', 'sales_lines', 'overrides'])
        await admin.query(`DELETE FROM erp.${table} WHERE document_id = ANY($1)`, [ids]);
      await admin.query('DELETE FROM erp.exceptions WHERE device_id = $1', [c.deviceId]);
      await admin.query('DELETE FROM erp.sales_documents WHERE id = ANY($1)', [ids]);
      await admin.query('DELETE FROM erp.sync_inbox WHERE device_id = $1', [c.deviceId]);
      await admin.query('DELETE FROM erp.sequence_gaps WHERE device_id = $1', [c.deviceId]);
      await admin.query('DELETE FROM erp.device_series WHERE device_id = $1', [c.deviceId]);
    } finally {
      await admin.end();
    }

    const handshake = await push(c, []);
    expect(handshake.results).toEqual([]);
    expect(handshake.series).toEqual([]);

    const again = await push(c, docs);
    expect(statuses(again)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    expect(again.series).toEqual([{ family: 'S', through: 4, missing: [] }]);
    expect(statuses(await push(c, docs))).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
  });
});

describe('audit events (sync spec §5, POS spec §13)', () => {
  it('stores PIN locks, manager unlocks and reprints in the audit log once, with the device and the people', async () => {
    const c = await enroll(await login('boss'), branch);
    const doc = sale(c, 1);
    await push(c, [await signed(c, doc)]);
    const events: PushEvent[] = [
      { id: uuidv7(), kind: 'pin.locked', at: '2026-11-02T09:00:00.000Z', userId: sara },
      {
        id: uuidv7(),
        kind: 'pin.unlocked_by_manager',
        at: '2026-11-02T09:01:00.000Z',
        userId: sara,
        byUserId: boss,
      },
      {
        id: uuidv7(),
        kind: 'bill.reprinted',
        at: '2026-11-02T10:20:00.000Z',
        userId: sara,
        documentId: doc.id,
        number: doc.number,
      },
    ];
    const ids = events.map((e) => e.id);
    expect((await push(c, [], { events })).events.sort()).toEqual([...ids].sort());
    expect((await push(c, [], { events })).events.sort()).toEqual([...ids].sort());

    const rows = await q<{
      id: string;
      action: string;
      entity: string;
      entity_id: string;
      user_id: string;
      device_id: string;
      at: Date;
    }>(
      'SELECT id, action, entity, entity_id, user_id, device_id, at FROM erp.audit_log WHERE id = ANY($1) ORDER BY at',
      [ids],
    );
    expect(rows.map((r) => ({ ...r, at: r.at.toISOString() }))).toEqual([
      {
        id: ids[0],
        action: 'pin.locked',
        entity: 'users',
        entity_id: sara,
        user_id: sara,
        device_id: c.deviceId,
        at: events[0]!.at,
      },
      {
        id: ids[1],
        action: 'pin.unlocked_by_manager',
        entity: 'users',
        entity_id: sara,
        user_id: boss,
        device_id: c.deviceId,
        at: events[1]!.at,
      },
      {
        id: ids[2],
        action: 'bill.reprinted',
        entity: 'sales_documents',
        entity_id: doc.id,
        user_id: sara,
        device_id: c.deviceId,
        at: events[2]!.at,
      },
    ]);
  });
});

describe('device health (PLT-09)', () => {
  it('each push and pull updates the counter’s health, shown on the back office Counters list', async () => {
    const cookie = await login('boss');
    const c = await enroll(cookie, branch);
    const listed = async () =>
      (
        await app().inject({
          method: 'GET',
          url: '/api/devices',
          headers: { host: HOST },
          cookies: { erp_session: cookie },
        })
      )
        .json<{ id: string; health: Record<string, unknown> | null }[]>()
        .find((d) => d.id === c.deviceId)!;
    expect((await listed()).health).toBeNull();

    const pulled = await app().inject({
      method: 'GET',
      url: '/api/sync/pull?datasets=tenant',
      headers: { authorization: `Device ${c.token}` },
    });
    expect(pulled.statusCode).toBe(200);
    await push(c, [], {
      clientVersion: '0.7.0',
      schemaVersion: 6,
      health: {
        outboxCount: 3,
        oldestUnsyncedAt: '2026-11-02T10:00:00.000Z',
        quarantinedCount: 1,
        storagePersisted: false,
        storageUsage: 41_000_000,
        storageQuota: 2_000_000_000,
        lastPullAt: null,
      },
    });
    const { health } = await listed();
    expect(health).toMatchObject({
      clientVersion: '0.7.0',
      schemaVersion: 6,
      outboxCount: 3,
      oldestUnsyncedAt: '2026-11-02T10:00:00.000Z',
      quarantinedCount: 1,
      storagePersisted: false,
      storageUsage: 41_000_000,
      storageQuota: 2_000_000_000,
      openGaps: 0,
    });
    for (const key of ['lastSeenAt', 'lastPushAt', 'lastPullAt']) expect(typeof health![key]).toBe('string');
    expect(Math.abs(health!['clockSkewMs'] as number)).toBeLessThan(60_000);
  });

  it('counts the bills a push just delivered as no longer waiting, and the refused ones as needing attention', async () => {
    const cookie = await login('boss');
    const c = await enroll(cookie, branch);
    const health = async () =>
      (
        await app().inject({
          method: 'GET',
          url: '/api/devices',
          headers: { host: HOST },
          cookies: { erp_session: cookie },
        })
      )
        .json<{ id: string; health: Record<string, unknown> }[]>()
        .find((d) => d.id === c.deviceId)!.health;
    const [a, b, d] = [sale(c, 1), sale(c, 2), sale(c, 3)];
    // The counter reports its health as it was before sending: three waiting, the oldest bill 1.
    await push(c, [await signed(c, a), await signed(c, b), { ...(await signed(c, d)), signature: null }], {
      health: {
        outboxCount: 3,
        oldestUnsyncedAt: a.createdAt,
        quarantinedCount: 0,
        storagePersisted: true,
        storageUsage: null,
        storageQuota: null,
        lastPullAt: null,
      },
    });
    expect(await health()).toMatchObject({
      outboxCount: 1,
      quarantinedCount: 1,
      oldestUnsyncedAt: a.createdAt,
    });
    await push(c, [], {
      health: {
        outboxCount: 1,
        oldestUnsyncedAt: d.createdAt,
        quarantinedCount: 1,
        storagePersisted: true,
        storageUsage: null,
        storageQuota: null,
        lastPullAt: null,
      },
    });
    const all = sale(c, 4);
    await push(c, [await signed(c, all)], {
      health: {
        outboxCount: 1,
        oldestUnsyncedAt: all.createdAt,
        quarantinedCount: 0,
        storagePersisted: true,
        storageUsage: null,
        storageQuota: null,
        lastPullAt: null,
      },
    });
    expect(await health()).toMatchObject({ outboxCount: 0, quarantinedCount: 0, oldestUnsyncedAt: null });
  });
});

describe('revoked devices (sync spec §1, owner answer 3)', () => {
  it('a revoked counter is told so; after Re-enable it pushes again, and what it made meanwhile is flagged', async () => {
    const cookie = await login('boss');
    const c = await enroll(cookie, branch);
    const before = sale(c, 1);
    const revoked = await post(`/api/devices/${c.deviceId}/revoke`, {}, cookie);
    expect(revoked.statusCode).toBe(204);
    // Made after the revocation and before Re-enable.
    const during = sale(c, 2, { createdAtMs: Date.now() });

    expect((await pushRaw(c, request([]))).statusCode).toBe(401);
    expect(await tokenFor(tenant, c.deviceId, c.keys)).toEqual({
      status: 401,
      body: { error: 'device_revoked' },
    });

    const salesman = await login('sara');
    expect((await post(`/api/devices/${c.deviceId}/reenable`, {}, salesman)).statusCode).toBe(403);
    expect((await post(`/api/devices/${c.deviceId}/reenable`, {}, cookie)).statusCode).toBe(204);

    const fresh = await tokenFor(tenant, c.deviceId, c.keys);
    expect(fresh.status).toBe(200);
    const back = { ...c, token: fresh.token! };
    const r = await push(back, [await signed(c, before), await signed(c, during)]);
    expect(r.results).toEqual([
      { id: before.id, status: 'accepted', exceptions: [], error: null },
      { id: during.id, status: 'accepted', exceptions: ['revoked_device_doc'], error: null },
    ]);
  });
});

describe('the SSE nudge (SYN-04)', () => {
  /** Opens the stream and collects its text; `ready` resolves on the first bytes (the server's opening comment). */
  async function stream(base: string, token: string) {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/sync/events`, {
      headers: { authorization: `Device ${token}` },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const s = { text: '', close: () => ctrl.abort(), ready: Promise.resolve() };
    let markReady!: () => void;
    s.ready = new Promise<void>((r) => (markReady = r));
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          s.text += decoder.decode(value, { stream: true });
          markReady();
        }
      } catch {
        // aborted
      }
    })();
    return s;
  }

  const waitFor = async (check: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return check();
  };

  it("tells a tenant's counters when a pulled table changes, and nobody else", async () => {
    const mine = await enroll(await login('boss'), branch);
    const theirs = await enroll(await login('otherboss', OTHER), otherBranch, OTHER, other);
    const server = app();
    const base = await server.listen({ port: 0, host: '127.0.0.1' });
    try {
      const a = await stream(base, mine.token);
      const b = await stream(base, theirs.token);
      await Promise.all([a.ready, b.ready]);
      await q('UPDATE erp.item_prices SET price = price + 100 WHERE item_id = $1', [pads]);
      expect(await waitFor(() => a.text.includes('event: changes-available'), 5000)).toBe(true);
      await new Promise((r) => setTimeout(r, 2500));
      expect(b.text).not.toContain('changes-available');
      a.close();
      b.close();
    } finally {
      await server.close();
    }
  });

  it('refuses a stream without a valid device token', async () => {
    const res = await app().inject({
      method: 'GET',
      url: '/api/sync/events',
      headers: { authorization: 'Device nope' },
    });
    expect(res.statusCode).toBe(401);
  });
});
