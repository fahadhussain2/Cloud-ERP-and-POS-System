import pg from 'pg';

// The pilot wipe and the go-live mark (W1-14, owner answer 1, D-101). The shadow pilot (D-031) is throwaway: legacy
// stays official and already has every pilot sale. Before the final run its documents and everything derived from
// them are removed, as erp_owner, in one transaction, and written to the audit log; the masters, staff, PINs and
// settings stay. It is the one exception to rules 3 and 4, for pre-go-live data only: refused once the tenant is marked
// live, and while any counter still reports unsynced documents (rule 9). The counters are revoked, so a counter that
// wasn't reset can't push into the clean books; each is cleared and enrolled again.

export class WipeRefused extends Error {
  constructor(
    readonly code: 'live' | 'unsynced',
    readonly detail: string[] = [],
  ) {
    super(
      code === 'live' ? 'refused: the shop is live' : `refused: unsynced documents on ${detail.join(', ')}`,
    );
  }
}

/**
 * Removed, in this order (children first). Synced document tables refuse deletes (rule 8's change feed), so that
 * trigger is switched off for this transaction only; the counters start from empty anyway.
 */
const DOCUMENT_TABLES = [
  'exceptions',
  'overrides',
  'sales_payments',
  'sales_voids',
  'cash_handovers',
  'payments',
  'cash_movements',
  'cash_sessions',
  'sales_lines',
  'sales_documents',
  'sync_inbox',
  'sequence_gaps',
  'device_series',
  'device_status',
  // Reports and support (W1-20): a counter's diagnostics, sent by a manager.
  'device_diagnostics',
  'journal_lines',
  'journal_entries',
  'stock_movements',
  'party_ledger_entries',
  'opening_balance_lines',
  'opening_balances',
  // Purchasing (W1-16): returns before the receipts they point at; the numbers start again.
  'purchase_return_lines',
  'purchase_returns',
  'goods_receipt_lines',
  'goods_receipts',
  'supplier_payments',
  // Stock operations (W1-18): adjustments before the transfers whose shortfall they record.
  'stock_adjustment_lines',
  'stock_adjustments',
  'stock_transfer_lines',
  'stock_transfers',
  // Back-office accounting (W1-19): a voucher's lines before it.
  'journal_voucher_lines',
  'journal_vouchers',
  'customer_receipts',
  'expenses',
  'fund_transfers',
  'document_counters',
  'postings',
  'posting_state',
  'item_costs',
] as const;

/** Synced balances: zeroed or marked deleted, like the rebuild does, so the change feed stays whole. */
const BALANCE_TABLES = ['stock_balances', 'party_balances', 'item_floors'] as const;

/** What the wipe keeps: everything a shop is set up with, the people, the catalog, the parties and the audit log. */
export const KEPT_TABLES = [
  'tenants',
  'branches',
  'locations',
  'tenant_directory',
  'users',
  'user_login_state',
  // Each person's theme (W2-07, D-120): a preference, kept with the people.
  'user_settings',
  'roles',
  'user_roles',
  'sessions',
  'audit_log',
  'devices',
  'device_enrollment_codes',
  'device_challenges',
  'device_tokens',
  'accounts',
  'bank_accounts',
  'payment_methods',
  'price_tiers',
  'tax_codes',
  'print_profiles',
  'expense_categories',
  'units',
  'categories',
  'brands',
  'origins',
  'vehicle_makes',
  'parties',
  'customer_accounts',
  'supplier_accounts',
  'items',
  'item_identifiers',
  'item_compatibility',
  'item_prices',
  // The prices are kept, so their history is too (W1-15, D-104).
  'price_history',
  // Which routes need receiving is a setting (W1-18).
  'transfer_routes',
] as const;
/** Every table is in exactly one list (a test checks it against the schema), so a new table needs a decision. */
export const WIPED_TABLES = [...DOCUMENT_TABLES, ...BALANCE_TABLES];

const SYNCED = new Set([
  'sales_documents',
  'sales_lines',
  'sales_payments',
  'overrides',
  'cash_sessions',
  'cash_handovers',
  'payments',
  'cash_movements',
  'sales_voids',
]);

export interface WipeReport {
  /** Rows removed per table. */
  removed: Record<string, number>;
  /** Counters revoked: to be cleared and enrolled again. */
  devicesRevoked: string[];
}

const session = async (c: pg.ClientBase, tenantId: string, userId: string | null) => {
  await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
    tenantId,
    userId ?? '',
  ]);
};

