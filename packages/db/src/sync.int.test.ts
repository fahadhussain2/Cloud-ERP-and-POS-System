import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pullChanges, START } from './sync';
import { withTenant } from './tenant';
import { createTenant, createTestDatabase, type TestDatabase } from './testing/database';

// Sync columns and the change-feed cursor (CLAUDE.md rule 8, architecture §5.3, D-078).

let db: TestDatabase;
let pool: pg.Pool;
let tenant: string;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  tenant = await createTenant(db.ownerUrl, 'Sync tenant');
});

afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const insertBranch = (c: pg.ClientBase, code: string) =>
  c.query<{ txid: string; row_version: string }>(
    "INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, $2, 'B') RETURNING txid::text, row_version::text",
    [tenant, code],
  );

describe('sync columns', () => {
  it('are set on insert and move forward on update', async () => {
    await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
      const ins = (await insertBranch(c, 'S1')).rows[0]!;
      expect(BigInt(ins.txid)).toBeGreaterThan(0n);
      expect(BigInt(ins.row_version)).toBeGreaterThan(0n);
    });
    await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
      const before = (
        await c.query("SELECT txid::text, row_version::text FROM erp.branches WHERE code = 'S1'")
      ).rows[0] as { txid: string; row_version: string };
      const after = (
        await c.query<{ txid: string; row_version: string }>(
          "UPDATE erp.branches SET name = 'renamed' WHERE code = 'S1' RETURNING txid::text, row_version::text",
        )
      ).rows[0]!;
      expect(BigInt(after.txid)).toBeGreaterThan(BigInt(before.txid));
      expect(BigInt(after.row_version)).toBeGreaterThan(BigInt(before.row_version));
    });
  });

  it('cannot be faked by the client', async () => {
    await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
      const { rows } = await c.query<{ row_version: string }>(
        "INSERT INTO erp.branches (tenant_id, code, name, row_version, txid) VALUES ($1, 'S2', 'B', 1, '1') RETURNING row_version::text",
        [tenant],
      );
      expect(rows[0]!.row_version).not.toBe('1');
    });
  });

  it('refuses DELETE: rows are soft-deleted so the deletion syncs', async () => {
    await expect(
      withTenant(pool, { tenantId: tenant }, (_db, c) =>
        c.query("DELETE FROM erp.branches WHERE code = 'S2'"),
      ),
    ).rejects.toThrow(/never deleted/);
    await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
      const before = (await c.query("SELECT row_version::text FROM erp.branches WHERE code = 'S2'"))
        .rows[0] as {
        row_version: string;
      };
      const after = (
        await c.query<{ row_version: string }>(
          "UPDATE erp.branches SET deleted_at = now() WHERE code = 'S2' RETURNING row_version::text",
        )
      ).rows[0]!;
      expect(BigInt(after.row_version)).toBeGreaterThan(BigInt(before.row_version));
    });
  });
});

describe('change-feed cursor', () => {
  it('returns every change exactly once, in order, when resumed page by page', async () => {
    const codes = ['P1', 'P2', 'P3', 'P4', 'P5'];
    for (const code of codes) {
      await withTenant(pool, { tenantId: tenant }, (_db, c) => insertBranch(c, code));
    }
    const seen: string[] = [];
    let cursor = START;
    for (;;) {
      const page = await withTenant(pool, { tenantId: tenant }, (_db, c) =>
        pullChanges(c, 'branches', cursor, 2),
      );
      seen.push(...page.rows.map((r) => r['code'] as string));
      if (page.rows.length === 0) break;
      cursor = page.cursor;
    }
    expect(seen.filter((c) => codes.includes(c))).toEqual(codes);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('never skips a row written by a slower transaction that commits later', async () => {
    // T1 writes and stays open; T2 writes later and commits first.
    const t1 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t1.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      await insertBranch(t1, 'SLOW');
      await withTenant(pool, { tenantId: tenant }, (_db, c) => insertBranch(c, 'FAST'));

      // A pull now must not return FAST: the cursor would move past T1's txid and lose SLOW forever.
      const during = await withTenant(pool, { tenantId: tenant }, (_db, c) =>
        pullChanges(c, 'branches', START, 1000),
      );
      expect(during.rows.map((r) => r['code'])).not.toContain('FAST');

      await t1.query('COMMIT');
      const after = await withTenant(pool, { tenantId: tenant }, (_db, c) =>
        pullChanges(c, 'branches', during.cursor, 1000),
      );
      const codes = after.rows.map((r) => r['code']);
      expect(codes).toContain('SLOW');
      expect(codes).toContain('FAST');
      expect(codes.indexOf('SLOW')).toBeLessThan(codes.indexOf('FAST'));
    } finally {
      t1.release();
    }
  });
});
