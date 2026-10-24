import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR, migrate } from './migrate';
import * as schema from './schema';
import { withTenant } from './tenant';
import { createTenant, createTestDatabase, type TestDatabase } from './testing/database';

// Audit columns, IDs, migrations and schema drift (D-078).

let db: TestDatabase;
let admin: pg.Client;
let pool: pg.Pool;
let tenant: string;

beforeAll(async () => {
  db = await createTestDatabase();
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 2 });
  tenant = await createTenant(db.ownerUrl, 'Schema tenant');
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.drop();
});

describe('audit columns', () => {
  it('record who created and who last changed a row, from the transaction context', async () => {
    const creator = '0192f1a0-0000-7000-8000-00000000c0de';
    const editor = '0192f1a0-0000-7000-8000-0000000ed170';
    await withTenant(pool, { tenantId: tenant, userId: creator }, (_db, c) =>
      c.query("INSERT INTO erp.branches (tenant_id, code, name) VALUES ($1, 'AU1', 'Audit')", [tenant]),
    );
    await withTenant(pool, { tenantId: tenant, userId: editor }, (_db, c) =>
      // A client trying to rewrite history is ignored.
      c.query(
        "UPDATE erp.branches SET name = 'Audited', created_by_user_id = $1, created_at = '2000-01-01' WHERE code = 'AU1'",
        [editor],
      ),
    );
    const { rows } = await admin.query<{
      created_by_user_id: string;
      updated_by_user_id: string;
      created_year: number;
      changed: boolean;
    }>(`SELECT created_by_user_id, updated_by_user_id, extract(year FROM created_at)::int AS created_year,
          updated_at > created_at AS changed FROM erp.branches WHERE code = 'AU1'`);
    expect(rows[0]).toEqual({
      created_by_user_id: creator,
      updated_by_user_id: editor,
      created_year: new Date().getUTCFullYear(),
      changed: true,
    });
  });
});

describe('erp.uuid_v7()', () => {
  it('returns version-7 UUIDs that sort by creation time', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { rows } = await admin.query<{ id: string }>('SELECT erp.uuid_v7()::text AS id');
      ids.push(rows[0]!.id);
      await new Promise((r) => setTimeout(r, 2));
    }
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('migrations', () => {
  it('are a no-op when run again', async () => {
    const applied = await migrate(db.ownerUrl, { log: () => undefined });
    expect(applied).toEqual([]);
  });

  it('refuse to run when an applied migration was edited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'erp-migrations-'));
    for (const f of readdirSync(MIGRATIONS_DIR))
      writeFileSync(join(dir, f), readFileSync(join(MIGRATIONS_DIR, f)));
    const first = readdirSync(dir).sort()[0]!;
    writeFileSync(join(dir, first), `${readFileSync(join(dir, first), 'utf8')}\n-- edited`);
    await expect(migrate(db.ownerUrl, { dir, log: () => undefined })).rejects.toThrow(
      /was changed after it was applied/,
    );
  });
});

describe('the Drizzle schema matches the database', () => {
  const normalize = (t: string) =>
    t
      .replace(/^char\((\d+)\)$/, 'character($1)')
      .replace(/^numeric\((\d+), (\d+)\)$/, 'numeric($1,$2)')
      .replace(/^time$/, 'time without time zone')
      .replace(/^timestamp$/, 'timestamp without time zone');

  it('has the same tables, columns, types and nullability', async () => {
    const { rows } = await admin.query<{ table: string; column: string; type: string; not_null: boolean }>(`
      SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
        a.attnotnull AS not_null
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'erp' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY 1, 2`);
    const database = rows.map((r) => `${r.table}.${r.column} ${r.type}${r.not_null ? ' not null' : ''}`);
    const drizzle = Object.values(schema)
      .flatMap((t) => {
        try {
          const cfg = getTableConfig(t as Parameters<typeof getTableConfig>[0]);
          return cfg.schema === 'erp' ? [cfg] : [];
        } catch {
          return [];
        }
      })
      .flatMap((cfg) =>
        cfg.columns.map(
          (c) => `${cfg.name}.${c.name} ${normalize(c.getSQLType())}${c.notNull ? ' not null' : ''}`,
        ),
      )
      .sort();
    expect(drizzle).toEqual([...database].sort());
  });
});
