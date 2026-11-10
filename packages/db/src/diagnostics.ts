import type pg from 'pg';

import { withTenant } from './tenant';

// A counter's diagnostics are kept 30 days (owner answer 6 to W1-20, D-110): long enough for support to look at a
// problem the shop reported, short enough that the log never becomes a record of its own.

export const DIAGNOSTICS_KEEP_DAYS = 30;

/** Removes one shop's diagnostics received more than 30 days before `now`; returns how many went. */
export async function pruneDiagnostics(pool: pg.Pool, tenantId: string, now: Date): Promise<number> {
  return withTenant(pool, { tenantId }, async (_db, c) => {
    const { rowCount } = await c.query(
      `DELETE FROM erp.device_diagnostics WHERE received_at < $1::timestamptz - make_interval(days => $2)`,
      [now.toISOString(), DIAGNOSTICS_KEEP_DAYS],
    );
    return rowCount ?? 0;
  });
}
