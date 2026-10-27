import { randomBytes } from 'node:crypto';

import pg from 'pg';

import { migrate } from '../migrate';

// Test-only role passwords for throwaway databases; never used on a server.
const OWNER = { name: 'erp_owner', password: 'erp_owner_test' };
const APP = { name: 'erp_app', password: 'erp_app_test' };

export interface TestDatabase {
  name: string;
  /** Superuser connection, for setup and catalog checks. */
  adminUrl: string;
  /** Migration role (owns the schema). */
  ownerUrl: string;
  /** Application role (no BYPASSRLS, owns nothing). */
  appUrl: string;
  drop: () => Promise<void>;
}

function withUser(url: string, user: { name: string; password: string } | null, database: string): string {
  const u = new URL(url);
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * Creates a fresh database with the two roles and all migrations applied (W0-07, D-078).
 * Needs DATABASE_URL to point at a PostgreSQL 17+ superuser (CI provides one; locally: pnpm db:up).
 * With a `name`, an existing database of that name is kept and brought up to date (the local `erp_dev`).
 */
export async function createTestDatabase(opts: { name?: string } = {}): Promise<TestDatabase> {
  const base = process.env['DATABASE_URL'];
  if (!base) throw new Error('DATABASE_URL is not set');
  const name = opts.name ?? `erp_test_${randomBytes(6).toString('hex')}`;
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`not a database name: ${name}`);

  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    // Roles are cluster-wide: create them once, with the same attributes as on the server.
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OWNER.name}') THEN
          CREATE ROLE ${OWNER.name} LOGIN PASSWORD '${OWNER.password}';
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP.name}') THEN
          CREATE ROLE ${APP.name} LOGIN PASSWORD '${APP.password}' NOBYPASSRLS;
        END IF;
      END $$`);
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${name}`);
    await admin.query(`GRANT CONNECT, CREATE ON DATABASE ${name} TO ${OWNER.name}`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO ${APP.name}`);
  } finally {
    await admin.end();
  }

  const db: TestDatabase = {
    name,
    adminUrl: withUser(base, null, name),
    ownerUrl: withUser(base, OWNER, name),
    appUrl: withUser(base, APP, name),
    drop: async () => {
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
  await migrate(db.ownerUrl, { log: () => undefined });
  return db;
}

/**
 * Creates a tenant as the owner role (FORCE RLS applies to it too, so it sets the context), and registers its
 * shop code in the login directory when one is given.
 */
export async function createTenant(ownerUrl: string, name: string, code?: string): Promise<string> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query<{ id: string }>('SELECT erp.uuid_v7() AS id');
    const id = rows[0]!.id;
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
    await c.query(
      `INSERT INTO erp.tenants (id, name, base_currency, currency_minor_units, timezone, locale,
         fiscal_year_start_month, closing_time)
       VALUES ($1, $2, 'PKR', 2, 'Asia/Karachi', 'en-PK', 1, '20:00')`,
      [id, name],
    );
    if (code) await c.query('INSERT INTO erp.tenant_directory (code, tenant_id) VALUES ($1, $2)', [code, id]);
    await c.query('COMMIT');
    return id;
  } finally {
    await c.end();
  }
}

export { seedCatalog, TEST_TIERS, type TestItem } from './catalog';
export { generateCatalog, seedGeneratedCatalog, type SeedReport } from './generate';
