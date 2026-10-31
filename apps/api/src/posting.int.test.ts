import {
  exportPublicKey,
  generateDeviceKey,
  signCanonical,
  TenantSpec,
  uuidv7,
  type PushDocument,
  type PushRequest,
  type PushResponse,
} from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import {
  buildSaleDocument,
  money,
  type Bill,
  type PaymentMethodCode,
  type PaymentMethodInfo,
  type Qty,
  type SaleDocument,
} from '@erp/domain';
import { applyRebuild, checkRebuild, postDocument, postPending, RebuildRefused } from '@erp/posting';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Posting inside push (architecture §5.2 step 4, §7; W1-08): every accepted sale gets its journal entry, stock
// movements and balances in the same transaction (ACC-02, INV-01); a sale that can't be posted is still accepted
// and flagged (SYN-03) and posted later by the catch-up; the rebuild check replays everything and must match.
// Two tenants from the Delux spec: `post` has costs seeded by hand (receipts and opening stock come with W1-14 and
// W1-16), `rebuild` has none, so its ledgers come only from postings and a rebuild must reproduce them exactly.

type DeviceKeys = Awaited<ReturnType<typeof generateDeviceKey>>;
interface Shop {
  code: string;
  tenantId: string;
  branchId: string;
  shopLocation: string;
  seller: string;
  retail: string;
  items: Record<string, string>;
}
interface Counter {
  shop: Shop;
  token: string;
  deviceId: string;
  code: string;
  keys: DeviceKeys;
  seq: number;
}
interface Line {
  item: string;
  qty: number;
  price: number;
}

const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';
const METHODS: PaymentMethodInfo[] = [
  { code: 'cash', isCash: true, requiresReference: false },
  { code: 'raast', isCash: false, requiresReference: true },
  { code: 'jazzcash', isCash: false, requiresReference: true },
];
const ITEMS = [
  {
    code: 'BRPD001',
    name: 'BRAKE PADS FRONT COROLLA',
    category: 'BRPD',
    floor: 400000,
    prices: { RETAIL: 450000 },
  },
  { code: 'OIL001', name: 'ENGINE OIL 4L', category: 'OIL', floor: 100000, prices: { RETAIL: 120000 } },
  { code: 'NEW001', name: 'WIPER BLADE 18IN', category: 'WIPER', floor: 50000, prices: { RETAIL: 60000 } },
];

let db: TestDatabase;
let pool: pg.Pool;
let owner: pg.Client;
let post: Shop;
let rebuild: Shop;
const app = () => buildApp({ pool, now: () => new Date() });

const specFor = (code: string, raast: string | null) =>
  TenantSpec.parse({
    ...deluxSpec,
    code,
    name: `${code} shop`,
    paymentMethods: deluxSpec.paymentMethods.map((m) =>
      m.code === 'raast' || m.code === 'bank_transfer' ? { ...m, bankAccount: raast } : m,
    ),
  });

const setup = async (code: string, raast: string | null) =>
  setupTenant(db.ownerUrl, specFor(code, raast), {
    ownerPasswordHash: await hashPassword(PASSWORD),
    mustChangePassword: false,
  });

const q = <T extends pg.QueryResultRow>(shop: Shop, sql: string, params: unknown[] = []) =>
  withTenant(pool, { tenantId: shop.tenantId }, async (_db, c) => (await c.query<T>(sql, params)).rows);

const asOwner = async (shop: Shop, sql: string, params: unknown[] = []) => {
  await owner.query('BEGIN');
  await owner.query("SELECT set_config('app.tenant_id', $1, true)", [shop.tenantId]);
  await owner.query(sql, params);
  await owner.query('COMMIT');
};

