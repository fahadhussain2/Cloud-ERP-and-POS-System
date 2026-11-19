import type { ShopTodayView } from '@erp/contracts';
import { withTenant } from '@erp/db';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requirePermission } from '../auth/routes';
import { shopDay } from '../lock';

// The lists the back office's Counters screen reads (W1-02, D-089). Devices need admin.devices, which managers have.
// The staff list is GET /api/users (admin/users.ts, W1-04). The shop's business date is for every back-office screen
// that starts on a date (W2-05).

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

export function registerAdmin(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  // The shop's business date now (tenant time zone and day cut-off): any signed-in user.
  scope.get('/shop/today', { preHandler: requireAuth }, async (req): Promise<ShopTodayView> => {
    const a = req.auth!;
    const { today } = await withTenant(
      pool,
      { tenantId: a.tenantId, userId: a.userId, requestId: req.id },
      (_db, c) => shopDay(c, now()),
    );
    return { today };
  });

  scope.get('/branches', { preHandler: requireAuth }, async (req) => {
    const a = req.auth!;
    const { rows } = await withTenant(
      pool,
      { tenantId: a.tenantId, userId: a.userId, requestId: req.id },
      (_db, c) =>
        c.query<{ id: string; code: string; name: string }>(
          "SELECT id, code, name FROM erp.branches WHERE deleted_at IS NULL AND status = 'active' ORDER BY code",
        ),
    );
    return rows;
  });

  scope.get('/devices', { preHandler: requirePermission(requireAuth, 'admin.devices') }, async (req) => {
    const a = req.auth!;
    const { rows } = await withTenant(
      pool,
      { tenantId: a.tenantId, userId: a.userId, requestId: req.id },
      (_db, c) =>
        c.query<{
          id: string;
          code: string;
          name: string | null;
          kind: string;
          branch_id: string;
          status: string;
          enrolled_at: Date;
          revoked_at: Date | null;
          last_seen_at: Date | null;
          last_push_at: Date | null;
          last_pull_at: Date | null;
          client_version: string | null;
          schema_version: number | null;
          outbox_count: number | null;
          oldest_unsynced_at: Date | null;
          quarantined_count: number | null;
          storage_persisted: boolean | null;
          storage_usage: string | null;
          storage_quota: string | null;
          clock_skew_ms: number | null;
          open_gaps: number;
        }>(
          // Each counter's health from its last push and pull (PLT-09, W1-07); null before it has called in.
          `SELECT d.id, d.code, d.name, d.kind, d.branch_id, d.status, d.enrolled_at, d.revoked_at,
             s.last_seen_at, s.last_push_at, s.last_pull_at, s.client_version, s.schema_version, s.outbox_count,
             s.oldest_unsynced_at, s.quarantined_count, s.storage_persisted, s.storage_usage, s.storage_quota,
             s.clock_skew_ms,
             (SELECT count(*)::int FROM erp.sequence_gaps g WHERE g.device_id = d.id AND g.resolved_at IS NULL)
               AS open_gaps
           FROM erp.devices d LEFT JOIN erp.device_status s ON s.tenant_id = d.tenant_id AND s.device_id = d.id
           WHERE d.deleted_at IS NULL ORDER BY d.code`,
        ),
    );
    const iso = (t: Date | null) => t?.toISOString() ?? null;
    const num = (n: string | null) => (n === null ? null : Number(n));
    return rows.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
      kind: d.kind,
      branchId: d.branch_id,
      status: d.status,
      enrolledAt: d.enrolled_at.toISOString(),
      revokedAt: iso(d.revoked_at),
      health:
        d.last_seen_at === null
          ? null
          : {
              lastSeenAt: iso(d.last_seen_at),
              lastPushAt: iso(d.last_push_at),
              lastPullAt: iso(d.last_pull_at),
              clientVersion: d.client_version,
              schemaVersion: d.schema_version,
              outboxCount: d.outbox_count,
              oldestUnsyncedAt: iso(d.oldest_unsynced_at),
              quarantinedCount: d.quarantined_count,
              storagePersisted: d.storage_persisted,
              storageUsage: num(d.storage_usage),
              storageQuota: num(d.storage_quota),
              clockSkewMs: d.clock_skew_ms,
              openGaps: d.open_gaps,
            },
    }));
  });
}
