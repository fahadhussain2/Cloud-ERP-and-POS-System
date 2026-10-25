import { withTenant } from '@erp/db';
import { createTenant, createTestDatabase, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { hashPassword } from './auth/password';

// The lists the back office's Counters and Staff PINs screens read (W1-02, D-089).

const SHOP = 'admin-shop';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let pool: pg.Pool;
let tenant: string;
let branch: string;
const app = () => buildApp({ pool, now: () => new Date() });

async function addUser(username: string, role: RoleTemplateKey, pin = false) {
  const hash = await hashPassword(PASSWORD);
  await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    const u = await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, short_code, password_hash, pin_verifier)
       VALUES ($1, $2, initcap($2), NULL, $3, $4) RETURNING id`,
      [tenant, username, hash, pin ? 'pbkdf2-sha256$600000$c2FsdA$aGFzaA' : null],
    );
    const t = ROLE_TEMPLATES[role];
    const r = await c.query<{ id: string }>(
      `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [tenant, role, role, t.permissions, t.limits],
    );
    await c.query('INSERT INTO erp.user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
      tenant,
      u.rows[0]!.id,
      r.rows[0]!.id,
    ]);
  });
}

async function login(username: string) {
  const res = await app().inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { tenantCode: SHOP, username, password: PASSWORD },
  });
  return res.cookies.find((c) => c.name === 'erp_session')!.value;
}
const get = (url: string, cookie: string) =>
  app().inject({ method: 'GET', url, cookies: { erp_session: cookie } });

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  tenant = await createTenant(db.ownerUrl, 'Admin Shop', SHOP);
  branch = await withTenant(
    pool,
    { tenantId: tenant },
    async (_db, c) =>
      (
        await c.query<{ id: string }>(
          "INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'MAIN', 'Main') RETURNING id",
          [tenant],
        )
      ).rows[0]!.id,
  );
  await addUser('boss', 'manager', true);
  await addUser('sara', 'salesman');
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('back-office lists', () => {
  it('branches: any signed-in user', async () => {
    const res = await get('/api/branches', await login('sara'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: branch, code: 'MAIN', name: 'Main' }]);
  });

  it('staff: managers see who has a PIN, and never a PIN verifier or password hash', async () => {
    const res = await get('/api/staff', await login('boss'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        username: 'boss',
        fullName: 'Boss',
        hasPin: true,
        pinMustChange: false,
        status: 'active',
      }),
      expect.objectContaining({
        username: 'sara',
        fullName: 'Sara',
        hasPin: false,
        pinMustChange: false,
        status: 'active',
      }),
    ]);
    expect(res.body).not.toContain('pbkdf2');
    expect(res.body).not.toContain('$argon2');
  });

  it('staff and devices: not for a salesman', async () => {
    const cookie = await login('sara');
    expect((await get('/api/staff', cookie)).statusCode).toBe(403);
    expect((await get('/api/devices', cookie)).statusCode).toBe(403);
  });

  it('devices: managers see the enrolled counters (none yet)', async () => {
    const res = await get('/api/devices', await login('boss'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
