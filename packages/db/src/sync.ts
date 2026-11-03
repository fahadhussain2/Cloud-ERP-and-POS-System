import pg from 'pg';

// Change-feed pull (architecture §5.3, CLAUDE.md rule 8). The sync endpoints build on this in Wave 1.

export interface Cursor {
  /** xid8, as a decimal string */
  txid: string;
  /** bigint, as a decimal string */
  rowVersion: string;
}

export const START: Cursor = { txid: '0', rowVersion: '0' };

export const SYNCED_TABLES = ['tenants', 'branches', 'locations'] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

/**
 * Rows changed after `after`, in (txid, row_version) order. Only rows whose transaction is older than every
 * transaction still running are returned (txid < pg_snapshot_xmin), so a slow transaction can never commit
 * "behind" a cursor the client already passed. Run inside withTenant: RLS scopes it to the tenant.
 */
export async function pullChanges(client: pg.ClientBase, table: SyncedTable, after: Cursor, limit: number) {
  if (!SYNCED_TABLES.includes(table)) throw new Error(`not a synced table: ${String(table)}`);
  const { rows } = await client.query<
    Record<string, unknown> & { txid_text: string; row_version_text: string }
  >(
    `SELECT *, txid::text AS txid_text, row_version::text AS row_version_text
     FROM erp.${table}
     WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
       AND (txid, row_version) > ($1::xid8, $2::bigint)
     ORDER BY txid, row_version
     LIMIT $3`,
    [after.txid, after.rowVersion, limit],
  );
  const last = rows.at(-1);
  const cursor: Cursor = last ? { txid: last.txid_text, rowVersion: last.row_version_text } : after;
  return { rows, cursor };
}

export interface PullSource {
  /** Table in the erp schema, e.g. `users`. */
  table: string;
  /** The only columns returned (sync spec §3): a column not listed never leaves the server. */
  columns: readonly string[];
  /** An extra filter with $n placeholders numbered from $4 (e.g. a branch filter). */
  where?: string;
  params?: readonly unknown[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
/** PostgreSQL's `date` type. */
const DATE_OID: number = pg.types.builtins.DATE;
/** node-pg's own parsers, except a `date`, which stays its text. */
const parserOf = pg.types.getTypeParser as (
  oid: number,
  format?: 'text' | 'binary',
) => (value: string) => unknown;
const keepDates = ((oid: number, format?: 'text' | 'binary') =>
  oid === DATE_OID ? (v: string): unknown => v : parserOf(oid, format)) as typeof pg.types.getTypeParser;

/**
 * pullChanges for counters (sync spec §2, D-089): the same cursor rule, but only the listed columns. Run inside
 * withTenant: RLS scopes it to the tenant.
 */
export async function pullColumns(client: pg.ClientBase, source: PullSource, after: Cursor, limit: number) {
  for (const name of [source.table, ...source.columns]) {
    if (!IDENTIFIER.test(name)) throw new Error(`not an identifier: ${name}`);
  }
  const { rows } = await client.query<Record<string, unknown> & { _txid: string; _rv: string }>({
    // A `date` stays its text (`2026-11-02`): parsed into a JS Date it would reach the counter as a timestamp, a day off
    // on a server whose time zone isn't UTC (W1-13: a bill's business date).
    types: { getTypeParser: keepDates },
    text: `SELECT ${source.columns.map((c) => `"${c}"`).join(', ')}, txid::text AS _txid, row_version::text AS _rv
     FROM erp.${source.table}
     WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
       AND (txid, row_version) > ($1::xid8, $2::bigint)
       ${source.where ? `AND (${source.where})` : ''}
     ORDER BY txid, row_version
     LIMIT $3`,
    values: [after.txid, after.rowVersion, limit, ...(source.params ?? [])],
  });
  const last = rows.at(-1);
  const cursor: Cursor = last ? { txid: last._txid, rowVersion: last._rv } : after;
  for (const row of rows) {
    delete (row as Partial<typeof row>)._txid;
    delete (row as Partial<typeof row>)._rv;
  }
  return { rows: rows as Record<string, unknown>[], cursor };
}
