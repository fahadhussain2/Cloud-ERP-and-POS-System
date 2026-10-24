import { setContext } from '@erp/observability';
import { randomBytes, randomInt } from 'node:crypto';

import {
  ChallengeRequest,
  CreateEnrollmentCodeRequest,
  EnrollRequest,
  fromBase64Url,
  makePinVerifier,
  SetPinRequest,
  TokenRequest,
  toBase64Url,
  verifyCanonical,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import { nextDeviceCode, pinProblem, type DeviceKind } from '@erp/domain';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { verifyPassword } from '../auth/password';
import { requirePermission } from '../auth/routes';
import { hashToken, parseSessionCookie } from '../auth/session';

// Device enrollment, key-based device tokens, revocation and staff PIN (PLT-03, PLT-04, platform spec, D-082).

export const ENROLLMENT_CODE_MS = 15 * 60_000;
export const CHALLENGE_MS = 60_000;
export const DEVICE_TOKEN_MS = 15 * 60_000;
/** Failed enrollments per shop in 15 minutes before the shop is refused for a while. */
export const ENROLL_FAILURES_PER_SHOP = 10;

// Crockford base32: no I, L, O or U, so codes can't be misread.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface DeviceContext {
  tenantId: string;
  deviceId: string;
  code: string;
  kind: DeviceKind;
  branchId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    device: DeviceContext | null;
  }
}

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

