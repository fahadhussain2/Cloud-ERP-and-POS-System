import { TenantSpec, type ShopSettingsView } from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTestDatabase, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';

// The shop's name and bill header (W1-25 plan; PLT-01, POS-09, D-112): the owner reads and saves them in one
// audited transaction under RLS; nobody else may (admin.settings); the counters pull the changed rows.

const SHOP = 'header-shop';
const OTHER = 'header-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Client;
let tenant: string;
let other: string;
let branch: string;
let otherBranch: string;
const cookies: Record<string, string> = {};
const app = () => buildApp({ pool, now: () => new Date('2026-11-13T06:00:00.000Z') });

async function addUser(username: string, template: RoleTemplateKey, tenantId: string) {
  const hash = await hashPassword(PASSWORD);
  await withTenant(pool, { tenantId }, async (_db, c) => {
    const role = await c.query<{ id: string }>(
      `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits) VALUES ($1, $2, NULL, $3, $4)
       RETURNING id`,
      [tenantId, `${username} role`, ROLE_TEMPLATES[template].permissions, ROLE_TEMPLATES[template].limits],
    );
    const user = await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, password_hash) VALUES ($1, $2, initcap($2), $3)
       RETURNING id`,
      [tenantId, username, hash],
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

const send = (method: 'GET' | 'PUT', url: string, who: string, payload?: unknown) =>
  app().inject({
    method,
    url,
    headers: { origin: ORIGIN, host: HOST },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    cookies: { erp_session: cookies[who]! },
  });

const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  (await admin.query<T>(sql, params)).rows;

const saved = () => ({
  name: 'City Auto Corner',
  branchId: branch,
  address: 'Shop 14, Auto Market, Karachi',
  phone: '021-1234567',
  lines: ['Dealers in genuine parts'],
  policyText: 'Exchange within 30 days with this bill.',
});

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
  branch = (await q<{ id: string }>('SELECT id FROM erp.branches WHERE tenant_id = $1', [tenant]))[0]!.id;
  otherBranch = (await q<{ id: string }>('SELECT id FROM erp.branches WHERE tenant_id = $1', [other]))[0]!.id;
  // The profile's own header line and paper settings must survive a save of the policy line.
  await q(
    `UPDATE erp.print_profiles SET template_options = '{"headerLines": ["Counter copy"], "fontSize": 11}'
     WHERE tenant_id = $1 AND is_tenant_default`,
    [tenant],
  );
  await addUser('owner', 'owner', tenant);
  await addUser('maria', 'manager', tenant);
  await addUser('otto', 'owner', other);
  for (const u of ['owner', 'maria']) await login(u);
  await login('otto', OTHER);
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.drop();
});

describe('the owner', () => {
  it('reads the shop as setup made it', async () => {
    const res = await send('GET', '/api/settings/shop', 'owner');
    expect(res.statusCode).toBe(200);
    expect(res.json<ShopSettingsView>()).toEqual({
      name: deluxSpec.name,
      branchId: branch,
      branchName: deluxSpec.branch.name,
      address: '',
      phone: '',
      lines: [],
      policyText: '',
      profileLines: ['Counter copy'],
    });
  });

  it('saves the name, the header and the policy line in one go, audited, and the counters pull them', async () => {
    const txids = async () =>
      (
        await q<{ t: string; b: string; p: string }>(
          `SELECT (SELECT txid::text FROM erp.tenants WHERE id = $1) AS t,
                  (SELECT txid::text FROM erp.branches WHERE id = $2) AS b,
                  (SELECT txid::text FROM erp.print_profiles WHERE tenant_id = $1 AND is_tenant_default) AS p`,
          [tenant, branch],
        )
      )[0]!;
    const before = await txids();
    const [{ at: since }] = (await q<{ at: string }>('SELECT clock_timestamp()::text AS at')) as [
      { at: string },
    ];
    const res = await send('PUT', '/api/settings/shop', 'owner', {
      ...saved(),
      name: '  City Auto Corner  ',
      lines: ['Dealers in genuine parts', '  '],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ShopSettingsView>()).toMatchObject({ ...saved(), profileLines: ['Counter copy'] });
    expect((await send('GET', '/api/settings/shop', 'owner')).json()).toEqual(res.json());

    expect(await q('SELECT name FROM erp.tenants WHERE id = $1', [tenant])).toEqual([
      { name: 'City Auto Corner' },
    ]);
    expect(
      await q('SELECT name, address, phone, receipt_header FROM erp.branches WHERE id = $1', [branch]),
    ).toEqual([
      {
        name: deluxSpec.branch.name,
        address: 'Shop 14, Auto Market, Karachi',
        phone: '021-1234567',
        receipt_header: { lines: ['Dealers in genuine parts'] },
      },
    ]);
    expect(
      await q('SELECT template_options FROM erp.print_profiles WHERE tenant_id = $1 AND is_tenant_default', [
        tenant,
      ]),
    ).toEqual([
      {
        template_options: {
          headerLines: ['Counter copy'],
          fontSize: 11,
          policyText: 'Exchange within 30 days with this bill.',
        },
      },
    ]);

    // Who changed it, with before and after.
    const owner = (
      await q<{ id: string }>("SELECT id FROM erp.users WHERE tenant_id = $1 AND username = 'owner'", [
        tenant,
      ])
    )[0]!.id;
    const audit = await q<{ entity: string; user_id: string; before: Record<string, unknown> }>(
      `SELECT entity, user_id, before FROM erp.audit_log
       WHERE tenant_id = $1 AND action = 'update' AND entity IN ('tenants', 'branches', 'print_profiles')
         AND at > $2::timestamptz
       ORDER BY entity`,
      [tenant, since],
    );
    expect(audit.map((a) => [a.entity, a.user_id])).toEqual([
      ['branches', owner],
      ['print_profiles', owner],
      ['tenants', owner],
    ]);
    expect(audit.find((a) => a.entity === 'tenants')!.before['name']).toBe(deluxSpec.name);

    // A new txid on each row: the counters' next pull returns them (sync spec §2).
    const after = await txids();
    expect(after.t).not.toBe(before.t);
    expect(after.b).not.toBe(before.b);
    expect(after.p).not.toBe(before.p);
  });

  it('clears the address, the phone, the lines and the policy line with blank values', async () => {
    const res = await send('PUT', '/api/settings/shop', 'owner', {
      ...saved(),
      address: ' ',
      phone: '',
      lines: [],
      policyText: '',
    });
    expect(res.statusCode).toBe(200);
    expect(
      await q('SELECT address, phone, receipt_header FROM erp.branches WHERE id = $1', [branch]),
    ).toEqual([{ address: null, phone: null, receipt_header: { lines: [] } }]);
    expect(
      await q('SELECT template_options FROM erp.print_profiles WHERE tenant_id = $1 AND is_tenant_default', [
        tenant,
      ]),
    ).toEqual([{ template_options: { headerLines: ['Counter copy'], fontSize: 11 } }]);
    await send('PUT', '/api/settings/shop', 'owner', saved());
  });

  it('is refused an empty name, a line over 60 characters and a fourth extra line, and nothing changes', async () => {
    for (const body of [
      { ...saved(), name: '   ' },
      { ...saved(), address: 'x'.repeat(61) },
      { ...saved(), lines: ['one', 'two', 'three', 'four'] },
      { ...saved(), policyText: 'y'.repeat(61) },
    ]) {
      const res = await send('PUT', '/api/settings/shop', 'owner', body);
      expect(res.statusCode).toBe(400);
    }
    expect(await q('SELECT name FROM erp.tenants WHERE id = $1', [tenant])).toEqual([
      { name: 'City Auto Corner' },
    ]);
  });
});

describe('everyone else', () => {
  it('a manager can neither read nor save it', async () => {
    expect((await send('GET', '/api/settings/shop', 'maria')).statusCode).toBe(403);
    expect((await send('PUT', '/api/settings/shop', 'maria', saved())).statusCode).toBe(403);
  });

  it("another shop's owner sees only their own shop and can't reach this one's branch", async () => {
    const theirs = await send('GET', '/api/settings/shop', 'otto');
    expect(theirs.json<ShopSettingsView>()).toMatchObject({ name: 'Other Shop', branchId: otherBranch });
    const res = await send('PUT', '/api/settings/shop', 'otto', { ...saved(), name: 'Taken over' });
    expect(res.statusCode).toBe(404);
    expect(
      await q('SELECT name FROM erp.tenants WHERE id IN ($1, $2) ORDER BY name', [tenant, other]),
    ).toEqual([{ name: 'City Auto Corner' }, { name: 'Other Shop' }]);
  });
});
