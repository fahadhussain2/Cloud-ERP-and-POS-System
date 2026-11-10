import {
  AdjustmentDraft,
  InventorySettingsRequest,
  ReceiveTransferRequest,
  RejectAdjustmentRequest,
  SaveAdjustmentRequest,
  SaveTransferRequest,
  StockPostRequest,
  TransferDraft,
  type AdjustmentStatus,
  type AdjustmentView,
  type InventoryItem,
  type InventoryLookups,
  type LocationKindName,
  type StockCardView,
  type StockDocumentRow,
  type TransferNeededRow,
  type TransferStatus,
  type TransferView,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import {
  ADJUSTMENT_REASONS,
  adjustmentApproval,
  can,
  checkAdjustment,
  checkTransfer,
  checkTransferReceipt,
  normalizeIdentifier,
  type Permission,
} from '@erp/domain';
import { postDocument } from '@erp/posting';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requireAnyPermission, requirePermission } from '../auth/routes';
import { lockedOn } from '../lock';
import { moneyOf } from '../reports/routes';

// Stock operations in the back office (W1-18 plan; INV-04, INV-05, INV-07; owner answers 1–4; D-107).
// - Transfers: the purchaser (inv.transfer) types a draft; the owner or the manager (inv.transfer.post) posts it. On a
//   route that moves at once it posts in one step; on one that needs receiving it is sent (into In transit) and later
//   received, the shortfall a loss adjustment out of In transit.
// - Adjustments (inv.adjust): posted at once, or, when the losses are above the shop's limit and the one posting can't
//   approve them, put up for the owner (inv.adjust.approve), who approves (it posts) or sends it back to a draft.
// Every post runs its posting in the same transaction: a posting that fails refuses the whole step. Posted = never
// changed (rule 3).

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

/** A 201 answer, sent by `run` once the transaction has committed. */
class Created {
  constructor(readonly body: unknown) {}
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
type Row = Record<string, unknown>;

/** Rs 10,000 (owner answer 3), until the owner sets another. */
const DEFAULT_APPROVAL_LIMIT = 1_000_000;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const thousandths = (v: unknown) => Math.round(Number(v) * 1000);
const units = (t: number) => t / 1000;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (x) => `\\${x}`);
const text = (v: unknown) => (typeof v === 'string' ? v : null);

async function nextNumber(c: Client, tenantId: string, family: 'TR' | 'AD'): Promise<string> {
  const { rows } = await c.query<{ last_no: string }>(
    `INSERT INTO erp.document_counters (tenant_id, family, last_no) VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, family) DO UPDATE SET last_no = erp.document_counters.last_no + 1
     RETURNING last_no::text`,
    [tenantId, family],
  );
  return `${family}${rows[0]!.last_no.padStart(6, '0')}`;
}

