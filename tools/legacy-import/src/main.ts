// The legacy importer's command line (importer spec, D-084). Prints counts and column names only.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import type { ColumnPolicy } from './columns';
import { DumpError } from './errors';
import { GROUPS, importMasters } from './load';
import { writeStagingReport } from './report';
import { writeImportReports } from './reports';
import { stageDump } from './stage';
import { parseMapping } from './transform/mapping';
import { parseArgs, usage } from './usage';

const toolDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(toolDir, '../..');
// The local dev PostgreSQL (pnpm db:up). Staging never goes to a server (D-084).
const DEFAULT_URL = 'postgres://postgres:postgres@127.0.0.1:54329/erp_legacy';
// The local dev database (pnpm dev:db), as the app role: the import runs under RLS like the app (D-085).
const DEFAULT_TARGET_URL = 'postgres://erp_app:erp_app_test@127.0.0.1:54329/erp_dev';

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
if (args.step === 'parse') {
  console.error('legacy-import: parsing runs as part of the stage step');
  process.exit(2);
}

try {
  const url = process.env['LEGACY_DATABASE_URL'] ?? DEFAULT_URL;
  if (args.step === 'stage') {
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
  } else {
    // transform and report compare and report only; load writes (D-085).
    const mapping = parseMapping(
      JSON.parse(await readFile(resolve(toolDir, 'mapping', `${args.tenant}.json`), 'utf8')),
    );
    const result = await importMasters({
      stagingUrl: url,
      label: args.label,
      appUrl: process.env['LEGACY_TARGET_URL'] ?? DEFAULT_TARGET_URL,
      tenantCode: args.tenant,
      mapping,
      dryRun: args.step !== 'load' || args.dryRun,
    });
    const index = await writeImportReports(result, resolve(toolDir, 'out', args.label));
    for (const g of GROUPS) {
      const c = result.groups[g];
      console.info(
        `${g.padEnd(18)} created ${c.created}, updated ${c.updated}, unchanged ${c.unchanged}, retired ${c.retired}`,
      );
    }
    console.info(`${result.dryRun ? 'dry run: nothing was written. ' : ''}reports: ${index}`);
  }
} catch (err) {
  // DumpError messages name files, lines and columns, never values.
  console.error(`legacy-import: ${err instanceof DumpError ? err.message : (err as Error).message}`);
  process.exit(1);
}
