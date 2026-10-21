import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Checks the database features the design depends on, before any schema exists.
describe('PostgreSQL connection', () => {
  const client = new pg.Client({ connectionString: process.env['DATABASE_URL'] });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it('is PostgreSQL 17 or newer', async () => {
    const { rows } = await client.query<{ server_version_num: string }>('SHOW server_version_num');
    expect(Number(rows[0]?.server_version_num)).toBeGreaterThanOrEqual(170000);
  });

  it('provides the xid8 snapshot cursor used by the change feed (CLAUDE.md rule 8)', async () => {
    const { rows } = await client.query<{ xmin: string; type: string }>(
      'SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin, pg_typeof(pg_snapshot_xmin(pg_current_snapshot()))::text AS type',
    );
    expect(rows[0]?.type).toBe('xid8');
    expect(rows[0]?.xmin).toMatch(/^\d+$/);
  });

  it('keeps a transaction-local tenant setting inside its transaction only (architecture §6.2)', async () => {
    const tenantId = '0192f1a0-0000-7000-8000-000000000001';
    const read = async () =>
      (await client.query<{ v: string | null }>("SELECT current_setting('app.tenant_id', true) AS v")).rows[0]
        ?.v;

    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    expect(await read()).toBe(tenantId);
    await client.query('COMMIT');

    expect(await read()).toBeFalsy();
  });
});
