import { ChangePasswordRequest, LoginRequest, type MeResponse } from '@erp/contracts';
import { withTenant } from '@erp/db';
import {
  can,
  effectiveLimits,
  expandPermissions,
  isPermission,
  type Permission,
  type RoleGrant,
  type RoleLimits,
} from '@erp/domain';
import { setContext } from '@erp/observability';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { hashPassword, needsRehash, passwordProblem, verifyPassword } from './password';
import {
  hashToken,
  LOCK_AFTER_FAILURES,
  LOCK_MS,
  newToken,
  parseSessionCookie,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
} from './session';

// Back-office login, sessions and permission checks (PLT-04, PLT-05, PLT-08, D-081).

export interface AuthDeps {
  pool: pg.Pool;
  now: () => Date;
}

export interface AuthContext {
  tenantId: string;
  userId: string;
  sessionId: string;
  username: string;
  fullName: string;
  grants: RoleGrant[];
  /** A generated password must be changed before anything else (D-083). */
  mustChangePassword: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
};

type Audit = (action: string, userId: string | null, detail?: Record<string, unknown>) => Promise<unknown>;

/** A person's roles, as a request's grants (also checked for a manager who sends a counter's diagnostics, W1-20). */
export async function loadGrants(c: pg.ClientBase, userId: string): Promise<RoleGrant[]> {
  const { rows } = await c.query<{ permissions: string[]; limits: RoleLimits; branch_id: string | null }>(
    `SELECT r.permissions, r.limits, ur.branch_id
     FROM erp.user_roles ur JOIN erp.roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
     WHERE ur.user_id = $1 AND ur.deleted_at IS NULL AND r.deleted_at IS NULL`,
    [userId],
  );
  return rows.map((r) => ({ permissions: r.permissions, limits: r.limits, branchId: r.branch_id }));
}

const me = (a: Omit<AuthContext, 'sessionId'>): MeResponse => ({
  tenantId: a.tenantId,
  user: { id: a.userId, username: a.username, fullName: a.fullName },
  permissions: expandPermissions(a.grants, null),
  limits: effectiveLimits(a.grants, null),
  mustChangePassword: a.mustChangePassword,
});

