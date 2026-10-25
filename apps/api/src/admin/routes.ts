import { withTenant } from '@erp/db';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requirePermission } from '../auth/routes';

// The lists the back office's Counters and Staff PINs screens read (W1-02, D-089). Staff and devices need
// admin.devices, which managers have; PIN verifiers and password hashes never leave the server.

interface Deps {
  pool: pg.Pool;
  requireAuth: preHandlerAsyncHookHandler;
}

export function registerAdmin(scope: FastifyInstance, { pool, requireAuth }: Deps) {
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

  scope.get('/staff', { preHandler: requirePermission(requireAuth, 'admin.devices') }, async (req) => {
    const a = req.auth!;
    const { rows } = await withTenant(
      pool,
      { tenantId: a.tenantId, userId: a.userId, requestId: req.id },
      (_db, c) =>
        c.query<{
          id: string;
          username: string;
          full_name: string;
          short_code: string | null;
          status: string;
          has_pin: boolean;
          pin_must_change: boolean;
        }>(
          `SELECT id, username, full_name, short_code, status, pin_verifier IS NOT NULL AS has_pin, pin_must_change
         FROM erp.users WHERE deleted_at IS NULL ORDER BY lower(full_name)`,
        ),
    );
    return rows.map((u) => ({
      id: u.id,
      username: u.username,
      fullName: u.full_name,
      shortCode: u.short_code,
      status: u.status,
      hasPin: u.has_pin,
      pinMustChange: u.pin_must_change,
    }));
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
        }>(
          `SELECT id, code, name, kind, branch_id, status, enrolled_at, revoked_at
         FROM erp.devices WHERE deleted_at IS NULL ORDER BY code`,
        ),
    );
    return rows.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
      kind: d.kind,
      branchId: d.branch_id,
      status: d.status,
      enrolledAt: d.enrolled_at.toISOString(),
      revokedAt: d.revoked_at?.toISOString() ?? null,
    }));
  });
}
