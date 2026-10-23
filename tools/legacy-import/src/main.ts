// The legacy importer's command line (importer spec, D-084). Prints counts and column names only.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import type { ColumnPolicy } from './columns';
import { DumpError } from './errors';
import { writeStagingReport } from './report';
import { stageDump } from './stage';
import { parseArgs, usage } from './usage';

const toolDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(toolDir, '../..');
// The local dev PostgreSQL (pnpm db:up). Staging never goes to a server (D-084).
const DEFAULT_URL = 'postgres://postgres:postgres@127.0.0.1:54329/erp_legacy';

/** Creates the staging database on first use. */
async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  const server = new URL(url);
  server.pathname = '/postgres';
  const c = new pg.Client({ connectionString: server.toString() });
  await c.connect();
  try {
    const found = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount === 0) await c.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } finally {
    await c.end();
  }
}

const args = parseArgs(process.argv.slice(2));
if ('error' in args) {
  console.error(`legacy-import: ${args.error}\n\n${usage()}`);
  process.exit(2);
}
if (args.step !== 'stage') {
  console.error(`legacy-import: ${args.step} is not implemented yet (W0-13)`);
  process.exit(2);
}

try {
  const url = process.env['LEGACY_DATABASE_URL'] ?? DEFAULT_URL;
  const policy = JSON.parse(await readFile(resolve(toolDir, 'columns.json'), 'utf8')) as ColumnPolicy;
  await ensureDatabase(url);
  const report = await stageDump({
    url,
    label: args.label,
    dumpDir: args.dump === null ? resolve(repoRoot, 'sql_dump') : resolve(process.cwd(), args.dump),
    policy,
  });
  const [md] = await writeStagingReport(report, resolve(toolDir, 'out'));
  const t = report.totals;
  console.info(`staged ${t.rows.toLocaleString('en-US')} rows from ${t.files} files into ${report.schema}`);
  console.info(`report: ${md}`);
} catch (err) {
  // DumpError messages name files, lines and columns, never values.
  console.error(`legacy-import: ${err instanceof DumpError ? err.message : (err as Error).message}`);
  process.exit(1);
}
