import {
  CASH_DESK_COLUMNS,
  CATALOG_COLUMNS,
  CHECKOUT_COLUMNS,
  CounterPinChangeRequest,
  CUSTOMER_COLUMNS,
  makePinVerifier,
  PULL_DATASETS,
  PULL_LIMIT_DEFAULT,
  PULL_LIMIT_MAX,
  TemporaryPinRequest,
  verifyPin,
  type CashDeskDataset,
  type CatalogDataset,
  type CheckoutDataset,
  type CustomerDataset,
  type PullDataset,
  type PullResponse,
} from '@erp/contracts';
import { pullColumns, START, withTenant, type Cursor, type PullSource } from '@erp/db';
import { pinProblem, PIN_MAX_FAILURES } from '@erp/domain';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { mayGivePin } from '../admin/users';
import { requirePermission } from '../auth/routes';
import { recordPull } from './push';

// Counter sync (sync spec v1, W1-02, W1-03, W1-06, W1-09, W1-10, D-089): pull with per-dataset column lists, and the
// counter PIN change.

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
  requireDevice: preHandlerAsyncHookHandler;
}

const isCatalog = (d: PullDataset): d is CatalogDataset => d in CATALOG_COLUMNS;
const isCheckout = (d: PullDataset): d is CheckoutDataset => d in CHECKOUT_COLUMNS;
const isCustomer = (d: PullDataset): d is CustomerDataset => d in CUSTOMER_COLUMNS;
const isCashDesk = (d: PullDataset): d is CashDeskDataset => d in CASH_DESK_COLUMNS;

/** How far back the queue sends bills already handed over (sync spec §3). */
const CASH_QUEUE_DAYS = 7;

/** Customers (W1-09): only parties with a live customer account, and only customer balances. */
const CUSTOMER_SOURCES: Record<CustomerDataset, Omit<PullSource, 'columns'>> = {
  customers: {
    table: 'parties',
    where: `EXISTS (SELECT 1 FROM erp.customer_accounts a
                    WHERE a.party_id = parties.id AND a.tenant_id = parties.tenant_id AND a.deleted_at IS NULL)`,
  },
  customer_accounts: { table: 'customer_accounts' },
  customer_balances: { table: 'party_balances', where: "role = 'customer'" },
};

/** Each dataset's source and the only columns that may leave the server (sync spec §3). */
function datasetSource(dataset: PullDataset, branchId: string, deviceId: string): PullSource {
  // The catalog (W1-03): the shared column list, tenant-wide; each table is named like its dataset.
  if (isCatalog(dataset))
    return {
      table: dataset,
      columns: [...Object.keys(CATALOG_COLUMNS[dataset]), 'row_version', 'deleted_at'],
    };
  // Payment methods and print profiles (W1-06): tenant-wide; the device: only the caller's own row.
  if (isCheckout(dataset)) {
    const columns = [...Object.keys(CHECKOUT_COLUMNS[dataset]), 'row_version', 'deleted_at'];
    if (dataset === 'device') return { table: 'devices', columns, where: 'id = $4', params: [deviceId] };
    return { table: dataset, columns };
  }
  if (isCustomer(dataset))
    return {
      ...CUSTOMER_SOURCES[dataset],
      columns: [...Object.keys(CUSTOMER_COLUMNS[dataset]), 'row_version', 'deleted_at'],
    };
  switch (dataset) {
    // The cash desk's queue (W1-10): the branch's bills with cash to move, pending or of the last 7 days, so a received
    // bill comes once more with its new status and the first pull stays small.
    case 'cash_queue':
      return {
        table: 'sales_documents',
        columns: [...Object.keys(CASH_DESK_COLUMNS.cash_queue), 'row_version', 'deleted_at'],
        where: `branch_id = $4 AND cash_due <> 0
                AND (handover_status = 'pending' OR received_at > now() - interval '${CASH_QUEUE_DAYS} days')`,
        params: [branchId],
      };
    case 'tenant':
      return {
        table: 'tenants',
        columns: [
          'id',
          'name',
          'base_currency',
          'currency_minor_units',
          'timezone',
          'locale',
          'tax_mode',
          'cash_rounding_increment',
          'day_cutoff_hour',
          'closing_time',
          'cash_handover_mode',
          'offline_warning_hours',
          'offline_strong_warning_hours',
          'status',
          'row_version',
          'deleted_at',
        ],
      };
    case 'branch':
      return {
        table: 'branches',
        columns: [
          'id',
          'code',
          'name',
          'address',
          'phone',
          'receipt_header',
          'status',
          'row_version',
          'deleted_at',
        ],
        where: 'id = $4',
        params: [branchId],
      };
    case 'users':
      // Never password_hash, email, password_changed_at or must_change_password.
      return {
        table: 'users',
        columns: [
          'id',
          'username',
          'full_name',
          'short_code',
          'pin_verifier',
          'pin_must_change',
          'status',
          'row_version',
          'deleted_at',
        ],
      };
    case 'roles':
      return {
        table: 'roles',
        columns: ['id', 'name', 'template_key', 'permissions', 'limits', 'row_version', 'deleted_at'],
      };
    case 'user_roles':
      return {
        table: 'user_roles',
        columns: ['id', 'user_id', 'role_id', 'branch_id', 'row_version', 'deleted_at'],
        where: 'branch_id IS NULL OR branch_id = $4',
        params: [branchId],
      };
  }
}