/** Each location's branch and kind, by id. */
async function locations(c: Client) {
  const { rows } = await c.query<{ id: string; branch_id: string; kind: LocationKindName }>(
    'SELECT id, branch_id, kind FROM erp.locations WHERE deleted_at IS NULL',
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** Each item's code, name and unit rule, its average, and its stock per location (thousandths). */
async function itemFacts(c: Client, itemIds: string[]) {
  const { rows } = await c.query<Row>(
    `SELECT i.id, i.code, i.name, u.allows_fraction, k.avg_cost,
       coalesce((SELECT jsonb_object_agg(b.location_id, (b.qty * 1000)::bigint) FROM erp.stock_balances b
                 WHERE b.item_id = i.id AND b.qty <> 0), '{}') AS stock
     FROM erp.items i JOIN erp.units u ON u.id = i.unit_id LEFT JOIN erp.item_costs k ON k.item_id = i.id
     WHERE i.id = ANY($1::uuid[])`,
    [itemIds],
  );
  return new Map(
    rows.map((r) => [
      r['id'] as string,
      {
        code: r['code'] as string,
        name: r['name'] as string,
        allowsFraction: r['allows_fraction'] as boolean,
        avgCost: num(r['avg_cost']),
        stock: Object.fromEntries(
          Object.entries(r['stock'] as Record<string, number | string>).map(([k, v]) => [k, Number(v)]),
        ),
      },
    ]),
  );
}

async function approvalLimit(c: Client): Promise<number> {
  const { rows } = await c.query<{ limit: string | null }>(
    "SELECT settings -> 'inventory' ->> 'adjustmentApprovalLimit' AS limit FROM erp.tenants",
  );
  return num(rows[0]?.limit) ?? DEFAULT_APPROVAL_LIMIT;
}

/** The document as it is now, refused when it is gone, past `allowed` or saved by someone else meanwhile. */
async function checkVersion(
  c: Client,
  table: 'stock_transfers' | 'stock_adjustments',
  id: string,
  rowVersion: string,
  allowed: readonly string[],
) {
  const r = (
    await c.query<{ status: string; row_version: string; by: string | null; at: Date }>(
      `SELECT d.status, d.row_version::text, u.full_name AS by, d.updated_at AS at
       FROM erp.${table} d LEFT JOIN erp.users u ON u.id = d.updated_by_user_id WHERE d.id = $1`,
      [id],
    )
  ).rows[0];
  if (!r) throw new Refusal(404, { error: 'not_found' });
  if (!allowed.includes(r.status))
    throw new Refusal(409, { error: r.status === 'posted' || r.status === 'received' ? 'posted' : r.status });
  if (r.row_version !== rowVersion)
    throw new Refusal(409, { error: 'stale', by: r.by, at: r.at.toISOString(), rowVersion: r.row_version });
  return r.status;
}

export function registerInventory(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  const lookups = requireAnyPermission(requireAuth, [
    'inv.transfer',
    'inv.adjust',
    'cost.view',
    'admin.settings',
  ]);
  const findItems = requireAnyPermission(requireAuth, ['inv.transfer', 'inv.adjust']);
  const readTransfers = requireAnyPermission(requireAuth, ['inv.transfer', 'inv.transfer.post']);
  const draftTransfer = requirePermission(requireAuth, 'inv.transfer');
  const postTransfer = requirePermission(requireAuth, 'inv.transfer.post');
  const readAdjustments = requireAnyPermission(requireAuth, ['inv.adjust', 'inv.adjust.approve']);
  const adjust = requirePermission(requireAuth, 'inv.adjust');
  const approve = requirePermission(requireAuth, 'inv.adjust.approve');
  const readCard = requireAnyPermission(requireAuth, ['inv.transfer', 'inv.adjust', 'cost.view']);
  const settings = requirePermission(requireAuth, 'admin.settings');
  const allowed = (req: FastifyRequest, p: Permission) => can(req.auth!.grants, p, null);

  const run = async <T>(req: FastifyRequest, reply: FastifyReply, fn: (c: Client) => Promise<T>) => {
    try {
      const out = await withTenant(
        pool,
        { tenantId: req.auth!.tenantId, userId: req.auth!.userId, requestId: req.id },
        (_db, c) => fn(c),
      );
      return out instanceof Created ? reply.code(201).send(out.body) : out;
    } catch (err) {
      if (err instanceof Refusal) return reply.code(err.status).send(err.body);
      const e = err as { code?: string };
      if (e.code === '23503' || e.code === '22P02' || e.code === '23514')
        return reply.code(400).send({ error: 'invalid_request' });
      throw err;
    }
  };

  /** Posts one step in this transaction; a posting that fails refuses the whole step. */
  const post = async (
    req: FastifyRequest,
    c: Client,
    type: 'stock_transfer' | 'stock_transfer_receipt' | 'stock_adjustment',
    id: string,
  ) => {
    // Nothing posts into a locked month from the back office (D-108); pick a later date.
    const locked = await lockedOn(c, type, id);
    if (locked !== null) throw new Refusal(409, { error: 'date_locked', lockDate: locked });
    const outcome = await postDocument(c, { tenantId: req.auth!.tenantId, type, id, now: now() });
    if (outcome.status === 'failed') throw new Refusal(400, { error: 'posting_failed', code: outcome.code });
  };

  scope.get('/inventory/lookups', { preHandler: lookups }, async (req, reply) =>
    run(req, reply, async (c) => {
      const t = (
        await c.query<{ live: boolean; lock_date: string | null }>(
          'SELECT go_live_at IS NOT NULL AS live, lock_date::text AS lock_date FROM erp.tenants',
        )
      ).rows[0];
      const out: InventoryLookups = {
        locations: (
          await c.query<{ id: string; code: string; name: string; kind: LocationKindName }>(
            `SELECT id, code, name, kind FROM erp.locations WHERE deleted_at IS NULL AND kind <> 'transit'
             ORDER BY code`,
          )
        ).rows,
        routes: (
          await c.query<{ fromLocationId: string; toLocationId: string; needsReceiving: boolean }>(
            `SELECT from_location_id AS "fromLocationId", to_location_id AS "toLocationId",
               needs_receiving AS "needsReceiving"
             FROM erp.transfer_routes WHERE needs_receiving ORDER BY from_location_id, to_location_id`,
          )
        ).rows,
        adjustmentApprovalLimit: await approvalLimit(c),
        reasons: [...ADJUSTMENT_REASONS],
        live: t?.live === true,
        money: await moneyOf(c),
        can: {
          transfer: allowed(req, 'inv.transfer'),
          postTransfer: allowed(req, 'inv.transfer.post'),
          adjust: allowed(req, 'inv.adjust'),
          approve: allowed(req, 'inv.adjust.approve'),
          viewCost: allowed(req, 'cost.view'),
          settings: allowed(req, 'admin.settings'),
        },
        lockDate: t?.lock_date ?? null,
      };
      return out;
    }),
  );

  // The owner's settings: the approval limit and the routes that need receiving (owner answers 3 and 4).
  scope.put('/inventory/settings', { preHandler: settings }, async (req, reply) => {
    const parsed = InventorySettingsRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      const locs = await locations(c);
      for (const r of b.routes) {
        const from = locs.get(r.fromLocationId);
        const to = locs.get(r.toLocationId);
        if (!from || !to || from.kind === 'transit' || to.kind === 'transit' || from === to)
          throw new Refusal(400, { error: 'invalid_request' });
      }
      await c.query(
        `UPDATE erp.tenants SET settings = jsonb_set(settings, '{inventory}',
           coalesce(settings -> 'inventory', '{}') || jsonb_build_object('adjustmentApprovalLimit', $1::bigint)),
           updated_at = now()`,
        [b.adjustmentApprovalLimit],
      );
      await c.query('DELETE FROM erp.transfer_routes');
      for (const r of b.routes.filter((x) => x.needsReceiving))
        await c.query(
          `INSERT INTO erp.transfer_routes (tenant_id, from_location_id, to_location_id, needs_receiving)
           VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING`,
          [req.auth!.tenantId, r.fromLocationId, r.toLocationId],
        );
      return { saved: true };
    });
  });

  // Items for a line: code, name, barcode or OEM number, with the unit rule and the stock per location.
  scope.get('/inventory/items', { preHandler: findItems }, async (req, reply) => {
    const q = ((req.query as Record<string, string | undefined>)['q'] ?? '').trim();
    if (q === '') return { items: [] };
    const words = q.split(/\s+/).map((w) => `%${likeEscape(w)}%`);
    const normalized = likeEscape(normalizeIdentifier(q));
    return run(req, reply, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT i.id FROM erp.items i
         WHERE i.deleted_at IS NULL
           AND (NOT EXISTS (SELECT 1 FROM unnest($1::text[]) w WHERE NOT (i.code ILIKE w OR i.name ILIKE w))
             OR EXISTS (SELECT 1 FROM erp.item_identifiers x WHERE x.item_id = i.id AND x.deleted_at IS NULL
                        AND x.normalized_value LIKE $2 || '%'))
         ORDER BY i.code LIMIT 20`,
        [words, normalized],
      );
      const facts = await itemFacts(
        c,
        rows.map((r) => r.id),
      );
      const viewCost = allowed(req, 'cost.view');
      const items: InventoryItem[] = rows.map((r) => {
        const f = facts.get(r.id)!;
        return {
          id: r.id,
          code: f.code,
          name: f.name,
          allowsFraction: f.allowsFraction,
          stock: f.stock,
          avgCost: viewCost ? f.avgCost : null,
        };
      });
      return { items };
    });
  });

  // ---- Transfers (INV-04) ----

  /** Whether stock from → to needs receiving (owner answer 4); no row = moves at once. */
  const needsReceiving = async (c: Client, from: string | null, to: string | null) =>
    from !== null &&
    to !== null &&
    ((
      await c.query(
        'SELECT 1 FROM erp.transfer_routes WHERE from_location_id = $1 AND to_location_id = $2 AND needs_receiving',
        [from, to],
      )
    ).rowCount ?? 0) > 0;

  const transferView = async (c: Client, id: string): Promise<TransferView | null> => {
    const h = (
      await c.query<Row>(
        `SELECT t.*, t.row_version::text AS rv, t.business_date::text AS moved_on, t.received_on::text AS received,
           pu.full_name AS posted_by, ru.full_name AS received_by
         FROM erp.stock_transfers t LEFT JOIN erp.users pu ON pu.id = t.posted_by_user_id
         LEFT JOIN erp.users ru ON ru.id = t.received_by_user_id WHERE t.id = $1`,
        [id],
      )
    ).rows[0];
    if (!h) return null;
    const rows = (
      await c.query<Row>('SELECT * FROM erp.stock_transfer_lines WHERE transfer_id = $1 ORDER BY line_no', [
        id,
      ])
    ).rows;
    const facts = await itemFacts(
      c,
      rows.map((r) => r['item_id'] as string | null).filter((x): x is string => x !== null),
    );
    const status = h['status'] as TransferStatus;
    const from = h['from_location_id'] as string;
    const to = h['to_location_id'] as string;
    const lines = rows.map((r) => {
      const f = r['item_id'] ? facts.get(r['item_id'] as string) : undefined;
      return {
        id: r['id'] as string,
        lineNo: Number(r['line_no']),
        itemId: (r['item_id'] as string | null) ?? null,
        code: f?.code ?? null,
        name: f?.name ?? null,
        qty: thousandths(r['qty']),
        receivedQty: r['received_qty'] === null ? null : thousandths(r['received_qty']),
        allowsFraction: f?.allowsFraction ?? false,
        // What the source has now matters only before it moves.
        available: status === 'draft' && f ? (f.stock[from] ?? 0) : null,
      };
    });
    const locs = await locations(c);
    const check = checkTransfer({
      fromLocationId: from,
      toLocationId: to,
      fromKind: locs.get(from)?.kind ?? null,
      toKind: locs.get(to)?.kind ?? null,
      lines,
    });
    const shortfall = (
      await c.query<{ id: string; number: string | null; status: AdjustmentStatus }>(
        'SELECT id, number, status FROM erp.stock_adjustments WHERE stock_transfer_id = $1 ORDER BY created_at LIMIT 1',
        [id],
      )
    ).rows[0];
    return {
      transfer: {
        id,
        number: text(h['number']),
        status,
        fromLocationId: from,
        toLocationId: to,
        movedOn: h['moved_on'] as string,
        note: text(h['note']),
        needsReceiving: status === 'draft' ? await needsReceiving(c, from, to) : status !== 'posted',
        receivedOn: text(h['received']),
        postedBy: text(h['posted_by']),
        receivedBy: text(h['received_by']),
        rowVersion: h['rv'] as string,
      },
      lines,
      check,
      shortfallAdjustment: shortfall ?? null,
    };
  };

  /** A draft's header and lines; the locations must exist and be ones stock is moved between by hand. */
  const writeTransfer = async (c: Client, tenantId: string, id: string | null, b: TransferDraft) => {
    const locs = await locations(c);
    const from = b.fromLocationId ? locs.get(b.fromLocationId) : undefined;
    const to = b.toLocationId ? locs.get(b.toLocationId) : undefined;
    if (!from || !to) throw new Refusal(400, { error: 'invalid_request' });
    let doc = id;
    if (doc === null) {
      doc = (
        await c.query<{ id: string }>(
          `INSERT INTO erp.stock_transfers (tenant_id, branch_id, from_location_id, to_location_id, business_date, note)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [tenantId, from.branch_id, from.id, to.id, b.movedOn, b.note],
        )
      ).rows[0]!.id;
    } else {
      await c.query(
        `UPDATE erp.stock_transfers SET branch_id = $2, from_location_id = $3, to_location_id = $4,
           business_date = $5, note = $6, row_version = row_version + 1 WHERE id = $1`,
        [doc, from.branch_id, from.id, to.id, b.movedOn, b.note],
      );
    }
    await c.query('DELETE FROM erp.stock_transfer_lines WHERE transfer_id = $1', [doc]);
    for (const [n, l] of b.lines.entries())
      await c.query(
        `INSERT INTO erp.stock_transfer_lines (tenant_id, transfer_id, line_no, item_id, qty)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, doc, n + 1, l.itemId, units(l.qty)],
      );
    const rv = (
      await c.query<{ rv: string }>('SELECT row_version::text AS rv FROM erp.stock_transfers WHERE id = $1', [
        doc,
      ])
    ).rows[0]!.rv;
    return { id: doc, rowVersion: rv };
  };

  scope.get('/inventory/transfers', { preHandler: readTransfers }, async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    return run(req, reply, async (c) => {
      const { rows } = await c.query<Row>(
        `SELECT t.id, t.number, t.status, t.business_date::text AS date, t.from_location_id, t.to_location_id,
           (SELECT count(*) FROM erp.stock_transfer_lines l WHERE l.transfer_id = t.id)::int AS lines
         FROM erp.stock_transfers t WHERE ($1::text IS NULL OR t.status = $1)
         ORDER BY t.status = 'draft' DESC, t.status = 'in_transit' DESC, t.business_date DESC, t.number DESC NULLS FIRST
         LIMIT 200`,
        [qs['status'] || null],
      );
      const transfers: StockDocumentRow[] = rows.map((r) => ({
        id: r['id'] as string,
        number: text(r['number']),
        status: r['status'] as string,
        date: r['date'] as string,
        fromLocationId: r['from_location_id'] as string,
        toLocationId: r['to_location_id'] as string,
        locationId: null,
        reason: null,
        lines: Number(r['lines']),
        lossValue: null,
      }));
      return { transfers };
    });
  });

  scope.get('/inventory/transfers/:id', { preHandler: readTransfers }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return run(req, reply, async (c) => {
      const v = await transferView(c, id);
      if (!v) throw new Refusal(404, { error: 'not_found' });
      return v;
    });
  });

  scope.post('/inventory/transfers', { preHandler: draftTransfer }, async (req, reply) => {
    const parsed = TransferDraft.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return run(
      req,
      reply,
      async (c) => new Created(await writeTransfer(c, req.auth!.tenantId, null, parsed.data)),
    );
  });

  scope.put('/inventory/transfers/:id', { preHandler: draftTransfer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SaveTransferRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, async (c) => {
      await checkVersion(c, 'stock_transfers', id, parsed.data.rowVersion, ['draft']);
      const { rowVersion } = await writeTransfer(c, req.auth!.tenantId, id, parsed.data);
      return { rowVersion };
    });
  });

  scope.delete('/inventory/transfers/:id', { preHandler: draftTransfer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return run(req, reply, async (c) => {
      const r = (
        await c.query<{ status: string }>('SELECT status FROM erp.stock_transfers WHERE id = $1', [id])
      ).rows[0];
      if (!r) throw new Refusal(404, { error: 'not_found' });
      if (r.status !== 'draft') throw new Refusal(409, { error: 'posted' });
      await c.query('DELETE FROM erp.stock_transfer_lines WHERE transfer_id = $1', [id]);
      await c.query('DELETE FROM erp.stock_transfers WHERE id = $1', [id]);
      return { deleted: true };
    });
  });

  // Posting: moves it at once, or sends it into In transit when its route needs receiving.
  scope.post('/inventory/transfers/:id/post', { preHandler: postTransfer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = StockPostRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, async (c) => {
      await checkVersion(c, 'stock_transfers', id, parsed.data.rowVersion, ['draft']);
      const v = (await transferView(c, id))!;
      if (v.check.problems.length > 0)
        throw new Refusal(400, { error: 'invalid', problems: v.check.problems, warnings: v.check.warnings });
      const status: TransferStatus = v.transfer.needsReceiving ? 'in_transit' : 'posted';
      const number = await nextNumber(c, req.auth!.tenantId, 'TR');
      await c.query(
        `UPDATE erp.stock_transfers SET status = $2, number = $3, posted_at = $4, posted_by_user_id = $5,
           row_version = row_version + 1 WHERE id = $1`,
        [id, status, number, now(), req.auth!.userId],
      );
      await post(req, c, 'stock_transfer', id);
      return { number, status };
    });
  });

  scope.post('/inventory/transfers/:id/receive', { preHandler: postTransfer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ReceiveTransferRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      await checkVersion(c, 'stock_transfers', id, b.rowVersion, ['in_transit']);
      const v = (await transferView(c, id))!;
      // Every line, once: what arrived of each.
      const got = new Map(b.lines.map((l) => [l.lineId, l.receivedQty]));
      if (got.size !== b.lines.length || got.size !== v.lines.length || v.lines.some((l) => !got.has(l.id)))
        throw new Refusal(400, { error: 'invalid_request' });
      const check = checkTransferReceipt({
        lines: v.lines.map((l) => ({
          sent: l.qty,
          received: got.get(l.id)!,
          allowsFraction: l.allowsFraction,
        })),
      });
      if (check.problems.length > 0) throw new Refusal(400, { error: 'invalid', problems: check.problems });
      for (const l of v.lines)
        await c.query('UPDATE erp.stock_transfer_lines SET received_qty = $2 WHERE id = $1', [
          l.id,
          units(got.get(l.id)!),
        ]);
      const receipt = (
        await c.query<{ id: string }>(
          `UPDATE erp.stock_transfers SET status = 'received', receipt_id = erp.uuid_v7(), received_on = $2,
             received_at = $3, received_by_user_id = $4, row_version = row_version + 1
           WHERE id = $1 RETURNING receipt_id AS id`,
          [id, b.receivedOn, now(), req.auth!.userId],
        )
      ).rows[0]!.id;
      await post(req, c, 'stock_transfer_receipt', receipt);

      // What didn't arrive leaves In transit as a loss, under the same approval rule (owner answers 3 and 4).
      let shortfall: { id: string; number: string | null; status: AdjustmentStatus } | null = null;
      if (check.shortfall.length > 0) {
        const head = (
          await c.query<{ id: string; branch_id: string }>(
            `INSERT INTO erp.stock_adjustments (tenant_id, branch_id, location_id, business_date, reason_code, note,
               stock_transfer_id)
             SELECT t.tenant_id, t.branch_id, l.id, $2, 'lost', 'Short on arrival of ' || t.number, t.id
             FROM erp.stock_transfers t
             JOIN erp.locations l ON l.branch_id = t.branch_id AND l.kind = 'transit' AND l.deleted_at IS NULL
             WHERE t.id = $1 RETURNING id, branch_id`,
            [id, b.receivedOn],
          )
        ).rows[0]!;
        for (const [n, s] of check.shortfall.entries())
          await c.query(
            `INSERT INTO erp.stock_adjustment_lines (tenant_id, adjustment_id, line_no, item_id, qty)
             VALUES ($1, $2, $3, $4, $5)`,
            [req.auth!.tenantId, head.id, n + 1, v.lines[s.row]!.itemId, units(-s.qty)],
          );
        const out = await submitAdjustment(req, c, head.id, false);
        shortfall = { id: head.id, ...out };
      }
      return { status: 'received', shortfall };
    });
  });

  // ---- Adjustments (INV-05) ----

  const adjustmentView = async (
    req: FastifyRequest,
    c: Client,
    id: string,
  ): Promise<(AdjustmentView & { lossValue: number }) | null> => {
    const h = (
      await c.query<Row>(
        `SELECT a.*, a.row_version::text AS rv, a.business_date::text AS adjusted_on, t.number AS transfer_number,
           su.full_name AS submitted_by, au.full_name AS approved_by, ru.full_name AS rejected_by, l.kind
         FROM erp.stock_adjustments a JOIN erp.locations l ON l.id = a.location_id
         LEFT JOIN erp.stock_transfers t ON t.id = a.stock_transfer_id
         LEFT JOIN erp.users su ON su.id = a.submitted_by_user_id
         LEFT JOIN erp.users au ON au.id = a.approved_by_user_id
         LEFT JOIN erp.users ru ON ru.id = a.rejected_by_user_id WHERE a.id = $1`,
        [id],
      )
    ).rows[0];
    if (!h) return null;
    const rows = (
      await c.query<Row>(
        'SELECT * FROM erp.stock_adjustment_lines WHERE adjustment_id = $1 ORDER BY line_no',
        [id],
      )
    ).rows;
    const facts = await itemFacts(
      c,
      rows.map((r) => r['item_id'] as string | null).filter((x): x is string => x !== null),
    );
    const status = h['status'] as AdjustmentStatus;
    const location = h['location_id'] as string;
    const viewCost = allowed(req, 'cost.view');
    const lines = rows.map((r) => {
      const f = r['item_id'] ? facts.get(r['item_id'] as string) : undefined;
      return {
        id: r['id'] as string,
        lineNo: Number(r['line_no']),
        itemId: (r['item_id'] as string | null) ?? null,
        code: f?.code ?? null,
        name: f?.name ?? null,
        qty: thousandths(r['qty']),
        allowsFraction: f?.allowsFraction ?? false,
        onHand: status !== 'posted' && f ? (f.stock[location] ?? 0) : null,
        avgCost: f?.avgCost ?? null,
      };
    });
    const check = checkAdjustment({
      locationId: location,
      locationKind: h['kind'] as LocationKindName,
      reason: text(h['reason_code']),
      note: text(h['note']),
      lines,
    });
    const value = adjustmentApproval({
      canApprove: allowed(req, 'inv.adjust.approve'),
      limit: await approvalLimit(c),
      lines,
    });
    return {
      adjustment: {
        id,
        number: text(h['number']),
        status,
        locationId: location,
        adjustedOn: h['adjusted_on'] as string,
        reason: text(h['reason_code']),
        note: text(h['note']),
        transfer: h['stock_transfer_id']
          ? { id: h['stock_transfer_id'] as string, number: text(h['transfer_number']) }
          : null,
        submittedBy: text(h['submitted_by']),
        approvedBy: text(h['approved_by']),
        rejection: h['rejected_at']
          ? {
              by: text(h['rejected_by']),
              at: (h['rejected_at'] as Date).toISOString(),
              note: text(h['rejection_note']),
            }
          : null,
        rowVersion: h['rv'] as string,
      },
      lines: lines.map((l) => ({ ...l, avgCost: viewCost ? l.avgCost : null })),
      check,
      value: viewCost ? { gain: value.gain, loss: value.loss } : null,
      needsApproval: status === 'draft' && value.needsApproval,
      lossValue: value.loss,
    };
  };

  /** Posts it now with the next number; `approved` records the owner's approval. */
  const postAdjustment = async (req: FastifyRequest, c: Client, id: string, approved: boolean) => {
    const number = await nextNumber(c, req.auth!.tenantId, 'AD');
    await c.query(
      `UPDATE erp.stock_adjustments SET status = 'posted', number = $2, posted_at = $3, posted_by_user_id = $4,
         approved_at = CASE WHEN $5::boolean THEN $3::timestamptz END,
         approved_by_user_id = CASE WHEN $5::boolean THEN $4::uuid END,
         row_version = row_version + 1
       WHERE id = $1`,
      [id, number, now(), req.auth!.userId, approved],
    );
    await post(req, c, 'stock_adjustment', id);
    return { number, status: 'posted' as AdjustmentStatus };
  };

  /** A draft checked, then posted or put up for the owner when its loss is above the limit (owner answer 3). */
  const submitAdjustment = async (req: FastifyRequest, c: Client, id: string, approved: boolean) => {
    const v = (await adjustmentView(req, c, id))!;
    if (v.check.problems.length > 0)
      throw new Refusal(400, { error: 'invalid', problems: v.check.problems, warnings: v.check.warnings });
    if (!approved && v.needsApproval) {
      await c.query(
        `UPDATE erp.stock_adjustments SET status = 'awaiting_approval', loss_value = $2, submitted_at = $3,
           submitted_by_user_id = $4, row_version = row_version + 1 WHERE id = $1`,
        [id, v.lossValue, now(), req.auth!.userId],
      );
      return { number: null, status: 'awaiting_approval' as AdjustmentStatus };
    }
    return postAdjustment(req, c, id, approved);
  };

  const writeAdjustment = async (c: Client, tenantId: string, id: string | null, b: AdjustmentDraft) => {
    const locs = await locations(c);
    const at = b.locationId ? locs.get(b.locationId) : undefined;
    if (!at) throw new Refusal(400, { error: 'invalid_request' });
    // Stock leaves In transit by hand only as a transfer's shortfall, which is made when it is received.
    if (at.kind === 'transit') {
      const linked =
        id !== null &&
        (
          await c.query(
            'SELECT 1 FROM erp.stock_adjustments WHERE id = $1 AND stock_transfer_id IS NOT NULL AND location_id = $2',
            [id, at.id],
          )
        ).rowCount;
      if (!linked) throw new Refusal(400, { error: 'invalid_request' });
    }
    let doc = id;
    if (doc === null) {
      doc = (
        await c.query<{ id: string }>(
          `INSERT INTO erp.stock_adjustments (tenant_id, branch_id, location_id, business_date, reason_code, note)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [tenantId, at.branch_id, at.id, b.adjustedOn, b.reason, b.note],
        )
      ).rows[0]!.id;
    } else {
      await c.query(
        `UPDATE erp.stock_adjustments SET branch_id = $2, location_id = $3, business_date = $4, reason_code = $5,
           note = $6, row_version = row_version + 1 WHERE id = $1`,
        [doc, at.branch_id, at.id, b.adjustedOn, b.reason, b.note],
      );
    }
    await c.query('DELETE FROM erp.stock_adjustment_lines WHERE adjustment_id = $1', [doc]);
    for (const [n, l] of b.lines.entries())
      await c.query(
        `INSERT INTO erp.stock_adjustment_lines (tenant_id, adjustment_id, line_no, item_id, qty)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, doc, n + 1, l.itemId, units(l.qty)],
      );
    const rv = (
      await c.query<{ rv: string }>(
        'SELECT row_version::text AS rv FROM erp.stock_adjustments WHERE id = $1',
        [doc],
      )
    ).rows[0]!.rv;
    return { id: doc, rowVersion: rv };
  };

  scope.get('/inventory/adjustments', { preHandler: readAdjustments }, async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>;
    return run(req, reply, async (c) => {
      const { rows } = await c.query<Row>(
        `SELECT a.id, a.number, a.status, a.business_date::text AS date, a.location_id, a.reason_code, a.loss_value,
           (SELECT count(*) FROM erp.stock_adjustment_lines l WHERE l.adjustment_id = a.id)::int AS lines
         FROM erp.stock_adjustments a WHERE ($1::text IS NULL OR a.status = $1)
         ORDER BY a.status = 'awaiting_approval' DESC, a.status = 'draft' DESC, a.business_date DESC,
           a.number DESC NULLS FIRST
         LIMIT 200`,
        [qs['status'] || null],
      );
      const viewCost = allowed(req, 'cost.view');
      const adjustments: StockDocumentRow[] = rows.map((r) => ({
        id: r['id'] as string,
        number: text(r['number']),
        status: r['status'] as string,
        date: r['date'] as string,
        fromLocationId: null,
        toLocationId: null,
        locationId: r['location_id'] as string,
        reason: text(r['reason_code']),
        lines: Number(r['lines']),
        lossValue: viewCost && r['status'] === 'awaiting_approval' ? num(r['loss_value']) : null,
      }));
      return { adjustments };
    });
  });

  scope.get('/inventory/adjustments/:id', { preHandler: readAdjustments }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return run(req, reply, async (c) => {
      const v = await adjustmentView(req, c, id);
      if (!v) throw new Refusal(404, { error: 'not_found' });
      const out: AdjustmentView = {
        adjustment: v.adjustment,
        lines: v.lines,
        check: v.check,
        value: v.value,
        needsApproval: v.needsApproval,
      };
      return out;
    });
  });

  scope.post('/inventory/adjustments', { preHandler: adjust }, async (req, reply) => {
    const parsed = AdjustmentDraft.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return run(
      req,
      reply,
      async (c) => new Created(await writeAdjustment(c, req.auth!.tenantId, null, parsed.data)),
    );
  });

  scope.put('/inventory/adjustments/:id', { preHandler: adjust }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SaveAdjustmentRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, async (c) => {
      await checkVersion(c, 'stock_adjustments', id, parsed.data.rowVersion, ['draft']);
      const { rowVersion } = await writeAdjustment(c, req.auth!.tenantId, id, parsed.data);
      return { rowVersion };
    });
  });

  scope.delete('/inventory/adjustments/:id', { preHandler: adjust }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return run(req, reply, async (c) => {
      const r = (
        await c.query<{ status: string; linked: boolean }>(
          'SELECT status, stock_transfer_id IS NOT NULL AS linked FROM erp.stock_adjustments WHERE id = $1',
          [id],
        )
      ).rows[0];
      if (!r) throw new Refusal(404, { error: 'not_found' });
      if (r.status !== 'draft')
        throw new Refusal(409, { error: r.status === 'posted' ? 'posted' : r.status });
      // A shortfall stays: the stock is gone from In transit whether or not anyone posts it.
      if (r.linked) throw new Refusal(409, { error: 'in_use' });
      await c.query('DELETE FROM erp.stock_adjustment_lines WHERE adjustment_id = $1', [id]);
      await c.query('DELETE FROM erp.stock_adjustments WHERE id = $1', [id]);
      return { deleted: true };
    });
  });

  scope.post('/inventory/adjustments/:id/post', { preHandler: adjust }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = StockPostRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, async (c) => {
      await checkVersion(c, 'stock_adjustments', id, parsed.data.rowVersion, ['draft']);
      return submitAdjustment(req, c, id, false);
    });
  });

  scope.post('/inventory/adjustments/:id/approve', { preHandler: approve }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = StockPostRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, async (c) => {
      await checkVersion(c, 'stock_adjustments', id, parsed.data.rowVersion, ['awaiting_approval']);
      return submitAdjustment(req, c, id, true);
    });
  });

  scope.post('/inventory/adjustments/:id/reject', { preHandler: approve }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = RejectAdjustmentRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, async (c) => {
      await checkVersion(c, 'stock_adjustments', id, parsed.data.rowVersion, ['awaiting_approval']);
      const { rows } = await c.query<{ rv: string }>(
        `UPDATE erp.stock_adjustments SET status = 'draft', rejected_at = $2, rejected_by_user_id = $3,
           rejection_note = $4, row_version = row_version + 1 WHERE id = $1 RETURNING row_version::text AS rv`,
        [id, now(), req.auth!.userId, parsed.data.note],
      );
      return { rowVersion: rows[0]!.rv };
    });
  });

  // ---- Reading the stock (INV-07, PRD W13) ----

  /**
   * Every movement of an item, newest first, 100 a page, with running balances per location and in total. Within a
   * posting, by line, and a transfer line out before in.
   */
  scope.get('/inventory/items/:id/card', { preHandler: readCard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const qs = req.query as Record<string, string | undefined>;
    const before = qs['before'] ? Number(qs['before']) : null;
    if (before !== null && !Number.isSafeInteger(before))
      return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, async (c) => {
      const item = (
        await c.query<{ id: string; code: string; name: string }>(
          'SELECT id, code, name FROM erp.items WHERE id = $1',
          [id],
        )
      ).rows[0];
      if (!item) throw new Refusal(404, { error: 'not_found' });
      const { rows } = await c.query<Row>(
        `WITH m AS (
           SELECT m.*, row_number() OVER (ORDER BY m.posting_seq, m.source_line_id NULLS FIRST, m.qty_delta, m.id) AS n,
             sum(m.qty_delta) OVER (PARTITION BY m.location_id ORDER BY m.posting_seq, m.source_line_id NULLS FIRST, m.qty_delta, m.id) AS balance,
             -- The total after the whole posting: a transfer moves stock, it never changes how much there is.
             sum(m.qty_delta) OVER (ORDER BY m.posting_seq) AS total
           FROM erp.stock_movements m WHERE m.item_id = $1
         )
         SELECT m.n, m.posting_seq, m.business_date::text AS date, m.source_type, m.location_id,
           (m.qty_delta * 1000)::bigint AS qty, m.unit_cost, m.value_delta,
           (m.balance * 1000)::bigint AS balance, (m.total * 1000)::bigint AS total,
           CASE WHEN m.source_type = 'stock_transfer_receipt' THEN tr.id ELSE m.source_id END AS document_id,
           coalesce(s.number, g.number, pr.number, t.number, tr.number, a.number, v.number, o.label) AS number
         FROM m
         LEFT JOIN erp.sales_documents s ON m.source_type = 'sale' AND s.id = m.source_id
         LEFT JOIN erp.goods_receipts g ON m.source_type = 'goods_receipt' AND g.id = m.source_id
         LEFT JOIN erp.purchase_returns pr ON m.source_type = 'purchase_return' AND pr.id = m.source_id
         LEFT JOIN erp.stock_transfers t ON m.source_type = 'stock_transfer' AND t.id = m.source_id
         LEFT JOIN erp.stock_transfers tr ON m.source_type = 'stock_transfer_receipt' AND tr.receipt_id = m.source_id
         LEFT JOIN erp.stock_adjustments a ON m.source_type = 'stock_adjustment' AND a.id = m.source_id
         LEFT JOIN erp.sales_voids v ON m.source_type = 'sales_void' AND v.id = m.source_id
         LEFT JOIN erp.opening_balances o ON m.source_type = 'opening' AND o.id = m.source_id
         WHERE ($2::bigint IS NULL OR m.n < $2) AND ($3::uuid IS NULL OR m.location_id = $3)
           AND ($4::date IS NULL OR m.business_date >= $4) AND ($5::date IS NULL OR m.business_date <= $5)
         ORDER BY m.n DESC LIMIT 101`,
        [id, before, qs['location'] || null, qs['from'] || null, qs['to'] || null],
      );
      const viewCost = allowed(req, 'cost.view');
      const page = rows.slice(0, 100);
      const balances = await c.query<{ location_id: string; q: string }>(
        `SELECT location_id, (qty * 1000)::bigint::text AS q FROM erp.stock_balances WHERE item_id = $1 AND qty <> 0`,
        [id],
      );
      const out: StockCardView = {
        item,
        balances: Object.fromEntries(balances.rows.map((b) => [b.location_id, Number(b.q)])),
        movements: page.map((r) => ({
          seq: Number(r['posting_seq']),
          date: r['date'] as string,
          kind: r['source_type'] as string,
          documentId: r['document_id'] as string,
          number: text(r['number']),
          locationId: r['location_id'] as string,
          qty: Number(r['qty']),
          unitCost: viewCost ? Number(r['unit_cost']) : null,
          value: viewCost ? Number(r['value_delta']) : null,
          balance: Number(r['balance']),
          total: Number(r['total']),
        })),
        next: rows.length > 100 ? Number(page.at(-1)!['n']) : null,
      };
      return out;
    });
  });

  // Items the Shop is short of (below 0) while the Godown has some (PRD W13), with what to move.
  scope.get('/inventory/transfer-needed', { preHandler: readTransfers }, async (req, reply) =>
    run(req, reply, async (c) => {
      const { rows } = await c.query<Row>(
        `SELECT i.id, i.code, i.name, (x.shop * 1000)::bigint AS shop, (x.godown * 1000)::bigint AS godown
         FROM (SELECT b.item_id,
                 sum(b.qty) FILTER (WHERE l.kind = 'shop') AS shop,
                 sum(b.qty) FILTER (WHERE l.kind = 'storage') AS godown
               FROM erp.stock_balances b JOIN erp.locations l ON l.id = b.location_id
               WHERE l.deleted_at IS NULL GROUP BY b.item_id) x
         JOIN erp.items i ON i.id = x.item_id
         WHERE x.shop < 0 AND x.godown > 0 ORDER BY i.code LIMIT 500`,
      );
      const out: TransferNeededRow[] = rows.map((r) => {
        const shop = Number(r['shop']);
        const godown = Number(r['godown']);
        return {
          itemId: r['id'] as string,
          code: r['code'] as string,
          name: r['name'] as string,
          shop,
          godown,
          suggested: Math.min(-shop, godown),
        };
      });
      return { rows: out };
    }),
  );
}
