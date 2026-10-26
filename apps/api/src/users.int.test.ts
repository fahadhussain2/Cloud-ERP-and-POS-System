import { exportPublicKey, generateDeviceKey, signCanonical } from '@erp/contracts';
import { withTenant } from '@erp/db';
import { createTenant, createTestDatabase, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Staff and user admin (W1-04 plan; PLT-04, PLT-05, PLT-08; D-081, D-083, D-089): people, roles per branch,
// optional back-office password, deactivate; the guards against locking the shop out.

const SHOP = 'users-shop';
const OTHER = 'users-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';
const TEMPORARY = 'temporary pass 2026';

let db: TestDatabase;
let pool: pg.Pool;
let tenant: string;
let other: string;
let branch: string;
const roles: Record<string, string> = {};
const ids: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date() });

async function addRole(
  tenantId: string,
  name: string,
  template: RoleTemplateKey | null,
  permissions: readonly string[],
) {
  return withTenant(pool, { tenantId }, async (_db, c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits) VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [tenantId, name, template, permissions, { maxDiscountBp: 0, voidWindow: 'none' }],
    );
    return rows[0]!.id;
  });
}

/** A person with a password and the given roles (all branches), made directly in the database. */
async function addUser(username: string, roleIds: string[], tenantId = tenant) {
  const hash = await hashPassword(PASSWORD);
  return withTenant(pool, { tenantId }, async (_db, c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, password_hash)
       VALUES ($1, $2, initcap($2), $3) RETURNING id`,
      [tenantId, username, hash],
    );
    for (const roleId of roleIds)
      await c.query('INSERT INTO erp.user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
        tenantId,
        rows[0]!.id,
        roleId,
      ]);
    return rows[0]!.id;
  });
}

const send = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  cookie?: string,
  payload?: unknown,
) =>
  app().inject({
    method,
    url,
    headers: { origin: ORIGIN, host: HOST },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    ...(cookie ? { cookies: { erp_session: cookie } } : {}),
  });

async function tryLogin(username: string, password = PASSWORD, shop = SHOP) {
  const res = await send('POST', '/api/auth/login', undefined, { tenantCode: shop, username, password });
  return res.cookies.find((x) => x.name === 'erp_session')?.value ?? null;
}
async function login(username: string, password = PASSWORD, shop = SHOP) {
  const cookie = await tryLogin(username, password, shop);
  if (!cookie) throw new Error(`login failed for ${username}`);
  return cookie;
}

/** Enrolls a counter for the main branch and returns its device token (W0-10 flow). */
async function counterToken(cookie: string) {
  const { code } = (
    await send('POST', '/api/devices/enrollment-codes', cookie, { branchId: branch, kind: 'counter' })
  ).json<{ code: string }>();
  const keys = await generateDeviceKey();
  const publicKey = await exportPublicKey(keys.publicKey);
  const signature = await signCanonical(keys.privateKey, { tenantCode: SHOP, code, publicKey });
  const { deviceId } = (
    await send('POST', '/api/devices/enroll', undefined, { tenantCode: SHOP, code, publicKey, signature })
  ).json<{ deviceId: string }>();
  const { nonce } = (
    await send('POST', '/api/devices/challenge', undefined, { tenantId: tenant, deviceId })
  ).json<{ nonce: string }>();
  const sig = await signCanonical(keys.privateKey, { tenantId: tenant, deviceId, nonce });
  return (
    await send('POST', '/api/devices/token', undefined, { tenantId: tenant, deviceId, nonce, signature: sig })
  ).json<{ accessToken: string }>().accessToken;
}

type PullBody = { changes: Record<string, Record<string, unknown>[]>; cursor: string; hasMore: boolean };
async function pullAll(token: string, datasets: string) {
  const rows: Record<string, Record<string, unknown>[]> = {};
  let cursor = '';
  for (;;) {
    const res = await app().inject({
      method: 'GET',
      url: `/api/sync/pull?datasets=${datasets}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`,
      headers: { authorization: `Device ${token}` },
    });
    const body = res.json<PullBody>();
    for (const [k, v] of Object.entries(body.changes)) (rows[k] ??= []).push(...v);
    cursor = body.cursor;
    if (!body.hasMore) return rows;
  }
}

const sessionsOpen = (userId: string) =>
  withTenant(pool, { tenantId: tenant }, async (_db, c) =>
    Number(
      (
        await c.query<{ n: string }>(
          'SELECT count(*) AS n FROM erp.sessions WHERE user_id = $1 AND revoked_at IS NULL',
          [userId],
        )
      ).rows[0]!.n,
    ),
  );

const auditRows = (entityId: string) =>
  withTenant(
    pool,
    { tenantId: tenant },
    async (_db, c) =>
      (
        await c.query<{
          action: string;
          entity: string;
          after: Record<string, unknown> | null;
          user_id: string;
        }>('SELECT action, entity, after, user_id FROM erp.audit_log WHERE entity_id = $1 ORDER BY at', [
          entityId,
        ])
      ).rows,
  );

interface UserRow {
  id: string;
  username: string;
  fullName: string;
  shortCode: string | null;
  email: string | null;
  status: string;
  hasPassword: boolean;
  hasPin: boolean;
  pinMustChange: boolean;
  lastLoginAt: string | null;
  roles: { roleId: string; name: string; templateKey: string | null; branchId: string | null }[];
}
const listUsers = async (cookie: string) => (await send('GET', '/api/users', cookie)).json<UserRow[]>();

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 6 });
  tenant = await createTenant(db.ownerUrl, 'Users Shop', SHOP);
  other = await createTenant(db.ownerUrl, 'Other Shop', OTHER);
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
  for (const key of Object.keys(ROLE_TEMPLATES) as RoleTemplateKey[])
    roles[key] = await addRole(
      tenant,
      key[0]!.toUpperCase() + key.slice(1),
      key,
      ROLE_TEMPLATES[key].permissions,
    );
  // A custom role that may manage people but holds few other rights (PLT-06 shape).
  roles['staffAdmin'] = await addRole(tenant, 'Staff admin', null, ['admin.users', 'admin.devices']);
  roles['devicesOnly'] = await addRole(tenant, 'Devices only', null, ['admin.devices']);

  ids['owner'] = await addUser('owner', [roles['owner']!]);
  ids['manager'] = await addUser('manager', [roles['manager']!]);
  ids['seller'] = await addUser('seller', [roles['salesman']!]);
  ids['staffAdmin'] = await addUser('staffadmin', [roles['staffAdmin']]);
  ids['stranger'] = await addUser('stranger', [await addRole(other, 'Owner', 'owner', ['*'])], other);
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

describe('listing people and roles', () => {
  it('owner: everyone with their roles, never a hash or verifier', async () => {
    const res = await send('GET', '/api/users', await login('owner'));
    expect(res.statusCode).toBe(200);
    const owner = res.json<UserRow[]>().find((u) => u.username === 'owner')!;
    expect(owner).toEqual(
      expect.objectContaining({
        fullName: 'Owner',
        status: 'active',
        hasPassword: true,
        hasPin: false,
        roles: [{ roleId: roles['owner'], name: 'Owner', templateKey: 'owner', branchId: null }],
      }),
    );
    expect(res.body).not.toContain('$argon2');
    expect(res.body).not.toContain('pbkdf2');
    expect(res.json<UserRow[]>().map((u) => u.username)).not.toContain('stranger');
  });

  it('roles: the tenant’s roles for the picker', async () => {
    const res = await send('GET', '/api/roles', await login('owner'));
    expect(res.statusCode).toBe(200);
    expect(res.json<{ id: string; name: string; templateKey: string | null }[]>()).toEqual(
      expect.arrayContaining([
        { id: roles['salesman'], name: 'Salesman', templateKey: 'salesman' },
        { id: roles['staffAdmin'], name: 'Staff admin', templateKey: null },
      ]),
    );
  });

  it('manager: sees the list (for temporary PINs) but not the roles', async () => {
    const cookie = await login('manager');
    expect((await send('GET', '/api/users', cookie)).statusCode).toBe(200);
    expect((await send('GET', '/api/roles', cookie)).statusCode).toBe(403);
  });

  it('salesman: nothing', async () => {
    const cookie = await login('seller');
    expect((await send('GET', '/api/users', cookie)).statusCode).toBe(403);
    expect((await send('GET', '/api/roles', cookie)).statusCode).toBe(403);
  });

  it('GET /api/staff is gone (replaced by /api/users)', async () => {
    expect((await send('GET', '/api/staff', await login('owner'))).statusCode).toBe(404);
  });
});

describe('adding a person', () => {
  it('without a password: listed with the role, can’t sign in, audited without secrets', async () => {
    const cookie = await login('owner');
    const res = await send('POST', '/api/users', cookie, {
      username: 'Ali.Raza',
      fullName: 'Ali Raza',
      shortCode: 'AR1',
      email: null,
      roles: [{ roleId: roles['salesman'], branchId: branch }],
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json<{ id: string }>();
    const ali = (await listUsers(cookie)).find((u) => u.id === id)!;
    expect(ali).toEqual(
      expect.objectContaining({
        username: 'Ali.Raza',
        shortCode: 'AR1',
        hasPassword: false,
        status: 'active',
        roles: [{ roleId: roles['salesman'], name: 'Salesman', templateKey: 'salesman', branchId: branch }],
      }),
    );
    expect(await tryLogin('Ali.Raza', '')).toBeNull();
    const audit = await auditRows(id);
    expect(audit[0]).toEqual(
      expect.objectContaining({ action: 'create', entity: 'users', user_id: ids['owner'] }),
    );
    expect(audit[0]!.after).not.toHaveProperty('password_hash');
    expect(audit[0]!.after).not.toHaveProperty('pin_verifier');
  });

  it('with a temporary password: signs in, then must change it first', async () => {
    const res = await send('POST', '/api/users', await login('owner'), {
      username: 'kashif',
      fullName: 'Kashif',
      roles: [{ roleId: roles['cashier'], branchId: null }],
      temporaryPassword: TEMPORARY,
    });
    expect(res.statusCode).toBe(201);
    const cookie = await login('kashif', TEMPORARY);
    expect((await send('GET', '/api/auth/me', cookie)).json()).toEqual(
      expect.objectContaining({ mustChangePassword: true }),
    );
    expect((await send('GET', '/api/branches', cookie)).statusCode).toBe(403);
    const audit = await auditRows(res.json<{ id: string }>().id);
    expect(audit.map((a) => a.action)).toContain('password.set_by_admin');
  });

  it('refuses a weak temporary password (D-081 rules)', async () => {
    const res = await send('POST', '/api/users', await login('owner'), {
      username: 'weakling',
      fullName: 'Weak',
      roles: [],
      temporaryPassword: 'short',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(expect.objectContaining({ error: 'weak_password' }));
  });

  it('refuses a duplicate username in any case, or a duplicate short code, naming the field', async () => {
    const cookie = await login('owner');
    const dupName = await send('POST', '/api/users', cookie, { username: 'OWNER', fullName: 'X', roles: [] });
    expect(dupName.statusCode).toBe(409);
    expect(dupName.json()).toEqual({ error: 'duplicate', field: 'username' });
    const dupCode = await send('POST', '/api/users', cookie, {
      username: 'newbie',
      fullName: 'Newbie',
      shortCode: 'AR1',
      roles: [],
    });
    expect(dupCode.statusCode).toBe(409);
    expect(dupCode.json()).toEqual({ error: 'duplicate', field: 'shortCode' });
  });

  it('the same username in another shop is fine', async () => {
    const res = await send('POST', '/api/users', await login('owner'), {
      username: 'stranger',
      fullName: 'Not the other one',
      roles: [],
    });
    expect(res.statusCode).toBe(201);
  });

  it('refuses a role of another shop', async () => {
    const otherRole = await addRole(other, 'Salesman', 'salesman', ROLE_TEMPLATES.salesman.permissions);
    const res = await send('POST', '/api/users', await login('owner'), {
      username: 'crosser',
      fullName: 'Crosser',
      roles: [{ roleId: otherRole, branchId: null }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a request without a session or from another origin', async () => {
    const body = { username: 'ghost', fullName: 'Ghost', roles: [] };
    expect((await send('POST', '/api/users', undefined, body)).statusCode).toBe(401);
    const res = await app().inject({
      method: 'POST',
      url: '/api/users',
      headers: { origin: 'https://evil.example', host: HOST },
      cookies: { erp_session: await login('owner') },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('editing a person', () => {
  it('changes name, short code and email; the username stays', async () => {
    const cookie = await login('owner');
    const id = await addUser('editme', [roles['salesman']!]);
    const res = await send('PATCH', `/api/users/${id}`, cookie, {
      fullName: 'Edited Name',
      shortCode: 'ED',
      email: 'ed@example.test',
      username: 'renamed',
    });
    expect(res.statusCode).toBe(204);
    const u = (await listUsers(cookie)).find((x) => x.id === id)!;
    expect(u).toEqual(
      expect.objectContaining({
        username: 'editme',
        fullName: 'Edited Name',
        shortCode: 'ED',
        email: 'ed@example.test',
      }),
    );
  });

  it('another shop’s person is not found (RLS)', async () => {
    const res = await send('PATCH', `/api/users/${ids['stranger']}`, await login('owner'), {
      fullName: 'Hacked',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('roles and branch', () => {
  it('replacing the roles soft-deletes the removed one, so counters get a tombstone', async () => {
    const cookie = await login('owner');
    const id = await addUser('mover', [roles['salesman']!]);
    const res = await send('PUT', `/api/users/${id}/roles`, cookie, {
      roles: [{ roleId: roles['cashier'], branchId: branch }],
    });
    expect(res.statusCode).toBe(204);
    const token = await counterToken(cookie);
    const rows = (await pullAll(token, 'user_roles')).user_roles!.filter((r) => r['user_id'] === id);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role_id: roles['salesman'], deleted_at: expect.any(String) as unknown }),
        expect.objectContaining({ role_id: roles['cashier'], branch_id: branch, deleted_at: null }),
      ]),
    );
  });

  it('nobody gives a role with more rights than they hold (canGrantRole)', async () => {
    const cookie = await login('staffadmin');
    const id = await addUser('target', []);
    const owner = await send('PUT', `/api/users/${id}/roles`, cookie, {
      roles: [{ roleId: roles['owner'], branchId: null }],
    });
    expect(owner.statusCode).toBe(403);
    expect(owner.json()).toEqual({ error: 'cannot_grant' });
    const subset = await send('PUT', `/api/users/${id}/roles`, cookie, {
      roles: [{ roleId: roles['devicesOnly'], branchId: null }],
    });
    expect(subset.statusCode).toBe(204);
    // Creating with a role counts too.
    const created = await send('POST', '/api/users', cookie, {
      username: 'sneaky',
      fullName: 'Sneaky',
      roles: [{ roleId: roles['manager'], branchId: null }],
    });
    expect(created.statusCode).toBe(403);
  });

  it('nobody takes away a role with more rights than they hold', async () => {
    const res = await send('PUT', `/api/users/${ids['manager']}/roles`, await login('staffadmin'), {
      roles: [],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'cannot_grant' });
  });

  it('you can’t take your own user admin away', async () => {
    const res = await send('PUT', `/api/users/${ids['staffAdmin']}/roles`, await login('staffadmin'), {
      roles: [{ roleId: roles['devicesOnly'], branchId: null }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'self' });
  });

  it('the last active Owner keeps the Owner role', async () => {
    const res = await send('PUT', `/api/users/${ids['owner']}/roles`, await login('owner'), {
      roles: [{ roleId: roles['manager'], branchId: null }],
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('back-office password', () => {
  it('reset: a new temporary password, the person’s sessions end and their login lock clears', async () => {
    const owner = await login('owner');
    const id = await addUser('forgetful', [roles['cashier']!]);
    const theirs = await login('forgetful');
    await withTenant(pool, { tenantId: tenant }, (_db, c) =>
      c.query(
        `INSERT INTO erp.user_login_state (tenant_id, user_id, failed_logins, locked_until)
         VALUES ($1, $2, 5, now() + interval '1 hour')
         ON CONFLICT (user_id) DO UPDATE SET failed_logins = 5, locked_until = now() + interval '1 hour'`,
        [tenant, id],
      ),
    );
    const res = await send('PUT', `/api/users/${id}/password`, owner, { temporaryPassword: TEMPORARY });
    expect(res.statusCode).toBe(204);
    expect((await send('GET', '/api/auth/me', theirs)).statusCode).toBe(401);
    expect(await sessionsOpen(id)).toBe(0);
    const fresh = await login('forgetful', TEMPORARY);
    expect((await send('GET', '/api/auth/me', fresh)).json()).toEqual(
      expect.objectContaining({ mustChangePassword: true }),
    );
  });

  it('remove: sessions end, login fails, audited', async () => {
    const owner = await login('owner');
    const id = await addUser('leaving.office', [roles['salesman']!]);
    const theirs = await login('leaving.office');
    const res = await send('DELETE', `/api/users/${id}/password`, owner);
    expect(res.statusCode).toBe(204);
    expect((await send('GET', '/api/auth/me', theirs)).statusCode).toBe(401);
    expect(await tryLogin('leaving.office')).toBeNull();
    expect((await listUsers(owner)).find((u) => u.id === id)!.hasPassword).toBe(false);
    expect((await auditRows(id)).map((a) => a.action)).toContain('password.removed');
  });

  it('you can’t remove your own password', async () => {
    const res = await send('DELETE', `/api/users/${ids['owner']}/password`, await login('owner'));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'self' });
  });

  it('no response carries the password', async () => {
    const id = await addUser('quiet', []);
    const res = await send('PUT', `/api/users/${id}/password`, await login('owner'), {
      temporaryPassword: TEMPORARY,
    });
    expect(res.body).not.toContain(TEMPORARY);
  });
});

describe('deactivate and reactivate', () => {
  it('deactivate: sessions end, login fails, counters get status disabled; reactivate restores login', async () => {
    const owner = await login('owner');
    const id = await addUser('leaver', [roles['salesman']!]);
    const theirs = await login('leaver');
    expect((await send('POST', `/api/users/${id}/deactivate`, owner)).statusCode).toBe(204);
    expect((await send('GET', '/api/auth/me', theirs)).statusCode).toBe(401);
    expect(await sessionsOpen(id)).toBe(0);
    expect(await tryLogin('leaver')).toBeNull();
    const users = (await pullAll(await counterToken(owner), 'users')).users!;
    expect(users.find((u) => u['id'] === id)).toEqual(expect.objectContaining({ status: 'disabled' }));
    expect((await send('POST', `/api/users/${id}/reactivate`, owner)).statusCode).toBe(204);
    expect(await tryLogin('leaver')).not.toBeNull();
  });

  it('you can’t deactivate yourself', async () => {
    const res = await send('POST', `/api/users/${ids['owner']}/deactivate`, await login('owner'));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'self' });
  });

  it('two owners deactivating each other at once: exactly one succeeds, one Owner stays', async () => {
    const second = await addUser('second.owner', [roles['owner']!]);
    const [a, b] = await Promise.all([login('owner'), login('second.owner')]);
    const results = await Promise.all([
      send('POST', `/api/users/${second}/deactivate`, a),
      send('POST', `/api/users/${ids['owner']}/deactivate`, b),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 409]);
    const loser = results.find((r) => r.statusCode === 409)!;
    expect(loser.json()).toEqual({ error: 'last_owner' });
    const owners = await withTenant(pool, { tenantId: tenant }, async (_db, c) =>
      Number(
        (
          await c.query<{ n: string }>(
            `SELECT count(*) AS n FROM erp.users u
             JOIN erp.user_roles ur ON ur.user_id = u.id AND ur.deleted_at IS NULL
             WHERE ur.role_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL`,
            [roles['owner']],
          )
        ).rows[0]!.n,
      ),
    );
    expect(owners).toBe(1);
    // Put the original owner back for the other tests if they lost.
    await withTenant(pool, { tenantId: tenant }, (_db, c) =>
      c.query("UPDATE erp.users SET status = 'active' WHERE id = $1", [ids['owner']]),
    );
  });
});

describe('who may change people', () => {
  it('a manager gives a temporary PIN but nothing else', async () => {
    const cookie = await login('manager');
    const id = await addUser('pinless', [roles['salesman']!]);
    expect((await send('PUT', `/api/users/${id}/temporary-pin`, cookie, { pin: '4826' })).statusCode).toBe(
      204,
    );
    const denied = [
      await send('POST', '/api/users', cookie, { username: 'x1', fullName: 'X', roles: [] }),
      await send('PATCH', `/api/users/${id}`, cookie, { fullName: 'Y' }),
      await send('PUT', `/api/users/${id}/roles`, cookie, { roles: [] }),
      await send('PUT', `/api/users/${id}/password`, cookie, { temporaryPassword: TEMPORARY }),
      await send('DELETE', `/api/users/${id}/password`, cookie),
      await send('POST', `/api/users/${id}/deactivate`, cookie),
      await send('POST', `/api/users/${id}/reactivate`, cookie),
    ];
    expect(denied.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403, 403, 403]);
  });

  it('a salesman changes nothing', async () => {
    const cookie = await login('seller');
    const res = await send('POST', `/api/users/${ids['manager']}/deactivate`, cookie);
    expect(res.statusCode).toBe(403);
  });
});
