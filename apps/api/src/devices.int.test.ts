import {
  exportPublicKey,
  generateDeviceKey,
  parsePinVerifier,
  signCanonical,
  verifyPin,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import { createTenant, createTestDatabase, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Device enrollment, key-based device tokens, revocation and staff PIN (PLT-03, PLT-04, spec, D-082).

type DeviceKeys = Awaited<ReturnType<typeof generateDeviceKey>>;

const SHOP = 'device-shop';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Client;
let tenant: string;
let branch: string;
let now = new Date('2026-11-02T08:00:00Z');
const app = () => buildApp({ pool, now: () => now });
const later = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

async function addUser(username: string, role: RoleTemplateKey, tenantId = tenant) {
  const hash = await hashPassword(PASSWORD);
  await withTenant(pool, { tenantId }, async (_db, c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, short_code, password_hash)
       VALUES ($1, $2, $2, $3, $4) RETURNING id`,
      [tenantId, username, username === 'sara' ? '4821' : null, hash],
    );
    const t = ROLE_TEMPLATES[role];
    const r = await c.query<{ id: string }>(
      `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [tenantId, role, role, t.permissions, t.limits],
    );
    await c.query('INSERT INTO erp.user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
      tenantId,
      rows[0]!.id,
      r.rows[0]!.id,
    ]);
  });
}

async function login(username: string, shop = SHOP) {
  const res = await app().inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { tenantCode: shop, username, password: PASSWORD },
  });
  const c = res.cookies.find((x) => x.name === 'erp_session');
  if (!c) throw new Error(`login failed for ${username}: ${res.body}`);
  return c.value;
}

const post = (url: string, payload: unknown, cookie?: string) =>
  app().inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, host: HOST },
    payload: payload as Record<string, unknown>,
    ...(cookie ? { cookies: { erp_session: cookie } } : {}),
  });

async function newCode(cookie: string, kind = 'counter', branchId = branch) {
  const res = await post('/api/devices/enrollment-codes', { branchId, kind }, cookie);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ code: string; expiresAt: string }>().code;
}

async function enroll(code: string, keys?: DeviceKeys, shop = SHOP) {
  const k = keys ?? (await generateDeviceKey());
  const publicKey = await exportPublicKey(k.publicKey);
  const signature = await signCanonical(k.privateKey, { tenantCode: shop, code, publicKey });
  const res = await post('/api/devices/enroll', { tenantCode: shop, code, publicKey, signature });
  return { res, keys: k };
}

async function deviceToken(deviceId: string, keys: DeviceKeys, tenantId = tenant) {
  const ch = await post('/api/devices/challenge', { tenantId, deviceId });
  if (ch.statusCode !== 200) return { status: ch.statusCode, token: null };
  const { nonce } = ch.json<{ nonce: string }>();
  const signature = await signCanonical(keys.privateKey, { tenantId, deviceId, nonce });
  const res = await post('/api/devices/token', { tenantId, deviceId, nonce, signature });
  return {
    status: res.statusCode,
    token: res.statusCode === 200 ? res.json<{ accessToken: string }>().accessToken : null,
  };
}

const deviceMe = (token: string) =>
  app().inject({ method: 'GET', url: '/api/devices/me', headers: { authorization: `Device ${token}` } });

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  tenant = await createTenant(db.ownerUrl, 'Device Shop', SHOP);
  branch = await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'MAIN', 'Main') RETURNING id",
      [tenant],
    );
    return rows[0]!.id;
  });
  await addUser('maria', 'manager');
  await addUser('sara', 'salesman');
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.drop();
});

describe('enrollment codes', () => {
  it('can be created only with admin.devices, and look like K7Q2-M9XD', async () => {
    const code = await newCode(await login('maria'));
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const res = await post(
      '/api/devices/enrollment-codes',
      { branchId: branch, kind: 'counter' },
      await login('sara'),
    );
    expect(res.statusCode).toBe(403);
  });

  it('are stored only as a hash', async () => {
    const code = await newCode(await login('maria'));
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM erp.device_enrollment_codes WHERE encode(code_hash, 'escape') LIKE $1",
      [`%${code.replace('-', '')}%`],
    );
    expect(rows[0]!.n).toBe(0);
  });
});

