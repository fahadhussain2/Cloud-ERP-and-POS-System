import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Only packages/posting writes the ledgers (posting rules invariant 1, CLAUDE.md rule 4). Tests may set up or tamper
// with rows on purpose, and migrations create the tables, so both are left out.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const LEDGERS = [
  'stock_movements',
  'stock_balances',
  'item_costs',
  'party_ledger_entries',
  'party_balances',
  'journal_entries',
  'journal_lines',
  'postings',
  'posting_state',
  // The floor from cost moves with the average (W1-14).
  'item_floors',
];
const WRITE = new RegExp(
  String.raw`\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+erp\.(${LEDGERS.join('|')})\b`,
  'i',
);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : sources(path);
    return /\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

describe('ledger writers', () => {
  it('finds no ledger-table writes outside packages/posting', () => {
    const files = ['apps', 'packages', 'tools'].flatMap((d) =>
      readdirSync(join(ROOT, d), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !(d === 'packages' && e.name === 'posting'))
        .flatMap((e) => sources(join(ROOT, d, e.name))),
    );
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter((f) => WRITE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
