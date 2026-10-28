import {
  CATALOG_COLUMNS,
  CATALOG_DATASETS,
  exportPublicKey,
  generateDeviceKey,
  signCanonical,
  verifyPin,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import { createTenant, createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Pull for counters and the counter PIN change (sync spec v1 §2–§5, W1-02, D-089), and the catalog datasets (W1-03).

type DeviceKeys = Awaited<ReturnType<typeof generateDeviceKey>>;

const SHOP = 'sync-shop';
const OTHER = 'sync-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';
const USER_COLUMNS = [
  'deleted_at',
  'full_name',
  'id',
  'pin_must_change',
  'pin_verifier',
  'row_version',
  'short_code',
  'status',
  'username',
];

let db: TestDatabase;
let pool: pg.Pool;
let tenant: string;
let other: string;
let branch: string;
let secondBranch: string;
let token: string;
let otherToken: string;
const ids: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date() });

async function addUser(
  username: string,
  role: RoleTemplateKey,
  tenantId = tenant,
  branchId: string | null = null,
) {
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
      'INSERT INTO erp.user_roles (tenant_id, user_id, role_id, branch_id) VALUES ($1, $2, $3, $4)',
      [tenantId, rows[0]!.id, r.rows[0]!.id, branchId],
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

/** Enrolls a counter for `branchId` and returns its device token (W0-10 flow). */
async function enrolledToken(cookie: string, branchId: string, shop: string, tenantId: string) {
  const code = (await post('/api/devices/enrollment-codes', { branchId, kind: 'counter' }, cookie)).json<{
    code: string;
  }>().code;
  const keys: DeviceKeys = await generateDeviceKey();
  const publicKey = await exportPublicKey(keys.publicKey);
  const signature = await signCanonical(keys.privateKey, { tenantCode: shop, code, publicKey });
  const enrolled = await post('/api/devices/enroll', { tenantCode: shop, code, publicKey, signature });
  const { deviceId } = enrolled.json<{ deviceId: string }>();
  const { nonce } = (await post('/api/devices/challenge', { tenantId, deviceId })).json<{ nonce: string }>();
  const sig = await signCanonical(keys.privateKey, { tenantId, deviceId, nonce });
  const res = await post('/api/devices/token', { tenantId, deviceId, nonce, signature: sig });
  return { token: res.json<{ accessToken: string }>().accessToken, deviceId };
}

const pull = (deviceToken: string, query: string) =>
  app().inject({
    method: 'GET',
    url: `/api/sync/pull?${query}`,
    headers: { authorization: `Device ${deviceToken}` },
  });

type PullBody = { changes: Record<string, Record<string, unknown>[]>; cursor: string; hasMore: boolean };

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  tenant = await createTenant(db.ownerUrl, 'Sync Shop', SHOP);
  other = await createTenant(db.ownerUrl, 'Other Shop', OTHER);
  [branch, secondBranch] = await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    const a = await c.query<{ id: string }>(
      "INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'MAIN', 'Main') RETURNING id",
      [tenant],
    );
    const b = await c.query<{ id: string }>(
      "INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'TWO', 'Two') RETURNING id",
      [tenant],
    );
    return [a.rows[0]!.id, b.rows[0]!.id];
  });
  const otherBranch = await withTenant(
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
  ids['boss'] = await addUser('boss', 'manager');
  ids['sara'] = await addUser('sara', 'salesman');
  ids['ali'] = await addUser('ali', 'salesman', tenant, secondBranch);
  ids['nadia'] = await addUser('nadia', 'cashier');
  await addUser('otherboss', 'manager', other);
  token = (await enrolledToken(await login('boss'), branch, SHOP, tenant)).token;
  otherToken = (await enrolledToken(await login('otherboss', OTHER), otherBranch, OTHER, other)).token;
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('pull', () => {
  it('sends users with only the listed columns: PIN verifiers yes, password hashes and e-mails never', async () => {
    const res = await pull(token, 'datasets=users');
    expect(res.statusCode, res.body).toBe(200);
    const users = res.json<PullBody>().changes['users']!;
    expect(users.map((u) => u['username']).sort()).toEqual(['ali', 'boss', 'nadia', 'sara']);
    for (const u of users) expect(Object.keys(u).sort()).toEqual(USER_COLUMNS);
    expect(res.body).not.toContain('$argon2');
    expect(res.body).not.toContain('@example.test');
  });

  it('pages with an opaque cursor until hasMore is false, every row once', async () => {
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const res = await pull(token, `datasets=users,roles&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<PullBody>();
      for (const rows of Object.values(body.changes)) {
        expect(rows.length).toBeLessThanOrEqual(2);
        for (const r of rows) seen.push(String(r['id']));
      }
      cursor = body.cursor;
      if (!body.hasMore) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(4 + 3); // 4 users, 3 roles (manager, salesman, cashier)
  });

  it('returns only what changed after the cursor, including soft deletes', async () => {
    const first = (await pull(token, 'datasets=users')).json<PullBody>();
    const nothing = (await pull(token, `datasets=users&cursor=${first.cursor}`)).json<PullBody>();
    expect(nothing.changes['users'] ?? []).toEqual([]);
    await withTenant(pool, { tenantId: tenant }, (_db, c) =>
      c.query("UPDATE erp.users SET full_name = 'Nadia K', deleted_at = now() WHERE id = $1", [ids['nadia']]),
    );
    const next = (await pull(token, `datasets=users&cursor=${first.cursor}`)).json<PullBody>();
    expect(next.changes['users']).toHaveLength(1);
    expect(next.changes['users']![0]).toMatchObject({ username: 'nadia', full_name: 'Nadia K' });
    expect(next.changes['users']![0]!['deleted_at']).not.toBeNull();
  });

  it("sends the device's branch and tenant settings, and only its branch's branch-specific roles", async () => {
    const body = (await pull(token, 'datasets=tenant,branch,user_roles')).json<PullBody>();
    expect(body.changes['tenant']).toEqual([
      expect.objectContaining({ id: tenant, name: 'Sync Shop', closing_time: '20:00:00' }),
    ]);
    expect(body.changes['branch']!.map((b) => b['code'])).toEqual(['MAIN']);
    expect(body.changes['user_roles']!.some((r) => r['user_id'] === ids['ali'])).toBe(false);
  });

  it('sends the offline warning thresholds with the tenant: 8 and 48 hours by default (SYN-06, W1-07)', async () => {
    const body = (await pull(token, 'datasets=tenant')).json<PullBody>();
    expect(body.changes['tenant']).toEqual([
      expect.objectContaining({ offline_warning_hours: 8, offline_strong_warning_hours: 48 }),
    ]);
  });

  it("never shows another tenant's rows", async () => {
    const body = (await pull(otherToken, 'datasets=users')).json<PullBody>();
    expect(body.changes['users']!.map((u) => u['username'])).toEqual(['otherboss']);
  });

  it('refuses unknown datasets, bad cursors and limits, and requests without a valid device token', async () => {
    expect((await pull(token, 'datasets=stock_balances')).json()).toEqual({ error: 'unknown_dataset' });
    expect((await pull(token, 'datasets=users&cursor=not-a-cursor')).json()).toEqual({ error: 'bad_cursor' });
    expect((await pull(token, 'datasets=users&limit=5000')).json()).toEqual({ error: 'bad_limit' });
    expect((await app().inject({ method: 'GET', url: '/api/sync/pull?datasets=users' })).statusCode).toBe(
      401,
    );
    expect(
      (await pull(`${tenant}.not-a-real-token-at-all-0000000000000000000`, 'datasets=users')).statusCode,
    ).toBe(401);
  });
});

describe('temporary PINs', () => {
  const setTemporary = (cookie: string, userId: string, pin: string) =>
    app().inject({
      method: 'PUT',
      url: `/api/users/${userId}/temporary-pin`,
      headers: { origin: ORIGIN, host: HOST },
      cookies: { erp_session: cookie },
      payload: { pin },
    });
  const change = (userId: string, currentPin: string, newPin: string, t = token) =>
    app().inject({
      method: 'POST',
      url: '/api/sync/pin',
      headers: { authorization: `Device ${t}` },
      payload: { userId, currentPin, newPin },
    });

  it('a manager (admin.devices) can set one, a salesman cannot', async () => {
    expect((await setTemporary(await login('sara'), ids['ali']!, '8642')).statusCode).toBe(403);
    expect((await setTemporary(await login('boss'), ids['sara']!, '8642')).statusCode).toBe(204);
    const sara = (await pull(token, 'datasets=users'))
      .json<PullBody>()
      .changes['users']!.find((u) => u['username'] === 'sara')!;
    expect(sara['pin_must_change']).toBe(true);
    expect(await verifyPin(String(sara['pin_verifier']), '8642')).toBe(true);
  });

  it("the counter changes it to the person's own PIN only with the right temporary PIN and a good new one", async () => {
    expect((await change(ids['sara']!, '1111', '5739')).statusCode).toBe(401);
    expect((await change(ids['sara']!, '8642', '1234')).json()).toEqual({
      error: 'weak_pin',
      problem: 'sequence',
    });
    expect((await change(ids['sara']!, '8642', '5739')).statusCode).toBe(204);
    const sara = (await pull(token, 'datasets=users'))
      .json<PullBody>()
      .changes['users']!.find((u) => u['username'] === 'sara')!;
    expect(sara['pin_must_change']).toBe(false);
    expect(await verifyPin(String(sara['pin_verifier']), '5739')).toBe(true);
    // Now it's the person's own PIN, not a temporary one.
    expect((await change(ids['sara']!, '5739', '9182')).json()).toEqual({ error: 'not_temporary' });
    const audit = await withTenant(pool, { tenantId: tenant }, (_db, c) =>
      c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM erp.audit_log WHERE action = 'pin.changed' AND entity_id = $1 AND device_id IS NOT NULL",
        [ids['sara']],
      ),
    );
    expect(audit.rows[0]!.n).toBe(1);
  });

  it('5 wrong temporary PINs lock the change', async () => {
    await setTemporary(await login('boss'), ids['boss']!, '7531');
    for (let i = 0; i < 5; i++) expect((await change(ids['boss']!, '0000', '2468')).statusCode).toBe(401);
    expect((await change(ids['boss']!, '7531', '2468')).json()).toEqual({ error: 'pin_locked' });
  });

  it("a counter can't change another tenant's user", async () => {
    expect((await change(ids['ali']!, '0000', '2468', otherToken)).statusCode).toBe(404);
  });
});

describe('catalog pull (W1-03)', () => {
  const ALL = CATALOG_DATASETS.join(',');
  let pads = '';

  beforeAll(async () => {
    await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
      const ids = await seedCatalog(c, tenant, [
        {
          code: 'BRPD001',
          name: 'BRAKE PADS FRONT COROLLA',
          category: 'BRPD',
          brand: 'KASHIYAMA',
          origin: 'JAPAN',
          variant: 'FRONT',
          bin: 'R3-B2',
          oem: ['04465-02220'],
          vehicles: [{ make: 'TOYOTA', model: 'COROLLA', from: 2009, to: 2014 }],
          prices: { RETAIL: 450000, MECHANIC: 427500, WHOLESALE: 405000 },
          legacy: { ItemID: 1, CostPrice: '3100' },
        },
        {
          code: 'FNBL001',
          name: 'FAN BELT CULTUS',
          category: 'FNBL',
          spec: '4PK-855',
          oem: ['17521-77E00'],
          alternate: ['17521-77E00-000'],
          vehicles: [{ make: 'SUZUKI', model: 'CULTUS', from: 2017 }],
          prices: { RETAIL: 130000 },
        },
      ]);
      pads = ids['BRPD001']!;
      // A supplier on the item: it must not reach the counter.
      const supplier = await c.query<{ id: string }>(
        "INSERT INTO erp.parties (tenant_id, code, name) VALUES ($1, 'SUP1', 'Supplier One') RETURNING id",
        [tenant],
      );
      await c.query(
        'UPDATE erp.items SET default_supplier_id = $1, min_qty = 2, max_qty = 10 WHERE id = $2',
        [supplier.rows[0]!.id, pads],
      );
    });
    await withTenant(pool, { tenantId: other }, (_db, c) =>
      seedCatalog(c, other, [
        { code: 'OTHER001', name: 'OTHER SHOP ITEM', category: 'MISC', oem: ['99999-00000'] },
      ]),
    );
  });

  const pullAllPages = async (deviceToken: string, limit: number, start = '') => {
    const rows: Record<string, Record<string, unknown>[]> = {};
    let cursor = start;
    for (let page = 0; page < 200; page++) {
      const res = await pull(
        deviceToken,
        `datasets=${ALL}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<PullBody>();
      for (const [dataset, list] of Object.entries(body.changes)) (rows[dataset] ??= []).push(...list);
      cursor = body.cursor;
      if (!body.hasMore) return { rows, cursor };
    }
    throw new Error('the pull never finished');
  };

  it('every catalog dataset sends exactly its listed columns: never legacy, suppliers or reorder settings', async () => {
    const { rows } = await pullAllPages(token, 1000);
    for (const dataset of CATALOG_DATASETS) {
      const expected = [...Object.keys(CATALOG_COLUMNS[dataset]), 'row_version', 'deleted_at'].sort();
      expect(rows[dataset]?.length, dataset).toBeGreaterThan(0);
      for (const r of rows[dataset]!) expect(Object.keys(r).sort(), dataset).toEqual(expected);
    }
    const item = rows['items']!.find((r) => r['code'] === 'BRPD001')!;
    expect(item).toMatchObject({ name: 'BRAKE PADS FRONT COROLLA', variant: 'FRONT', bin_location: 'R3-B2' });
    expect(item).not.toHaveProperty('legacy');
    expect(item).not.toHaveProperty('default_supplier_id');
    const body = JSON.stringify(rows);
    expect(body).not.toContain('CostPrice');
    expect(body).not.toContain('Supplier One');
    expect(rows['item_prices']!.filter((p) => p['item_id'] === pads).map((p) => p['price'])).toEqual(
      expect.arrayContaining(['450000', '427500', '405000']),
    );
    expect(rows['item_identifiers']!.filter((x) => x['item_id'] === pads)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'barcode', value: 'BRPD001', normalized_value: 'BRPD001' }),
        expect.objectContaining({ kind: 'oem', value: '04465-02220', normalized_value: '0446502220' }),
      ]),
    );
    expect(rows['item_compatibility']!.find((v) => v['item_id'] === pads)).toMatchObject({
      model: 'COROLLA',
      year_from: 2009,
      year_to: 2014,
    });
  });

  it('pages through every catalog row exactly once', async () => {
    const { rows } = await pullAllPages(token, 7);
    const counts = await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
      const out: Record<string, number> = {};
      for (const dataset of CATALOG_DATASETS) {
        const r = await c.query<{ n: string }>(`SELECT count(*) AS n FROM erp.${dataset}`);
        out[dataset] = Number(r.rows[0]!.n);
      }
      return out;
    });
    for (const dataset of CATALOG_DATASETS) {
      const ids = (rows[dataset] ?? []).map((r) => String(r['id']));
      expect(new Set(ids).size, dataset).toBe(ids.length);
      expect(ids.length, dataset).toBe(counts[dataset]);
    }
  });

  it('sends a removed identifier as a tombstone after the cursor', async () => {
    const { cursor } = await pullAllPages(token, 1000);
    await withTenant(pool, { tenantId: tenant }, (_db, c) =>
      c.query("UPDATE erp.item_identifiers SET deleted_at = now() WHERE value = '17521-77E00-000'"),
    );
    const { rows } = await pullAllPages(token, 1000, cursor);
    expect(rows['item_identifiers']).toEqual([
      expect.objectContaining({ value: '17521-77E00-000', deleted_at: expect.any(String) as unknown }),
    ]);
    expect(rows['items'] ?? []).toEqual([]);
  });

  it("never sends another tenant's catalog", async () => {
    const mine = JSON.stringify((await pullAllPages(token, 1000)).rows);
    expect(mine).not.toContain('OTHER001');
    const theirs = (await pullAllPages(otherToken, 1000)).rows;
    expect(theirs['items']!.map((r) => r['code'])).toEqual(['OTHER001']);
  });
});

