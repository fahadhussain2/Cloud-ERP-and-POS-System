import type pg from 'pg';

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
