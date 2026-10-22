import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';

import * as schema from './schema';

export interface TenantContext {
  tenantId: string;
  userId?: string;
  deviceId?: string;
  requestId?: string;
}

export type Db = NodePgDatabase<typeof schema>;

/**
 * Runs `fn` in one transaction with the tenant context set (SET LOCAL via set_config(..., true)).
 * RLS uses it on every table; outside this function every table is empty (D-078, CLAUDE.md rule 5).
 * The context ends with the transaction, so a pooled connection never carries it to the next request.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  ctx: TenantContext,
  fn: (db: Db, client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
              set_config('app.device_id', $3, true), set_config('app.request_id', $4, true)`,
      [ctx.tenantId, ctx.userId ?? '', ctx.deviceId ?? '', ctx.requestId ?? ''],
    );
    const result = await fn(drizzle(client, { schema }), client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
