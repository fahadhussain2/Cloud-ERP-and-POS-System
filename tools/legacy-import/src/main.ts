// The legacy importer's command line (importer spec, D-084). Prints counts and column names only.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import type { ColumnPolicy } from './columns';
import { DumpError } from './errors';
import { GROUPS, importMasters } from './load';
import { importOpening, type LegacyTotals, type OpeningInputs } from './opening-load';
import { writeOpeningReports } from './opening-reports';
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
  } else if (args.step === 'opening') {
    // W1-14: compute, write the draft (unless --dry-run), post it with --post, and the reconciliation report.
    const mapping = parseMapping(
      JSON.parse(await readFile(resolve(toolDir, 'mapping', `${args.tenant}.json`), 'utf8')),
    );
    const labelDir = resolve(toolDir, 'out', args.label);
    const optional = async <T>(file: string): Promise<T | null> => {
      try {
        return JSON.parse(await readFile(resolve(labelDir, file), 'utf8')) as T;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    };
    const o = args.opening!;
    const started = Date.now();
    const run = importOpening({
      stagingUrl: url,
      label: args.label,
      appUrl: process.env['LEGACY_TARGET_URL'] ?? DEFAULT_TARGET_URL,
      tenantCode: args.tenant,
      mapping,
      asOf: o.asOf,
      businessDate: o.date,
      write: !args.dryRun,
      post: o.post,
      inputs: (await optional<OpeningInputs>('opening-inputs.json')) ?? {},
      legacyTotals: await optional<LegacyTotals>('legacy-totals.json'),
      legacyClosing: await legacyClosingOf(resolve(labelDir, 'legacy-closing.csv')),
      now: new Date(),
    });
    // An unmapped document type stops the run, but its report is written first, to decide the signs from.
    const result = await run.catch(async (err: unknown) => {
      const partial = (err as { partial?: Awaited<typeof run> }).partial;
      if (partial) console.info(`document types: ${await writeOpeningReports(partial, labelDir)}`);
      throw err;
    });
    const page = await writeOpeningReports(result, labelDir);
    const t = result.totals;
    const rs = (minor: number) => (minor / 100).toFixed(2);
    console.info(
      `opening ${args.label}: ${result.status}${result.status === 'unchanged' ? `, ${result.differences} lines differ` : ''}`,
    );
    console.info(`stock      ${t.stockLines} items, value ${rs(t.stockValue)}, ${t.noCost} without a cost`);
    console.info(`customers  ${t.customers}, total ${rs(t.customerTotal)}`);
    console.info(`suppliers  ${t.suppliers}, total ${rs(t.supplierTotal)}`);
    const cc = result.closingCompare;
    if (cc)
      console.info(
        `legacy report: ${Object.entries(cc.counts)
          .map(([k, v]) => `${k} ${v}`)
          .join(
            ', ',
          )}; totals legacy ${cc.totals.legacy / 1000}, computed ${cc.totals.computed / 1000}, records ${cc.totals.records / 1000}`,
      );
    const kc = result.costCompare;
    if (kc)
      console.info(
        `legacy rates: ${Object.entries(kc.counts)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}; value ours ${kc.values.ours / 100}, report ${kc.values.report / 100}`,
      );
    for (const c of result.checks) console.info(`${c.status.padEnd(8)} ${c.check}`);
    console.info(`took ${((Date.now() - started) / 1000).toFixed(1)} s. reconciliation: ${page}`);
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
    // Over the tunnel to production each query waits one round trip (W1-24).
    console.info(`queries to the target: ${result.queries.toLocaleString('en-US')}`);
    console.info(`${result.dryRun ? 'dry run: nothing was written. ' : ''}reports: ${index}`);
  }
} catch (err) {
  // DumpError messages name files, lines and columns, never values.
  console.error(`legacy-import: ${err instanceof DumpError ? err.message : (err as Error).message}`);
  process.exit(1);
}

/** legacy-closing.csv (item,qty[,rate]): the legacy Item Wise Closing Stock report per item, for the dump day; optional. */
async function legacyClosingOf(
  path: string,
): Promise<{ itemId: string; qty: string; rate?: string }[] | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const [header, ...lines] = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  const cols = (header ?? '').split(',').map((c) => c.trim().toLowerCase());
  const item = cols.indexOf('item');
  const qty = cols.indexOf('qty');
  if (item < 0 || qty < 0) throw new Error('legacy-closing.csv needs the columns item and qty');
  const rate = cols.indexOf('rate');
  return lines.map((l) => {
    const c = l.split(',');
    return {
      itemId: (c[item] ?? '').trim(),
      qty: (c[qty] ?? '').trim(),
      ...(rate < 0 ? {} : { rate: (c[rate] ?? '').trim() }),
    };
  });
}
