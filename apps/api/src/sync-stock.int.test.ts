import { exportPublicKey, generateDeviceKey, signCanonical } from '@erp/contracts';
import { withTenant } from '@erp/db';
import { createTenant, createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Stock on the counter (W1-27 plan; POS-02, sync spec §3): the `locations` and `stock_balances` datasets, scoped to
// the device's branch and to shop- and storage-kind locations (not Damaged or In transit), with exactly their listed
// columns (never cost or value), under RLS, and by the change-feed cursor like every other dataset (rule 8).

const SHOP = 'stock-shop';
const OTHER = 'stock-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let pool: pg.Pool;
let tenant: string;
let other: string;
let token: string;
let otherToken: string;
const loc: Record<string, string> = {};
const item: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date() });

const post = (url: string, payload: unknown, cookie?: string) =>
  app().inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, host: HOST },
    payload: payload as Record<string, unknown>,
    ...(cookie ? { cookies: { erp_session: cookie } } : {}),
  });

async function owner(tenantId: string, shop: string) {
  const hash = await hashPassword(PASSWORD);
  await withTenant(pool, { tenantId }, async (_db, c) => {
    const u = await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, email, password_hash)
       VALUES ($1, 'owner', 'Owner', 'owner@example.test', $2) RETURNING id`,
      [tenantId, hash],
    );
    const r = await c.query<{ id: string }>(
      `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits)
       VALUES ($1, 'owner', 'owner', $2, $3) RETURNING id`,
      [tenantId, ROLE_TEMPLATES.owner.permissions, ROLE_TEMPLATES.owner.limits],
    );
    await c.query('INSERT INTO erp.user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
      tenantId,
      u.rows[0]!.id,
      r.rows[0]!.id,
    ]);
  });
  const res = await post('/api/auth/login', { tenantCode: shop, username: 'owner', password: PASSWORD });
  const cookie = res.cookies.find((x) => x.name === 'erp_session')?.value;
  if (!cookie) throw new Error(`login failed: ${res.body}`);
  return cookie;
}

/** Enrolls a counter for `branchId` and returns its device token (W0-10 flow). */
async function counterToken(cookie: string, branchId: string, shop: string, tenantId: string) {
  const { code } = (await post('/api/devices/enrollment-codes', { branchId, kind: 'counter' }, cookie)).json<{
    code: string;
  }>();
  const keys = await generateDeviceKey();
  const publicKey = await exportPublicKey(keys.publicKey);
  const signature = await signCanonical(keys.privateKey, { tenantCode: shop, code, publicKey });
  const { deviceId } = (
    await post('/api/devices/enroll', { tenantCode: shop, code, publicKey, signature })
  ).json<{ deviceId: string }>();
  const { nonce } = (await post('/api/devices/challenge', { tenantId, deviceId })).json<{ nonce: string }>();
  const sig = await signCanonical(keys.privateKey, { tenantId, deviceId, nonce });
  const res = await post('/api/devices/token', { tenantId, deviceId, nonce, signature: sig });
  return res.json<{ accessToken: string }>().accessToken;
}

type PullBody = { changes: Record<string, Record<string, unknown>[]>; cursor: string; hasMore: boolean };
const pull = async (deviceToken: string, datasets: string, cursor?: string) => {
  const res = await app().inject({
    method: 'GET',
    url: `/api/sync/pull?datasets=${datasets}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    headers: { authorization: `Device ${deviceToken}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json<PullBody>();
};

async function places(c: pg.ClientBase, tenantId: string, branchId: string, codes: [string, string][]) {
  for (const [code, kind] of codes)
    loc[`${tenantId === tenant ? '' : 'other:'}${code}`] = (
      await c.query<{ id: string }>(
        `INSERT INTO erp.locations (tenant_id, branch_id, code, name, kind, is_sellable)
         VALUES ($1, $2, $3, initcap($3), $4, $4 = 'shop') RETURNING id`,
        [tenantId, branchId, code, kind],
      )
    ).rows[0]!.id;
}
const balance = (c: pg.ClientBase, tenantId: string, itemId: string, locationId: string, qty: number) =>
  c.query('INSERT INTO erp.stock_balances (tenant_id, item_id, location_id, qty) VALUES ($1, $2, $3, $4)', [
    tenantId,
    itemId,
    locationId,
    qty,
  ]);

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  tenant = await createTenant(db.ownerUrl, 'Stock Shop', SHOP);
  other = await createTenant(db.ownerUrl, 'Other Shop', OTHER);
  const [main, otherMain] = await Promise.all([
    withTenant(pool, { tenantId: tenant }, async (_db, c) => {
      const b = async (code: string) =>
        (
          await c.query<{ id: string }>(
            'INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id',
            [tenant, code],
          )
        ).rows[0]!.id;
      const [one, two] = [await b('MAIN'), await b('TWO')];
      await places(c, tenant, one, [
        ['SHOP', 'shop'],
        ['GODOWN', 'storage'],
        ['DAMAGED', 'damaged'],
        ['TRANSIT', 'transit'],
      ]);
      await places(c, tenant, two, [['SHOP2', 'shop']]);
      Object.assign(
        item,
        await seedCatalog(c, tenant, [
          { code: 'PAD001', name: 'BRAKE PAD SET', category: 'BRPD', prices: { RETAIL: 295000 } },
          {
            code: 'HOS001',
            name: 'BRAKE HOSE',
            category: 'BRPD',
            unit: 'METER',
            fractional: true,
            prices: { RETAIL: 52000 },
          },
        ]),
      );
      await balance(c, tenant, item['PAD001']!, loc['SHOP']!, 8);
      await balance(c, tenant, item['PAD001']!, loc['GODOWN']!, 4);
      await balance(c, tenant, item['PAD001']!, loc['DAMAGED']!, 2);
      await balance(c, tenant, item['PAD001']!, loc['TRANSIT']!, 1);
      await balance(c, tenant, item['PAD001']!, loc['SHOP2']!, 5);
      await balance(c, tenant, item['HOS001']!, loc['SHOP']!, 4.5);
      // Cost lives elsewhere and must never come down with the balances.
      await c.query(
        'INSERT INTO erp.item_costs (tenant_id, item_id, avg_cost, on_hand) VALUES ($1, $2, 218000, 12)',
        [tenant, item['PAD001']],
      );
      return one;
    }),
    withTenant(pool, { tenantId: other }, async (_db, c) => {
      const b = (
        await c.query<{ id: string }>(
          "INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'MAIN', 'Main') RETURNING id",
          [other],
        )
      ).rows[0]!.id;
      await places(c, other, b, [['SHOP', 'shop']]);
      const ids = await seedCatalog(c, other, [
        { code: 'ZZZ001', name: 'OTHER SHOP ITEM', category: 'ZZZ', prices: { RETAIL: 100 } },
      ]);
      await balance(c, other, ids['ZZZ001']!, loc['other:SHOP']!, 7);
      return b;
    }),
  ]);
  token = await counterToken(await owner(tenant, SHOP), main, SHOP, tenant);
  otherToken = await counterToken(await owner(other, OTHER), otherMain, OTHER, other);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('stock on the counter (W1-27)', () => {
  it("sends the branch's Shop and Godown as `locations`, with only their listed columns", async () => {
    const rows = (await pull(token, 'locations')).changes['locations']!;
    expect(rows.map((r) => r['id']).sort()).toEqual([loc['SHOP'], loc['GODOWN']].sort());
    expect(Object.keys(rows[0]!).sort()).toEqual(['code', 'deleted_at', 'id', 'kind', 'name', 'row_version']);
    expect(rows.find((r) => r['id'] === loc['GODOWN'])).toMatchObject({ name: 'Godown', kind: 'storage' });
  });

  it("sends the balances of the branch's Shop and Godown only, with no cost: not Damaged, In transit or another branch", async () => {
    const rows = (await pull(token, 'stock_balances')).changes['stock_balances']!;
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'deleted_at',
      'item_id',
      'location_id',
      'qty',
      'row_version',
    ]);
    const seen = rows.map((r) => `${String(r['item_id'])} ${String(r['location_id'])} ${String(r['qty'])}`);
    expect(seen.sort()).toEqual(
      [
        `${item['PAD001']} ${loc['SHOP']} 8.000`,
        `${item['PAD001']} ${loc['GODOWN']} 4.000`,
        `${item['HOS001']} ${loc['SHOP']} 4.500`,
      ].sort(),
    );
  });

  it('brings a changed balance in the next pull from the last cursor, and nothing else', async () => {
    const first = await pull(token, 'stock_balances');
    // As posting a sale of 3 does: the Shop's balance changes in its own transaction.
    await withTenant(pool, { tenantId: tenant }, (_db, c) =>
      c.query('UPDATE erp.stock_balances SET qty = 5 WHERE item_id = $1 AND location_id = $2', [
        item['PAD001'],
        loc['SHOP'],
      ]),
    );
    const next = await pull(token, 'stock_balances', first.cursor);
    expect(next.changes['stock_balances']).toEqual([
      expect.objectContaining({ item_id: item['PAD001'], location_id: loc['SHOP'], qty: '5.000' }),
    ]);
  });

  it("never sends another shop's locations or balances", async () => {
    const theirs = await pull(otherToken, 'locations,stock_balances');
    expect(theirs.changes['locations']!.map((r) => r['id'])).toEqual([loc['other:SHOP']]);
    expect(theirs.changes['stock_balances']!.map((r) => r['qty'])).toEqual(['7.000']);
  });
});
