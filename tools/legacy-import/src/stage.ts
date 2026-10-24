import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import pg from 'pg';

import { isCredentialColumn, looksLikeCnic, NO_POLICY, type ColumnPolicy } from './columns';
import { DumpError } from './errors';
import { countInsertLines, parseScript, readDumpFile, type InsertStatement } from './parse';

// Staging (importer spec §5, D-084): every row of a dump folder into `legacy_<label>`, as text, in one
// transaction. Staging a label again replaces it; other labels are untouched.

export interface StageOptions {
  /** The staging database (erp_legacy), never the app database. */
  url: string;
  /** Names the dump copy: `legacy_<label>`. */
  label: string;
  dumpDir: string;
  policy?: ColumnPolicy;
}

export interface StagedTable {
  /** As in the dump, e.g. `INV_Item`. */
  table: string;
  /** In staging, e.g. `inv_item`. */
  staged: string;
  columns: string[];
  dropped: string[];
  rows: number;
}

export interface StagedFile {
  file: string;
  sha256: string;
  /** Lines that start an INSERT, counted without the parser. */
  insertLines: number;
  statements: number;
  rowsParsed: number;
  rowsStaged: number;
  tables: StagedTable[];
}

export interface StagingReport {
  label: string;
  schema: string;
  stagedAt: string;
  files: StagedFile[];
  totals: { files: number; tables: number; rows: number };
}

interface TableState extends StagedTable {
  /** The column list as the dump gives it. */
  source: string[];
  /** Source column positions that are staged. */
  keep: number[];
  insert: (rows: unknown[][]) => Promise<void>;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** Parameters per INSERT stay well under PostgreSQL's 65,535. */
const MAX_PARAMS = 30_000;

export async function stageDump({
  url,
  label,
  dumpDir,
  policy = NO_POLICY,
}: StageOptions): Promise<StagingReport> {
  if (!/^[a-z0-9_]{1,30}$/.test(label)) throw new DumpError('bad_label', 'a label is 1–30 of a-z, 0-9 and _');
  const files = (await readdir(dumpDir)).filter((f) => /\.sql$/i.test(f)).sort();
  if (files.length === 0) throw new DumpError('no_files', 'no .sql files in the dump folder');
  const schema = `legacy_${label}`;
  const drop = new Set(policy.drop);
  const allow = new Set(policy.allow);

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`DROP SCHEMA IF EXISTS ${ident(schema)} CASCADE`);
    await c.query(`CREATE SCHEMA ${ident(schema)}`);
    await c.query(`CREATE TABLE ${ident(schema)}._files (
      file text PRIMARY KEY, sha256 text NOT NULL, insert_lines integer NOT NULL, statements integer NOT NULL,
      rows_parsed integer NOT NULL, rows_staged integer NOT NULL, dropped text[] NOT NULL, staged_at timestamptz NOT NULL)`);

    const tables = new Map<string, TableState>();
    const createTable = async (s: InsertStatement, file: string): Promise<TableState> => {
      const keep = s.columns.flatMap((col, i) =>
        isCredentialColumn(col) || drop.has(`${s.table}.${col}`) ? [] : [i],
      );
      const kept = keep.map((i) => s.columns[i]!);
      const staged = s.table.toLowerCase();
      const names = [...kept.map((col) => col.toLowerCase()), '_file', '_line'];
      if (new Set(names).size !== names.length)
        throw new DumpError(
          'columns_changed',
          `${s.table} has two columns that differ only in case`,
          file,
          s.line,
        );
      const target = `${ident(schema)}.${ident(staged)}`;
      await c.query(
        `CREATE TABLE ${target} (${names.map((n) => `${ident(n)} ${n === '_line' ? 'integer NOT NULL' : n === '_file' ? 'text NOT NULL' : 'text'}`).join(', ')})`,
      );
      const width = names.length;
      const batch = Math.max(1, Math.floor(MAX_PARAMS / width));
      const insert = async (rows: unknown[][]) => {
        for (let start = 0; start < rows.length; start += batch) {
          const chunk = rows.slice(start, start + batch);
          const values = chunk
            .map((_, r) => `(${names.map((__, k) => `$${r * width + k + 1}`).join(', ')})`)
            .join(', ');
          await c.query(`INSERT INTO ${target} VALUES ${values}`, chunk.flat());
        }
      };
      return {
        table: s.table,
        staged,
        columns: kept,
        dropped: s.columns.filter((_, i) => !keep.includes(i)),
        rows: 0,
        source: s.columns,
        keep,
        insert,
      };
    };

