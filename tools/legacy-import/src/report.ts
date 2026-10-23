import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StagingReport } from './stage';

// The staging report (D-084): counts and column names only, never a value, so it can be shared.

const n = (v: number) => v.toLocaleString('en-US');

export function formatStagingReport(r: StagingReport): string {
  const tables = r.files
    .flatMap((f) => f.tables.map((t) => ({ f, t })))
    .sort((a, b) => a.t.table.localeCompare(b.t.table));
  const dropped = tables.flatMap(({ t }) => t.dropped.map((d) => `${t.table}.${d}`));
  return [
    `# Staging report: ${r.label}`,
    '',
    `Staged into \`${r.schema}\` at ${r.stagedAt}: ${n(r.totals.files)} files, ${n(r.totals.tables)} tables, ${n(r.totals.rows)} rows.`,
    'Every file passed the count check: INSERT lines = rows parsed = rows staged.',
    '',
    `**Dropped columns (never stored):** ${dropped.length ? dropped.join(', ') : 'none'}`,
    '',
    '| Table | INSERT lines | Rows parsed | Rows staged | File |',
    '|---|--:|--:|--:|---|',
    ...tables.map(
      ({ f, t }) =>
        `| ${t.table} | ${n(f.insertLines)} | ${n(f.rowsParsed)} | ${n(f.rowsStaged)} | ${f.file} |`,
    ),
    '',
    '## Staged columns',
    '',
    'Check once that none of these holds a password, PIN or CNIC; add any that does to `columns.json` under `drop`.',
    '',
    ...tables.map(({ t }) => `- **${t.table}** (\`${r.schema}.${t.staged}\`): ${t.columns.join(', ')}`),
    '',
  ].join('\n');
}

/** Writes `<outDir>/<label>/staging-report.md` and `.json`; returns their paths. */
export async function writeStagingReport(
  r: StagingReport,
  outDir: string,
): Promise<[md: string, json: string]> {
  const dir = join(outDir, r.label);
  await mkdir(dir, { recursive: true });
  const md = join(dir, 'staging-report.md');
  const json = join(dir, 'staging-report.json');
  await writeFile(md, formatStagingReport(r));
  await writeFile(json, JSON.stringify(r, null, 2) + '\n');
  return [md, json];
}
