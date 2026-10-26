import {
  CreateUserRequest,
  SetRolesRequest,
  TemporaryPasswordRequest,
  UpdateUserRequest,
  type RoleAssignment,
  type UserSummary,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import { can, canGivePinTo, canGrantRole, type RoleGrant, type RoleLimits } from '@erp/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { hashPassword, passwordProblem } from '../auth/password';
import { requireAnyPermission, requirePermission, type AuthContext } from '../auth/routes';

// Staff and user admin (W1-04 plan; PLT-04, PLT-05, PLT-08; D-081, D-083, D-091). People are managed with
// admin.users (Owner by template); the list is also open to admin.devices, for temporary PINs. Guards:
// - nobody gives or takes away a role, or changes a person, with more rights than they hold (canGrantRole);
// - nobody deactivates themselves, removes their own password or their own admin.users;
// - the shop keeps at least one active Owner who can sign in. Owner changes take a per-tenant advisory lock, so two
//   admins can't race past the check.
// Every row change is audited by the W0-09 triggers; password events are written here, since the hash is stripped.

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

/** A refusal raised inside the transaction, so it rolls back. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body['error']));
  }
}

type Client = pg.PoolClient;

const DUPLICATE_FIELDS: Record<string, string> = {
  users_username_uq: 'username',
  users_short_code_uq: 'shortCode',
  users_email_uq: 'email',
};

/** Turns database refusals into answers: a duplicate names its field; an unknown branch is a bad request. */
function dbRefusal(err: unknown): Refusal | null {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint && DUPLICATE_FIELDS[e.constraint])
    return new Refusal(409, { error: 'duplicate', field: DUPLICATE_FIELDS[e.constraint] });
  if (e.code === '23503') return new Refusal(400, { error: 'invalid_request' });
  return null;
}

interface RoleRow {
  id: string;
  permissions: string[];
  limits: RoleLimits;
}

/** The roles named in `assignments`, from this tenant only (RLS); an unknown one is a bad request. */
async function loadRoles(c: Client, assignments: readonly RoleAssignment[]): Promise<Map<string, RoleRow>> {
  const ids = [...new Set(assignments.map((a) => a.roleId))];
  const { rows } = await c.query<RoleRow>(
    'SELECT id, permissions, limits FROM erp.roles WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
    [ids],
  );
  const roles = new Map(rows.map((r) => [r.id, r]));
  if (roles.size !== ids.length) throw new Refusal(400, { error: 'invalid_role' });
  return roles;
}

/** A person's current role assignments. */
async function currentAssignments(c: Client, userId: string) {
  const { rows } = await c.query<{ id: string; role_id: string; branch_id: string | null }>(
    'SELECT id, role_id, branch_id FROM erp.user_roles WHERE user_id = $1 AND deleted_at IS NULL',
    [userId],
  );
  return rows.map((r) => ({ id: r.id, roleId: r.role_id, branchId: r.branch_id }));
}

/** Every person's roles as grants, by user id; one query for the whole list, or for one person. */
async function grantsByUser(c: Client, userId: string | null = null): Promise<Map<string, RoleGrant[]>> {
  const { rows } = await c.query<{
    user_id: string;
    permissions: string[];
    limits: RoleLimits;
    branch_id: string | null;
  }>(
    `SELECT ur.user_id, r.permissions, r.limits, ur.branch_id
     FROM erp.user_roles ur JOIN erp.roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
     WHERE ur.deleted_at IS NULL AND r.deleted_at IS NULL AND ($1::uuid IS NULL OR ur.user_id = $1)`,
    [userId],
  );
  const byUser = new Map<string, RoleGrant[]>();
  for (const r of rows) {
    const list = byUser.get(r.user_id) ?? [];
    list.push({ permissions: r.permissions, limits: r.limits, branchId: r.branch_id });
    byUser.set(r.user_id, list);
  }
  return byUser;
}

/** May the actor give this person a temporary PIN? Not to an Owner or a staff admin they don't outrank (D-091). */
export async function mayGivePin(c: Client, actor: AuthContext, userId: string): Promise<boolean> {
  return canGivePinTo(actor.grants, (await grantsByUser(c, userId)).get(userId) ?? []);
}