const newEnrollmentCode = () => {
  const chars = Array.from({ length: 8 }, () => CROCKFORD[randomInt(32)]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
};

export function registerDevices(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  scope.decorateRequest('device', null);

  const audit = (
    c: pg.ClientBase,
    at: Date,
    e: { tenantId: string; userId: string | null; deviceId?: string | null; requestId: string },
    action: string,
    entityId: string | null,
    after: Record<string, unknown> | null = null,
  ) =>
    c.query(
      `INSERT INTO erp.audit_log (tenant_id, at, user_id, device_id, request_id, action, entity, entity_id, after)
       VALUES ($1, $2, $3, $4, $5, $6, 'devices', $7, $8)`,
      [e.tenantId, at, e.userId, e.deviceId ?? null, e.requestId, action, entityId, after],
    );

  /** Device auth: `Authorization: Device <tenantId>.<token>`, looked up under RLS (spec §2). */
  const requireDevice: preHandlerAsyncHookHandler = async (req, reply) => {
    const header = req.headers.authorization;
    const parsed = header?.startsWith('Device ') ? parseSessionCookie(header.slice(7)) : null;
    if (!parsed) return reply.code(401).send({ error: 'unauthenticated' });
    req.device = await withTenant(pool, { tenantId: parsed.tenantId, requestId: req.id }, async (_db, c) => {
      const { rows } = await c.query<{ id: string; code: string; kind: DeviceKind; branch_id: string }>(
        `SELECT d.id, d.code, d.kind, d.branch_id FROM erp.device_tokens t
         JOIN erp.devices d ON d.tenant_id = t.tenant_id AND d.id = t.device_id
         WHERE t.token_hash = $1 AND t.expires_at > $2 AND d.status = 'active' AND d.deleted_at IS NULL`,
        [hashToken(parsed.token), now()],
      );
      const d = rows[0];
      return d
        ? { tenantId: parsed.tenantId, deviceId: d.id, code: d.code, kind: d.kind, branchId: d.branch_id }
        : null;
    });
    if (!req.device) return reply.code(401).send({ error: 'unauthenticated' });
    setContext({
      tenantId: req.device.tenantId,
      deviceId: req.device.deviceId,
      branchId: req.device.branchId,
    });
  };

  scope.post(
    '/devices/enrollment-codes',
    { preHandler: requirePermission(requireAuth, 'admin.devices') },
    async (req, reply) => {
      const body = CreateEnrollmentCodeRequest.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const a = req.auth!;
      const t = now();
      const code = newEnrollmentCode();
      const expiresAt = new Date(t.getTime() + ENROLLMENT_CODE_MS);
      const ok = await withTenant(
        pool,
        { tenantId: a.tenantId, userId: a.userId, requestId: req.id },
        async (_db, c) => {
          const branch = await c.query('SELECT 1 FROM erp.branches WHERE id = $1 AND deleted_at IS NULL', [
            body.data.branchId,
          ]);
          if (branch.rowCount === 0) return false;
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO erp.device_enrollment_codes (tenant_id, branch_id, kind, name, code_hash, created_at,
             created_by_user_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              a.tenantId,
              body.data.branchId,
              body.data.kind,
              body.data.name ?? null,
              hashToken(code),
              t,
              a.userId,
              expiresAt,
            ],
          );
          await audit(
            c,
            t,
            { tenantId: a.tenantId, userId: a.userId, requestId: req.id },
            'device.code_created',
            null,
            {
              codeId: rows[0]!.id,
              kind: body.data.kind,
              branchId: body.data.branchId,
            },
          );
          return true;
        },
      );
      if (!ok) return reply.code(400).send({ error: 'unknown_branch' });
      // Shown once; only its hash is stored.
      return reply.code(201).send({ code, expiresAt: expiresAt.toISOString() });
    },
  );

  scope.post(
    '/devices/enroll',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const body = EnrollRequest.safeParse(req.body);
      const failed = () => reply.code(400).send({ error: 'enrollment_failed' });
      if (!body.success) return failed();
      const { tenantCode, code, publicKey, signature } = body.data;
      const dir = await pool.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM erp.tenant_directory WHERE code = $1',
        [tenantCode],
      );
      const tenantId = dir.rows[0]?.tenant_id;
      if (tenantId) setContext({ tenantId });
      if (!tenantId) return failed();
      const t = now();
      const ctx = { tenantId, userId: null, requestId: req.id };

      const result = await withTenant(pool, { tenantId, requestId: req.id }, async (_db, c) => {
        const recent = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM erp.audit_log
           WHERE action = 'device.enroll_failed' AND at > $1`,
          [new Date(t.getTime() - ENROLLMENT_CODE_MS)],
        );
        if (recent.rows[0]!.n >= ENROLL_FAILURES_PER_SHOP) return 'limited' as const;

        const fail = async (reason: string) => {
          await audit(c, t, ctx, 'device.enroll_failed', null, { reason });
          return 'failed' as const;
        };
        const { rows } = await c.query<{
          id: string;
          branch_id: string;
          kind: DeviceKind;
          name: string | null;
          created_by_user_id: string;
        }>(
          `SELECT id, branch_id, kind, name, created_by_user_id FROM erp.device_enrollment_codes
           WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2 FOR UPDATE`,
          [hashToken(code), t],
        );
        const ec = rows[0];
        if (!ec) return fail('unknown_or_used_code');
        // Proof of possession: the request is signed with the key being registered.
        if (!(await verifyCanonical(publicKey, { tenantCode, code, publicKey }, signature)))
          return fail('bad_signature');

        // The device is created in the name of the manager who made the code (audit trail, spec §5).
        await c.query("SELECT set_config('app.user_id', $1, true)", [ec.created_by_user_id]);
        const existing = await c.query<{ code: string }>('SELECT code FROM erp.devices');
        const deviceCode = nextDeviceCode(
          ec.kind,
          existing.rows.map((r) => r.code),
        );
        const device = await c.query<{ id: string }>(
          `INSERT INTO erp.devices (tenant_id, branch_id, code, name, kind, public_key, enrolled_at, enrolled_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            tenantId,
            ec.branch_id,
            deviceCode,
            ec.name,
            ec.kind,
            Buffer.from(fromBase64Url(publicKey)),
            t,
            ec.created_by_user_id,
          ],
        );
        const deviceId = device.rows[0]!.id;
        await c.query(
          'UPDATE erp.device_enrollment_codes SET used_at = $1, used_by_device_id = $2 WHERE id = $3',
          [t, deviceId, ec.id],
        );
        await audit(c, t, { ...ctx, userId: ec.created_by_user_id, deviceId }, 'device.enrolled', deviceId, {
          codeId: ec.id,
          code: deviceCode,
        });
        return { deviceId, code: deviceCode, kind: ec.kind, branchId: ec.branch_id };
      });

      if (result === 'limited') return reply.code(429).send({ error: 'too_many_attempts' });
      if (result === 'failed') return failed();
      return reply.code(201).send({ ...result, tenantId });
    },
  );

  scope.post(
    '/devices/challenge',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = ChallengeRequest.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const { tenantId, deviceId } = body.data;
      const t = now();
      const nonce = toBase64Url(randomBytes(32));
      const ok = await withTenant(pool, { tenantId, requestId: req.id }, async (_db, c) => {
        const d = await c.query(
          "SELECT 1 FROM erp.devices WHERE id = $1 AND status = 'active' AND deleted_at IS NULL",
          [deviceId],
        );
        if (d.rowCount === 0) return false;
        await c.query(
          'INSERT INTO erp.device_challenges (tenant_id, device_id, nonce_hash, expires_at) VALUES ($1, $2, $3, $4)',
          [tenantId, deviceId, hashToken(nonce), new Date(t.getTime() + CHALLENGE_MS)],
        );
        return true;
      });
      if (!ok) return reply.code(401).send({ error: 'device_refused' });
      return { nonce };
    },
  );

  scope.post(
    '/devices/token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = TokenRequest.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const { tenantId, deviceId, nonce, signature } = body.data;
      const t = now();
      const token = toBase64Url(randomBytes(32));
      const expiresAt = new Date(t.getTime() + DEVICE_TOKEN_MS);
      const ok = await withTenant(pool, { tenantId, requestId: req.id }, async (_db, c) => {
        // The nonce is used up whatever happens next: one try per challenge.
        const ch = await c.query<{ public_key: Buffer }>(
          `UPDATE erp.device_challenges ch SET used_at = $1
         FROM erp.devices d
         WHERE ch.nonce_hash = $2 AND ch.device_id = $3 AND ch.used_at IS NULL AND ch.expires_at > $1
           AND d.tenant_id = ch.tenant_id AND d.id = ch.device_id AND d.status = 'active' AND d.deleted_at IS NULL
         RETURNING d.public_key`,
          [t, hashToken(nonce), deviceId],
        );
        const key = ch.rows[0]?.public_key;
        if (!key) return false;
        if (!(await verifyCanonical(toBase64Url(key), { tenantId, deviceId, nonce }, signature)))
          return false;
        await c.query(
          'INSERT INTO erp.device_tokens (tenant_id, device_id, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)',
          [tenantId, deviceId, hashToken(token), t, expiresAt],
        );
        return true;
      });
      if (!ok) return reply.code(401).send({ error: 'device_refused' });
      return { accessToken: `${tenantId}.${token}`, expiresAt: expiresAt.toISOString() };
    },
  );

  scope.get('/devices/me', { preHandler: requireDevice }, (req) => req.device);

  scope.post<{ Params: { id: string } }>(
    '/devices/:id/revoke',
    { preHandler: requirePermission(requireAuth, 'admin.devices') },
    async (req, reply) => {
      const a = req.auth!;
      const t = now();
      const done = await withTenant(
        pool,
        { tenantId: a.tenantId, userId: a.userId, requestId: req.id },
        async (_db, c) => {
          const r = await c.query(
            `UPDATE erp.devices SET status = 'revoked', revoked_at = $1, revoked_by_user_id = $2
           WHERE id = $3 AND status = 'active'`,
            [t, a.userId, req.params.id],
          );
          if (r.rowCount === 0) return false;
          await c.query('DELETE FROM erp.device_tokens WHERE device_id = $1', [req.params.id]);
          return true;
        },
      );
      if (!done) return reply.code(404).send({ error: 'unknown_device' });
      return reply.code(204).send();
    },
  );

  scope.put('/users/me/pin', { preHandler: requireAuth }, async (req, reply) => {
    const body = SetPinRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const a = req.auth!;
    const t = now();
    const user = await withTenant(pool, { tenantId: a.tenantId, requestId: req.id }, (_db, c) =>
      c.query<{ password_hash: string | null; short_code: string | null }>(
        'SELECT password_hash, short_code FROM erp.users WHERE id = $1',
        [a.userId],
      ),
    );
    const u = user.rows[0];
    if (!u || !(await verifyPassword(u.password_hash, body.data.password))) {
      return reply.code(401).send({ error: 'wrong_password' });
    }
    const problem = pinProblem(body.data.pin, u.short_code);
    if (problem) return reply.code(400).send({ error: 'weak_pin', problem });
    const verifier = await makePinVerifier(body.data.pin);
    await withTenant(pool, { tenantId: a.tenantId, userId: a.userId, requestId: req.id }, async (_db, c) => {
      await c.query('UPDATE erp.users SET pin_verifier = $1 WHERE id = $2', [verifier, a.userId]);
      // The verifier is stripped from the audit trigger's before/after, so record the change explicitly.
      await c.query(
        `INSERT INTO erp.audit_log (tenant_id, at, user_id, request_id, action, entity, entity_id)
         VALUES ($1, $2, $3, $4, 'pin.changed', 'users', $3)`,
        [a.tenantId, t, a.userId, req.id],
      );
    });
    return reply.code(204).send();
  });

  return requireDevice;
}