    const report: StagedFile[] = [];
    for (const file of files) {
      const { text, sha256 } = await readDumpFile(join(dumpDir, file));
      const inFile = new Map<string, TableState>();
      const pending = new Map<TableState, unknown[][]>();
      let statements = 0;
      let rowsParsed = 0;
      for (const s of parseScript(text, file)) {
        statements += 1;
        let t = tables.get(s.table.toLowerCase());
        if (!t) {
          t = await createTable(s, file);
          tables.set(t.staged, t);
        } else if (s.columns.join('\u0000') !== t.source.join('\u0000')) {
          throw new DumpError('columns_changed', `${s.table}: a different column list`, file, s.line);
        }
        inFile.set(t.staged, t);
        const rows = pending.get(t) ?? [];
        for (const row of s.rows) {
          const staged = t.keep.map((i) => row[i] ?? null);
          staged.forEach((v, k) => {
            const column = `${t.table}.${t.columns[k]!}`;
            if (v !== null && looksLikeCnic(v) && !allow.has(column))
              throw new DumpError(
                'personal_data',
                `${column} has a value shaped like a CNIC; drop the column or allow it in columns.json`,
                file,
                s.line,
              );
          });
          rows.push([...staged, file, s.line]);
        }
        rowsParsed += s.rows.length;
        t.rows += s.rows.length;
        pending.set(t, rows);
        if (rows.length >= 5_000) {
          await t.insert(rows);
          pending.set(t, []);
        }
      }
      for (const [t, rows] of pending) await t.insert(rows);

      let rowsStaged = 0;
      for (const t of inFile.values()) {
        const r = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${ident(schema)}.${ident(t.staged)} WHERE _file = $1`,
          [file],
        );
        rowsStaged += r.rows[0]!.n;
      }
      const insertLines = countInsertLines(text);
      if (insertLines !== statements || rowsStaged !== rowsParsed)
        throw new DumpError(
          'count_mismatch',
          `INSERT lines ${insertLines}, statements ${statements}, rows parsed ${rowsParsed}, rows staged ${rowsStaged}`,
          file,
        );
      const dropped = [...inFile.values()].flatMap((t) => t.dropped.map((d) => `${t.table}.${d}`));
      await c.query(
        `INSERT INTO ${ident(schema)}._files (file, sha256, insert_lines, statements, rows_parsed, rows_staged, dropped, staged_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [file, sha256, insertLines, statements, rowsParsed, rowsStaged, dropped],
      );
      report.push({
        file,
        sha256,
        insertLines,
        statements,
        rowsParsed,
        rowsStaged,
        tables: [...inFile.values()].map(({ table, staged, columns, dropped: d }) => ({
          table,
          staged,
          columns,
          dropped: d,
          rows: 0,
        })),
      });
    }

    await c.query('COMMIT');
    // Table row counts are known only once every file is staged (a table could span files).
    for (const f of report) for (const t of f.tables) t.rows = tables.get(t.staged)!.rows;
    return {
      label,
      schema,
      stagedAt: new Date().toISOString(),
      files: report,
      totals: {
        files: report.length,
        tables: tables.size,
        rows: report.reduce((n, f) => n + f.rowsStaged, 0),
      },
    };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}