describe('enrollment', () => {
  it('registers the device with the next code, once, and records who made the code', async () => {
    const cookie = await login('maria');
    const first = await enroll(await newCode(cookie));
    expect(first.res.statusCode, first.res.body).toBe(201);
    expect(first.res.json()).toMatchObject({
      code: 'C01',
      kind: 'counter',
      branchId: branch,
      tenantId: tenant,
    });

    const code = await newCode(cookie);
    const second = await enroll(code);
    expect(second.res.json()).toMatchObject({ code: 'C02' });

    const reused = await enroll(code);
    expect(reused.res.statusCode).toBe(400);
    expect(reused.res.json()).toEqual({ error: 'enrollment_failed' });

    const desk = await enroll(await newCode(cookie, 'cash_desk'));
    expect(desk.res.json()).toMatchObject({ code: 'D01', kind: 'cash_desk' });

    const { rows } = await admin.query<{ action: string; by: string }>(
      `SELECT a.action, u.username AS by FROM erp.audit_log a JOIN erp.users u ON u.id = a.user_id
       WHERE a.entity = 'devices' AND a.entity_id = $1 ORDER BY a.at`,
      [first.res.json<{ deviceId: string }>().deviceId],
    );
    expect(rows[0]).toEqual({ action: 'create', by: 'maria' });
  });

  it('refuses a wrong code, an expired code and a forged proof of key, all the same way', async () => {
    const cookie = await login('maria');
    expect((await enroll('AAAA-AAAA')).res.json()).toEqual({ error: 'enrollment_failed' });

    const expiring = await newCode(cookie);
    later(16 * 60_000);
    expect((await enroll(expiring)).res.json()).toEqual({ error: 'enrollment_failed' });

    const code = await newCode(await login('maria'));
    const keys = await generateDeviceKey();
    const other = await generateDeviceKey();
    const publicKey = await exportPublicKey(keys.publicKey);
    const forged = await signCanonical(other.privateKey, { tenantCode: SHOP, code, publicKey });
    const res = await post('/api/devices/enroll', { tenantCode: SHOP, code, publicKey, signature: forged });
    expect(res.json()).toEqual({ error: 'enrollment_failed' });
    // The code is still usable by the real device afterwards.
    expect((await enroll(code, keys)).res.statusCode).toBe(201);
  });

  it('stops a shop after 10 failed attempts in 15 minutes', async () => {
    const shop = 'busy-shop';
    const busy = await createTenant(db.ownerUrl, 'Busy Shop', shop);
    await withTenant(pool, { tenantId: busy }, (_db, c) =>
      c.query("INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'MAIN', 'Main')", [busy]),
    );
    await addUser('busyboss', 'owner', busy);
    for (let i = 0; i < 10; i++) await enroll('ZZZZ-ZZZZ', undefined, shop);
    const cookie = await login('busyboss', shop);
    const { rows } = await withTenant(pool, { tenantId: busy }, (_db, c) =>
      c.query<{ id: string }>('SELECT id FROM erp.branches'),
    );
    const res = await post(
      '/api/devices/enrollment-codes',
      { branchId: rows[0]!.id, kind: 'counter' },
      cookie,
    );
    const good = await enroll(res.json<{ code: string }>().code, undefined, shop);
    expect(good.res.statusCode).toBe(429);
  });
});

