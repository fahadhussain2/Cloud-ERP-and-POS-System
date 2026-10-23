import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from './tenant';
import { createTenant, createTestDatabase, type TestDatabase } from './testing/database';

// Tenant isolation is enforced by PostgreSQL (CLAUDE.md rule 5, PLT-10, D-028, D-078).

// Tables that are not tenant-owned by a `tenant_id` column. Keep this list short and justified.
const NOT_TENANT_ID = new Map([['tenants', 'its policy is on id: a tenant sees only its own row']]);

let db: TestDatabase;
let admin: pg.Client;
let pool: pg.Pool;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  db = await createTestDatabase();
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 1 });
  tenantA = await createTenant(db.ownerUrl, 'Tenant A');
  tenantB = await createTenant(db.ownerUrl, 'Tenant B');
  for (const [tenant, code] of [
    [tenantA, 'A1'],
    [tenantB, 'B1'],
  ] as const) {
    await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
      await c.query("INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, $2, 'Main')", [
        tenant,
        code,
      ]);
    });
  }
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.drop();
});

describe('every table has forced RLS', () => {
  it('has RLS enabled and forced, a policy, and a NOT NULL tenant_id', async () => {
    const { rows } = await admin.query<{
      table: string;
      enabled: boolean;
      forced: boolean;
      policies: number;
      tenant_id_not_null: boolean | null;
    }>(`
      SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
        (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
        (SELECT a.attnotnull FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS tenant_id_not_null
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'erp' AND c.relkind IN ('r', 'p')
      ORDER BY 1`);
    expect(rows.length).toBeGreaterThan(0);
    const problems = rows.flatMap((t) => {
      const issues: string[] = [];
      if (!t.enabled) issues.push('RLS not enabled');
      if (!t.forced) issues.push('RLS not forced');
      if (t.policies === 0) issues.push('no policy');
      if (!NOT_TENANT_ID.has(t.table) && t.tenant_id_not_null !== true) issues.push('no NOT NULL tenant_id');
      return issues.map((i) => `erp.${t.table}: ${i}`);
    });
    expect(problems).toEqual([]);
  });

  it('keeps tables out of the public schema', async () => {
    const { rows } = await admin.query(
      "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND relkind IN ('r', 'p')",
    );
    expect(rows).toEqual([]);
  });
});

describe('the application role is safe', () => {
  it('is not a superuser, cannot bypass RLS and owns nothing', async () => {
    const { rows } = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean; owned: number }>(`
      SELECT r.rolsuper, r.rolbypassrls,
        (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned
      FROM pg_roles r WHERE r.rolname = 'erp_app'`);
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, owned: 0 });
  });

  it('cannot alter, disable RLS on, or drop a table', async () => {
    for (const sql of [
      'ALTER TABLE erp.branches DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE erp.branches NO FORCE ROW LEVEL SECURITY',
      'DROP TABLE erp.branches',
    ]) {
      await expect(pool.query(sql), sql).rejects.toThrow(/must be owner/);
    }
  });

  it('cannot create tenants', async () => {
    await expect(
      withTenant(pool, { tenantId: tenantA }, (_db, c) =>
        c.query(
          `INSERT INTO erp.tenants (name, base_currency, currency_minor_units, timezone, locale,
             fiscal_year_start_month, closing_time) VALUES ('X', 'PKR', 2, 'Asia/Karachi', 'en', 1, '20:00')`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('tenants are isolated', () => {
  it('sees only its own tenant row and branches', async () => {
    await withTenant(pool, { tenantId: tenantA }, async (_db, c) => {
      const tenants = await c.query<{ id: string }>('SELECT id FROM erp.tenants');
      expect(tenants.rows.map((r) => r.id)).toEqual([tenantA]);
      const branches = await c.query<{ code: string }>('SELECT code FROM erp.branches');
      expect(branches.rows.map((r) => r.code)).toEqual(['A1']);
    });
  });

  it("cannot update or delete another tenant's rows", async () => {
    await withTenant(pool, { tenantId: tenantA }, async (_db, c) => {
      const updated = await c.query("UPDATE erp.branches SET name = 'hacked' WHERE code = 'B1'");
      expect(updated.rowCount).toBe(0);
      const deleted = await c.query("DELETE FROM erp.branches WHERE code = 'B1'");
      expect(deleted.rowCount).toBe(0);
    });
    const { rows } = await admin.query("SELECT name FROM erp.branches WHERE code = 'B1'");
    expect(rows).toEqual([{ name: 'Main' }]);
  });

  it('cannot insert a row for another tenant', async () => {
    await expect(
      withTenant(pool, { tenantId: tenantA }, (_db, c) =>
        c.query("INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'X1', 'Sneaky')", [tenantB]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot move its own row to another tenant', async () => {
    await expect(
      withTenant(pool, { tenantId: tenantA }, (_db, c) =>
        c.query("UPDATE erp.branches SET tenant_id = $1 WHERE code = 'A1'", [tenantB]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('fails closed', () => {
  it('returns nothing and cannot write without a tenant context', async () => {
    for (const table of ['tenants', 'branches', 'locations']) {
      const { rows } = await pool.query(`SELECT * FROM erp.${table}`);
      expect(rows, table).toEqual([]);
    }
    await expect(
      pool.query("INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'Z1', 'No context')", [
        tenantA,
      ]),
    ).rejects.toThrow(/row-level security/);
  });

  it('raises an error for a malformed tenant context', async () => {
    await expect(
      withTenant(pool, { tenantId: 'not-a-uuid' }, (_db, c) => c.query('SELECT * FROM erp.branches')),
    ).rejects.toThrow(/invalid input syntax for type uuid/);
  });

  it('leaves no context on the pooled connection after the transaction', async () => {
    await withTenant(pool, { tenantId: tenantA, userId: tenantA }, () => Promise.resolve());
    // The pool has a single connection, so this runs on the same one.
    const { rows } = await pool.query<{ tenant: string | null; branches: number }>(
      "SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant, (SELECT count(*)::int FROM erp.branches) AS branches",
    );
    expect(rows[0]).toEqual({ tenant: null, branches: 0 });
  });
});
