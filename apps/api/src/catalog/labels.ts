import { LabelItemsRequest, LabelTemplateRequest, type LabelsView } from '@erp/contracts';
import { withTenant } from '@erp/db';
import {
  DEFAULT_LABEL_TEMPLATE,
  itemLabels,
  labelTemplateProblems,
  receiptLabels,
  type LabelTemplate,
} from '@erp/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requireAnyPermission, requirePermission } from '../auth/routes';

// Item labels (W1-17 plan; CAT-08, D-019, D-055). Printing needs cat.label.print (owner, manager, purchaser); the
// template is the shop's setting (`tenants.settings.labels`), changed by the owner only (admin.settings, owner
// answer 5). Nothing is stored about what was printed: a reprint is just printing again.

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The shop's template: what the owner saved over the defaults (a key added later still gets its default). */
async function templateOf(c: Client): Promise<LabelTemplate> {
  const { rows } = await c.query<{ labels: Partial<LabelTemplate> | null }>(
    "SELECT settings -> 'labels' AS labels FROM erp.tenants",
  );
  return { ...DEFAULT_LABEL_TEMPLATE, ...(rows[0]?.labels ?? {}) };
}

/** SQL: the item `i` has a barcode other than its own code, i.e. the maker's (data model §4). */
const MAKER_BARCODE = `EXISTS (SELECT 1 FROM erp.item_identifiers x WHERE x.item_id = i.id AND x.kind = 'barcode'
  AND x.deleted_at IS NULL AND x.normalized_value <> upper(i.code))`;

export function registerLabels(scope: FastifyInstance, { pool, requireAuth }: Deps) {
  const print = requirePermission(requireAuth, 'cat.label.print');
  const readTemplate = requireAnyPermission(requireAuth, ['cat.label.print', 'admin.settings']);
  const editTemplate = requirePermission(requireAuth, 'admin.settings');

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

  scope.get('/catalog/labels/template', { preHandler: readTemplate }, (req, reply) =>
    run(req, reply, templateOf),
  );

  scope.put('/catalog/labels/template', { preHandler: editTemplate }, async (req, reply) => {
    const parsed = LabelTemplateRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { template, problems } = labelTemplateProblems(parsed.data);
    if (problems.length > 0) return reply.code(400).send({ error: 'invalid', problems });
    return run(req, reply, async (c) => {
      await c.query(
        "UPDATE erp.tenants SET settings = jsonb_set(settings, '{labels}', $1::jsonb), updated_at = now()",
        [JSON.stringify(template)],
      );
      return template;
    });
  });

  // A posted receipt by its id or its number (GR000001), as the legacy screen picked a purchase invoice.
  scope.get('/catalog/labels/receipt', { preHandler: print }, async (req, reply) => {
    const ref = ((req.query as Record<string, string | undefined>)['receipt'] ?? '').trim();
    if (ref === '') return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, async (c) => {
      const { rows } = await c.query<{ id: string; number: string | null; status: string; supplier: string }>(
        `SELECT r.id, r.number, r.status, coalesce(p.name, '') AS supplier
         FROM erp.goods_receipts r LEFT JOIN erp.parties p ON p.id = r.supplier_party_id
         WHERE ${UUID.test(ref) ? 'r.id = $1::uuid' : 'upper(r.number) = upper($1)'}`,
        [ref],
      );
      const r = rows[0];
      if (!r) throw new Refusal(404, { error: 'not_found' });
      if (r.status !== 'posted') throw new Refusal(409, { error: 'not_posted' });
      const template = await templateOf(c);
      const lines = await c.query<{
        item_id: string;
        code: string;
        name: string;
        qty: string;
        allows_fraction: boolean;
        maker: boolean;
        abbr: string | null;
      }>(
        `SELECT i.id AS item_id, i.code, i.name, round(l.qty * 1000)::text AS qty, u.allows_fraction,
           ${MAKER_BARCODE} AS maker, p.label_abbr AS abbr
         FROM erp.goods_receipt_lines l
         JOIN erp.goods_receipts r ON r.id = l.receipt_id
         JOIN erp.items i ON i.id = l.item_id
         JOIN erp.units u ON u.id = i.unit_id
         LEFT JOIN erp.parties p ON p.id = r.supplier_party_id
         WHERE l.receipt_id = $1
         ORDER BY l.line_no`,
        [r.id],
      );
      const out: LabelsView = {
        source: { number: r.number!, supplier: r.supplier },
        template,
        lines: receiptLabels({
          labelMakerBarcoded: template.labelMakerBarcoded,
          lines: lines.rows.map((l) => ({
            itemId: l.item_id,
            code: l.code,
            name: l.name,
            qty: Number(l.qty),
            allowsFraction: l.allows_fraction,
            makerBarcode: l.maker,
            supplierAbbr: l.abbr,
          })),
        }),
      };
      return out;
    });
  });

  // A relabel: the supplier is the item's last purchase supplier, else its default supplier (W1-17 plan).
  scope.post('/catalog/labels/items', { preHandler: print }, async (req, reply) => {
    const parsed = LabelItemsRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const ids = parsed.data.itemIds;
    return run(req, reply, async (c) => {
      const template = await templateOf(c);
      const { rows } = await c.query<{ id: string; code: string; name: string; abbr: string | null }>(
        `SELECT i.id, i.code, i.name, coalesce(last.label_abbr, def.label_abbr) AS abbr
         FROM erp.items i
         LEFT JOIN erp.item_costs k ON k.item_id = i.id
         LEFT JOIN erp.parties last ON last.id = k.last_supplier_id AND last.deleted_at IS NULL
         LEFT JOIN erp.parties def ON def.id = i.default_supplier_id AND def.deleted_at IS NULL
         WHERE i.id = ANY($1::uuid[]) AND i.deleted_at IS NULL`,
        [ids],
      );
      // In the order they were picked.
      const byId = new Map(rows.map((r) => [r.id, r]));
      const picked = ids.flatMap((id) => {
        const r = byId.get(id);
        return r ? [{ itemId: r.id, code: r.code, name: r.name, supplierAbbr: r.abbr }] : [];
      });
      const out: LabelsView = { source: null, template, lines: itemLabels(picked) };
      return out;
    });
  });
}
