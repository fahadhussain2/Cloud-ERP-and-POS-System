import { createHash } from 'node:crypto';

import {
  canonicalJson,
  fromBase64Url,
  PushRequestSchema,
  SaleDocumentV1,
  toBase64Url,
  verifyCanonical,
  type ExceptionKind,
  type PushDocument,
  type PushEvent,
  type PushRequest,
  type PushResponse,
  type PushResult,
  type RejectCode,
  type SeriesState,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import {
  businessDate,
  money,
  onAccountAmount,
  reviewCredit,
  reviewSale,
  type CreditAccount,
  type CreditFinding,
  type PaymentMethodCode,
  type PaymentMethodInfo,
  type RoleGrant,
  type RoleLimits,
  type SaleDocument,
  type SaleFinding,
} from '@erp/domain';
import { holdPostingOrder, postDocument, type PostOutcome } from '@erp/posting';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

// Push (sync spec §6.2–§7, SYN-02, SYN-03, SYN-05, PLT-09, W1-07). Each document in its own transaction: claim its id
// in sync_inbox → check it can be trusted and stored (else rejected, kept for a retry) → re-check the rules with
// reviewSale (and a sale on account with reviewCredit, W1-09) and store it with its exceptions (never refused on
// business rules, D-011) → the device's series and gaps. Then the audit events and the device's health. An accepted sale is posted in its own transaction (W1-08,
// architecture §5.2 step 4); one that can't be posted is still accepted and flagged `posting_failed`.

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireDevice: preHandlerAsyncHookHandler;
}

interface Device {
  tenantId: string;
  deviceId: string;
  code: string;
  branchId: string;
}

/** What every document of one push is checked against, read once per push. */
interface Setting {
  timeZone: string;
  cutoffHour: number;
  increment: number;
  publicKey: string;
  lastRevokedAt: Date | null;
  reenabledAt: Date | null;
  methods: (PaymentMethodInfo & { id: string })[];
  shopLocation: string | null;
  /** For items without their own tax code (ACC-09). */
  defaultTaxCode: string | null;
}

/** 5 minutes either way (architecture §4.4). */
const MAX_SKEW_MS = 5 * 60_000;

const SEVERITY: Partial<Record<ExceptionKind, 'low' | 'medium' | 'high'>> = {
  bad_signature: 'high',
  document_inconsistent: 'high',
  revoked_device_doc: 'high',
  below_floor_no_override: 'medium',
  discount_over_limit: 'medium',
  credit_limit_exceeded: 'medium',
  offline_cap_exceeded: 'medium',
  seq_gap: 'medium',
  clock_skew: 'low',
};

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest();

class Rejected extends Error {
  constructor(readonly code: RejectCode) {
    super(code);
  }
}

export function registerPush(scope: FastifyInstance, { pool, now, requireDevice }: Deps) {
  scope.post('/sync/push', { preHandler: requireDevice, bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const parsed = PushRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const body = parsed.data;
    const d = req.device!;
    const device: Device = { tenantId: d.tenantId, deviceId: d.deviceId, code: d.code, branchId: d.branchId };
    const received = now();
    const ctx = { tenantId: d.tenantId, deviceId: d.deviceId, requestId: req.id };
    const setting = await withTenant(pool, ctx, (_db, c) => loadSetting(c, device));

    const results: PushResult[] = [];
    for (const doc of body.documents) {
      const started = performance.now();
      const { result, posting, postingMs } = await withTenant(pool, ctx, (_db, c) =>
        pushOne(c, device, setting, doc, received),
      );
      results.push(result);
      // Posting errors must be 0 (architecture §11): each one is logged as an error and alerts.
      if (posting?.status === 'failed')
        req.log.error({ documentId: doc.id, code: posting.code, message: posting.message }, 'posting.failed');
      // Every document's result against its id (architecture §11.2); never the payload or the signature.
      req.log.info(
        {
          documentId: doc.id,
          family: doc.family,
          seq: doc.seq,
          status: result.status,
          error: result.error,
          exceptions: result.exceptions,
          posting: posting?.status ?? null,
          postingMs,
          ms: Math.round(performance.now() - started),
        },
        'sync.push.document',
      );
    }

    const { events, series } = await withTenant(pool, ctx, async (_db, c) => {
      const stored = await storeEvents(c, device, body.events, req.id);
      await recordHealth(c, device, setting, body, results, received);
      return { events: stored, series: await seriesOf(c, device) };
    });
    req.log.info(
      {
        documents: body.documents.length,
        accepted: results.filter((r) => r.status === 'accepted').length,
        duplicate: results.filter((r) => r.status === 'duplicate').length,
        rejected: results.filter((r) => r.status === 'rejected').length,
        events: body.events.length,
        clientVersion: body.clientVersion,
      },
      'sync.push',
    );
    const response: PushResponse = { serverTime: received.toISOString(), results, series, events };
    return response;
  });
}

