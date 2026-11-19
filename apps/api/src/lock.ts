import { businessDate, checkDocumentDate } from '@erp/domain';
import type pg from 'pg';

// The lock date in the back office (ACC-06, owner answer 5 to W1-19, D-108): a back-office document dated on or before
// it is refused, whoever posts it; the back office can always pick another date. Counter documents are never refused
// (rule 7): they post on the first open date with `posted_after_lock`.

/** Where each back-office posting source keeps the day it posts on. */
const DATED: Record<string, { table: string; column: string; by: 'id' | 'receipt_id' }> = {
  goods_receipt: { table: 'goods_receipts', column: 'business_date', by: 'id' },
  purchase_return: { table: 'purchase_returns', column: 'business_date', by: 'id' },
  supplier_payment: { table: 'supplier_payments', column: 'business_date', by: 'id' },
  stock_transfer: { table: 'stock_transfers', column: 'business_date', by: 'id' },
  stock_transfer_receipt: { table: 'stock_transfers', column: 'received_on', by: 'receipt_id' },
  stock_adjustment: { table: 'stock_adjustments', column: 'business_date', by: 'id' },
  customer_receipt: { table: 'customer_receipts', column: 'business_date', by: 'id' },
  expense: { table: 'expenses', column: 'business_date', by: 'id' },
  fund_transfer: { table: 'fund_transfers', column: 'business_date', by: 'id' },
  journal_voucher: { table: 'journal_vouchers', column: 'business_date', by: 'id' },
};

/** The lock date, when this back-office document is dated on or before it; null when it may post. */
export async function lockedOn(c: pg.ClientBase, type: string, id: string): Promise<string | null> {
  const d = DATED[type];
  if (!d) throw new Error(`no date known for ${type}`);
  const { rows } = await c.query<{ lock_date: string }>(
    `SELECT t.lock_date::text AS lock_date FROM erp.tenants t, erp.${d.table} x
     WHERE x.${d.by} = $1 AND t.lock_date IS NOT NULL AND x.${d.column} <= t.lock_date`,
    [id],
  );
  return rows[0]?.lock_date ?? null;
}

/** The shop's business date now and its lock date. */
export async function shopDay(
  c: pg.ClientBase,
  now: Date,
): Promise<{ today: string; lockDate: string | null }> {
  const { rows } = await c.query<{ timezone: string; day_cutoff_hour: number; lock_date: string | null }>(
    'SELECT timezone, day_cutoff_hour, lock_date::text AS lock_date FROM erp.tenants',
  );
  const t = rows[0]!;
  return { today: businessDate(now.getTime(), t.timezone, t.day_cutoff_hour), lockDate: t.lock_date };
}

/** Why a back-office document can't post on its date: what the API answers, with the date to name. */
export type DateRefusal =
  { error: 'date_in_future'; today: string } | { error: 'date_locked'; lockDate: string };

/**
 * Why this back-office document can't post on its date, or null when it may: dated after the shop's business date
 * (W2-05; the business date has a cut-off, so at 00:30 the shop is still on the day before), or on or before the lock
 * date (D-108). Purchasing and stock documents; accounting checks its own with `checkDocumentDate` first.
 */
export async function dateRefusal(
  c: pg.ClientBase,
  type: string,
  id: string,
  now: Date,
): Promise<DateRefusal | null> {
  const d = DATED[type];
  if (!d) throw new Error(`no date known for ${type}`);
  const { rows } = await c.query<{ day: string | null }>(
    `SELECT x.${d.column}::text AS day FROM erp.${d.table} x WHERE x.${d.by} = $1`,
    [id],
  );
  const { today, lockDate } = await shopDay(c, now);
  const problem = checkDocumentDate(rows[0]?.day ?? null, today, lockDate);
  if (problem === 'date_in_future') return { error: 'date_in_future', today };
  if (problem === 'date_locked') return { error: 'date_locked', lockDate: lockDate! };
  return null;
}
