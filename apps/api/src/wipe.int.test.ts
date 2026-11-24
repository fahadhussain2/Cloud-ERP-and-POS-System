import {
  exportPublicKey,
  generateDeviceKey,
  signCanonical,
  TenantSpec,
  uuidv7,
  type PushRequest,
} from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import {
  buildSaleDocument,
  buildVoidDocument,
  money,
  ROLE_TEMPLATES,
  type Bill,
  type Qty,
  type SaleDocument,
} from '@erp/domain';
import { checkRebuild, KEPT_TABLES, markLive, WIPED_TABLES, WipeRefused, wipePilot } from '@erp/posting';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';

// The pilot wipe (W1-14, owner answer 1, D-101): before the final run the shadow pilot's documents and everything
// derived from them go, the masters, staff and settings stay, the counters are revoked to be enrolled again; refused
// while a counter has unsynced documents and once the shop is live.

const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Client;
let tenantId: string;
let branchId: string;
let seller: string;
let owner: string;
let retail: string;
let pads: string;
let counter: {
  token: string;
  deviceId: string;
  code: string;
  keys: Awaited<ReturnType<typeof generateDeviceKey>>;
};
const app = () => buildApp({ pool, now: () => new Date() });

const httpPost = (url: string, payload: unknown, cookie?: string) =>
  app().inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, host: HOST },
    payload: payload as Record<string, unknown>,
    ...(cookie ? { cookies: { erp_session: cookie } } : {}),
  });

async function enroll() {
  const login = await httpPost('/api/auth/login', {
    tenantCode: 'delux',
    username: 'fahad',
    password: PASSWORD,
  });
  const cookie = login.cookies.find((x) => x.name === 'erp_session')!.value;
  const code = (await httpPost('/api/devices/enrollment-codes', { branchId, kind: 'counter' }, cookie)).json<{
    code: string;
  }>().code;
  const keys = await generateDeviceKey();
  const publicKey = await exportPublicKey(keys.publicKey);
  const signature = await signCanonical(keys.privateKey, { tenantCode: 'delux', code, publicKey });
  const enrolled = (
    await httpPost('/api/devices/enroll', { tenantCode: 'delux', code, publicKey, signature })
  ).json<{
    deviceId: string;
    code: string;
  }>();
  const challenge = (
    await httpPost('/api/devices/challenge', { tenantId, deviceId: enrolled.deviceId })
  ).json<{
    nonce: string;
  }>();
  const tokenSignature = await signCanonical(keys.privateKey, {
    tenantId,
    deviceId: enrolled.deviceId,
    nonce: challenge.nonce,
  });
  const token = (
    await httpPost('/api/devices/token', {
      tenantId,
      deviceId: enrolled.deviceId,
      nonce: challenge.nonce,
      signature: tokenSignature,
    })
  ).json<{ accessToken: string }>().accessToken;
  return { token, deviceId: enrolled.deviceId, code: enrolled.code, keys };
}

/** A cash sale of one brake pad at Rs 4,500, pushed; the counter had `outbox` documents before this push. */
async function pushSale(seq: number, outbox: number): Promise<SaleDocument> {
  const bill: Bill = {
    version: 1,
    sellerId: seller,
    tierId: retail,
    lines: [
      {
        id: 'l1',
        itemId: pads,
        qty: 1000 as Qty,
        allowsFraction: false,
        list: money(450000),
        floor: null,
        unitPrice: money(450000),
        approval: null,
      },
    ],
    billDiscount: money(0),
    billApproval: null,
  };
  const doc = buildSaleDocument({
    bill,
    tender: { payments: [{ method: 'cash', amount: money(450000), reference: null }], cashReceived: null },
    methods: [{ code: 'cash', isCash: true, requiresReference: false }],
    sellerMaxDiscountBp: 0,
    customer: { id: null, walkinPhone: null },
    credit: null,
    creditApproval: null,
    context: {
      id: uuidv7(),
      seq,
      deviceId: counter.deviceId,
      deviceCode: counter.code,
      branchId,
      createdAtMs: Date.now() - 1000,
      timeZone: 'Asia/Karachi',
      cutoffHour: 4,
      increment: money(100),
      clientVersion: '0.7.0',
    },
  });
  await push({ id: doc.id, family: 'S', seq, payload: doc }, outbox);
  return doc;
}

/** One document pushed by the counter, which reports `outbox` documents still waiting. */
async function push(d: { id: string; family: 'S' | 'V'; seq: number; payload: object }, outbox: number) {
  const body: PushRequest = {
    clientVersion: '0.7.0',
    schemaVersion: 6,
    deviceClock: new Date().toISOString(),
    health: {
      outboxCount: outbox,
      oldestUnsyncedAt: null,
      quarantinedCount: 0,
      storagePersisted: true,
      storageUsage: 1,
      storageQuota: 2,
      lastPullAt: null,
    },
    documents: [{ ...d, signature: await signCanonical(counter.keys.privateKey, d.payload) }],
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

const count = async (table: string) =>
  Number((await admin.query<{ n: string }>(`SELECT count(*) AS n FROM erp.${table}`)).rows[0]!.n);

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  ({ tenantId } = await setupTenant(db.ownerUrl, TenantSpec.parse(deluxSpec), {
    ownerPasswordHash: await hashPassword(PASSWORD),
    mustChangePassword: false,
  }));
  await withTenant(pool, { tenantId }, async (_db, c) => {
    const one = async (sql: string) => (await c.query<{ id: string }>(sql)).rows[0]!.id;
    branchId = await one('SELECT id FROM erp.branches');
    owner = await one("SELECT id FROM erp.users WHERE username = 'fahad'");
    retail = await one("SELECT id FROM erp.price_tiers WHERE code = 'RETAIL'");
    const role = await one(`SELECT id FROM erp.roles WHERE template_key = 'salesman'`);
    seller = (
      await c.query<{ id: string }>(
        `INSERT INTO erp.users (tenant_id, username, full_name, password_hash) VALUES ($1, 'sara', 'Sara', 'x')
         RETURNING id`,
        [tenantId],
      )
    ).rows[0]!.id;
    await c.query(
      'INSERT INTO erp.user_roles (tenant_id, user_id, role_id, branch_id) VALUES ($1, $2, $3, NULL)',
      [tenantId, seller, role],
    );
    pads = (
      await seedCatalog(c, tenantId, [
        { code: 'BRPD001', name: 'BRAKE PADS', category: 'BRPD', prices: { RETAIL: 450000 } },
      ])
    )['BRPD001']!;
  });
  counter = await enroll();
  // The counter still holds a second bill: the server records one waiting.
  await pushSale(1, 2);
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.drop();
});