describe('device tokens', () => {
  it('are issued for a signed challenge and work for 15 minutes', async () => {
    const { res, keys } = await enroll(await newCode(await login('maria')));
    const deviceId = res.json<{ deviceId: string }>().deviceId;
    const { token } = await deviceToken(deviceId, keys);
    expect(token).toMatch(new RegExp(`^${tenant}\\.`));
    const me = await deviceMe(token!);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ deviceId, tenantId: tenant, branchId: branch });
    later(15 * 60_000 + 1000);
    expect((await deviceMe(token!)).statusCode).toBe(401);
  });

  it("refuse another device's key, a wrong signature, an expired nonce and a reused nonce", async () => {
    const cookie = await login('maria');
    const a = await enroll(await newCode(cookie));
    const b = await enroll(await newCode(cookie));
    const deviceA = a.res.json<{ deviceId: string }>().deviceId;
    expect((await deviceToken(deviceA, b.keys)).status).toBe(401);

    const ch = await post('/api/devices/challenge', { tenantId: tenant, deviceId: deviceA });
    const { nonce } = ch.json<{ nonce: string }>();
    const bad = await signCanonical(a.keys.privateKey, { tenantId: tenant, deviceId: deviceA, nonce: 'x' });
    expect(
      (await post('/api/devices/token', { tenantId: tenant, deviceId: deviceA, nonce, signature: bad }))
        .statusCode,
    ).toBe(401);

    const ch2 = await post('/api/devices/challenge', { tenantId: tenant, deviceId: deviceA });
    const n2 = ch2.json<{ nonce: string }>().nonce;
    const sig2 = await signCanonical(a.keys.privateKey, { tenantId: tenant, deviceId: deviceA, nonce: n2 });
    later(61_000);
    expect(
      (await post('/api/devices/token', { tenantId: tenant, deviceId: deviceA, nonce: n2, signature: sig2 }))
        .statusCode,
    ).toBe(401);

    const ch3 = await post('/api/devices/challenge', { tenantId: tenant, deviceId: deviceA });
    const n3 = ch3.json<{ nonce: string }>().nonce;
    const sig3 = await signCanonical(a.keys.privateKey, { tenantId: tenant, deviceId: deviceA, nonce: n3 });
    const body = { tenantId: tenant, deviceId: deviceA, nonce: n3, signature: sig3 };
    expect((await post('/api/devices/token', body)).statusCode).toBe(200);
    expect((await post('/api/devices/token', body)).statusCode).toBe(401);
  });

  it("and back-office sessions can't stand in for each other", async () => {
    const cookie = await login('maria');
    const { res, keys } = await enroll(await newCode(cookie));
    const { token } = await deviceToken(res.json<{ deviceId: string }>().deviceId, keys);
    expect((await deviceMe(cookie)).statusCode).toBe(401);
    const me = await app().inject({ method: 'GET', url: '/api/auth/me', cookies: { erp_session: token! } });
    expect(me.statusCode).toBe(401);
  });
});

describe('revocation', () => {
  it('stops the device at once and for good', async () => {
    const cookie = await login('maria');
    const { res, keys } = await enroll(await newCode(cookie));
    const deviceId = res.json<{ deviceId: string }>().deviceId;
    const { token } = await deviceToken(deviceId, keys);
    expect((await deviceMe(token!)).statusCode).toBe(200);

    expect((await post(`/api/devices/${deviceId}/revoke`, {}, await login('sara'))).statusCode).toBe(403);
    expect((await post(`/api/devices/${deviceId}/revoke`, {}, cookie)).statusCode).toBe(204);
    expect((await deviceMe(token!)).statusCode).toBe(401);
    expect((await deviceToken(deviceId, keys)).status).toBe(401);
  });
});

describe('staff PIN', () => {
  const setPin = (cookie: string, password: string, pin: string) =>
    app().inject({
      method: 'PUT',
      url: '/api/users/me/pin',
      headers: { origin: ORIGIN, host: HOST },
      cookies: { erp_session: cookie },
      payload: { password, pin },
    });

  it('needs the current password and refuses trivial PINs', async () => {
    const cookie = await login('maria');
    expect((await setPin(cookie, 'wrong password!!', '4821')).statusCode).toBe(401);
    const weak = await setPin(cookie, PASSWORD, '1234');
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toEqual({ error: 'weak_pin', problem: 'sequence' });
  });

  it("refuses the user's own short code as the PIN", async () => {
    const res = await setPin(await login('sara'), PASSWORD, '4821');
    expect(res.json()).toEqual({ error: 'weak_pin', problem: 'is_short_code' });
  });

  it('stores a PBKDF2 verifier, never the PIN, and the PIN still cannot log in', async () => {
    const cookie = await login('maria');
    expect((await setPin(cookie, PASSWORD, '7391')).statusCode).toBe(204);
    const { rows } = await admin.query<{ pin_verifier: string }>(
      "SELECT pin_verifier FROM erp.users WHERE username = 'maria'",
    );
    const v = rows[0]!.pin_verifier;
    expect(parsePinVerifier(v)?.iterations).toBe(600_000);
    expect(v).not.toContain('7391');
    expect(await verifyPin(v, '7391')).toBe(true);

    const pinLogin = await app().inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN, host: HOST },
      payload: { tenantCode: SHOP, username: 'maria', password: '7391' },
    });
    expect(pinLogin.statusCode).toBe(401);

    const audit = await admin.query<{ action: string }>(
      "SELECT a.action FROM erp.audit_log a JOIN erp.users u ON u.id = a.user_id WHERE u.username = 'maria' AND a.action = 'pin.changed'",
    );
    expect(audit.rows).toHaveLength(1);
  });
});