export async function wipePilot(
  ownerUrl: string,
  tenantId: string,
  opts: { userId: string | null; now: Date },
): Promise<WipeReport> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await session(c, tenantId, opts.userId);
    // No posting while the books are emptied.
    await c.query('INSERT INTO erp.posting_state (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenantId]);
    await c.query('SELECT 1 FROM erp.posting_state WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
    const live = await c.query('SELECT 1 FROM erp.tenants WHERE id = $1 AND go_live_at IS NOT NULL', [
      tenantId,
    ]);
    if (live.rowCount) throw new WipeRefused('live');
    const unsynced = await c.query<{ code: string }>(
      `SELECT d.code FROM erp.device_status s JOIN erp.devices d ON d.id = s.device_id
       WHERE s.outbox_count > 0 AND d.status = 'active' ORDER BY d.code`,
    );
    if (unsynced.rowCount)
      throw new WipeRefused(
        'unsynced',
        unsynced.rows.map((r) => r.code),
      );

    const removed: Record<string, number> = {};
    for (const table of DOCUMENT_TABLES) {
      if (table === 'sales_voids') continue; // removed with its bills, below
      if (table === 'sales_documents') {
        // A voided bill points at its void and the void at the bill (0013), and a voided bill must keep its void, so
        // neither table can go first: one statement removes both, and the foreign keys are checked at its end.
        for (const t of ['sales_voids', 'sales_documents'])
          await c.query(`ALTER TABLE erp.${t} DISABLE TRIGGER refuse_delete`);
        const both = await c.query<{ voids: string; bills: string }>(
          `WITH v AS (DELETE FROM erp.sales_voids WHERE tenant_id = $1 RETURNING 1),
                d AS (DELETE FROM erp.sales_documents WHERE tenant_id = $1 RETURNING 1)
           SELECT (SELECT count(*) FROM v) AS voids, (SELECT count(*) FROM d) AS bills`,
          [tenantId],
        );
        removed['sales_voids'] = Number(both.rows[0]!.voids);
        removed['sales_documents'] = Number(both.rows[0]!.bills);
        for (const t of ['sales_voids', 'sales_documents'])
          await c.query(`ALTER TABLE erp.${t} ENABLE TRIGGER refuse_delete`);
        continue;
      }
      if (SYNCED.has(table)) await c.query(`ALTER TABLE erp.${table} DISABLE TRIGGER refuse_delete`);
      removed[table] =
        (await c.query(`DELETE FROM erp.${table} WHERE tenant_id = $1`, [tenantId])).rowCount ?? 0;
      if (SYNCED.has(table)) await c.query(`ALTER TABLE erp.${table} ENABLE TRIGGER refuse_delete`);
    }
    removed['stock_balances'] =
      (await c.query('UPDATE erp.stock_balances SET qty = 0, updated_at = $1 WHERE qty <> 0', [opts.now]))
        .rowCount ?? 0;
    removed['party_balances'] =
      (
        await c.query('UPDATE erp.party_balances SET balance = 0, updated_at = $1 WHERE balance <> 0', [
          opts.now,
        ])
      ).rowCount ?? 0;
    removed['item_floors'] =
      (
        await c.query(
          'UPDATE erp.item_floors SET deleted_at = $1, updated_at = $1 WHERE deleted_at IS NULL',
          [opts.now],
        )
      ).rowCount ?? 0;
    const revoked = await c.query<{ code: string }>(
      `UPDATE erp.devices SET status = 'revoked', revoked_at = $1, revoked_by_user_id = $2
       WHERE status = 'active' RETURNING code`,
      [opts.now, opts.userId],
    );
    const report: WipeReport = { removed, devicesRevoked: revoked.rows.map((r) => r.code).sort() };
    await c.query(
      `INSERT INTO erp.audit_log (tenant_id, user_id, action, entity, after) VALUES ($1, $2, 'pilot.wipe', 'tenants', $3)`,
      [tenantId, opts.userId, JSON.stringify({ ...report, at: opts.now })],
    );
    await c.query('COMMIT');
    return report;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

/** The final run's last step: the shop is live (the wipe is refused from now on) and the books before it are locked. */
export async function markLive(
  ownerUrl: string,
  tenantId: string,
  opts: { userId: string | null; lockDate: string; now: Date },
): Promise<void> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await session(c, tenantId, opts.userId);
    const r = await c.query(
      'UPDATE erp.tenants SET go_live_at = $2, lock_date = $3 WHERE id = $1 AND go_live_at IS NULL',
      [tenantId, opts.now, opts.lockDate],
    );
    if (!r.rowCount) throw new Error('the shop is already live');
    await c.query(
      `INSERT INTO erp.audit_log (tenant_id, user_id, action, entity, entity_id, after)
       VALUES ($1, $2, 'tenant.go_live', 'tenants', $1, $3)`,
      [tenantId, opts.userId, JSON.stringify({ lockDate: opts.lockDate, at: opts.now })],
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}