async function loadSetting(c: pg.ClientBase, device: Device): Promise<Setting> {
  const t = await c.query<{ timezone: string; day_cutoff_hour: number; cash_rounding_increment: string }>(
    'SELECT timezone, day_cutoff_hour, cash_rounding_increment FROM erp.tenants',
  );
  const dev = await c.query<{ public_key: Buffer; last_revoked_at: Date | null; reenabled_at: Date | null }>(
    'SELECT public_key, last_revoked_at, reenabled_at FROM erp.devices WHERE id = $1',
    [device.deviceId],
  );
  // Every method, active, switched off or removed: one taken away during an outage still paid a sale (SYN-03).
  const m = await c.query<{
    id: string;
    code: PaymentMethodCode;
    is_cash: boolean;
    requires_reference: boolean;
  }>('SELECT id, code, is_cash, requires_reference FROM erp.payment_methods');
  const tax = await c.query<{ id: string }>(
    'SELECT id FROM erp.tax_codes WHERE is_default AND deleted_at IS NULL',
  );
  const shop = await c.query<{ id: string }>(
    `SELECT id FROM erp.locations WHERE branch_id = $1 AND kind = 'shop' AND deleted_at IS NULL ORDER BY code LIMIT 1`,
    [device.branchId],
  );
  return {
    timeZone: t.rows[0]!.timezone,
    cutoffHour: t.rows[0]!.day_cutoff_hour,
    increment: Number(t.rows[0]!.cash_rounding_increment),
    publicKey: toBase64Url(dev.rows[0]!.public_key),
    lastRevokedAt: dev.rows[0]!.last_revoked_at,
    reenabledAt: dev.rows[0]!.reenabled_at,
    methods: m.rows.map((r) => ({
      id: r.id,
      code: r.code,
      isCash: r.is_cash,
      requiresReference: r.requires_reference,
    })),
    shopLocation: shop.rows[0]?.id ?? null,
    defaultTaxCode: tax.rows[0]?.id ?? null,
  };
}

const today = (s: Setting, at: Date) => businessDate(at.getTime(), s.timeZone, s.cutoffHour);

/** One document, in the caller's transaction. */
async function pushOne(
  c: pg.ClientBase,
  device: Device,
  s: Setting,
  doc: PushDocument,
  received: Date,
): Promise<{ result: PushResult; posting: PostOutcome | null; postingMs: number | null }> {
  const hash = sha256(doc.payload);
  const claimed = await c.query(
    `INSERT INTO erp.sync_inbox (tenant_id, document_id, device_id, family, seq, status, result, payload_hash, received_at)
     VALUES ($1, $2, $3, $4, $5, 'rejected', '{}', $6, $7) ON CONFLICT DO NOTHING`,
    [device.tenantId, doc.id, device.deviceId, doc.family, doc.seq, hash, received],
  );
  const isNew = claimed.rowCount === 1;
  if (!isNew) {
    // Two pushes of one id wait here for each other (the row lock), so only one can accept it.
    const prior = (
      await c.query<{ status: string; payload_hash: Buffer; result: PushResult }>(
        'SELECT status, payload_hash, result FROM erp.sync_inbox WHERE document_id = $1 FOR UPDATE',
        [doc.id],
      )
    ).rows[0]!;
    if (prior.status === 'accepted')
      return {
        result: prior.payload_hash.equals(hash)
          ? { ...prior.result, status: 'duplicate' }
          : { id: doc.id, status: 'rejected', exceptions: [], error: 'id_conflict' },
        posting: null,
        postingMs: null,
      };
    // A rejected document is checked again: it may come back fixed (signed, say).
    await c.query(
      'UPDATE erp.sync_inbox SET attempts = attempts + 1, payload_hash = $2, received_at = $3 WHERE document_id = $1',
      [doc.id, hash, received],
    );
  }

  let result: PushResult;
  let posting: PostOutcome | null = null;
  let postingMs: number | null = null;
  try {
    const document = await trusted(c, device, s, doc);
    result = await accept(c, device, s, document, doc, received);
    const started = performance.now();
    posting = await postDocument(c, {
      tenantId: device.tenantId,
      type: 'sale',
      id: document.id,
      now: received,
    });
    postingMs = Math.round(performance.now() - started);
  } catch (err) {
    if (!(err instanceof Rejected)) throw err;
    const exceptions: ExceptionKind[] = err.code === 'bad_signature' ? ['bad_signature'] : [];
    if (err.code === 'bad_signature')
      await addException(c, device, {
        kind: 'bad_signature',
        documentId: doc.id,
        userId: null,
        businessDate: today(s, received),
        details: { family: doc.family, seq: doc.seq },
      });
    result = { id: doc.id, status: 'rejected', exceptions, error: err.code };
  }
  await c.query('UPDATE erp.sync_inbox SET status = $2, result = $3 WHERE document_id = $1', [
    doc.id,
    result.status,
    JSON.stringify(result),
  ]);
  if (isNew) await advanceSeries(c, device, s, doc, received);
  return { result, posting, postingMs };
}

