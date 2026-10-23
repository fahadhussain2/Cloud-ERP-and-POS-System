import { withTenant } from '@erp/db';
import { createTenant, createTestDatabase, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Password change and the must-change-password gate (D-083, W0-11).

const SHOP = 'pw-shop';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const TEMP = 'temporary pass 2026';
const NEW = 'my own long password';

let db: TestDatabase;
let pool: pg.Pool;
let tenant: string;
const app = () => buildApp({ pool, now: () => new Date('2026-11-02T08:00:00Z') });

const login = async (password: string) => {
  const res = await app().inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { tenantCode: SHOP, username: 'newbie', password },
  });
  return { res, cookie: res.cookies.find((c) => c.name === 'erp_session')?.value ?? '' };
};

const change = (cookie: string, currentPassword: string, newPassword: string) =>
  app().inject({
    method: 'PUT',
    url: '/api/users/me/password',
    headers: { origin: ORIGIN, host: HOST },
    cookies: { erp_session: cookie },
    payload: { currentPassword, newPassword },
  });

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  tenant = await createTenant(db.ownerUrl, 'Password Shop', SHOP);
  const hash = await hashPassword(TEMP);
  await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    const u = await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, password_hash, must_change_password)
       VALUES ($1, 'newbie', 'New User', $2, true) RETURNING id`,
      [tenant, hash],
    );
    const t = ROLE_TEMPLATES.manager;
    const r = await c.query<{ id: string }>(
      "INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits) VALUES ($1, 'Manager', 'manager', $2, $3) RETURNING id",
      [tenant, t.permissions, t.limits],
    );
    await c.query('INSERT INTO erp.user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
      tenant,
      u.rows[0]!.id,
      r.rows[0]!.id,
    ]);
  });
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('a user who must change their password', () => {
  it('is told so at login and in me, and can reach nothing else', async () => {
    const { res, cookie } = await login(TEMP);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mustChangePassword: true });
    const me = await app().inject({ method: 'GET', url: '/api/auth/me', cookies: { erp_session: cookie } });
    expect(me.json()).toMatchObject({ mustChangePassword: true });
    const other = await app().inject({
      method: 'GET',
      url: '/api/auth/can/pos.void',
      cookies: { erp_session: cookie },
    });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toEqual({ error: 'password_change_required' });
  });

  it('must give the current password and choose a good new one', async () => {
    const { cookie } = await login(TEMP);
    expect((await change(cookie, 'wrong current pass', NEW)).statusCode).toBe(401);
    const weak = await change(cookie, TEMP, 'short');
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toEqual({ error: 'weak_password', problem: 'too_short' });
  });

  it('after changing it: the gate opens, the old password stops working, and other sessions end', async () => {
    const other = await login(TEMP);
    const { cookie } = await login(TEMP);
    expect((await change(cookie, TEMP, NEW)).statusCode).toBe(204);

    const can = await app().inject({
      method: 'GET',
      url: '/api/auth/can/pos.void',
      cookies: { erp_session: cookie },
    });
    expect(can.statusCode).toBe(204);
    const stale = await app().inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { erp_session: other.cookie },
    });
    expect(stale.statusCode).toBe(401);
    expect((await login(TEMP)).res.statusCode).toBe(401);
    const fresh = await login(NEW);
    expect(fresh.res.json()).toMatchObject({ mustChangePassword: false });
  });
});