describe('the pilot wipe', () => {
  it('has a decision for every table: wiped or kept', async () => {
    const { rows } = await admin.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'erp' AND table_type = 'BASE TABLE'",
    );
    const decided = [...KEPT_TABLES, ...WIPED_TABLES];
    expect(new Set(decided).size).toBe(decided.length);
    expect([...decided].sort()).toEqual(rows.map((r) => r.table_name).sort());
  });

  it('is refused while a counter reports unsynced documents', async () => {
    await expect(wipePilot(db.ownerUrl, tenantId, { userId: null, now: new Date() })).rejects.toThrow(
      WipeRefused,
    );
    expect(await count('sales_documents')).toBe(1);
  });

  it('removes the documents and everything derived from them; keeps the masters, staff and settings', async () => {
    const second = await pushSale(2, 1);
    // A voided bill points at its void and the void at the bill (0013): the wipe must remove both (staging, 24 Nov).
    const v = buildVoidDocument({
      bill: {
        id: second.id,
        number: second.number,
        deviceId: second.deviceId,
        businessDate: second.businessDate,
        total: second.amounts.total,
        cashDue: second.cashDue,
        status: 'finalized',
        payments: second.payments,
      },
      answers: Object.fromEntries(second.payments.map((p) => [p.method, 'not_arrived' as const])),
      deviceId: counter.deviceId,
      branchId,
      deskStatus: 'pending',
      approverId: owner,
      approverGrants: [{ ...ROLE_TEMPLATES.owner, branchId: null }],
      reason: 'wrong_price',
      note: null,
      userId: seller,
      context: {
        id: uuidv7(),
        seq: 1,
        deviceId: counter.deviceId,
        deviceCode: counter.code,
        branchId,
        createdAtMs: Date.now() - 500,
        timeZone: 'Asia/Karachi',
        cutoffHour: 4,
        clientVersion: '0.7.0',
      },
    });
    await push({ id: v.id, family: 'V', seq: 1, payload: v }, 0);
    expect(await count('sales_voids')).toBe(1);
    const voided = await admin.query("SELECT 1 FROM erp.sales_documents WHERE status = 'voided'");
    expect(voided.rowCount).toBe(1);
    expect(await count('postings')).toBeGreaterThanOrEqual(2);
    const keptBefore = await Promise.all(['items', 'item_prices', 'users', 'accounts', 'parties'].map(count));
    const report = await wipePilot(db.ownerUrl, tenantId, { userId: null, now: new Date() });
    for (const table of [
      'sales_documents',
      'sales_lines',
      'sales_payments',
      'sales_voids',
      'sync_inbox',
      'device_series',
      'postings',
      'journal_entries',
      'journal_lines',
      'stock_movements',
      'item_costs',
      'exceptions',
    ])
      expect(await count(table), table).toBe(0);
    expect(report.removed['sales_documents']).toBe(2);
    expect(report.devicesRevoked).toEqual([counter.code]);
    const stock = await admin.query<{ qty: string }>('SELECT qty::text FROM erp.stock_balances');
    expect(stock.rows.every((r) => Number(r.qty) === 0)).toBe(true);
    expect(await Promise.all(['items', 'item_prices', 'users', 'accounts', 'parties'].map(count))).toEqual(
      keptBefore,
    );
    const audit = await admin.query("SELECT 1 FROM erp.audit_log WHERE action = 'pilot.wipe'");
    expect(audit.rowCount).toBe(1);
    expect((await checkRebuild(pool, tenantId)).differences).toEqual([]);
  });

  it('is refused once the shop is live', async () => {
    await markLive(db.ownerUrl, tenantId, { userId: null, lockDate: '2026-12-31', now: new Date() });
    const t = await admin.query<{ lock_date: string; live: boolean }>(
      'SELECT lock_date::text, go_live_at IS NOT NULL AS live FROM erp.tenants WHERE id = $1',
      [tenantId],
    );
    expect(t.rows[0]).toEqual({ lock_date: '2026-12-31', live: true });
    await expect(wipePilot(db.ownerUrl, tenantId, { userId: null, now: new Date() })).rejects.toThrow(
      'refused: the shop is live',
    );
    await expect(
      markLive(db.ownerUrl, tenantId, { userId: null, lockDate: '2026-12-31', now: new Date() }),
    ).rejects.toThrow('already live');
  });
});