/** The reasons a document can't be trusted or stored (sync spec §6.2); anything else is accepted. */
async function trusted(
  c: pg.ClientBase,
  device: Device,
  s: Setting,
  doc: PushDocument,
): Promise<SaleDocument> {
  if (doc.signature === null) throw new Rejected('unsigned');
  // A document is verified with the key of the device it names (platform spec §3). A device pushes only its own
  // (a re-enrolled PC carrying old ones is not built, owner answer 3), so one well signed by another is wrong_device.
  const named = (doc.payload as { deviceId?: unknown } | null)?.deviceId;
  if (typeof named === 'string' && named !== device.deviceId) {
    const other = await c.query<{ public_key: Buffer }>(
      'SELECT public_key FROM erp.devices WHERE id::text = $1',
      [named],
    );
    const key = other.rows[0]?.public_key;
    const genuine =
      key !== undefined && (await verifyCanonical(toBase64Url(key), doc.payload, doc.signature));
    throw new Rejected(genuine ? 'wrong_device' : 'bad_signature');
  }
  if (!(await verifyCanonical(s.publicKey, doc.payload, doc.signature))) throw new Rejected('bad_signature');
  const parsed = SaleDocumentV1.safeParse(doc.payload);
  if (!parsed.success) throw new Rejected('bad_schema');
  const d = parsed.data as unknown as SaleDocument;
  if (d.id !== doc.id || d.seq !== doc.seq || doc.family !== 'S') throw new Rejected('bad_schema');
  if (d.branchId !== device.branchId) throw new Rejected('wrong_device');

  const users = [d.sellerId, ...d.overrides.flatMap((o) => [o.requestedBy, o.approvedBy])];
  const items = d.lines.map((l) => l.itemId);
  const known = await c.query<{ users: number; items: number; tier: number; customer: number }>(
    `SELECT (SELECT count(*)::int FROM erp.users WHERE id = ANY($1)) AS users,
            (SELECT count(*)::int FROM erp.items WHERE id = ANY($2)) AS items,
            (SELECT count(*)::int FROM erp.price_tiers WHERE id = $3) AS tier,
            (SELECT count(*)::int FROM erp.parties WHERE id = $4) AS customer`,
    [[...new Set(users)], [...new Set(items)], d.tierId, d.customerId],
  );
  const k = known.rows[0]!;
  const methodsKnown = d.payments.every((p) => s.methods.some((m) => m.code === p.method));
  if (
    k.users !== new Set(users).size ||
    k.items !== new Set(items).size ||
    k.tier !== 1 ||
    !methodsKnown ||
    (d.customerId !== null && k.customer !== 1)
  )
    throw new Rejected('unknown_reference');

  const taken = await c.query(
    'SELECT 1 FROM erp.sales_documents WHERE device_id = $1 AND seq = $2 AND id <> $3',
    [device.deviceId, d.seq, d.id],
  );
  if (taken.rowCount !== 0) throw new Rejected('seq_conflict');
  return d;
}