/** Registers the auth routes on `scope` and returns `requireAuth` for other routes in it. */
export async function registerAuth(
  scope: FastifyInstance,
  { pool, now }: AuthDeps,
): Promise<preHandlerAsyncHookHandler> {
  await scope.register(cookie);
  await scope.register(rateLimit, { global: false });
  scope.decorateRequest('auth', null);

  // State-changing requests must come from our own origin, on top of SameSite=Strict (CSRF defense in depth).
  scope.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!STATE_CHANGING.has(req.method) || origin === undefined) return;
    if (hostOf(origin) !== req.headers.host) await reply.code(403).send({ error: 'bad_origin' });
  });

  // A valid session, whether or not the password must be changed: only me, logout and the change itself use it.
  const requireSession: preHandlerAsyncHookHandler = async (req, reply) => {
    const parsed = parseSessionCookie(req.cookies[SESSION_COOKIE]);
    if (!parsed) return reply.code(401).send({ error: 'unauthenticated' });
    const t = now();
    req.auth = await withTenant(pool, { tenantId: parsed.tenantId, requestId: req.id }, async (_db, c) => {
      const { rows } = await c.query<{
        id: string;
        user_id: string;
        last_seen_at: Date;
        username: string;
        full_name: string;
        must_change_password: boolean;
      }>(
        `SELECT s.id, s.user_id, s.last_seen_at, u.username, u.full_name, u.must_change_password
         FROM erp.sessions s JOIN erp.users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.last_seen_at > $3
           AND u.status = 'active' AND u.deleted_at IS NULL`,
        [hashToken(parsed.token), t, new Date(t.getTime() - SESSION_IDLE_MS)],
      );
      const s = rows[0];
      if (!s) return null;
      if (t.getTime() - s.last_seen_at.getTime() > SESSION_TOUCH_MS) {
        await c.query('UPDATE erp.sessions SET last_seen_at = $1 WHERE id = $2', [t, s.id]);
      }
      return {
        tenantId: parsed.tenantId,
        userId: s.user_id,
        sessionId: s.id,
        username: s.username,
        fullName: s.full_name,
        grants: await loadGrants(c, s.user_id),
        mustChangePassword: s.must_change_password,
      };
    });
    if (!req.auth) return reply.code(401).send({ error: 'unauthenticated' });
    setContext({ tenantId: req.auth.tenantId, userId: req.auth.userId });
  };

  // Every other route: a valid session and no pending password change.
  const requireAuth: preHandlerAsyncHookHandler = async (req, reply) => {
    await requireSession.call(scope, req, reply);
    if (reply.sent) return;
    if (req.auth!.mustChangePassword) return reply.code(403).send({ error: 'password_change_required' });
  };

  scope.post(
    '/auth/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = LoginRequest.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const { tenantCode, username, password } = body.data;
      const failed = () => reply.code(401).send({ error: 'login_failed' });

      const dir = await pool.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM erp.tenant_directory WHERE code = $1',
        [tenantCode],
      );
      const tenantId = dir.rows[0]?.tenant_id;
      if (tenantId) setContext({ tenantId });
      if (!tenantId) {
        await verifyPassword(null, password);
        return failed();
      }

      const t = now();
      const result = await withTenant(pool, { tenantId, requestId: req.id }, async (_db, c) => {
        const audit: Audit = (action, userId, detail) =>
          c.query(
            `INSERT INTO erp.audit_log (tenant_id, user_id, request_id, action, entity, entity_id, after, ip)
           VALUES ($1, $2, $3, $4, 'session', $2, $5, $6)`,
            [tenantId, userId, req.id, action, { username, ...detail }, req.ip],
          );
        const { rows } = await c.query<{
          id: string;
          username: string;
          full_name: string;
          password_hash: string | null;
          must_change_password: boolean;
          status: string;
          failed_logins: number | null;
          locked_until: Date | null;
        }>(
          `SELECT u.id, u.username, u.full_name, u.password_hash, u.must_change_password, u.status,
           s.failed_logins, s.locked_until
         FROM erp.users u LEFT JOIN erp.user_login_state s ON s.user_id = u.id
         WHERE lower(u.username) = lower($1) AND u.deleted_at IS NULL
         FOR UPDATE OF u`,
          [username],
        );
        const user = rows[0];
        if (!user || user.status !== 'active') {
          await verifyPassword(null, password);
          await audit('login.failed', user?.id ?? null);
          return null;
        }
        if (user.locked_until && user.locked_until > t) {
          await verifyPassword(null, password);
          await audit('login.refused_locked', user.id);
          return null;
        }
        const setState = (failedLogins: number, lockedUntil: Date | null, lastLoginAt: Date | null) =>
          c.query(
            `INSERT INTO erp.user_login_state (user_id, tenant_id, failed_logins, locked_until, last_login_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id) DO UPDATE SET failed_logins = EXCLUDED.failed_logins,
             locked_until = EXCLUDED.locked_until,
             last_login_at = coalesce(EXCLUDED.last_login_at, erp.user_login_state.last_login_at)`,
            [user.id, tenantId, failedLogins, lockedUntil, lastLoginAt],
          );

        // The PIN is never consulted here: a PIN can't log in to the back office (D-081).
        if (!(await verifyPassword(user.password_hash, password))) {
          const count = (user.failed_logins ?? 0) + 1;
          const lock = count >= LOCK_AFTER_FAILURES;
          await setState(lock ? 0 : count, lock ? new Date(t.getTime() + LOCK_MS) : null, null);
          await audit(lock ? 'login.locked' : 'login.failed', user.id);
          return null;
        }

        await setState(0, null, t);
        if (user.password_hash && needsRehash(user.password_hash)) {
          await c.query('UPDATE erp.users SET password_hash = $1 WHERE id = $2', [
            await hashPassword(password),
            user.id,
          ]);
        }
        const token = newToken();
        await c.query(
          `INSERT INTO erp.sessions (tenant_id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $4, $6, $7)`,
          [
            tenantId,
            user.id,
            hashToken(token),
            t,
            new Date(t.getTime() + SESSION_ABSOLUTE_MS),
            req.ip,
            req.headers['user-agent'] ?? null,
          ],
        );
        await audit('login.success', user.id);
        return {
          token,
          me: me({
            tenantId,
            userId: user.id,
            username: user.username,
            fullName: user.full_name,
            grants: await loadGrants(c, user.id),
            mustChangePassword: user.must_change_password,
          }),
        };
      });

      if (!result) return failed();
      void reply.setCookie(SESSION_COOKIE, `${tenantId}.${result.token}`, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/api',
        maxAge: SESSION_ABSOLUTE_MS / 1000,
      });
      return result.me;
    },
  );

  scope.post('/auth/logout', { preHandler: requireSession }, async (req, reply) => {
    const a = req.auth!;
    await withTenant(pool, { tenantId: a.tenantId, userId: a.userId, requestId: req.id }, async (_db, c) => {
      await c.query('UPDATE erp.sessions SET revoked_at = $1 WHERE id = $2', [now(), a.sessionId]);
      await c.query(
        `INSERT INTO erp.audit_log (tenant_id, user_id, request_id, action, entity, entity_id, ip)
         VALUES ($1, $2, $3, 'logout', 'session', $2, $4)`,
        [a.tenantId, a.userId, req.id, req.ip],
      );
    });
    void reply.clearCookie(SESSION_COOKIE, { path: '/api' });
    return reply.code(204).send();
  });

  scope.get('/auth/me', { preHandler: requireSession }, (req) => me(req.auth!));

  // Change your own password (D-083): needs the current one; ends your other sessions.
  scope.put(
    '/users/me/password',
    { preHandler: requireSession, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = ChangePasswordRequest.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const { currentPassword, newPassword } = body.data;
      const a = req.auth!;
      const t = now();
      const outcome = await withTenant(
        pool,
        { tenantId: a.tenantId, userId: a.userId, requestId: req.id },
        async (_db, c) => {
          const { rows } = await c.query<{ password_hash: string | null }>(
            'SELECT password_hash FROM erp.users WHERE id = $1 FOR UPDATE',
            [a.userId],
          );
          if (!(await verifyPassword(rows[0]?.password_hash ?? null, currentPassword)))
            return 'wrong' as const;
          const problem = passwordProblem(newPassword, a.username);
          if (problem) return { problem };
          await c.query(
            `UPDATE erp.users SET password_hash = $1, must_change_password = false, password_changed_at = $2
             WHERE id = $3`,
            [await hashPassword(newPassword), t, a.userId],
          );
          await c.query(
            'UPDATE erp.sessions SET revoked_at = $1 WHERE user_id = $2 AND id <> $3 AND revoked_at IS NULL',
            [t, a.userId, a.sessionId],
          );
          await c.query(
            `INSERT INTO erp.audit_log (tenant_id, user_id, request_id, action, entity, entity_id, ip)
             VALUES ($1, $2, $3, 'password.changed', 'user', $2, $4)`,
            [a.tenantId, a.userId, req.id, req.ip],
          );
          return 'changed' as const;
        },
      );
      if (outcome === 'wrong') return reply.code(401).send({ error: 'wrong_password' });
      if (outcome !== 'changed')
        return reply.code(400).send({ error: 'weak_password', problem: outcome.problem });
      return reply.code(204).send();
    },
  );

  // "May I?" for screens: 204 if the user has the permission (all branches), 403 if not.
  scope.get<{ Params: { permission: string } }>(
    '/auth/can/:permission',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { permission } = req.params;
      if (!isPermission(permission)) return reply.code(404).send({ error: 'unknown_permission' });
      return reply.code(can(req.auth!.grants, permission, null) ? 204 : 403).send();
    },
  );

  return requireAuth;
}

/** preHandlers for a route that needs a logged-in user with `permission` (in a branch-free role). */
export function requirePermission(
  requireAuth: preHandlerAsyncHookHandler,
  permission: Permission,
): preHandlerAsyncHookHandler[] {
  return requireAnyPermission(requireAuth, [permission]);
}

/** preHandlers for a route that needs a logged-in user with at least one of `permissions` (branch-free roles). */
export function requireAnyPermission(
  requireAuth: preHandlerAsyncHookHandler,
  permissions: readonly Permission[],
): preHandlerAsyncHookHandler[] {
  return [
    requireAuth,
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!permissions.some((p) => can(req.auth!.grants, p, null)))
        await reply
          .code(403)
          .send({ error: 'forbidden', permission: permissions.length === 1 ? permissions[0] : permissions });
    },
  ];
}
