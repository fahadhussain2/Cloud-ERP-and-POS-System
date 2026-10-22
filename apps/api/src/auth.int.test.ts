import { withTenant } from '@erp/db';
import { createTenant, createTestDatabase, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Back-office login, sessions, permissions and the audit trail (PLT-04, PLT-05, PLT-08, D-081).

const SHOP = 'test-shop';
const ORIGIN = 'https://app.example.test';
const HOST = 'app.example.test';
const PASSWORD = 'correct horse battery';
const PIN = '4821';

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Client;
let tenant: string;
let otherTenant: string;
let now = new Date('2026-11-02T08:00:00Z');
const app = () => buildApp({ pool, now: () => now });

async function addUser(username: string, roles: RoleTemplateKey[]) {
  const passwordHash = await hashPassword(PASSWORD);
  const pinVerifier = await hashPassword(PIN);
  return withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, password_hash, pin_verifier)
       VALUES ($1, $2, $2, $3, $4) RETURNING id`,
      [tenant, username, passwordHash, pinVerifier],
    );
    const userId = rows[0]!.id;
    for (const key of roles) {
      const t = ROLE_TEMPLATES[key];
      const role = await c.query<{ id: string }>(
        `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [tenant, key, key, t.permissions, t.limits],
      );
      await c.query('INSERT INTO erp.user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
        tenant,
        userId,
        role.rows[0]!.id,
      ]);
    }
    return userId;
  });
}

const login = (username: string, password: string, shop = SHOP) =>
  app().inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { tenantCode: shop, username, password },
  });

const cookieOf = (res: Awaited<ReturnType<typeof login>>) => {
  const c = res.cookies.find((x) => x.name === 'erp_session');
  if (!c) throw new Error('no session cookie');
  return c;
};

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  tenant = await createTenant(db.ownerUrl, 'Test Shop', SHOP);
  otherTenant = await createTenant(db.ownerUrl, 'Other Shop', 'other-shop');
  await addUser('owner', ['owner']);
  await addUser('ahmed', ['salesman']);
  await addUser('maria', ['manager']);
  await addUser('locky', ['salesman']);
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.drop();
});

describe('login', () => {
  it('sets a secure session cookie and returns the user with their permissions', async () => {
    const res = await login('ahmed', PASSWORD);
    expect(res.statusCode).toBe(200);
    const c = cookieOf(res);
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/api' });
    expect(c.value.startsWith(`${tenant}.`)).toBe(true);

    const me = await app().inject({ method: 'GET', url: '/api/auth/me', cookies: { erp_session: c.value } });
    expect(me.statusCode).toBe(200);
    const body = me.json<{ user: { username: string }; permissions: string[] }>();
    expect(body.user.username).toBe('ahmed');
    expect(body.permissions).toContain('pos.return.create');
    expect(body.permissions).not.toContain('pos.void');
  });

  it('accepts the username in any case', async () => {
    expect((await login('AHMED', PASSWORD)).statusCode).toBe(200);
  });

  it('gives the same answer for a wrong password, an unknown user and an unknown shop', async () => {
    const answers = await Promise.all([
      login('ahmed', 'wrong password!!'),
      login('nobody', PASSWORD),
      login('ahmed', PASSWORD, 'no-such-shop'),
    ]);
    for (const res of answers) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'login_failed' });
      expect(res.cookies).toEqual([]);
    }
  });

  it("doesn't accept the user's PIN as the password", async () => {
    const res = await login('ahmed', PIN);
    expect(res.statusCode).toBe(401);
  });

  it('locks the account for 15 minutes after 5 wrong passwords, even for the right one', async () => {
    for (let i = 0; i < 5; i++) expect((await login('locky', 'wrong password!!')).statusCode).toBe(401);
    expect((await login('locky', PASSWORD)).statusCode).toBe(401);
    now = new Date(now.getTime() + 16 * 60_000);
    expect((await login('locky', PASSWORD)).statusCode).toBe(200);

    const { rows } = await admin.query<{ action: string }>(
      `SELECT a.action FROM erp.audit_log a JOIN erp.users u ON u.id = a.user_id
       WHERE u.username = 'locky' AND a.entity = 'session' ORDER BY a.at, a.id`,
    );
    expect(rows.map((r) => r.action)).toEqual([
      'login.failed',
      'login.failed',
      'login.failed',
      'login.failed',
      'login.locked',
      'login.refused_locked',
      'login.success',
    ]);
  });

  it('rejects a malformed request', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN, host: HOST },
      payload: { tenantCode: SHOP, username: 'ahmed' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a request from another site', async () => {
    const res = await app().inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example', host: HOST },
      payload: { tenantCode: SHOP, username: 'ahmed', password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('sessions', () => {
  it('end after 2 hours idle', async () => {
    const c = cookieOf(await login('ahmed', PASSWORD));
    now = new Date(now.getTime() + 2 * 3600_000 + 60_000);
    const me = await app().inject({ method: 'GET', url: '/api/auth/me', cookies: { erp_session: c.value } });
    expect(me.statusCode).toBe(401);
  });

  it('end after 12 hours even when used all the time', async () => {
    const c = cookieOf(await login('ahmed', PASSWORD));
    for (let h = 0; h < 12; h++) {
      now = new Date(now.getTime() + 3600_000);
      await app().inject({ method: 'GET', url: '/api/auth/me', cookies: { erp_session: c.value } });
    }
    now = new Date(now.getTime() + 60_000);
    const me = await app().inject({ method: 'GET', url: '/api/auth/me', cookies: { erp_session: c.value } });
    expect(me.statusCode).toBe(401);
  });

  it('end at logout', async () => {
    const c = cookieOf(await login('ahmed', PASSWORD));
    const out = await app().inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: ORIGIN, host: HOST },
      cookies: { erp_session: c.value },
    });
    expect(out.statusCode).toBe(204);
    const me = await app().inject({ method: 'GET', url: '/api/auth/me', cookies: { erp_session: c.value } });
    expect(me.statusCode).toBe(401);
  });

  it("can't be moved to another tenant by editing the cookie", async () => {
    const c = cookieOf(await login('ahmed', PASSWORD));
    const token = c.value.split('.')[1];
    const me = await app().inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { erp_session: `${otherTenant}.${token}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it('reject garbage cookies', async () => {
    for (const value of ['', 'nonsense', `${tenant}.`, 'not-a-uuid.abc']) {
      const me = await app().inject({ method: 'GET', url: '/api/auth/me', cookies: { erp_session: value } });
      expect(me.statusCode, value).toBe(401);
    }
  });
});

describe('permissions on routes', () => {
  it('requirePermission refuses a Salesman and allows a Manager (pos.void)', async () => {
    const salesman = cookieOf(await login('ahmed', PASSWORD));
    const manager = cookieOf(await login('maria', PASSWORD));
    const check = (cookie: string) =>
      app().inject({ method: 'GET', url: '/api/auth/can/pos.void', cookies: { erp_session: cookie } });
    expect((await check(salesman.value)).statusCode).toBe(403);
    expect((await check(manager.value)).statusCode).toBe(204);
  });
});