describe('checkout pull (W1-06)', () => {
  // Sync spec §3, checkout datasets: payment methods, print profiles and the calling device's own row.
  const CHECKOUT = 'payment_methods,print_profiles,device';
  let first: { token: string; deviceId: string };
  let second: { token: string; deviceId: string };
  let a5 = '';
  let a4 = '';

  beforeAll(async () => {
    const cookie = await login('boss');
    first = await enrolledToken(cookie, branch, SHOP, tenant);
    second = await enrolledToken(cookie, branch, SHOP, tenant);
    await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
      const glAccount = await c.query<{ id: string }>(
        `INSERT INTO erp.accounts (tenant_id, code, name, type, is_postable)
         VALUES ($1, '1170', 'JazzCash', 'asset', true) RETURNING id`,
        [tenant],
      );
      const wallet = await c.query<{ id: string }>(
        `INSERT INTO erp.bank_accounts (tenant_id, code, name, kind, gl_account_id)
         VALUES ($1, 'jazzcash', 'JazzCash', 'wallet', $2) RETURNING id`,
        [tenant, glAccount.rows[0]!.id],
      );
      await c.query(
        `INSERT INTO erp.payment_methods (tenant_id, code, name, is_cash, requires_reference, bank_account_id, sort)
         VALUES ($1, 'cash', 'Cash', true, false, NULL, 1),
                ($1, 'jazzcash', 'JazzCash', false, true, $2, 2),
                ($1, 'on_account', 'On account', false, false, NULL, 3)`,
        [tenant, wallet.rows[0]!.id],
      );
      const p = await c.query<{ id: string; paper_format: string }>(
        `INSERT INTO erp.print_profiles (tenant_id, name, paper_format, code_type, copies, template_options,
           is_tenant_default)
         VALUES ($1, 'A5 landscape dot matrix', 'a5', 'barcode', 1,
                 '{"headerLines": ["Shop 14, Auto Market"], "policyText": "Returns within 30 days."}', true),
                ($1, 'A4 laser', 'a4', 'barcode', 2, '{}', false)
         RETURNING id, paper_format`,
        [tenant],
      );
      a5 = p.rows.find((r) => r.paper_format === 'a5')!.id;
      a4 = p.rows.find((r) => r.paper_format === 'a4')!.id;
      await c.query('UPDATE erp.devices SET print_profile_id = $1 WHERE id = $2', [a4, second.deviceId]);
    });
  });

  const pullCheckout = async (deviceToken: string) => {
    const res = await pull(deviceToken, `datasets=${CHECKOUT}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<PullBody>().changes;
  };

  it('sends payment methods with only their listed columns: never the bank account', async () => {
    const methods = (await pullCheckout(first.token))['payment_methods']!;
    expect(methods.map((m) => m['code'])).toEqual(expect.arrayContaining(['cash', 'jazzcash', 'on_account']));
    for (const m of methods)
      expect(Object.keys(m).sort()).toEqual(
        [
          'code',
          'deleted_at',
          'id',
          'is_active',
          'is_cash',
          'name',
          'requires_reference',
          'row_version',
          'sort',
        ].sort(),
      );
    expect(methods.find((m) => m['code'] === 'jazzcash')).toMatchObject({
      requires_reference: true,
      sort: 2,
    });
  });

  it('sends print profiles with their template options', async () => {
    const profiles = (await pullCheckout(first.token))['print_profiles']!;
    for (const p of profiles)
      expect(Object.keys(p).sort()).toEqual(
        [
          'code_type',
          'copies',
          'deleted_at',
          'id',
          'is_tenant_default',
          'name',
          'paper_format',
          'row_version',
          'template_options',
        ].sort(),
      );
    expect(profiles.find((p) => p['id'] === a5)).toMatchObject({
      paper_format: 'a5',
      is_tenant_default: true,
      template_options: { headerLines: ['Shop 14, Auto Market'], policyText: 'Returns within 30 days.' },
    });
  });

  it("sends only the calling device's own row, with its print profile and never its public key", async () => {
    const mine = (await pullCheckout(first.token))['device']!;
    expect(mine).toEqual([
      {
        id: first.deviceId,
        code: expect.stringMatching(/^C\d{2,}$/) as unknown,
        print_profile_id: null,
        status: 'active',
        row_version: expect.any(String) as unknown,
        deleted_at: null,
      },
    ]);
    const theirs = (await pullCheckout(second.token))['device']!;
    expect(theirs.map((d) => [d['id'], d['print_profile_id']])).toEqual([[second.deviceId, a4]]);
  });

  it("never sends another tenant's methods, profiles or devices", async () => {
    const changes = await pullCheckout(otherToken);
    expect(changes['payment_methods'] ?? []).toEqual([]);
    expect(changes['print_profiles'] ?? []).toEqual([]);
    expect(JSON.stringify(changes['device'])).not.toContain(first.deviceId);
  });
});
