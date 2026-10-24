import { Writable } from 'node:stream';

import { withTenant } from '@erp/db';
import { createTenant, createTestDatabase, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES } from '@erp/domain';
import { createLogger } from '@erp/observability';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { hashPassword } from './auth/password';

// An authenticated request's log lines carry the tenant and the user (architecture §11.2, D-086).

const SHOP = 'obs-shop';
const HOST = 'app.example.test';
const PASSWORD = 'observability pass 2026';

let db: TestDatabase;
let pool: pg.Pool;
let tenant: string;
let user: string;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  tenant = await createTenant(db.ownerUrl, 'Observed Shop', SHOP);
  const hash = await hashPassword(PASSWORD);
  user = await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    const u = await c.query<{ id: string }>(
      "INSERT INTO erp.users (tenant_id, username, full_name, password_hash) VALUES ($1, 'watcher', 'Watcher', $2) RETURNING id",
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
    return u.rows[0]!.id;
  });
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('logs of an authenticated request', () => {
  it('carry the request ID, the tenant and the user, and no session token', async () => {
    const lines: Record<string, unknown>[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _enc, done) {
        for (const l of chunk.toString().split('\n').filter(Boolean))
          lines.push(JSON.parse(l) as Record<string, unknown>);
        done();
      },
    });
    const app = buildApp({
      pool,
      loggerInstance: createLogger({ app: 'api', env: 'test', version: 'v1', destination }),
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: `https://${HOST}`, host: HOST },
      payload: { tenantCode: SHOP, username: 'watcher', password: PASSWORD },
    });
    const cookie = login.cookies.find((c) => c.name === 'erp_session')!.value;
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { erp_session: cookie } });
    const id = me.headers['x-request-id'];
    const done = lines.find((l) => l['request_id'] === id && l['msg'] === 'request completed');
    expect(done).toMatchObject({ request_id: id, tenant_id: tenant, user_id: user });
    expect(JSON.stringify(lines)).not.toContain(cookie.split('.')[1]!);
    expect(JSON.stringify(lines)).not.toContain(PASSWORD);
  });
});
