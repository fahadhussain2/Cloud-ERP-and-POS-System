import { TenantSpec } from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTestDatabase, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Each back-office user's theme (W2-07 plan, PLT-13, D-120): kept on the server per user, System until chosen,
// returned by /auth/me and saved with PUT /users/me/settings, under RLS (rule 5).

const SHOP = 'theme-shop';
const OTHER = 'theme-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Client;
let tenant: string;
let other: string;
const cookies: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date('2026-11-21T06:00:00.000Z') });

async function addUser(username: string, template: RoleTemplateKey, tenantId: string, mustChange = false) {
  const hash = await hashPassword(PASSWORD);
  await withTenant(pool, { tenantId }, async (_db, c) => {
    const role = await c.query<{ id: string }>(
      `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits) VALUES ($1, $2, NULL, $3, $4)
       RETURNING id`,
      [tenantId, `${username} role`, ROLE_TEMPLATES[template].permissions, ROLE_TEMPLATES[template].limits],
    );
    const user = await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, password_hash, must_change_password)
       VALUES ($1, $2, initcap($2), $3, $4) RETURNING id`,
      [tenantId, username, hash, mustChange],
    );
    await c.query('INSERT INTO erp.user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
      tenantId,
      user.rows[0]!.id,
      role.rows[0]!.id,
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
  const c = res.cookies.find((x) => x.name === 'erp_session')?.value;
  if (!c) throw new Error(`login failed for ${username}: ${res.body}`);
  cookies[username] = c;
}

const send = (method: 'GET' | 'PUT', url: string, who: string | null, payload?: unknown) =>
  app().inject({
    method,
    url,
    headers: { origin: ORIGIN, host: HOST },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    ...(who ? { cookies: { erp_session: cookies[who]! } } : {}),
  });

const themeOf = async (who: string) =>
  (await send('GET', '/api/auth/me', who)).json<{ theme: string }>().theme;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  ({ tenantId: tenant } = await setupTenant(db.ownerUrl, TenantSpec.parse({ ...deluxSpec, code: SHOP }), {
    ownerPasswordHash: 'x',
    mustChangePassword: false,
  }));
  ({ tenantId: other } = await setupTenant(
    db.ownerUrl,
    TenantSpec.parse({ ...deluxSpec, code: OTHER, name: 'Other Shop' }),
    { ownerPasswordHash: 'x', mustChangePassword: false },
  ));
  await addUser('owner', 'owner', tenant);
  await addUser('maria', 'manager', tenant);
  await addUser('newbie', 'cashier', tenant, true);
  await addUser('otto', 'owner', other);
  for (const u of ['owner', 'maria', 'newbie']) await login(u);
  await login('otto', OTHER);
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.drop();
});

describe('a user’s theme', () => {
  it('is System until chosen', async () => {
    expect(await themeOf('owner')).toBe('system');
  });

  it('is saved for that user and changed again by a second save', async () => {
    expect((await send('PUT', '/api/users/me/settings', 'owner', { theme: 'dark' })).statusCode).toBe(204);
    expect(await themeOf('owner')).toBe('dark');
    expect((await send('PUT', '/api/users/me/settings', 'owner', { theme: 'light' })).statusCode).toBe(204);
    expect(await themeOf('owner')).toBe('light');
  });

  it('is each person’s own', async () => {
    await send('PUT', '/api/users/me/settings', 'owner', { theme: 'dark' });
    expect(await themeOf('maria')).toBe('system');
    expect(await themeOf('otto')).toBe('system');
  });

  it('stays inside its shop (RLS)', async () => {
    await send('PUT', '/api/users/me/settings', 'otto', { theme: 'light' });
    const rows = await withTenant(
      pool,
      { tenantId: tenant },
      async (_db, c) =>
        (await c.query<{ tenant_id: string }>('SELECT tenant_id FROM erp.user_settings')).rows,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === tenant)).toBe(true);
    const forced = await admin.query<{ relforcerowsecurity: boolean }>(
      "SELECT relforcerowsecurity FROM pg_class WHERE oid = 'erp.user_settings'::regclass",
    );
    expect(forced.rows[0]!.relforcerowsecurity).toBe(true);
    expect(other).not.toBe(tenant);
  });

  it('refuses a value that is not a theme', async () => {
    expect((await send('PUT', '/api/users/me/settings', 'owner', { theme: 'blue' })).statusCode).toBe(400);
    expect((await send('PUT', '/api/users/me/settings', 'owner', {})).statusCode).toBe(400);
  });

  it('needs a session and no pending password change', async () => {
    expect((await send('PUT', '/api/users/me/settings', null, { theme: 'dark' })).statusCode).toBe(401);
    const due = await send('PUT', '/api/users/me/settings', 'newbie', { theme: 'dark' });
    expect(due.statusCode).toBe(403);
    expect(due.json()).toMatchObject({ error: 'password_change_required' });
  });
});