/** Refuses unless the actor may give (or take away) every one of these assignments. */
function checkGrant(actor: AuthContext, assignments: readonly RoleAssignment[], roles: Map<string, RoleRow>) {
  for (const a of assignments)
    if (!canGrantRole(actor.grants, roles.get(a.roleId)!.permissions, a.branchId))
      throw new Refusal(403, { error: 'cannot_grant' });
}

/** Refuses unless the actor holds everything the target person holds (to change their password, status, details). */
async function checkOutranks(c: Client, actor: AuthContext, userId: string) {
  const current = await currentAssignments(c, userId);
  checkGrant(actor, current, await loadRoles(c, current));
}

/** The person must exist in this tenant (RLS hides everyone else's). */
async function requireUser(c: Client, userId: string): Promise<{ username: string }> {
  const { rows } = await c.query<{ username: string }>(
    'SELECT username FROM erp.users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [userId],
  );
  if (!rows[0]) throw new Refusal(404, { error: 'not_found' });
  return rows[0];
}

/** Serializes every change that could remove the last Owner, per tenant, until the transaction ends. */
const lockOwners = (c: Client, tenantId: string) =>
  c.query("SELECT pg_advisory_xact_lock(hashtext('erp.owners:' || $1))", [tenantId]);

/** After the change, someone active with a password must still hold `*` for every branch. */
async function checkOwnerRemains(c: Client) {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM erp.users u
     WHERE u.status = 'active' AND u.deleted_at IS NULL AND u.password_hash IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM erp.user_roles ur JOIN erp.roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
         WHERE ur.user_id = u.id AND ur.deleted_at IS NULL AND r.deleted_at IS NULL AND ur.branch_id IS NULL
           AND '*' = ANY (r.permissions))`,
  );
  if (rows[0]!.n === 0) throw new Refusal(409, { error: 'last_owner' });
}

const endSessions = (c: Client, userId: string, at: Date) =>
  c.query('UPDATE erp.sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL', [at, userId]);

const audit = (c: Client, req: FastifyRequest, action: string, userId: string, at: Date) =>
  c.query(
    `INSERT INTO erp.audit_log (tenant_id, at, user_id, request_id, action, entity, entity_id, ip)
     VALUES ($1, $2, $3, $4, $5, 'users', $6, $7)`,
    [req.auth!.tenantId, at, req.auth!.userId, req.id, action, userId, req.ip],
  );

/** Stores a temporary password (D-083 rules), forces a change at sign-in, ends sessions and clears the login lock. */
async function setTemporaryPassword(
  c: Client,
  req: FastifyRequest,
  user: { id: string; username: string },
  password: string,
  at: Date,
) {
  const problem = passwordProblem(password, user.username);
  if (problem) throw new Refusal(400, { error: 'weak_password', problem });
  await c.query(
    `UPDATE erp.users SET password_hash = $1, must_change_password = true, password_changed_at = $2 WHERE id = $3`,
    [await hashPassword(password), at, user.id],
  );
  await c.query('UPDATE erp.user_login_state SET failed_logins = 0, locked_until = NULL WHERE user_id = $1', [
    user.id,
  ]);
  await endSessions(c, user.id, at);
  await audit(c, req, 'password.set_by_admin', user.id, at);
}

const sameAssignment = (a: RoleAssignment, b: RoleAssignment) =>
  a.roleId === b.roleId && a.branchId === b.branchId;

/** Adds an assignment, bringing back a removed one (the unique key includes soft-deleted rows). */
const addAssignment = (c: Client, tenantId: string, userId: string, a: RoleAssignment) =>
  c.query(
    `INSERT INTO erp.user_roles (tenant_id, user_id, role_id, branch_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, user_id, role_id, branch_id) DO UPDATE SET deleted_at = NULL`,
    [tenantId, userId, a.roleId, a.branchId],
  );

export function registerUsers(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  const admin = requirePermission(requireAuth, 'admin.users');

  /** Runs `fn` in the actor's tenant transaction and turns refusals into replies. */
  async function run(
    req: FastifyRequest,
    reply: FastifyReply,
    fn: (c: Client, actor: AuthContext) => Promise<unknown>,
    ok = 204,
  ) {
    const actor = req.auth!;
    try {
      const body = await withTenant(
        pool,
        { tenantId: actor.tenantId, userId: actor.userId, requestId: req.id },
        async (_db, c) => {
          try {
            return await fn(c, actor);
          } catch (err) {
            throw dbRefusal(err) ?? err;
          }
        },
      );
      return ok === 204 ? reply.code(204).send() : reply.code(ok).send(body);
    } catch (err) {
      if (err instanceof Refusal) return reply.code(err.status).send(err.body);
      throw err;
    }
  }

  scope.get(
    '/users',
    { preHandler: requireAnyPermission(requireAuth, ['admin.users', 'admin.devices']) },
    (req) =>
      withTenant(
        pool,
        { tenantId: req.auth!.tenantId, userId: req.auth!.userId, requestId: req.id },
        async (_db, c) => {
          const { rows } = await c.query<{
            id: string;
            username: string;
            full_name: string;
            short_code: string | null;
            email: string | null;
            status: 'active' | 'disabled';
            has_password: boolean;
            has_pin: boolean;
            pin_must_change: boolean;
            last_login_at: Date | null;
            roles: UserSummary['roles'];
          }>(
            `SELECT u.id, u.username, u.full_name, u.short_code, u.email, u.status,
           u.password_hash IS NOT NULL AS has_password, u.pin_verifier IS NOT NULL AS has_pin, u.pin_must_change,
           ls.last_login_at,
           coalesce((
             SELECT json_agg(json_build_object('roleId', r.id, 'name', r.name, 'templateKey', r.template_key,
                                               'branchId', ur.branch_id) ORDER BY lower(r.name), ur.branch_id)
             FROM erp.user_roles ur JOIN erp.roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
             WHERE ur.user_id = u.id AND ur.deleted_at IS NULL AND r.deleted_at IS NULL), '[]') AS roles
         FROM erp.users u LEFT JOIN erp.user_login_state ls ON ls.user_id = u.id
         WHERE u.deleted_at IS NULL
         ORDER BY lower(u.full_name), u.username`,
          );
          const grants = await grantsByUser(c);
          return rows.map((u): UserSummary => ({
            id: u.id,
            username: u.username,
            fullName: u.full_name,
            shortCode: u.short_code,
            email: u.email,
            status: u.status,
            hasPassword: u.has_password,
            hasPin: u.has_pin,
            pinMustChange: u.pin_must_change,
            lastLoginAt: u.last_login_at?.toISOString() ?? null,
            canGivePin: canGivePinTo(req.auth!.grants, grants.get(u.id) ?? []),
            roles: u.roles,
          }));
        },
      ),
  );

  scope.get('/roles', { preHandler: admin }, (req) =>
    withTenant(
      pool,
      { tenantId: req.auth!.tenantId, userId: req.auth!.userId, requestId: req.id },
      async (_db, c) => {
        const { rows } = await c.query<{ id: string; name: string; template_key: string | null }>(
          'SELECT id, name, template_key FROM erp.roles WHERE deleted_at IS NULL ORDER BY lower(name)',
        );
        return rows.map((r) => ({ id: r.id, name: r.name, templateKey: r.template_key }));
      },
    ),
  );

  scope.post('/users', { preHandler: admin }, async (req, reply) => {
    const parsed = CreateUserRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(
      req,
      reply,
      async (c, actor) => {
        checkGrant(actor, b.roles, await loadRoles(c, b.roles));
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO erp.users (tenant_id, username, full_name, short_code, email)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [actor.tenantId, b.username, b.fullName, b.shortCode ?? null, b.email ?? null],
        );
        const id = rows[0]!.id;
        for (const a of b.roles) await addAssignment(c, actor.tenantId, id, a);
        if (b.temporaryPassword !== undefined)
          await setTemporaryPassword(c, req, { id, username: b.username }, b.temporaryPassword, now());
        return { id };
      },
      201,
    );
  });

  scope.patch<{ Params: { id: string } }>('/users/:id', { preHandler: admin }, async (req, reply) => {
    const parsed = UpdateUserRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c, actor) => {
      await requireUser(c, req.params.id);
      await checkOutranks(c, actor, req.params.id);
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [column, value] of [
        ['full_name', b.fullName],
        ['short_code', b.shortCode],
        ['email', b.email],
      ] as const) {
        if (value === undefined) continue;
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
      if (sets.length === 0) return;
      values.push(req.params.id);
      await c.query(`UPDATE erp.users SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
    });
  });

  scope.put<{ Params: { id: string } }>('/users/:id/roles', { preHandler: admin }, async (req, reply) => {
    const parsed = SetRolesRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const wanted = parsed.data.roles.filter((a, i, all) => all.findIndex((x) => sameAssignment(x, a)) === i);
    return run(req, reply, async (c, actor) => {
      await lockOwners(c, actor.tenantId);
      await requireUser(c, req.params.id);
      const current = await currentAssignments(c, req.params.id);
      const added = wanted.filter((a) => !current.some((x) => sameAssignment(x, a)));
      const removed = current.filter((x) => !wanted.some((a) => sameAssignment(x, a)));
      const roles = await loadRoles(c, [...added, ...removed]);
      checkGrant(actor, [...added, ...removed], roles);
      if (req.params.id === actor.userId) {
        // You keep admin.users for every branch, or you'd lock yourself out of this screen.
        const wantedRoles = await loadRoles(c, wanted);
        const after: RoleGrant[] = wanted.map((a) => {
          const r = wantedRoles.get(a.roleId)!;
          return { permissions: r.permissions, limits: r.limits, branchId: a.branchId };
        });
        if (!can(after, 'admin.users', null)) throw new Refusal(409, { error: 'self' });
      }
      const t = now();
      for (const x of removed)
        await c.query('UPDATE erp.user_roles SET deleted_at = $1 WHERE id = $2', [t, x.id]);
      for (const a of added) await addAssignment(c, actor.tenantId, req.params.id, a);
      await checkOwnerRemains(c);
    });
  });

  scope.put<{ Params: { id: string } }>('/users/:id/password', { preHandler: admin }, async (req, reply) => {
    const parsed = TemporaryPasswordRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, async (c, actor) => {
      const user = await requireUser(c, req.params.id);
      await checkOutranks(c, actor, req.params.id);
      await setTemporaryPassword(
        c,
        req,
        { id: req.params.id, ...user },
        parsed.data.temporaryPassword,
        now(),
      );
    });
  });

  scope.delete<{ Params: { id: string } }>('/users/:id/password', { preHandler: admin }, (req, reply) =>
    run(req, reply, async (c, actor) => {
      if (req.params.id === actor.userId) throw new Refusal(409, { error: 'self' });
      await lockOwners(c, actor.tenantId);
      await requireUser(c, req.params.id);
      await checkOutranks(c, actor, req.params.id);
      const t = now();
      await c.query('UPDATE erp.users SET password_hash = NULL, must_change_password = false WHERE id = $1', [
        req.params.id,
      ]);
      await endSessions(c, req.params.id, t);
      await audit(c, req, 'password.removed', req.params.id, t);
      await checkOwnerRemains(c);
    }),
  );

  for (const [action, status] of [
    ['deactivate', 'disabled'],
    ['reactivate', 'active'],
  ] as const) {
    scope.post<{ Params: { id: string } }>(`/users/:id/${action}`, { preHandler: admin }, (req, reply) =>
      run(req, reply, async (c, actor) => {
        if (req.params.id === actor.userId) throw new Refusal(409, { error: 'self' });
        await lockOwners(c, actor.tenantId);
        await requireUser(c, req.params.id);
        await checkOutranks(c, actor, req.params.id);
        await c.query('UPDATE erp.users SET status = $1 WHERE id = $2', [status, req.params.id]);
        if (status === 'disabled') {
          await endSessions(c, req.params.id, now());
          await checkOwnerRemains(c);
        }
      }),
    );
  }
}