const DIGITS = /^\d+$/;

/** The opaque cursor: base64url JSON of { dataset: { txid, rowVersion } }. Null if malformed. */
function parseCursor(text: string | undefined): Partial<Record<PullDataset, Cursor>> | null {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const out: Partial<Record<PullDataset, Cursor>> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = v as Partial<Cursor> | null;
      if (
        !(PULL_DATASETS as readonly string[]).includes(k) ||
        !c ||
        !DIGITS.test(String(c.txid)) ||
        !DIGITS.test(String(c.rowVersion))
      )
        return null;
      out[k as PullDataset] = { txid: String(c.txid), rowVersion: String(c.rowVersion) };
    }
    return out;
  } catch {
    return null;
  }
}

const encodeCursor = (c: Partial<Record<PullDataset, Cursor>>) =>
  Buffer.from(JSON.stringify(c)).toString('base64url');

export function registerSync(scope: FastifyInstance, { pool, now, requireAuth, requireDevice }: Deps) {
  scope.get<{ Querystring: { datasets?: string; cursor?: string; limit?: string } }>(
    '/sync/pull',
    { preHandler: requireDevice },
    async (req, reply) => {
      const d = req.device!;
      const datasets = (req.query.datasets ?? '').split(',').filter(Boolean);
      if (datasets.length === 0 || !datasets.every((x) => (PULL_DATASETS as readonly string[]).includes(x)))
        return reply.code(400).send({ error: 'unknown_dataset' });
      // Bills with cash to move go only to the branch's cash desks (W1-10); a counter has no use for them.
      if (d.kind !== 'cash_desk' && (datasets as PullDataset[]).some(isCashDesk))
        return reply.code(403).send({ error: 'not_cash_desk' });
      const limit = req.query.limit === undefined ? PULL_LIMIT_DEFAULT : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > PULL_LIMIT_MAX)
        return reply.code(400).send({ error: 'bad_limit' });
      const cursor = parseCursor(req.query.cursor);
      if (!cursor) return reply.code(400).send({ error: 'bad_cursor' });

      const body: PullResponse = { changes: {}, cursor: '', hasMore: false };
      await withTenant(
        pool,
        { tenantId: d.tenantId, deviceId: d.deviceId, requestId: req.id },
        async (_db, c) => {
          await recordPull(c, d.tenantId, d.deviceId, now());
          let remaining = limit;
          for (const dataset of datasets as PullDataset[]) {
            if (remaining === 0) {
              body.hasMore = true;
              break;
            }
            const page = await pullColumns(
              c,
              datasetSource(dataset, d.branchId, d.deviceId),
              cursor[dataset] ?? START,
              remaining,
            );
            body.changes[dataset] = page.rows;
            cursor[dataset] = page.cursor;
            remaining -= page.rows.length;
            // A full page may have more behind it; the next call finds out.
            if (remaining === 0) body.hasMore = true;
          }
        },
      );
      body.cursor = encodeCursor(cursor);
      return body;
    },
  );

  // A manager gives someone a temporary PIN (owner answer 2 to W1-02); they choose their own at a counter. Guarded by
  // admin.devices, which managers have for counters (W0-09 gives admin.users to the owner only), and never to an Owner
  // or a staff admin the actor doesn't outrank (canGivePinTo, D-091).
  scope.put<{ Params: { id: string } }>(
    '/users/:id/temporary-pin',
    { preHandler: requirePermission(requireAuth, 'admin.devices') },
    async (req, reply) => {
      const body = TemporaryPinRequest.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const a = req.auth!;
      const t = now();
      const verifier = await makePinVerifier(body.data.pin);
      const outcome = await withTenant(
        pool,
        { tenantId: a.tenantId, userId: a.userId, requestId: req.id },
        async (_db, c) => {
          const u = await c.query<{ id: string; short_code: string | null }>(
            'SELECT id, short_code FROM erp.users WHERE id = $1 AND deleted_at IS NULL',
            [req.params.id],
          );
          const user = u.rows[0];
          if (!user) return 'missing' as const;
          // Not to an Owner or a staff admin the actor doesn't outrank: they could take over that PIN (D-091).
          if (!(await mayGivePin(c, a, user.id))) return 'refused' as const;
          const problem = pinProblem(body.data.pin, user.short_code);
          if (problem) return { problem };
          await c.query('UPDATE erp.users SET pin_verifier = $1, pin_must_change = true WHERE id = $2', [
            verifier,
            user.id,
          ]);
          await c.query(
            `INSERT INTO erp.user_login_state (user_id, tenant_id, pin_failures) VALUES ($1, $2, 0)
           ON CONFLICT (user_id) DO UPDATE SET pin_failures = 0`,
            [user.id, a.tenantId],
          );
          // The verifier is stripped from the audit trigger's before/after, so record the change explicitly.
          await c.query(
            `INSERT INTO erp.audit_log (tenant_id, at, user_id, request_id, action, entity, entity_id)
           VALUES ($1, $2, $3, $4, 'pin.temporary_set', 'users', $5)`,
            [a.tenantId, t, a.userId, req.id, user.id],
          );
          return 'set' as const;
        },
      );
      if (outcome === 'missing') return reply.code(404).send({ error: 'not_found' });
      if (outcome === 'refused') return reply.code(403).send({ error: 'cannot_grant' });
      if (outcome !== 'set') return reply.code(400).send({ error: 'weak_pin', problem: outcome.problem });
      return reply.code(204).send();
    },
  );

  // A counter replaces a temporary PIN with the person's own (sync spec §5).
  scope.post('/sync/pin', { preHandler: requireDevice }, async (req, reply) => {
    const body = CounterPinChangeRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const d = req.device!;
    const { userId, currentPin, newPin } = body.data;
    const t = now();
    const result = await withTenant(
      pool,
      { tenantId: d.tenantId, deviceId: d.deviceId, requestId: req.id },
      async (_db, c) => {
        const u = await c.query<{
          id: string;
          short_code: string | null;
          pin_verifier: string | null;
          pin_must_change: boolean;
          pin_failures: number | null;
        }>(
          `SELECT u.id, u.short_code, u.pin_verifier, u.pin_must_change, s.pin_failures
         FROM erp.users u LEFT JOIN erp.user_login_state s ON s.user_id = u.id
         WHERE u.id = $1 AND u.deleted_at IS NULL AND u.status = 'active' FOR UPDATE OF u`,
          [userId],
        );
        const user = u.rows[0];
        if (!user) return { code: 404, body: { error: 'not_found' } };
        if ((user.pin_failures ?? 0) >= PIN_MAX_FAILURES) return { code: 403, body: { error: 'pin_locked' } };
        if (!user.pin_must_change || !user.pin_verifier)
          return { code: 409, body: { error: 'not_temporary' } };
        if (!(await verifyPin(user.pin_verifier, currentPin))) {
          await c.query(
            `INSERT INTO erp.user_login_state (user_id, tenant_id, pin_failures) VALUES ($1, $2, 1)
           ON CONFLICT (user_id) DO UPDATE SET pin_failures = erp.user_login_state.pin_failures + 1`,
            [user.id, d.tenantId],
          );
          return { code: 401, body: { error: 'wrong_pin' } };
        }
        const problem = pinProblem(newPin, user.short_code);
        if (problem) return { code: 400, body: { error: 'weak_pin', problem } };
        await c.query('UPDATE erp.users SET pin_verifier = $1, pin_must_change = false WHERE id = $2', [
          await makePinVerifier(newPin),
          user.id,
        ]);
        await c.query('UPDATE erp.user_login_state SET pin_failures = 0 WHERE user_id = $1', [user.id]);
        await c.query(
          `INSERT INTO erp.audit_log (tenant_id, at, user_id, device_id, request_id, action, entity, entity_id)
         VALUES ($1, $2, $3, $4, $5, 'pin.changed', 'users', $3)`,
          [d.tenantId, t, user.id, d.deviceId, req.id],
        );
        return { code: 204, body: null };
      },
    );
    return result.body === null ? reply.code(204).send() : reply.code(result.code).send(result.body);
  });
}