async function makeShop(code: string, raast: string | null): Promise<Shop> {
  const { tenantId } = await setup(code, raast);
  return withTenant(pool, { tenantId }, async (_db, c) => {
    const one = async (sql: string) => (await c.query<{ id: string }>(sql)).rows[0]!.id;
    const role = await one(`SELECT id FROM erp.roles WHERE template_key = 'salesman'`);
    const seller = (
      await c.query<{ id: string }>(
        `INSERT INTO erp.users (tenant_id, username, full_name, email, password_hash)
         VALUES ($1, 'sara', 'Sara', 'sara@example.test', $2) RETURNING id`,
        [tenantId, await hashPassword(PASSWORD)],
      )
    ).rows[0]!.id;
    await c.query(
      'INSERT INTO erp.user_roles (tenant_id, user_id, role_id, branch_id) VALUES ($1, $2, $3, NULL)',
      [tenantId, seller, role],
    );
    return {
      code,
      tenantId,
      branchId: await one('SELECT id FROM erp.branches'),
      shopLocation: await one("SELECT id FROM erp.locations WHERE code = 'SHOP'"),
      seller,
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

async function enroll(shop: Shop): Promise<Counter> {
  const login = await httpPost('/api/auth/login', {
    tenantCode: shop.code,
    username: 'fahad',
    password: PASSWORD,
  });
  const cookie = login.cookies.find((x) => x.name === 'erp_session')!.value;
  const code = (
    await httpPost('/api/devices/enrollment-codes', { branchId: shop.branchId, kind: 'counter' }, cookie)
  ).json<{ code: string }>().code;
  const keys = await generateDeviceKey();
  const publicKey = await exportPublicKey(keys.publicKey);
  const signature = await signCanonical(keys.privateKey, { tenantCode: shop.code, code, publicKey });
  const enrolled = (
    await httpPost('/api/devices/enroll', { tenantCode: shop.code, code, publicKey, signature })
  ).json<{
    deviceId: string;
    code: string;
  }>();
  const challenge = (
    await httpPost('/api/devices/challenge', { tenantId: shop.tenantId, deviceId: enrolled.deviceId })
  ).json<{ nonce: string }>();
  const tokenSignature = await signCanonical(keys.privateKey, {
    tenantId: shop.tenantId,
    deviceId: enrolled.deviceId,
    nonce: challenge.nonce,
  });
  const token = (
    await httpPost('/api/devices/token', {
      tenantId: shop.tenantId,
      deviceId: enrolled.deviceId,
      nonce: challenge.nonce,
      signature: tokenSignature,
    })
  ).json<{ accessToken: string }>().accessToken;
  return { shop, token, deviceId: enrolled.deviceId, code: enrolled.code, keys, seq: 0 };
}

/** The counter's next sale (W1-06), at list price; paid in cash unless `payments` says otherwise. */
function sale(counter: Counter, lines: Line[], payments?: [PaymentMethodCode, number][]): SaleDocument {
  const bill: Bill = {
    version: 1,
    sellerId: counter.shop.seller,
    tierId: counter.shop.retail,
    lines: lines.map((l, i) => ({
      id: `l${i + 1}`,
      itemId: counter.shop.items[l.item]!,
      qty: l.qty as Qty,
      allowsFraction: false,
      list: money(l.price),
      floor: null,
      unitPrice: money(l.price),
      approval: null,
    })),
    billDiscount: money(0),
    billApproval: null,
  };
  const total = lines.reduce((t, l) => t + (l.qty / 1000) * l.price, 0);
  counter.seq += 1;
  return buildSaleDocument({
    bill,
    tender: {
      payments: (payments ?? [['cash', total]]).map(([method, amount]) => ({
        method,
        amount: money(amount),
        reference: method === 'cash' ? null : 'REF123',
      })),
      cashReceived: null,
    },
    methods: METHODS,
    sellerMaxDiscountBp: 0,
    hasCreditCustomer: false,
    context: {
      id: uuidv7(),
      seq: counter.seq,
      deviceId: counter.deviceId,
      deviceCode: counter.code,
      branchId: counter.shop.branchId,
      createdAtMs: Date.now() - 1000,
      timeZone: 'Asia/Karachi',
      cutoffHour: 4,
      increment: money(100),
      clientVersion: '0.7.0',
    },
  });
}

async function push(counter: Counter, docs: SaleDocument[]): Promise<PushResponse> {
  const documents: PushDocument[] = await Promise.all(
    docs.map(async (d) => ({
      id: d.id,
      family: 'S' as const,
      seq: d.seq,
      payload: d,
      signature: await signCanonical(counter.keys.privateKey, d),
    })),
  );
  const body: PushRequest = {
    clientVersion: '0.7.0',
    schemaVersion: 6,
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
  return res.json<PushResponse>();
}

const journalOf = (shop: Shop, documentId: string) =>
  q<{ number: string; code: string; debit: number; credit: number; party: string | null }>(
    shop,
    `SELECT e.number, a.code, l.debit::int AS debit, l.credit::int AS credit, p.code AS party
     FROM erp.journal_entries e JOIN erp.journal_lines l ON l.entry_id = e.id JOIN erp.accounts a ON a.id = l.account_id
     LEFT JOIN erp.parties p ON p.id = l.party_id
     WHERE e.source_type = 'sale' AND e.source_id = $1 ORDER BY l.line_no`,
    [documentId],
  );

const exceptionsOf = (shop: Shop, documentId: string) =>
  q<{ kind: string; status: string; details: Record<string, unknown> }>(
    shop,
    'SELECT kind, status, details FROM erp.exceptions WHERE document_id = $1 ORDER BY kind',
    [documentId],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 6 });
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  post = await makeShop('post', null);
  rebuild = await makeShop('rebuild', 'hbl');
  // Costs and shelf stock for `post`, as W1-14 and W1-16 will post them: pads Rs 3,100 (5 on hand), oil Rs 800 (2).
  await withTenant(pool, { tenantId: post.tenantId }, async (_db, c) => {
    for (const [code, avg, onHand] of [
      ['BRPD001', 310000, 5],
      ['OIL001', 80000, 2],
    ] as const) {
      await c.query(
        'INSERT INTO erp.item_costs (tenant_id, item_id, avg_cost, on_hand) VALUES ($1, $2, $3, $4)',
        [post.tenantId, post.items[code], avg, onHand],
      );
      await c.query(
        'INSERT INTO erp.stock_balances (tenant_id, item_id, location_id, qty) VALUES ($1, $2, $3, $4)',
        [post.tenantId, post.items[code], post.shopLocation, onHand],
      );
    }
  });
});

afterAll(async () => {
  await owner?.end();
  await pool?.end();
  await db?.drop();
});

describe('posting inside push (ACC-02, INV-01, INV-03)', () => {
  let c: Counter;

  beforeAll(async () => {
    c = await enroll(post);
  });

  it('posts an accepted cash sale in the same transaction: entry, movements, balances, order of record', async () => {
    const doc = sale(c, [
      { item: 'BRPD001', qty: 1000, price: 450000 },
      { item: 'OIL001', qty: 1000, price: 120000 },
    ]);
    const r = await push(c, [doc]);
    expect(r.results).toEqual([{ id: doc.id, status: 'accepted', exceptions: [], error: null }]);

    expect(await journalOf(post, doc.id)).toEqual([
      { number: 'J000001', code: '1120', debit: 570000, credit: 0, party: null },
      { number: 'J000001', code: '4100', debit: 0, credit: 570000, party: null },
      { number: 'J000001', code: '5100', debit: 390000, credit: 0, party: null },
      { number: 'J000001', code: '1300', debit: 0, credit: 390000, party: null },
    ]);
    expect(
      await q(
        post,
        `SELECT i.code, (m.qty_delta * 1000)::int AS qty, m.unit_cost::int AS unit_cost,
           m.value_delta::int AS value_delta, m.avg_cost_after::int AS avg_after, m.location_id = $2 AS in_shop,
           m.source_line_id = l.id AS from_line
         FROM erp.stock_movements m JOIN erp.items i ON i.id = m.item_id
         JOIN erp.sales_lines l ON l.document_id = $1 AND l.item_id = m.item_id
         WHERE m.source_type = 'sale' AND m.source_id = $1 ORDER BY l.line_no`,
        [doc.id, post.shopLocation],
      ),
    ).toEqual([
      {
        code: 'BRPD001',
        qty: -1000,
        unit_cost: 310000,
        value_delta: -310000,
        avg_after: 310000,
        in_shop: true,
        from_line: true,
      },
      {
        code: 'OIL001',
        qty: -1000,
        unit_cost: 80000,
        value_delta: -80000,
        avg_after: 80000,
        in_shop: true,
        from_line: true,
      },
    ]);
    expect(
      await q(
        post,
        `SELECT i.code, (b.qty * 1000)::int AS shelf, (k.on_hand * 1000)::int AS on_hand, k.avg_cost::int AS avg
         FROM erp.items i JOIN erp.stock_balances b ON b.item_id = i.id JOIN erp.item_costs k ON k.item_id = i.id
         WHERE i.code IN ('BRPD001', 'OIL001') ORDER BY i.code`,
      ),
    ).toEqual([
      { code: 'BRPD001', shelf: 4000, on_hand: 4000, avg: 310000 },
      { code: 'OIL001', shelf: 1000, on_hand: 1000, avg: 80000 },
    ]);
    const [p] = await q<{ seq: number; entry_date: string; context: { accounts: { roles: object } } }>(
      post,
      "SELECT seq::int, entry_date::text, context FROM erp.postings WHERE source_type = 'sale' AND source_id = $1",
      [doc.id],
    );
    expect(p).toMatchObject({ seq: 1, entry_date: doc.businessDate });
    expect(Object.keys(p!.context.accounts.roles)).toContain('SALES');
  });

  it('posts nothing twice when the counter pushes the same bill again', async () => {
    const doc = sale(c, [{ item: 'OIL001', qty: 1000, price: 120000 }]);
    await push(c, [doc]);
    const again = await push(c, [doc]);
    expect(again.results[0]!.status).toBe('duplicate');
    expect(await journalOf(post, doc.id)).toHaveLength(4);
    expect(
      await q(
        post,
        "SELECT count(*)::int AS n FROM erp.stock_movements WHERE source_type = 'sale' AND source_id = $1",
        [doc.id],
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('flags the shelf going below zero once, and still posts the sale (INV-03)', async () => {
    // OIL001 has 0 on the shelf now.
    const first = sale(c, [{ item: 'OIL001', qty: 1000, price: 120000 }]);
    const second = sale(c, [{ item: 'OIL001', qty: 1000, price: 120000 }]);
    const r = await push(c, [first, second]);
    expect(r.results.map((x) => x.status)).toEqual(['accepted', 'accepted']);
    expect((await exceptionsOf(post, first.id)).map((e) => e.kind)).toEqual(['negative_stock']);
    expect(await exceptionsOf(post, second.id)).toEqual([]);
    expect(await journalOf(post, second.id)).toHaveLength(4);
  });

  it('posts an item with no cost yet at 0 and flags no_cost (owner answer 2)', async () => {
    const doc = sale(c, [{ item: 'NEW001', qty: 1000, price: 60000 }]);
    await push(c, [doc]);
    expect((await exceptionsOf(post, doc.id)).map((e) => e.kind)).toEqual(['negative_stock', 'no_cost']);
    expect(await q(post, 'SELECT exception_count FROM erp.sales_documents WHERE id = $1', [doc.id])).toEqual([
      { exception_count: 2 },
    ]);
    expect((await journalOf(post, doc.id)).map((l) => l.code)).toEqual(['1120', '4100']);
  });

  it('gives every line its tax code: the item’s own, or the tenant default, with no tax (ACC-09)', async () => {
    const gst = (
      await q<{ id: string }>(
        post,
        "INSERT INTO erp.tax_codes (tenant_id, code, name, rate_bp) VALUES ($1, 'GST17', 'GST 17%', 1700) RETURNING id",
        [post.tenantId],
      )
    )[0]!.id;
    await q(post, 'UPDATE erp.items SET tax_code_id = $1 WHERE id = $2', [gst, post.items['BRPD001']]);
    const doc = sale(c, [
      { item: 'BRPD001', qty: 1000, price: 450000 },
      { item: 'OIL001', qty: 1000, price: 120000 },
    ]);
    await push(c, [doc]);
    expect(
      await q(
        post,
        `SELECT t.code, l.tax_amount::int AS tax FROM erp.sales_lines l JOIN erp.tax_codes t ON t.id = l.tax_code_id
         WHERE l.document_id = $1 ORDER BY l.line_no`,
        [doc.id],
      ),
    ).toEqual([
      { code: 'GST17', tax: 0 },
      { code: 'ZERO', tax: 0 },
    ]);
  });

  it('posts a sale on account to the customer’s ledger and balance, due after their terms (ACC-03)', async () => {
    const party = (
      await q<{ id: string }>(
        post,
        "INSERT INTO erp.parties (tenant_id, code, name) VALUES ($1, 'KHAN', 'Khan Motors') RETURNING id",
        [post.tenantId],
      )
    )[0]!.id;
    await q(
      post,
      `INSERT INTO erp.customer_accounts (tenant_id, party_id, price_tier_id, credit_allowed, offline_daily_cap,
         payment_terms_days) VALUES ($1, $2, $3, true, 0, 30)`,
      [post.tenantId, party, post.retail],
    );
    // The counter sells on account from W1-09; this bill is changed by hand the way it will look then.
    const doc = {
      ...sale(c, [{ item: 'BRPD001', qty: 1000, price: 450000 }]),
      customerId: party,
      cashDue: money(0),
      handoverStatus: 'not_applicable' as const,
    };
    doc.payments = [
      { method: 'on_account', amount: money(450000), cashReceived: null, changeDue: null, reference: null },
    ];
    const r = await push(c, [doc]);
    expect(r.results[0]!.status).toBe('accepted');
    expect((await journalOf(post, doc.id)).slice(0, 2)).toEqual([
      { number: expect.any(String) as string, code: '1200', debit: 450000, credit: 0, party: 'KHAN' },
      { number: expect.any(String) as string, code: '4100', debit: 0, credit: 450000, party: null },
    ]);
    const due = new Date(`${doc.businessDate}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + 30);
    expect(
      await q(
        post,
        `SELECT role, amount::int, entry_date::text, due_date::text FROM erp.party_ledger_entries
         WHERE source_type = 'sale' AND source_id = $1`,
        [doc.id],
      ),
    ).toEqual([
      {
        role: 'customer',
        amount: 450000,
        entry_date: doc.businessDate,
        due_date: due.toISOString().slice(0, 10),
      },
    ]);
    expect(
      await q(post, 'SELECT role, balance::int FROM erp.party_balances WHERE party_id = $1', [party]),
    ).toEqual([{ role: 'customer', balance: 450000 }]);
  });

  it('posts bills from two counters arriving together one after the other, in a recorded order', async () => {
    const c2 = await enroll(post);
    const [a, b] = [
      sale(c, [{ item: 'BRPD001', qty: 1000, price: 450000 }]),
      sale(c2, [{ item: 'BRPD001', qty: 1000, price: 450000 }]),
    ];
    const before = await q<{ on_hand: number }>(
      post,
      'SELECT (on_hand * 1000)::int AS on_hand FROM erp.item_costs WHERE item_id = $1',
      [post.items['BRPD001']],
    );
    await Promise.all([push(c, [a]), push(c2, [b])]);
    const seqs = await q<{ seq: number }>(
      post,
      'SELECT seq::int FROM erp.postings WHERE source_id = ANY ($1) ORDER BY seq',
      [[a.id, b.id]],
    );
    expect(seqs).toHaveLength(2);
    expect(seqs[1]!.seq - seqs[0]!.seq).toBe(1);
    expect(
      await q(post, 'SELECT (on_hand * 1000)::int AS on_hand FROM erp.item_costs WHERE item_id = $1', [
        post.items['BRPD001'],
      ]),
    ).toEqual([{ on_hand: before[0]!.on_hand - 2000 }]);
  });

  it('answers already_posted when asked to post a posted bill', async () => {
    const doc = sale(c, [{ item: 'OIL001', qty: 1000, price: 120000 }]);
    await push(c, [doc]);
    const outcome = await withTenant(pool, { tenantId: post.tenantId }, (_db, cl) =>
      postDocument(cl, { tenantId: post.tenantId, type: 'sale', id: doc.id, now: new Date() }),
    );
    expect(outcome).toEqual({ status: 'already_posted' });
  });

  it('keeps the line cost on the movement only: sales_lines has no unit_cost (rule 3)', async () => {
    expect(
      await q(
        post,
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'erp' AND table_name = 'sales_lines' AND column_name = 'unit_cost'",
      ),
    ).toEqual([]);
  });

  it('keeps another tenant’s ledgers out (rule 5)', async () => {
    const mine = await q<{ n: number }>(post, 'SELECT count(*)::int AS n FROM erp.postings');
    expect(mine[0]!.n).toBeGreaterThan(0);
    const ids = (await q<{ source_id: string }>(post, 'SELECT source_id FROM erp.postings')).map(
      (r) => r.source_id,
    );
    expect(await q(rebuild, 'SELECT 1 FROM erp.postings WHERE source_id = ANY ($1)', [ids])).toEqual([]);
    expect(await q(rebuild, 'SELECT 1 FROM erp.journal_entries WHERE source_id = ANY ($1)', [ids])).toEqual(
      [],
    );
  });
});

describe('a bill that can’t be posted yet (SYN-03): accepted, flagged, posted by the catch-up', () => {
  let c: Counter;
  let held: SaleDocument[];

  beforeAll(async () => {
    c = await enroll(post);
    held = [
      sale(c, [{ item: 'OIL001', qty: 1000, price: 120000 }], [['raast', 120000]]),
      sale(c, [{ item: 'BRPD001', qty: 1000, price: 450000 }], [['raast', 450000]]),
    ];
  });

  it('accepts a Raast bill while Raast has no account, with posting_failed and nothing half-posted', async () => {
    const r = await push(c, held);
    // The answer to the counter is unchanged: posting is the server's business (and old counters know no new kinds).
    expect(r.results.map((x) => [x.status, x.exceptions])).toEqual([
      ['accepted', []],
      ['accepted', []],
    ]);
    for (const d of held) {
      expect(await exceptionsOf(post, d.id)).toEqual([
        { kind: 'posting_failed', status: 'open', details: { code: 'method_unmapped' } },
      ]);
      expect(await journalOf(post, d.id)).toEqual([]);
      expect(await q(post, 'SELECT 1 FROM erp.stock_movements WHERE source_id = $1', [d.id])).toEqual([]);
      expect(await q(post, 'SELECT 1 FROM erp.postings WHERE source_id = $1', [d.id])).toEqual([]);
    }
  });

  it('keeps trying without piling up exceptions while the cause is there', async () => {
    expect(await postPending(pool, post.tenantId, { now: () => new Date() })).toEqual({
      posted: 0,
      failed: 2,
    });
    expect(await postPending(pool, post.tenantId, { now: () => new Date() })).toEqual({
      posted: 0,
      failed: 2,
    });
    for (const d of held) expect(await exceptionsOf(post, d.id)).toHaveLength(1);
  });

  it('posts them in the order they arrived once Raast is mapped to HBL, and notes it on the exception', async () => {
    await setup('post', 'hbl');
    expect(await postPending(pool, post.tenantId, { now: () => new Date() })).toEqual({
      posted: 2,
      failed: 0,
    });
    const seqs = await q<{ source_id: string }>(
      post,
      'SELECT source_id FROM erp.postings WHERE source_id = ANY ($1) ORDER BY seq',
      [held.map((d) => d.id)],
    );
    expect(seqs.map((s) => s.source_id)).toEqual(held.map((d) => d.id));
    expect((await journalOf(post, held[0]!.id))[0]).toMatchObject({ code: '1160', debit: 120000 });
    const [e] = await exceptionsOf(post, held[0]!.id);
    expect(e).toMatchObject({ kind: 'posting_failed', status: 'open', details: { code: 'method_unmapped' } });
    expect(typeof e!.details['postedAt']).toBe('string');
    expect(await postPending(pool, post.tenantId, { now: () => new Date() })).toEqual({
      posted: 0,
      failed: 0,
    });
  });
});

describe('bills that never post (PR #84 review)', () => {
  let c: Counter;
  const stuck: SaleDocument[] = [];

  /** A sale on account with no customer: accepted, and posting refuses it every time. */
  const onAccountWithoutCustomer = () => {
    const d = sale(c, [{ item: 'OIL001', qty: 1000, price: 120000 }]);
    return {
      ...d,
      cashDue: money(0),
      handoverStatus: 'not_applicable' as const,
      payments: [
        {
          method: 'on_account' as const,
          amount: money(120000),
          cashReceived: null,
          changeDue: null,
          reference: null,
        },
      ],
    };
  };

  beforeAll(async () => {
    c = await enroll(post);
    stuck.push(onAccountWithoutCustomer(), onAccountWithoutCustomer());
    await push(c, stuck);
  });

  it('stays accepted and flagged when the posting can’t even start (the lock times out)', async () => {
    const holder = new pg.Client({ connectionString: db.ownerUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT set_config('app.tenant_id', $1, true)", [post.tenantId]);
      await holder.query('SELECT 1 FROM erp.posting_state FOR UPDATE');
      const outcome = await withTenant(pool, { tenantId: post.tenantId }, async (_db, cl) => {
        await cl.query("SET LOCAL lock_timeout = '200ms'");
        return postDocument(cl, { tenantId: post.tenantId, type: 'sale', id: stuck[0]!.id, now: new Date() });
      });
      expect(outcome).toMatchObject({ status: 'failed', code: 'internal_error' });
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });

  it('reaches every pending bill in one run, however many never post', async () => {
    const r = await postPending(pool, post.tenantId, { now: () => new Date(), pageSize: 1 });
    expect(r.failed).toBeGreaterThanOrEqual(2);
    expect(r.posted).toBe(0);
  });
});

describe('the rebuild check (ACC-02, rule 4)', () => {
  let c: Counter;
  let d: Counter;
  const raastBills: SaleDocument[] = [];

  beforeAll(async () => {
    c = await enroll(rebuild);
    d = await enroll(rebuild);
    const shapes: { lines: Line[]; pay?: (total: number) => [PaymentMethodCode, number][] }[] = [
      { lines: [{ item: 'BRPD001', qty: 1000, price: 450000 }] },
      { lines: [{ item: 'OIL001', qty: 2000, price: 120000 }], pay: (t) => [['raast', t]] },
      {
        lines: [
          { item: 'NEW001', qty: 1000, price: 60000 },
          { item: 'BRPD001', qty: 1000, price: 450000 },
        ],
        pay: (t) => [
          ['cash', 10000],
          ['jazzcash', t - 10000],
        ],
      },
    ];
    for (let i = 0; i < 30; i += 1) {
      const counter = i % 2 === 0 ? c : d;
      const s = shapes[i % shapes.length]!;
      const total = s.lines.reduce((t, l) => t + (l.qty / 1000) * l.price, 0);
      const doc = sale(counter, s.lines, s.pay?.(total));
      if (s.pay && s.pay(total)[0]![0] === 'raast') raastBills.push(doc);
      const r = await push(counter, [doc]);
      expect(r.results[0]!.status).toBe('accepted');
    }
  });

  it('finds no difference between the live ledgers and a replay of the documents', async () => {
    expect(await q(rebuild, 'SELECT count(*)::int AS n FROM erp.postings')).toEqual([{ n: 30 }]);
    expect(await checkRebuild(pool, rebuild.tenantId)).toEqual({ differences: [] });
  });

  it('still finds none after Raast moves to Soneri: old bills stay on HBL, new ones go to Soneri', async () => {
    await setup('rebuild', 'soneri');
    const doc = sale(c, [{ item: 'OIL001', qty: 1000, price: 120000 }], [['raast', 120000]]);
    await push(c, [doc]);
    expect((await journalOf(rebuild, doc.id))[0]).toMatchObject({ code: '1150', debit: 120000 });
    expect((await journalOf(rebuild, raastBills[0]!.id))[0]).toMatchObject({ code: '1160' });
    expect(await checkRebuild(pool, rebuild.tenantId)).toEqual({ differences: [] });
  });

  it('reports a ledger row changed behind the engine’s back', async () => {
    await asOwner(
      rebuild,
      `UPDATE erp.stock_movements SET unit_cost = unit_cost + 1
       WHERE id = (SELECT id FROM erp.stock_movements ORDER BY posted_at, id LIMIT 1)`,
    );
    const { differences } = await checkRebuild(pool, rebuild.tenantId);
    expect(differences.length).toBeGreaterThan(0);
    expect(differences.join('\n')).toMatch(/stock_movements/);
  });

  it('rewrites the ledgers from the replay when applied, and records it in the audit log', async () => {
    expect(await applyRebuild(db.ownerUrl, rebuild.tenantId, { userId: null, now: new Date() })).toEqual({
      postings: 31,
    });
    expect(await checkRebuild(pool, rebuild.tenantId)).toEqual({ differences: [] });
    expect(
      await q(rebuild, "SELECT count(*)::int AS n FROM erp.audit_log WHERE action = 'posting.rebuild'"),
    ).toEqual([{ n: 1 }]);
  });

  it('refuses to rewrite a locked period', async () => {
    await asOwner(rebuild, 'UPDATE erp.tenants SET lock_date = current_date + 1');
    await expect(
      applyRebuild(db.ownerUrl, rebuild.tenantId, { userId: null, now: new Date() }),
    ).rejects.toBeInstanceOf(RebuildRefused);
  });
});
