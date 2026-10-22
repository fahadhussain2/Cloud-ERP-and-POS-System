import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

// Bundled apps keep this relative path: the API image copies the folder next to dist/ (D-078).
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface MigrateOptions {
  dir?: string;
  log?: (message: string) => void;
}

/**
 * Applies new SQL migrations in order, each in its own transaction, as the schema owner (D-078).
 * Applied migrations are immutable: if one was edited, nothing runs. Returns the names it applied.
 */
export async function migrate(
  url: string,
  { dir = MIGRATIONS_DIR, log = console.info }: MigrateOptions = {},
) {
  const files = readdirSync(dir)
    .filter((f) => FILE.test(f))
    .sort();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // One migration run at a time, even if two deploys overlap.
    await client.query("SELECT pg_advisory_lock(hashtext('erp-migrate'))");
    await client.query('CREATE SCHEMA IF NOT EXISTS erp_meta');
    await client.query(`CREATE TABLE IF NOT EXISTS erp_meta.migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM erp_meta.migrations ORDER BY name',
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    const sql = new Map(files.map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')]));
    const checksum = (f: string) => createHash('sha256').update(sql.get(f)!).digest('hex');

    for (const [name, sum] of applied) {
      if (!sql.has(name)) throw new Error(`migration ${name} was applied but its file is missing`);
      if (checksum(name) !== sum) throw new Error(`migration ${name} was changed after it was applied`);
    }

    const pending = files.filter((f) => !applied.has(f));
    for (const name of pending) {
      log(`migrate: applying ${name}`);
      await client.query('BEGIN');
      try {
        await client.query(sql.get(name)!);
        await client.query('INSERT INTO erp_meta.migrations (name, checksum) VALUES ($1, $2)', [
          name,
          checksum(name),
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${name} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    log(pending.length ? `migrate: applied ${pending.length}` : 'migrate: up to date');
    return pending;
  } finally {
    await client.end();
  }
}