async function grantsOf(c: pg.ClientBase, userIds: string[]): Promise<Record<string, RoleGrant[]>> {
  const { rows } = await c.query<{
    user_id: string;
    permissions: string[];
    limits: RoleLimits;
    branch_id: string | null;
  }>(
    `SELECT ur.user_id, r.permissions, r.limits, ur.branch_id
     FROM erp.user_roles ur JOIN erp.roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
     WHERE ur.user_id = ANY($1) AND ur.deleted_at IS NULL AND r.deleted_at IS NULL`,
    [userIds],
  );
  const out: Record<string, RoleGrant[]> = {};
  for (const r of rows)
    (out[r.user_id] ??= []).push({ permissions: r.permissions, limits: r.limits, branchId: r.branch_id });
  return out;
}

/** Stores an accepted sale with its lines, payments, approvals and exceptions. */
async function accept(
  c: pg.ClientBase,
  device: Device,
  s: Setting,
  d: SaleDocument,
  doc: PushDocument,
  received: Date,
): Promise<PushResult> {
  const grants = await grantsOf(c, [d.sellerId, ...d.overrides.map((o) => o.approvedBy)]);
  const findings = reviewSale(d, {
    deviceCode: device.code,
    timeZone: s.timeZone,
    cutoffHour: s.cutoffHour,
    increment: money(s.increment),
    methods: s.methods,
    grants,
  });
  const credit = await creditFindings(c, device, d, grants);
  const createdAt = Date.parse(d.createdAt);
  const whileRevoked =
    s.lastRevokedAt !== null &&
    createdAt >= s.lastRevokedAt.getTime() &&
    (s.reenabledAt === null || createdAt < s.reenabledAt.getTime());
  const exceptions: { kind: ExceptionKind; details: object }[] = findings.map((f) => ({
    kind: f.kind,
    details: detailsOf(f),
  }));
  // The server's figures, and what the counter saw when it decided (sync spec §6.2).
  for (const { kind, ...figures } of credit)
    exceptions.push({ kind, details: { ...figures, counter: d.credit ?? null } });
  if (whileRevoked) exceptions.push({ kind: 'revoked_device_doc', details: { revokedAt: s.lastRevokedAt } });

  await c.query(
    `INSERT INTO erp.sales_documents (id, tenant_id, branch_id, device_id, number, seq, kind, business_date,
       created_at_device, received_at, salesperson_user_id, customer_party_id, walkin_phone, price_tier_id, subtotal,
       line_discount_total, bill_discount, rounding, tax_total, total, cash_due, handover_status, payload, payload_hash,
       signature, client_version, exception_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
       $24, $25, $26, $27)`,
    [
      d.id,
      device.tenantId,
      d.branchId,
      d.deviceId,
      d.number,
      d.seq,
      d.kind,
      d.businessDate,
      d.createdAt,
      received,
      d.sellerId,
      d.customerId,
      d.walkinPhone,
      d.tierId,
      d.amounts.subtotal,
      d.amounts.lineDiscountTotal,
      d.amounts.billDiscount,
      d.amounts.rounding,
      d.amounts.taxTotal,
      d.amounts.total,
      d.cashDue,
      d.handoverStatus,
      JSON.stringify(doc.payload),
      sha256(doc.payload),
      Buffer.from(fromBase64Url(doc.signature!)),
      d.clientVersion,
      exceptions.length,
    ],
  );
  // Each line says which tax code applied, at 0% for now (ACC-09): the item's own, or the tenant's default.
  const taxCodes = new Map(
    (
      await c.query<{ id: string; tax_code_id: string | null }>(
        'SELECT id, tax_code_id FROM erp.items WHERE id = ANY ($1)',
        [d.lines.map((l) => l.itemId)],
      )
    ).rows.map((r) => [r.id, r.tax_code_id ?? s.defaultTaxCode]),
  );
  const lineIds = new Map<number, string>();
  for (const l of d.lines) {
    const r = await c.query<{ id: string }>(
      `INSERT INTO erp.sales_lines (tenant_id, document_id, line_no, item_id, qty, list_price, unit_price, line_discount,
         bill_share, line_total, floor_price_at_sale, location_id, tax_code_id)
       VALUES ($1, $2, $3, $4, $5::numeric / 1000, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        device.tenantId,
        d.id,
        l.lineNo,
        l.itemId,
        l.qty,
        l.listPrice,
        l.unitPrice,
        l.lineDiscount,
        l.billShare,
        l.lineTotal,
        l.floorPrice,
        s.shopLocation,
        taxCodes.get(l.itemId) ?? null,
      ],
    );
    lineIds.set(l.lineNo, r.rows[0]!.id);
  }
  for (const [i, p] of d.payments.entries())
    await c.query(
      `INSERT INTO erp.sales_payments (tenant_id, document_id, line_no, method_id, amount, cash_received, change_due,
         reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        device.tenantId,
        d.id,
        i + 1,
        s.methods.find((m) => m.code === p.method)!.id,
        p.amount,
        p.cashReceived,
        p.changeDue,
        p.reference,
      ],
    );
  for (const o of d.overrides)
    await c.query(
      `INSERT INTO erp.overrides (tenant_id, document_id, line_id, kind, requested_by_user_id, approved_by_user_id,
         reason_code, note, values, at_device)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        device.tenantId,
        d.id,
        o.lineNo === null ? null : (lineIds.get(o.lineNo) ?? null),
        o.kind,
        o.requestedBy,
        o.approvedBy,
        o.reason,
        o.note,
        JSON.stringify(o.values),
        o.at,
      ],
    );
  for (const e of exceptions)
    await addException(c, device, {
      kind: e.kind,
      documentId: d.id,
      userId: d.sellerId,
      businessDate: d.businessDate,
      details: e.details,
    });
  return {
    id: d.id,
    status: 'accepted',
    exceptions: [...new Set(exceptions.map((e) => e.kind))],
    error: null,
  };
}

/**
 * The credit findings on a sale on account (sync spec §6.2, W1-09): judged with the server's balance (every
 * counter's posted sales) and this device's offline on-account sales to the customer that business day. The posting
 * order lock is taken first, so no other posting moves the balance until this sale is posted after it.
 */
async function creditFindings(
  c: pg.ClientBase,
  device: Device,
  d: SaleDocument,
  grants: Record<string, RoleGrant[]>,
): Promise<CreditFinding[]> {
  if (d.customerId === null || onAccountAmount(d.payments) === 0) return [];
  await holdPostingOrder(c, device.tenantId);
  const { rows } = await c.query<{
    credit_allowed: boolean | null;
    credit_limit: string | null;
    offline_daily_cap: string | null;
    balance: string;
    offline_today: string;
  }>(
    `SELECT a.credit_allowed, a.credit_limit, a.offline_daily_cap,
            coalesce((SELECT balance FROM erp.party_balances WHERE party_id = $1 AND role = 'customer'), 0) AS balance,
            (SELECT coalesce(sum(p.amount), 0)
             FROM erp.sales_documents s
             JOIN erp.sales_payments p ON p.tenant_id = s.tenant_id AND p.document_id = s.id
             JOIN erp.payment_methods m ON m.tenant_id = p.tenant_id AND m.id = p.method_id
             WHERE s.device_id = $2 AND s.customer_party_id = $1 AND s.business_date = $3 AND s.id <> $4
               AND s.status = 'finalized' AND m.code = 'on_account'
               AND (s.payload -> 'credit' ->> 'offline') = 'true') AS offline_today
     FROM (SELECT 1) AS one
     LEFT JOIN erp.customer_accounts a ON a.party_id = $1 AND a.deleted_at IS NULL`,
    [d.customerId, device.deviceId, d.businessDate, d.id],
  );
  const r = rows[0]!;
  const account: CreditAccount | null =
    r.credit_allowed === null
      ? null
      : {
          creditAllowed: r.credit_allowed,
          creditLimit: r.credit_limit === null ? null : money(r.credit_limit),
          offlineDailyCap: money(r.offline_daily_cap!),
        };
  return reviewCredit(d, {
    account,
    balanceBefore: money(r.balance),
    offlineTodayBefore: money(r.offline_today),
    grants,
  });
}

const detailsOf = (f: SaleFinding) =>
  f.kind === 'document_inconsistent'
    ? { code: f.code, lineNo: f.lineNo, problem: f.problem }
    : { lineNo: f.lineNo, discountBp: f.discountBp, cause: f.cause };

async function addException(
  c: pg.ClientBase,
  device: Device,
  e: {
    kind: ExceptionKind;
    documentId: string | null;
    userId: string | null;
    businessDate: string;
    details: object;
  },
) {
  await c.query(
    `INSERT INTO erp.exceptions (tenant_id, kind, severity, document_type, document_id, device_id, user_id,
       business_date, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      device.tenantId,
      e.kind,
      SEVERITY[e.kind] ?? 'medium',
      e.documentId === null ? null : 'sales_document',
      e.documentId,
      device.deviceId,
      e.userId,
      e.businessDate,
      JSON.stringify(e.details),
    ],
  );
}

/**
 * A first arrival of a seq (accepted or rejected): a jump past the highest opens a gap (and a seq_gap exception), a
 * seq inside a gap may close it, and `through` moves up over every seq now present (sync spec §7).
 */
async function advanceSeries(c: pg.ClientBase, device: Device, s: Setting, doc: PushDocument, at: Date) {
  const key = [device.deviceId, doc.family];
  await c.query(
    `INSERT INTO erp.device_series (tenant_id, device_id, family, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [device.tenantId, ...key, at],
  );
  const row = (
    await c.query<{ through: number; max_seq: number }>(
      'SELECT through, max_seq FROM erp.device_series WHERE device_id = $1 AND family = $2 FOR UPDATE',
      key,
    )
  ).rows[0]!;
  if (doc.seq > row.max_seq + 1) {
    await c.query(
      `INSERT INTO erp.sequence_gaps (tenant_id, device_id, family, from_seq, to_seq, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [device.tenantId, ...key, row.max_seq + 1, doc.seq - 1, at],
    );
    await addException(c, device, {
      kind: 'seq_gap',
      documentId: null,
      userId: null,
      businessDate: today(s, at),
      details: { family: doc.family, from: row.max_seq + 1, to: doc.seq - 1 },
    });
  } else if (doc.seq <= row.max_seq) {
    await c.query(
      `UPDATE erp.sequence_gaps g SET resolved_at = $4
       WHERE g.device_id = $1 AND g.family = $2 AND g.resolved_at IS NULL AND $3 BETWEEN g.from_seq AND g.to_seq
         AND (SELECT count(DISTINCT i.seq) FROM erp.sync_inbox i
              WHERE i.device_id = g.device_id AND i.family = g.family AND i.seq BETWEEN g.from_seq AND g.to_seq)
             = g.to_seq - g.from_seq + 1`,
      [...key, doc.seq, at],
    );
  }
  let through = row.through;
  if (doc.seq === through + 1) {
    const after = await c.query<{ seq: number }>(
      'SELECT DISTINCT seq FROM erp.sync_inbox WHERE device_id = $1 AND family = $2 AND seq > $3 ORDER BY seq',
      [...key, through],
    );
    for (const r of after.rows) {
      if (r.seq !== through + 1) break;
      through = r.seq;
    }
  }
  await c.query(
    'UPDATE erp.device_series SET through = $3, max_seq = greatest(max_seq, $4), updated_at = $5 WHERE device_id = $1 AND family = $2',
    [...key, through, doc.seq, at],
  );
}

/**
 * Every family the device has documents in: `through`, and the ranges missing above it. Every number above `through`
 * that never arrived lies in an open gap (a jump opens one), so only those ranges are read: the cost follows the
 * gaps, not the device's history.
 */
async function seriesOf(c: pg.ClientBase, device: Device): Promise<SeriesState[]> {
  const series = await c.query<{ family: SeriesState['family']; through: number }>(
    'SELECT family, through FROM erp.device_series WHERE device_id = $1 ORDER BY family',
    [device.deviceId],
  );
  const gaps = await c.query<{ family: string; from_seq: number; to_seq: number; present: number[] }>(
    `SELECT g.family, g.from_seq, g.to_seq,
       ARRAY(SELECT DISTINCT i.seq FROM erp.sync_inbox i WHERE i.device_id = g.device_id AND i.family = g.family
             AND i.seq BETWEEN g.from_seq AND g.to_seq ORDER BY i.seq) AS present
     FROM erp.sequence_gaps g WHERE g.device_id = $1 AND g.resolved_at IS NULL ORDER BY g.family, g.from_seq`,
    [device.deviceId],
  );
  return series.rows.map((r) => {
    const missing: [number, number][] = [];
    for (const g of gaps.rows.filter((x) => x.family === r.family)) {
      let next = g.from_seq;
      for (const seq of g.present) {
        if (seq > next) missing.push([next, seq - 1]);
        next = seq + 1;
      }
      if (next <= g.to_seq) missing.push([next, g.to_seq]);
    }
    return { family: r.family, through: r.through, missing };
  });
}

/** The counter's audit events (sync spec §5): each with its own id, so a re-send is stored once. */
async function storeEvents(c: pg.ClientBase, device: Device, events: PushEvent[], requestId: string) {
  for (const e of events) {
    const row =
      e.kind === 'bill.reprinted'
        ? { userId: e.userId, entity: 'sales_documents', entityId: e.documentId, after: { number: e.number } }
        : e.kind === 'pin.unlocked_by_manager'
          ? { userId: e.byUserId, entity: 'users', entityId: e.userId, after: null }
          : { userId: e.userId, entity: 'users', entityId: e.userId, after: null };
    await c.query(
      `INSERT INTO erp.audit_log (id, tenant_id, at, user_id, device_id, request_id, action, entity, entity_id, after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
      [
        e.id,
        device.tenantId,
        e.at,
        row.userId,
        device.deviceId,
        requestId,
        e.kind,
        row.entity,
        row.entityId,
        row.after === null ? null : JSON.stringify(row.after),
      ],
    );
  }
  return events.map((e) => e.id);
}

/**
 * The device's health (PLT-09) and, once a day, a clock skew over 5 minutes (architecture §4.4). The counter reports
 * its outbox as it was before sending, so what this push delivered no longer waits, and what it refused now needs
 * attention; with nothing left waiting there is no oldest.
 */
async function recordHealth(
  c: pg.ClientBase,
  device: Device,
  s: Setting,
  body: PushRequest,
  results: readonly PushResult[],
  at: Date,
) {
  const skew = at.getTime() - Date.parse(body.deviceClock);
  const delivered = results.filter((r) => r.status !== 'rejected').length;
  const refused = results.length - delivered;
  const waiting = Math.max(0, body.health.outboxCount - delivered);
  const h = {
    ...body.health,
    outboxCount: waiting,
    oldestUnsyncedAt: waiting === 0 ? null : body.health.oldestUnsyncedAt,
    quarantinedCount: body.health.quarantinedCount + refused,
  };
  await c.query(
    `INSERT INTO erp.device_status (tenant_id, device_id, last_seen_at, last_push_at, client_version, schema_version,
       outbox_count, oldest_unsynced_at, quarantined_count, storage_persisted, storage_usage, storage_quota,
       clock_skew_ms)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tenant_id, device_id) DO UPDATE SET last_seen_at = $3, last_push_at = $3, client_version = $4,
       schema_version = $5, outbox_count = $6, oldest_unsynced_at = $7, quarantined_count = $8,
       storage_persisted = $9, storage_usage = $10, storage_quota = $11, clock_skew_ms = $12`,
    [
      device.tenantId,
      device.deviceId,
      at,
      body.clientVersion,
      body.schemaVersion,
      h.outboxCount,
      h.oldestUnsyncedAt,
      h.quarantinedCount,
      h.storagePersisted,
      h.storageUsage,
      h.storageQuota,
      skew,
    ],
  );
  if (Math.abs(skew) > MAX_SKEW_MS)
    await c.query(
      `INSERT INTO erp.exceptions (tenant_id, kind, severity, device_id, business_date, details)
       VALUES ($1, 'clock_skew', 'low', $2, $3, $4)
       ON CONFLICT (tenant_id, device_id, business_date) WHERE kind = 'clock_skew' DO NOTHING`,
      [device.tenantId, device.deviceId, today(s, at), JSON.stringify({ skewMs: skew })],
    );
}

/** Pull counts as contact too (PLT-09): its time on the device's health. */
export async function recordPull(c: pg.ClientBase, tenantId: string, deviceId: string, at: Date) {
  await c.query(
    `INSERT INTO erp.device_status (tenant_id, device_id, last_seen_at, last_pull_at) VALUES ($1, $2, $3, $3)
     ON CONFLICT (tenant_id, device_id) DO UPDATE SET last_seen_at = $3, last_pull_at = $3`,
    [tenantId, deviceId, at],
  );
}
