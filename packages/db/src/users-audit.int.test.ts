import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from './tenant';
import { createTenant, createTestDatabase, type TestDatabase } from './testing/database';

// Users, roles, the tenant directory and the append-only audit log (PLT-04, PLT-05, PLT-08, D-081).

let db: TestDatabase;
let admin: pg.Client;
let pool: pg.Pool;
let tenantA: string;
let tenantB: string;
const actor = '0192f1a0-0000-7000-8000-0000000000a1';

beforeAll(async () => {
  db = await createTestDatabase();
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 2 });
  tenantA = await createTenant(db.ownerUrl, 'Users A', 'users-a');
  tenantB = await createTenant(db.ownerUrl, 'Users B', 'users-b');
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.drop();
});

const insertUser = (c: pg.ClientBase, tenant: string, username: string) =>
  c.query<{ id: string }>(
    `INSERT INTO erp.users (tenant_id, username, full_name, password_hash, pin_verifier)
     VALUES ($1, $2, 'Test User', 'secret-hash', 'secret-pin') RETURNING id`,
    [tenant, username],
  );

describe('users', () => {
  it('have case-insensitive unique usernames per tenant, but two tenants may share one', async () => {
    await withTenant(pool, { tenantId: tenantA }, (_db, c) => insertUser(c, tenantA, 'Ali'));
    await expect(
      withTenant(pool, { tenantId: tenantA }, (_db, c) => insertUser(c, tenantA, 'ali')),
    ).rejects.toThrow(/duplicate key/);
    await withTenant(pool, { tenantId: tenantB }, (_db, c) => insertUser(c, tenantB, 'ali'));
  });
});

describe('tenant directory', () => {
  it('maps a shop code to its tenant for login, readable without a tenant context', async () => {
    const { rows } = await pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM erp.tenant_directory WHERE code = 'users-a'",
    );
    expect(rows).toEqual([{ tenant_id: tenantA }]);
  });

  it('holds only the code and the tenant id', async () => {
    const { rows } = await admin.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'erp' AND table_name = 'tenant_directory' ORDER BY 1",
    );
    expect(rows.map((r) => r.column_name)).toEqual(['code', 'tenant_id']);
  });

  it('cannot be changed by the application role', async () => {
    await expect(
      withTenant(pool, { tenantId: tenantA }, (_db, c) =>
        c.query("UPDATE erp.tenant_directory SET code = 'stolen' WHERE tenant_id = $1", [tenantA]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('audit log', () => {
  it('records before and after of a change, with the user and request, without secrets', async () => {
    const userId = await withTenant(pool, { tenantId: tenantA, userId: actor }, async (_db, c) => {
      const { rows } = await insertUser(c, tenantA, 'auditme');
      return rows[0]!.id;
    });
    await withTenant(pool, { tenantId: tenantA, userId: actor, requestId: 'req-42' }, (_db, c) =>
      c.query("UPDATE erp.users SET full_name = 'Renamed', password_hash = 'new-secret' WHERE id = $1", [
        userId,
      ]),
    );
    const { rows } = await admin.query<{
      action: string;
      user_id: string;
      request_id: string | null;
      before: Record<string, unknown> | null;
      after: Record<string, unknown>;
    }>(
      `SELECT action, user_id, request_id, before, after FROM erp.audit_log
       WHERE entity = 'users' AND entity_id = $1 ORDER BY at, id`,
      [userId],
    );
    expect(rows.map((r) => r.action)).toEqual(['create', 'update']);
    const update = rows[1]!;
    expect(update.user_id).toBe(actor);
    expect(update.request_id).toBe('req-42');
    expect(update.before?.['full_name']).toBe('Test User');
    expect(update.after['full_name']).toBe('Renamed');
    for (const r of rows) {
      for (const json of [r.before, r.after]) {
        expect(json ?? {}).not.toHaveProperty('password_hash');
        expect(json ?? {}).not.toHaveProperty('pin_verifier');
      }
    }
  });

  it('records a soft delete as a delete, and skips writes that change nothing', async () => {
    const id = await withTenant(pool, { tenantId: tenantA }, async (_db, c) => {
      const { rows } = await c.query<{ id: string }>(
        "INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'AUD', 'Audited') RETURNING id",
        [tenantA],
      );
      await c.query("UPDATE erp.branches SET name = 'Audited' WHERE id = $1", [rows[0]!.id]);
      await c.query('UPDATE erp.branches SET deleted_at = now() WHERE id = $1', [rows[0]!.id]);
      return rows[0]!.id;
    });
    const { rows } = await admin.query<{ action: string }>(
      "SELECT action FROM erp.audit_log WHERE entity = 'branches' AND entity_id = $1 ORDER BY at, id",
      [id],
    );
    expect(rows.map((r) => r.action)).toEqual(['create', 'delete']);
  });

  it('is append-only for the application role and the owner role alike', async () => {
    const owner = new pg.Client({ connectionString: db.ownerUrl });
    await owner.connect();
    try {
      for (const client of [pool, owner]) {
        for (const sql of [
          'UPDATE erp.audit_log SET action = $1',
          'DELETE FROM erp.audit_log WHERE action = $1',
        ]) {
          await expect(
            (async () => {
              const c = client instanceof pg.Pool ? await client.connect() : client;
              try {
                await c.query('BEGIN');
                await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
                await c.query(sql, ['create']);
              } finally {
                await c.query('ROLLBACK');
                if (client instanceof pg.Pool) (c as pg.PoolClient).release();
              }
            })(),
          ).rejects.toThrow(/append-only|permission denied/);
        }
      }
      await expect(owner.query('TRUNCATE erp.audit_log')).rejects.toThrow(/append-only/);
    } finally {
      await owner.end();
    }
  });

  it('is invisible to other tenants', async () => {
    const { rows } = await withTenant(pool, { tenantId: tenantB }, (_db, c) =>
      c.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM erp.audit_log'),
    );
    expect(rows.every((r) => r.tenant_id === tenantB)).toBe(true);
  });
});
