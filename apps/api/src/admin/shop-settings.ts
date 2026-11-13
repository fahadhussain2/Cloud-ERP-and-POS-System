import { ShopSettingsRequest, type ShopSettingsView } from '@erp/contracts';
import { withTenant } from '@erp/db';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requirePermission } from '../auth/routes';

// The shop's name and bill header (W1-25 plan; PLT-01, POS-09, D-112), the owner's (admin.settings): the shop name
// (`tenants.name`), the branch's address, phone and extra lines (`branches.receipt_header.lines`), and the policy
// line (the default print profile's `template_options.policyText`). One audited transaction; the counters pull the
// changed rows (they're already in the pull and nudged), so nothing else changes on the counter.

interface Deps {
  pool: pg.Pool;
  requireAuth: preHandlerAsyncHookHandler;
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body['error']));
  }
}

type Client = pg.PoolClient;

/** The shop's settings for one branch: the one asked for, else the first by code (Delux has one, MAIN). */
async function viewOf(c: Client, branchId: string | null): Promise<ShopSettingsView> {
  const { rows } = await c.query<{
    name: string;
    branch_id: string;
    branch_name: string;
    address: string | null;
    phone: string | null;
    receipt_header: { lines?: unknown } | null;
    template_options: { policyText?: unknown; headerLines?: unknown } | null;
  }>(
    `SELECT t.name, b.id AS branch_id, b.name AS branch_name, b.address, b.phone, b.receipt_header,
            (SELECT p.template_options FROM erp.print_profiles p
             WHERE p.is_tenant_default AND p.deleted_at IS NULL LIMIT 1) AS template_options
     FROM erp.tenants t JOIN erp.branches b ON b.tenant_id = t.id AND b.deleted_at IS NULL
     WHERE ($1::uuid IS NULL OR b.id = $1::uuid)
     ORDER BY b.code LIMIT 1`,
    [branchId],
  );
  const r = rows[0];
  if (!r) throw new Refusal(404, { error: 'not_found' });
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const policy = r.template_options?.policyText;
  return {
    name: r.name,
    branchId: r.branch_id,
    branchName: r.branch_name,
    address: r.address ?? '',
    phone: r.phone ?? '',
    lines: strings(r.receipt_header?.lines),
    policyText: typeof policy === 'string' ? policy : '',
    profileLines: strings(r.template_options?.headerLines),
  };
}

export function registerShopSettings(scope: FastifyInstance, { pool, requireAuth }: Deps) {
  const owner = requirePermission(requireAuth, 'admin.settings');

  /** One transaction as the signed-in person; a Refusal rolls back and becomes the answer. */
  const run = async <T>(req: FastifyRequest, reply: FastifyReply, fn: (c: Client) => Promise<T>) => {
    try {
      return await withTenant(
        pool,
        { tenantId: req.auth!.tenantId, userId: req.auth!.userId, requestId: req.id },
        (_db, c) => fn(c),
      );
    } catch (err) {
      if (err instanceof Refusal) return reply.code(err.status).send(err.body);
      throw err;
    }
  };

  scope.get('/settings/shop', { preHandler: owner }, (req, reply) => {
    const branch = (req.query as Record<string, string | undefined>)['branch'] ?? null;
    if (branch !== null && ShopSettingsRequest.shape.branchId.safeParse(branch).success === false)
      return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, (c) => viewOf(c, branch));
  });

  scope.put('/settings/shop', { preHandler: owner }, async (req, reply) => {
    const parsed = ShopSettingsRequest.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: 'invalid_request',
        fields: [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '')))],
      });
    const s = parsed.data;
    const orNull = (v: string) => (v === '' ? null : v);
    return run(req, reply, async (c) => {
      // RLS keeps another shop's branch out of sight: it's simply not found.
      const branch = await c.query(
        'SELECT 1 FROM erp.branches WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [s.branchId],
      );
      if (branch.rowCount === 0) throw new Refusal(404, { error: 'not_found' });
      await c.query('UPDATE erp.tenants SET name = $1, updated_at = now() WHERE name IS DISTINCT FROM $1', [
        s.name,
      ]);
      await c.query(
        `UPDATE erp.branches SET address = $2, phone = $3,
           receipt_header = jsonb_set(receipt_header, '{lines}', $4::jsonb), updated_at = now()
         WHERE id = $1 AND (address IS DISTINCT FROM $2 OR phone IS DISTINCT FROM $3
           OR receipt_header -> 'lines' IS DISTINCT FROM $4::jsonb)`,
        [s.branchId, orNull(s.address), orNull(s.phone), JSON.stringify(s.lines.filter((l) => l !== ''))],
      );
      // An empty policy line removes the key, so the bill prints the default again.
      await c.query(
        `UPDATE erp.print_profiles
         SET template_options = CASE WHEN $1 = '' THEN template_options - 'policyText'
                                     ELSE jsonb_set(template_options, '{policyText}', to_jsonb($1::text)) END,
             updated_at = now()
         WHERE is_tenant_default AND deleted_at IS NULL
           AND template_options ->> 'policyText' IS DISTINCT FROM nullif($1, '')`,
        [s.policyText],
      );
      return viewOf(c, s.branchId);
    });
  });
}
