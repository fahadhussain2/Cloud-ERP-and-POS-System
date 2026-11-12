import { createHash } from 'node:crypto';

import {
  canonicalJson,
  CashHandoverV1,
  CashMovementV1,
  CashMovementV2,
  CashSessionV1,
  CashSessionV2,
  CustomerCollectionV1,
  fromBase64Url,
  PushRequestSchema,
  SaleDocumentV1,
  SaleDocumentV2,
  SaleVoidV1,
  SaleVoidV2,
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
  cashKnownOf,
  money,
  onAccountAmount,
  qty,
  reviewCredit,
  reviewDeskDocument,
  reviewHandover,
  reviewReturn,
  reviewSale,
  reviewSession,
  reviewVoid,
  reviewVoidCash,
  type CashFinding,
  type CashHandoverDocument,
  type CashMovementDocument,
  type CashSessionDocument,
  type CustomerCollectionDocument,
  type CreditAccount,
  type CreditFinding,
  type DeviceKind,
  type HandoverFinding,
  type ItemPolicy,
  type ReturnDocument,
  type ReturnFinding,
  type ReturnReviewOriginal,
  type PaymentMethodCode,
  type PaymentMethodInfo,
  type RoleGrant,
  type RoleLimits,
  type SaleDocument,
  type SaleFinding,
  type SaleVoidDocument,
  type VoidCashFinding,
  type VoidFinding,
} from '@erp/domain';
import {
  holdPostingOrder,
  postDocument,
  waitingReturns,
  type PostOutcome,
  type SourceType,
} from '@erp/posting';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

// Push (sync spec §6.2–§7, SYN-02, SYN-03, SYN-05, PLT-09, W1-07). Each document in its own transaction: claim its id
// in sync_inbox → check it can be trusted and stored (else rejected, kept for a retry) → re-check the rules with
// reviewSale (and a sale on account with reviewCredit, W1-09) and store it with its exceptions (never refused on
// business rules, D-011) → the device's series and gaps. Then the audit events and the device's health. An accepted
// sale is posted in its own transaction (W1-08, architecture §5.2 step 4); one that can't be posted is still accepted
// and flagged `posting_failed`. A cash desk also pushes its handovers (H) and its sessions' open and close (Z, W1-10):
// a handover is linked to its bill by number, now or when the bill arrives, reviewed with reviewHandover and posted.
// From W1-11 it also pushes collections (R) and cash movements (M), and closes with a count (CashSessionV2): each is
// reviewed (reviewDeskDocument, reviewSession), stored and posted like a handover. From W1-12 any device pushes its
// voids (V): linked to the bill by number, now or when the bill arrives, reviewed with reviewVoid, the bill marked
// voided, and the bill's posting reversed once the bill has posted.

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireDevice: preHandlerAsyncHookHandler;
}

interface Device {
  tenantId: string;
  deviceId: string;
  code: string;
  kind: DeviceKind;
  branchId: string;
}

/** A pushed document that can be trusted and stored, by family. */
type Trusted =
  | { family: 'S'; doc: SaleDocument | ReturnDocument }
  | { family: 'H'; doc: CashHandoverDocument }
  | { family: 'R'; doc: CustomerCollectionDocument }
  | { family: 'M'; doc: CashMovementDocument }
  | { family: 'Z'; doc: CashSessionDocument }
  | { family: 'V'; doc: SaleVoidDocument };

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
  /** Where a defective returned line goes (W1-13, D-008); SHOP when the branch has none. */
  damagedLocation: string | null;
  /** The tenant's return window (W1-13, PRD Q3). */
  returnWindowDays: number;
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
  handover_amount_mismatch: 'medium',
  duplicate_handover: 'medium',
  float_mismatch: 'medium',
  seq_gap: 'medium',
  handover_not_permitted: 'low',
  cash_not_permitted: 'low',
  clock_skew: 'low',
  // Cash in the drawer for a voided bill is a possible leak (D-059).
  cash_received_for_void: 'high',
  void_not_permitted: 'medium',
  duplicate_void: 'medium',
  // Returns (W1-13): goods that may not exist came back, or a refund nobody could check.
  return_over_quantity: 'high',
  return_original_invalid: 'medium',
  return_price_mismatch: 'medium',
  return_not_permitted: 'medium',
  // W1-23 (D-111): a refund paid before its bill's cash came in, and cash given back for a voided bill that looks wrong.
  refund_before_payment: 'high',
  void_cash_duplicate: 'high',
  void_cash_without_handover: 'high',
  void_cash_not_voided: 'medium',
  void_cash_amount_mismatch: 'medium',
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
    const device: Device = {
      tenantId: d.tenantId,
      deviceId: d.deviceId,
      code: d.code,
      kind: d.kind,
      branchId: d.branchId,
    };
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
  const t = await c.query<{
    timezone: string;
    day_cutoff_hour: number;
    cash_rounding_increment: string;
    return_window_days: number;
  }>('SELECT timezone, day_cutoff_hour, cash_rounding_increment, return_window_days FROM erp.tenants');
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
  const damaged = await c.query<{ id: string }>(
    `SELECT id FROM erp.locations WHERE branch_id = $1 AND kind = 'damaged' AND deleted_at IS NULL
     ORDER BY code LIMIT 1`,
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
    damagedLocation: damaged.rows[0]?.id ?? shop.rows[0]?.id ?? null,
    returnWindowDays: t.rows[0]!.return_window_days,
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
    const t = await trusted(c, device, s, doc);
    let post: SourceType | null = null;
    /** Voids that were waiting for this bill: posted after it (W1-12). */
    let voids: string[] = [];
    /** Returns that were waiting for this bill to post: posted after it (W1-13). */
    let returns: string[] = [];
    if (t.family === 'S') {
      const stored = await accept(c, device, s, t.doc, doc, received);
      result = stored.result;
      voids = stored.voids;
      // A return posts once the bill it returns has (it comes back at that bill's costs).
      if (stored.originalPosted) post = 'sale';
    } else if (t.family === 'V') {
      const stored = await acceptVoid(c, device, t.doc, doc, received);
      result = stored.result;
      if (stored.post) post = 'sales_void';
    } else if (t.family === 'H') {
      const stored = await acceptHandover(c, device, t.doc, doc, received);
      result = stored.result;
      // A duplicate is kept for review and never posted (it would count the cash twice).
      if (!stored.duplicate) post = 'cash_handover';
    } else if (t.family === 'R') {
      result = await acceptCollection(c, device, t.doc, doc, received);
      post = 'payment';
    } else if (t.family === 'M') {
      const stored = await acceptMovement(c, device, t.doc, doc, received);
      result = stored.result;
      // A second give-back of a bill is kept for review and never posted (W1-23).
      if (!stored.duplicate) post = 'cash_movement';
    } else {
      result = await acceptSession(c, device, t.doc, doc);
      // The open posts a float other than what stayed; the close its variance and what went to the safe.
      post = 'cash_session';
    }
    if (post !== null) {
      const started = performance.now();
      posting = await postDocument(c, { tenantId: device.tenantId, type: post, id: doc.id, now: received });
      // A void can only swap a posted bill: one whose bill failed to post waits for the catch-up.
      if (posting.status === 'posted') {
        for (const id of voids)
          await postDocument(c, { tenantId: device.tenantId, type: 'sales_void', id, now: received });
        if (post === 'sale') returns = await waitingReturns(c, doc.id);
        for (const id of returns)
          await postDocument(c, { tenantId: device.tenantId, type: 'sale', id, now: received });
      }
      postingMs = Math.round(performance.now() - started);
    }
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
async function trusted(c: pg.ClientBase, device: Device, s: Setting, doc: PushDocument): Promise<Trusted> {
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
  if (doc.family === 'H') return { family: 'H', doc: await trustedHandover(c, device, doc) };
  if (doc.family === 'Z') return { family: 'Z', doc: await trustedSession(c, device, doc) };
  if (doc.family === 'R') return { family: 'R', doc: await trustedCollection(c, device, s, doc) };
  if (doc.family === 'M') return { family: 'M', doc: await trustedMovement(c, device, doc) };
  if (doc.family === 'V') return { family: 'V', doc: await trustedVoid(c, device, doc) };
  // A return or exchange is version 2 (W1-13); a plain sale stays version 1.
  const version = (doc.payload as { version?: unknown } | null)?.version;
  const parsed = (version === 2 ? SaleDocumentV2 : SaleDocumentV1).safeParse(doc.payload);
  if (!parsed.success) throw new Rejected('bad_schema');
  const d = parsed.data as unknown as SaleDocument | ReturnDocument;
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
  return { family: 'S', doc: d };
}

/** The same id, seq and family as its outbox row, from this device and branch: else refused like a sale. */
function sameRow(
  d: { id: string; seq: number; deviceId: string; branchId: string },
  doc: PushDocument,
  device: Device,
) {
  if (d.id !== doc.id || d.seq !== doc.seq) throw new Rejected('bad_schema');
  // Only a cash desk keeps a drawer (W1-10); its documents name it and its branch.
  if (device.kind !== 'cash_desk' || d.deviceId !== device.deviceId || d.branchId !== device.branchId)
    throw new Rejected('wrong_device');
}

/** Another accepted document already holds this device's seq in the family. */
async function seqTaken(c: pg.ClientBase, device: Device, doc: PushDocument) {
  const taken = await c.query(
    `SELECT 1 FROM erp.sync_inbox WHERE device_id = $1 AND family = $2 AND seq = $3 AND document_id <> $4
       AND status = 'accepted'`,
    [device.deviceId, doc.family, doc.seq, doc.id],
  );
  if (taken.rowCount !== 0) throw new Rejected('seq_conflict');
}

async function trustedHandover(c: pg.ClientBase, device: Device, doc: PushDocument) {
  const parsed = CashHandoverV1.safeParse(doc.payload);
  if (!parsed.success) throw new Rejected('bad_schema');
  const h = parsed.data as unknown as CashHandoverDocument;
  sameRow(h, doc, device);
  // The bill isn't checked: a handover is linked by its bill's number (data model §6), now or when the bill arrives,
  // and the desk's own sale is pushed after its automatic handover (the outbox goes by family). Only the cashier must
  // be this tenant's (RLS keeps other tenants' out).
  const known = await c.query('SELECT 1 FROM erp.users WHERE id = $1', [h.cashierId]);
  if (known.rowCount !== 1) throw new Rejected('unknown_reference');
  await seqTaken(c, device, doc);
  return h;
}

/** A W1-10 close (no count) reads as version 1 with the counted fields empty. */
const V1_FIELDS = {
  floatExpected: null,
  countedCash: null,
  denominations: null,
  variance: null,
  varianceReason: null,
  varianceNote: null,
  acknowledgedByUserId: null,
  leftInDrawer: null,
};

async function trustedSession(c: pg.ClientBase, device: Device, doc: PushDocument) {
  const v2 = CashSessionV2.safeParse(doc.payload);
  const v1 = v2.success ? null : CashSessionV1.safeParse(doc.payload);
  let z: CashSessionDocument;
  if (v2.success) z = v2.data as unknown as CashSessionDocument;
  else if (v1?.success) z = { ...(v1.data as unknown as CashSessionDocument), ...V1_FIELDS };
  else throw new Rejected('bad_schema');
  sameRow(z, doc, device);
  const known = await c.query<{ users: number; session: number }>(
    `SELECT (SELECT count(*)::int FROM erp.users WHERE id = $1) AS users,
            (SELECT count(*)::int FROM erp.cash_sessions WHERE id = $2 AND device_id = $3) AS session`,
    [z.userId, z.sessionId, device.deviceId],
  );
  const k = known.rows[0]!;
  // A close names this desk's session; the desk pushes the open first (its outbox is in creation order).
  if (k.users !== 1 || (z.event === 'close' && k.session !== 1)) throw new Rejected('unknown_reference');
  await seqTaken(c, device, doc);
  return z;
}

/** A collection (W1-11): the cashier and the method must be this tenant's; the customer is checked by posting. */
async function trustedCollection(c: pg.ClientBase, device: Device, s: Setting, doc: PushDocument) {
  const parsed = CustomerCollectionV1.safeParse(doc.payload);
  if (!parsed.success) throw new Rejected('bad_schema');
  const r = parsed.data as unknown as CustomerCollectionDocument;
  sameRow(r, doc, device);
  const known = await c.query('SELECT 1 FROM erp.users WHERE id = $1', [r.cashierId]);
  if (known.rowCount !== 1 || !s.methods.some((m) => m.id === r.methodId))
    throw new Rejected('unknown_reference');
  await seqTaken(c, device, doc);
  return r;
}

/**
 * A cash movement (W1-11; V2, W1-23: cash given back for a voided bill): the cashier, and a give-back's approver, must
 * be this tenant's; its category, supplier or bank is checked by posting.
 */
async function trustedMovement(c: pg.ClientBase, device: Device, doc: PushDocument) {
  const version = (doc.payload as { version?: unknown }).version;
  const parsed = (version === 2 ? CashMovementV2 : CashMovementV1).safeParse(doc.payload);
  if (!parsed.success) throw new Rejected('bad_schema');
  const m = parsed.data as unknown as CashMovementDocument;
  sameRow(m, doc, device);
  const users = [
    ...new Set([m.cashierId, ...(m.approvedByUserId === undefined ? [] : [m.approvedByUserId])]),
  ];
  const known = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM erp.users WHERE id = ANY($1)', [
    users,
  ]);
  if (known.rows[0]!.n !== users.length) throw new Rejected('unknown_reference');
  await seqTaken(c, device, doc);
  return m;
}

/**
 * A void (W1-12): from any kind of device, but only of its own bill (owner answer 2): the bill's number carries the
 * device's code. The bill itself isn't checked: it is linked by number, now or when it arrives. The voider and the
 * approver must be this tenant's.
 */
async function trustedVoid(c: pg.ClientBase, device: Device, doc: PushDocument) {
  // V2 (W1-23) adds the payment checks; a W1-12 counter still sends V1.
  const version = (doc.payload as { version?: unknown }).version;
  const parsed = (version === 2 ? SaleVoidV2 : SaleVoidV1).safeParse(doc.payload);
  if (!parsed.success) throw new Rejected('bad_schema');
  const v = parsed.data as unknown as SaleVoidDocument;
  if (v.id !== doc.id || v.seq !== doc.seq) throw new Rejected('bad_schema');
  if (
    v.deviceId !== device.deviceId ||
    v.branchId !== device.branchId ||
    !v.saleNumber.startsWith(`${device.code}-S`)
  )
    throw new Rejected('wrong_device');
  const users = [...new Set([v.userId, v.approvedBy])];
  const known = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM erp.users WHERE id = ANY($1)', [
    users,
  ]);
  if (known.rows[0]!.n !== users.length) throw new Rejected('unknown_reference');
  await seqTaken(c, device, doc);
  return v;
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
  d: SaleDocument | ReturnDocument,
  doc: PushDocument,
  received: Date,
): Promise<{ result: PushResult; voids: string[]; originalPosted: boolean }> {
  // First, before the posting order lock a sale on account takes: the same order as a handover's and a void's push.
  await holdBill(c, d.number);
  // A return also holds its original bill, so returns of one line are judged one after the other (W1-13).
  const ret = d.version === 2 ? await returnReview(c, s, d) : null;
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
  for (const f of ret?.findings ?? []) {
    const { kind, ...details } = f;
    exceptions.push({ kind, details });
  }
  const cash = d.payments.find((p) => p.method === 'cash');
  const returnOf = d.version === 2 ? (d.returnOf ?? null) : null;
  const noReceipt = d.version === 2 && d.noReceipt !== undefined;

  await c.query(
    `INSERT INTO erp.sales_documents (id, tenant_id, branch_id, device_id, number, seq, kind, business_date,
       created_at_device, received_at, salesperson_user_id, customer_party_id, walkin_phone, price_tier_id, subtotal,
       line_discount_total, bill_discount, rounding, tax_total, total, cash_due, handover_status, payload, payload_hash,
       signature, client_version, exception_count, cash_received, change_due, reissue_of_id, reissue_of_number,
       return_of_id, return_of_number, no_receipt, no_receipt_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
       $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35)`,
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
      // What the cash desk's queue shows (W1-10): the salesman's cash received and the change.
      cash?.cashReceived ?? null,
      cash?.changeDue ?? null,
      // The voided bill this one reissues (W1-12), as the counter named it.
      d.version === 1 ? (d.reissueOf?.id ?? null) : null,
      d.version === 1 ? (d.reissueOf?.number ?? null) : null,
      // The bill this return is of, or none (W1-13).
      returnOf?.id ?? null,
      returnOf?.number ?? null,
      noReceipt,
      d.version === 2 ? (d.noReceipt?.ref ?? null) : null,
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
         bill_share, line_total, floor_price_at_sale, location_id, tax_code_id, original_line_id, return_reason_code,
         return_condition, return_note)
       VALUES ($1, $2, $3, $4, $5::numeric / 1000, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id`,
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
        // A defective returned line goes to Damaged (D-008); everything else is in the Shop.
        'returnOf' in l && l.condition === 'defective' ? s.damagedLocation : s.shopLocation,
        taxCodes.get(l.itemId) ?? null,
        'returnOf' in l ? (ret?.links.get(l.lineNo) ?? null) : null,
        'returnOf' in l ? l.reason : null,
        'returnOf' in l ? l.condition : null,
        'returnOf' in l ? l.note : null,
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
  await linkWaitingHandovers(c, device.tenantId, d);
  const voids = await linkWaitingVoids(c, device, d);
  return {
    result: {
      id: d.id,
      status: 'accepted',
      exceptions: [...new Set(exceptions.map((e) => e.kind))],
      error: null,
    },
    voids,
    originalPosted: ret?.originalPosted ?? true,
  };
}

/**
 * A return's review against its original bill as the server holds it (W1-13, sync spec §6.2): the original's lines
 * with what other returns took of each, the categories' return policies, the roles. Holds the original's per-bill lock
 * first. `links` gives each returned line the original line to store (only one that is that item and not itself a
 * return), and `originalPosted` says whether the return can post now.
 */
async function returnReview(
  c: pg.ClientBase,
  s: Setting,
  d: ReturnDocument,
): Promise<{ findings: ReturnFinding[]; links: Map<number, string>; originalPosted: boolean }> {
  if (d.returnOf !== undefined) await holdBill(c, d.returnOf.number);
  let original: ReturnReviewOriginal | null = null;
  const lineIds = new Map<number, string>();
  let originalPosted = true;
  if (d.returnOf !== undefined) {
    const doc = await c.query<{
      status: 'finalized' | 'voided';
      business_date: string;
      number: string;
      posted: boolean;
    }>(
      `SELECT status, business_date::text, number,
         EXISTS (SELECT 1 FROM erp.postings p WHERE p.source_type = 'sale' AND p.source_id = d.id) AS posted
       FROM erp.sales_documents d WHERE id = $1`,
      [d.returnOf.id],
    );
    const o = doc.rows[0];
    if (o) {
      originalPosted = o.posted;
      const lines = await c.query<{
        id: string;
        line_no: number;
        item_id: string;
        qty: string;
        line_total: string;
        returned_qty: string;
        returned_refund: string;
      }>(
        `SELECT l.id, l.line_no, l.item_id, (l.qty * 1000)::bigint AS qty, l.line_total,
           coalesce((SELECT -sum(r.qty * 1000)::bigint FROM erp.sales_lines r WHERE r.original_line_id = l.id), 0)
             AS returned_qty,
           coalesce((SELECT -sum(r.line_total) FROM erp.sales_lines r WHERE r.original_line_id = l.id), 0)
             AS returned_refund
         FROM erp.sales_lines l WHERE l.document_id = $1 ORDER BY l.line_no`,
        [d.returnOf.id],
      );
      original = {
        id: d.returnOf.id,
        number: o.number,
        status: o.status,
        businessDate: o.business_date,
        lines: lines.rows.map((l) => ({
          lineNo: l.line_no,
          itemId: l.item_id,
          qty: qty(Number(l.qty)),
          lineTotal: money(l.line_total),
          returned: { qty: qty(Number(l.returned_qty)), refund: money(l.returned_refund) },
          isReturn: Number(l.qty) < 0,
        })),
      };
      for (const l of lines.rows) lineIds.set(l.line_no, l.id);
    }
  }
  const items = await c.query<{ id: string; return_policy: ItemPolicy | null }>(
    `SELECT i.id, c.return_policy FROM erp.items i LEFT JOIN erp.categories c ON c.id = i.category_id
     WHERE i.id = ANY($1)`,
    [d.lines.map((l) => l.itemId)],
  );
  const grants = await grantsOf(c, [d.sellerId, ...d.overrides.map((o) => o.approvedBy)]);
  const findings = reviewReturn(d, {
    original,
    windowDays: s.returnWindowDays,
    items: Object.fromEntries(items.rows.map((r) => [r.id, r.return_policy ?? {}])),
    grants,
  });
  // A returned line is linked to its original only when that is the same item and a sold line: its cost comes back.
  const links = new Map<number, string>();
  for (const l of d.lines)
    if ('returnOf' in l && l.returnOf !== null && original !== null) {
      const sold = original.lines.find((x) => x.lineNo === l.returnOf!.lineNo);
      const id = lineIds.get(l.returnOf.lineNo);
      if (sold && id && sold.itemId === l.itemId && !sold.isReturn) links.set(l.lineNo, id);
    }
  return { findings, links, originalPosted: originalPosted || links.size === 0 };
}

/**
 * Voids that arrived before their bill (W1-12): linked now, and the bill marked voided. They were reviewed at their
 * own arrival against the bill number and the document's dates, so nothing new is found. Returns the ones to post.
 */
async function linkWaitingVoids(
  c: pg.ClientBase,
  device: Device,
  bill: SaleDocument | ReturnDocument,
): Promise<string[]> {
  const { rows } = await c.query<{ id: string; payload: SaleVoidDocument; duplicate_of_id: string | null }>(
    `SELECT id, payload, duplicate_of_id FROM erp.sales_voids
     WHERE sale_number = $1 AND sale_document_id IS NULL ORDER BY received_at, id`,
    [bill.number],
  );
  const toPost: string[] = [];
  for (const v of rows) {
    await c.query('UPDATE erp.sales_voids SET sale_document_id = $2 WHERE id = $1', [v.id, bill.id]);
    if (v.duplicate_of_id !== null) continue;
    await markVoided(c, device, bill.id, v.payload);
    toPost.push(v.id);
  }
  return toPost;
}

/**
 * The bill becomes voided (workflow fields, audited by the table's trigger and as `sale.voided`), and the approval is
 * kept as an override of kind `void` on it, so the overrides report sees it (data model §5).
 */
async function markVoided(c: pg.ClientBase, device: Device, billId: string, v: SaleVoidDocument) {
  await c.query(
    `UPDATE erp.sales_documents SET status = 'voided', void_document_id = $2, void_reason_code = $3, voided_at = $4,
       voided_by_user_id = $5, void_approved_by_user_id = $6, void_number = $7
     WHERE id = $1 AND status = 'finalized'`,
    [billId, v.id, v.reason, v.createdAt, v.userId, v.approvedBy, v.number],
  );
  await c.query(
    `INSERT INTO erp.overrides (tenant_id, document_id, line_id, kind, requested_by_user_id, approved_by_user_id,
       reason_code, note, values, at_device)
     VALUES ($1, $2, NULL, 'void', $3, $4, $5, $6, $7, $8)`,
    [
      device.tenantId,
      billId,
      v.userId,
      v.approvedBy,
      v.reason,
      v.note,
      JSON.stringify({
        voidNumber: v.number,
        total: v.saleTotal,
        cashDue: v.saleCashDue,
        seen: v.handoverSeen,
      }),
      v.createdAt,
    ],
  );
  await c.query(
    `INSERT INTO erp.audit_log (tenant_id, at, user_id, device_id, action, entity, entity_id, after)
     VALUES ($1, $2, $3, $4, 'sale.voided', 'sales_documents', $5, $6)`,
    [
      device.tenantId,
      v.createdAt,
      v.approvedBy,
      v.deviceId,
      billId,
      JSON.stringify({ number: v.saleNumber, void: v.number, voidedBy: v.userId, reason: v.reason }),
    ],
  );
}

/**
 * Stores a pushed void (W1-12) with its findings: linked to its bill when the bill is here (and the bill marked
 * voided), else waiting for it by number. A second void of the bill is kept as a duplicate and never posted. Says
 * whether to post it now: only a linked first void of a bill that has posted.
 */
async function acceptVoid(
  c: pg.ClientBase,
  device: Device,
  v: SaleVoidDocument,
  doc: PushDocument,
  received: Date,
): Promise<{ result: PushResult; post: boolean }> {
  await holdBill(c, v.saleNumber);
  const bill = (
    await c.query<{ id: string; business_date: string; cash_due: string; posted: boolean }>(
      `SELECT d.id, d.business_date::text, d.cash_due,
         EXISTS (SELECT 1 FROM erp.postings p WHERE p.source_type = 'sale' AND p.source_id = d.id) AS posted
       FROM erp.sales_documents d WHERE d.number = $1 ORDER BY d.received_at, d.id LIMIT 1`,
      [v.saleNumber],
    )
  ).rows[0];
  const existing = (
    await c.query<{ id: string; number: string }>(
      `SELECT id, number FROM erp.sales_voids
       WHERE sale_number = $1 AND duplicate_of_id IS NULL AND id <> $2 FOR UPDATE`,
      [v.saleNumber, v.id],
    )
  ).rows[0];
  // Any handover in of the number, an offline scan whose bill hasn't arrived included.
  const handover = (
    await c.query<{ id: string; number: string; at_device: Date }>(
      `SELECT id, number, at_device FROM erp.cash_handovers
       WHERE bill_number = $1 AND kind = 'in' AND duplicate_of_id IS NULL ORDER BY at_device LIMIT 1`,
      [v.saleNumber],
    )
  ).rows[0];
  const grants = await grantsOf(c, [v.approvedBy]);
  const findings = reviewVoid(v, {
    bill: bill ? { id: bill.id, businessDate: bill.business_date, cashDue: money(bill.cash_due) } : null,
    handover: handover
      ? { id: handover.id, number: handover.number, at: handover.at_device.toISOString() }
      : null,
    existing: existing ?? null,
    grants: grants[v.approvedBy] ?? [],
    branchId: v.branchId,
  });
  await c.query(
    `INSERT INTO erp.sales_voids (id, tenant_id, branch_id, device_id, number, seq, sale_document_id, sale_number,
       voided_by_user_id, approved_by_user_id, reason_code, note, handover_seen, at_device, business_date, received_at,
       duplicate_of_id, payload, payload_hash, signature, client_version, exception_count, payment_checks)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
       $23)`,
    [
      v.id,
      device.tenantId,
      v.branchId,
      v.deviceId,
      v.number,
      v.seq,
      bill?.id ?? null,
      v.saleNumber,
      v.userId,
      v.approvedBy,
      v.reason,
      v.note,
      v.handoverSeen,
      v.createdAt,
      v.businessDate,
      received,
      existing?.id ?? null,
      JSON.stringify(doc.payload),
      sha256(doc.payload),
      Buffer.from(fromBase64Url(doc.signature!)),
      v.clientVersion,
      findings.length,
      v.paymentChecks === undefined ? null : JSON.stringify(v.paymentChecks),
    ],
  );
  const duplicate = existing !== undefined;
  if (bill && !duplicate) await markVoided(c, device, bill.id, v);
  for (const f of findings) await addVoidException(c, device, v, f);
  return {
    result: {
      id: v.id,
      status: 'accepted',
      exceptions: [...new Set(findings.map((f) => f.kind))],
      error: null,
    },
    post: bill !== undefined && bill.posted && !duplicate,
  };
}

/** One exception on a void, with its figures (sync spec §6.2). */
async function addVoidException(c: pg.ClientBase, device: Device, v: SaleVoidDocument, f: VoidFinding) {
  const { kind, ...details } = f;
  await addException(c, device, {
    kind,
    documentType: 'sales_void',
    documentId: v.id,
    userId: v.userId,
    businessDate: v.businessDate,
    details: { ...details, billNumber: v.saleNumber, voidNumber: v.number, approvedBy: v.approvedBy },
  });
}

/**
 * A bill's cash and its handovers are judged one transaction at a time: a desk's scan and the counter's bill often
 * arrive together (both reconnect), and each looks for the other. Held until the transaction ends; the tenant is in
 * the key because a bill number is unique only within a tenant. Taken before any other lock, by both paths.
 */
async function holdBill(c: pg.ClientBase, billNumber: string) {
  await c.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('erp.bill:' || current_setting('app.tenant_id') || ':' || $1, 0))`,
    [billNumber],
  );
}

/** The bill's new status once a handover of the right direction is linked to it (data model §5). */
function settledStatus(h: { kind: 'in' | 'payout' }, cashDue: number): 'received' | 'paid_out' | null {
  if (h.kind === 'in' && cashDue > 0) return 'received';
  if (h.kind === 'payout' && cashDue < 0) return 'paid_out';
  return null;
}

/**
 * Handovers the desk recorded from the bill's code before the bill arrived (an offline scan, PRD W4): linked now, the
 * bill marked received, and the amount compared (D-059). They were posted at their own arrival.
 */
async function linkWaitingHandovers(c: pg.ClientBase, tenantId: string, bill: SaleDocument | ReturnDocument) {
  const { rows } = await c.query<{
    id: string;
    device_id: string;
    payload: CashHandoverDocument;
    duplicate_of_id: string | null;
  }>(
    `SELECT id, device_id, payload, duplicate_of_id FROM erp.cash_handovers
     WHERE bill_number = $1 AND sales_document_id IS NULL ORDER BY received_at, id`,
    [bill.number],
  );
  for (const h of rows) {
    await c.query('UPDATE erp.cash_handovers SET sales_document_id = $2 WHERE id = $1', [h.id, bill.id]);
    if (h.duplicate_of_id !== null) continue;
    const status = settledStatus(h.payload, bill.cashDue);
    if (status !== null)
      await c.query(
        `UPDATE erp.sales_documents SET handover_status = $2 WHERE id = $1 AND handover_status = 'pending'`,
        [bill.id, status],
      );
    // Only the amount and a return's original are new now: the permission was judged when the handover arrived.
    const returnOf = bill.version === 2 ? (bill.returnOf ?? null) : null;
    const originalPending =
      returnOf === null
        ? false
        : (
            await c.query<{ pending: boolean }>(
              `SELECT cash_due > 0 AND handover_status = 'pending' AND status = 'finalized' AS pending
               FROM erp.sales_documents WHERE number = $1 ORDER BY received_at, id LIMIT 1`,
              [returnOf.number],
            )
          ).rows[0]?.pending === true;
    const mismatch = reviewHandover(h.payload, {
      bill: {
        id: bill.id,
        cashDue: money(bill.cashDue),
        returnOf: returnOf === null ? null : { number: returnOf.number, pending: originalPending },
      },
      existing: null,
      grants: [],
      branchId: bill.branchId,
    }).filter((f) => f.kind === 'handover_amount_mismatch' || f.kind === 'refund_before_payment');
    for (const f of mismatch)
      await addHandoverException(c, { tenantId, deviceId: h.device_id }, h.payload, f);
  }
}

/**
 * Stores a pushed handover (data model §6) with its findings: linked to its bill when the bill is here (and the bill
 * marked received or paid out), else waiting for it by number. A second one for the bill is kept as a duplicate.
 */
async function acceptHandover(
  c: pg.ClientBase,
  device: Device,
  h: CashHandoverDocument,
  doc: PushDocument,
  received: Date,
): Promise<{ result: PushResult; duplicate: boolean }> {
  await holdBill(c, h.billNumber);
  const bill = (
    await c.query<{
      id: string;
      cash_due: string;
      void_id: string | null;
      void_number: string | null;
      voided_at: Date | null;
      void_payload: SaleVoidDocument | null;
      return_of_number: string | null;
      original_pending: boolean | null;
    }>(
      `SELECT d.id, d.cash_due, v.id AS void_id, v.number AS void_number, d.voided_at, v.payload AS void_payload,
         d.return_of_number,
         (SELECT o.cash_due > 0 AND o.handover_status = 'pending' AND o.status = 'finalized'
          FROM erp.sales_documents o WHERE o.number = d.return_of_number
          ORDER BY o.received_at, o.id LIMIT 1) AS original_pending
       FROM erp.sales_documents d LEFT JOIN erp.sales_voids v ON v.id = d.void_document_id
       WHERE d.number = $1 ORDER BY d.received_at, d.id LIMIT 1`,
      [h.billNumber],
    )
  ).rows[0];
  // The row lock makes a second desk's handover of the bill wait for the first one's transaction.
  const existing = (
    await c.query<{ id: string; number: string }>(
      `SELECT id, number FROM erp.cash_handovers
       WHERE bill_number = $1 AND kind = $2 AND duplicate_of_id IS NULL AND id <> $3 FOR UPDATE`,
      [h.billNumber, h.kind, h.id],
    )
  ).rows[0];
  const grants = await grantsOf(c, [h.cashierId]);
  const findings = reviewHandover(h, {
    bill: bill
      ? {
          id: bill.id,
          cashDue: money(bill.cash_due),
          // A voided bill (W1-12): cash for it is a finding (D-059), with how the counter knew (W1-23).
          voided:
            bill.void_id === null
              ? null
              : {
                  id: bill.void_id,
                  number: bill.void_number!,
                  at: bill.voided_at!.toISOString(),
                  cashKnown: bill.void_payload === null ? null : cashKnownOf(bill.void_payload),
                },
          // A return's refund before its bill's cash came in (W1-23, guard 2).
          returnOf:
            bill.return_of_number === null
              ? null
              : { number: bill.return_of_number, pending: bill.original_pending === true },
        }
      : null,
    existing: existing ?? null,
    grants: grants[h.cashierId] ?? [],
    branchId: h.branchId,
  });
  await c.query(
    `INSERT INTO erp.cash_handovers (id, tenant_id, branch_id, device_id, number, seq, session_id, sales_document_id,
       bill_number, kind, amount, received_amount, change_given, corrected_from, method, cashier_user_id, at_device,
       business_date, received_at, duplicate_of_id, payload, payload_hash, signature, client_version, exception_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
       $24, $25)`,
    [
      h.id,
      device.tenantId,
      h.branchId,
      h.deviceId,
      h.number,
      h.seq,
      h.sessionId,
      bill?.id ?? null,
      h.billNumber,
      h.kind,
      h.amount,
      h.cashReceived,
      h.changeGiven,
      h.correctedFrom,
      h.method,
      h.cashierId,
      h.createdAt,
      h.businessDate,
      received,
      existing?.id ?? null,
      JSON.stringify(doc.payload),
      sha256(doc.payload),
      Buffer.from(fromBase64Url(doc.signature!)),
      h.clientVersion,
      findings.length,
    ],
  );
  const duplicate = existing !== undefined;
  if (bill && !duplicate) {
    const status = settledStatus(h, Number(bill.cash_due));
    if (status !== null)
      await c.query(
        `UPDATE erp.sales_documents SET handover_status = $2 WHERE id = $1 AND handover_status = 'pending'`,
        [bill.id, status],
      );
  }
  for (const f of findings) await addHandoverException(c, device, h, f);
  // The bill's cash came in: a refund of a return of it paid out earlier is settled (W1-23, guard 2).
  if (h.kind === 'in' && !duplicate)
    await settleExceptions(c, device, {
      kind: 'refund_before_payment',
      key: 'originalNumber',
      value: h.billNumber,
      note: `Bill paid on ${h.number}`,
      userId: h.cashierId,
      at: received,
    });
  return {
    result: {
      id: h.id,
      status: 'accepted',
      exceptions: [...new Set(findings.map((f) => f.kind))],
      error: null,
    },
    duplicate,
  };
}

/** One exception on a handover, with its figures (sync spec §6.2). */
async function addHandoverException(
  c: pg.ClientBase,
  device: Pick<Device, 'tenantId' | 'deviceId'>,
  h: CashHandoverDocument,
  f: HandoverFinding,
) {
  const { kind, ...details } = f;
  await addException(c, device, {
    kind,
    documentType: 'cash_handover',
    documentId: h.id,
    userId: h.cashierId,
    businessDate: h.businessDate,
    details: { ...details, billNumber: h.billNumber, handoverNumber: h.number },
  });
}

/**
 * A session's open creates its row; its close sets the close fields and the count (data model §6, W1-11). Reviewed
 * with reviewSession: an acknowledgement the server says isn't allowed is not stored, so the variance waits for a
 * manager on the day reconciliation (owner answer 1), and the finding says why.
 */
async function acceptSession(
  c: pg.ClientBase,
  device: Device,
  z: CashSessionDocument,
  doc: PushDocument,
): Promise<PushResult> {
  const signature = Buffer.from(fromBase64Url(doc.signature!));
  const sessionCashier =
    z.event === 'open'
      ? z.userId
      : ((
          await c.query<{ cashier_user_id: string }>(
            'SELECT cashier_user_id FROM erp.cash_sessions WHERE id = $1',
            [z.sessionId],
          )
        ).rows[0]?.cashier_user_id ?? null);
  const people = [z.userId, ...(z.acknowledgedByUserId === null ? [] : [z.acknowledgedByUserId])];
  const grants = await grantsOf(c, people);
  const findings = reviewSession(z, {
    grantsOf: (id) => grants[id] ?? [],
    sessionCashierId: sessionCashier,
    branchId: z.branchId,
  });
  const ackRefused = findings.some(
    (f) =>
      f.kind === 'cash_not_permitted' &&
      f.userId === z.acknowledgedByUserId &&
      f.permission === 'cash.variance.approve',
  );
  const acknowledgedBy = ackRefused ? null : z.acknowledgedByUserId;
  if (z.event === 'open')
    await c.query(
      `INSERT INTO erp.cash_sessions (id, tenant_id, branch_id, device_id, number, cashier_user_id, opened_at,
         business_date, opening_float, float_expected, payload, signature, client_version, exception_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        z.id,
        device.tenantId,
        z.branchId,
        z.deviceId,
        z.number,
        z.userId,
        z.createdAt,
        z.businessDate,
        z.openingFloat,
        z.floatExpected,
        JSON.stringify(doc.payload),
        signature,
        z.clientVersion,
        findings.length,
      ],
    );
  else
    await c.query(
      `UPDATE erp.cash_sessions SET status = 'closed', closed_at = $2, closed_by_user_id = $3,
         close_document_id = $4, close_number = $5, expected_cash = $6, close_payload = $7, close_signature = $8,
         counted_cash = $9, denominations = $10, variance = $11, variance_reason_code = $12, variance_note = $13,
         left_in_drawer = $14, acknowledged_by_user_id = $15, acknowledged_at = CASE WHEN $15::uuid IS NULL THEN NULL
         ELSE $2::timestamptz END, exception_count = exception_count + $16
       WHERE id = $1 AND status = 'open'`,
      [
        z.sessionId,
        z.createdAt,
        z.userId,
        z.id,
        z.number,
        z.expectedCash,
        JSON.stringify(doc.payload),
        signature,
        z.countedCash,
        z.denominations === null ? null : JSON.stringify(z.denominations),
        z.variance,
        z.varianceReason,
        z.varianceNote,
        z.leftInDrawer,
        acknowledgedBy,
        findings.length,
      ],
    );
  for (const f of findings)
    await addCashException(
      c,
      device,
      {
        documentType: 'cash_session',
        id: z.id,
        number: z.number,
        userId: z.userId,
        businessDate: z.businessDate,
      },
      f,
    );
  return {
    id: z.id,
    status: 'accepted',
    exceptions: [...new Set(findings.map((f) => f.kind))],
    error: null,
  };
}

/** A collection at the desk (CSH-05, W1-11), stored as a payment in; reviewed, never refused (rule 7). */
async function acceptCollection(
  c: pg.ClientBase,
  device: Device,
  r: CustomerCollectionDocument,
  doc: PushDocument,
  received: Date,
): Promise<PushResult> {
  const grants = await grantsOf(c, [r.cashierId]);
  const findings = reviewDeskDocument(r, { grants: grants[r.cashierId] ?? [], branchId: r.branchId });
  await c.query(
    `INSERT INTO erp.payments (id, tenant_id, branch_id, device_id, number, seq, direction, party_id, method_id,
       amount, reference, note, session_id, cashier_user_id, at_device, business_date, received_at, payload,
       payload_hash, signature, client_version, exception_count)
     VALUES ($1, $2, $3, $4, $5, $6, 'in', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
      r.id,
      device.tenantId,
      r.branchId,
      r.deviceId,
      r.number,
      r.seq,
      r.partyId,
      r.methodId,
      r.amount,
      r.reference,
      r.note,
      r.sessionId,
      r.cashierId,
      r.createdAt,
      r.businessDate,
      received,
      JSON.stringify(doc.payload),
      sha256(doc.payload),
      Buffer.from(fromBase64Url(doc.signature!)),
      r.clientVersion,
      findings.length,
    ],
  );
  for (const f of findings)
    await addCashException(
      c,
      device,
      {
        documentType: 'payment',
        id: r.id,
        number: r.number,
        userId: r.cashierId,
        businessDate: r.businessDate,
      },
      f,
    );
  return { id: r.id, status: 'accepted', exceptions: [...new Set(findings.map((f) => f.kind))], error: null };
}

/** A cash-out or safe movement at the desk (CSH-06, W1-11); reviewed, never refused (rule 7). */
async function acceptMovement(
  c: pg.ClientBase,
  device: Device,
  m: CashMovementDocument,
  doc: PushDocument,
  received: Date,
): Promise<{ result: PushResult; duplicate: boolean }> {
  const giveBack = m.kind === 'void_cash' ? await voidCashReview(c, m) : null;
  const grants = await grantsOf(c, [m.cashierId]);
  const findings: (CashFinding | VoidCashFinding)[] =
    giveBack?.findings ?? reviewDeskDocument(m, { grants: grants[m.cashierId] ?? [], branchId: m.branchId });
  const duplicateOf = giveBack?.existing?.id ?? null;
  await c.query(
    `INSERT INTO erp.cash_movements (id, tenant_id, branch_id, device_id, number, seq, kind, amount,
       expense_category_id, party_id, bank_account_id, note, reference, session_id, cashier_user_id, at_device,
       business_date, received_at, payload, payload_hash, signature, client_version, exception_count, bill_number,
       approved_by_user_id, duplicate_of_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
       $23, $24, $25, $26)`,
    [
      m.id,
      device.tenantId,
      m.branchId,
      m.deviceId,
      m.number,
      m.seq,
      m.kind,
      m.amount,
      m.expenseCategoryId,
      m.partyId,
      m.bankAccountId,
      m.note,
      m.reference,
      m.sessionId,
      m.cashierId,
      m.createdAt,
      m.businessDate,
      received,
      JSON.stringify(doc.payload),
      sha256(doc.payload),
      Buffer.from(fromBase64Url(doc.signature!)),
      m.clientVersion,
      findings.length,
      m.billNumber ?? null,
      m.approvedByUserId ?? null,
      duplicateOf,
    ],
  );
  for (const f of findings)
    await addCashException(
      c,
      device,
      {
        documentType: 'cash_movement',
        id: m.id,
        number: m.number,
        userId: m.cashierId,
        businessDate: m.businessDate,
      },
      // A give-back's findings name its bill, so the exceptions report can show it.
      giveBack === null
        ? f
        : ({ ...f, billNumber: m.billNumber! } as VoidCashFinding & { billNumber: string }),
    );
  const duplicate = duplicateOf !== null;
  if (giveBack !== null && !duplicate) {
    // The queue drops the bill (its row comes again), and the cash-for-void exception is settled (owner answer 3).
    if (giveBack.billId !== null)
      await c.query(
        `UPDATE erp.sales_documents SET cash_given_back_number = $2
         WHERE id = $1 AND cash_given_back_number IS NULL`,
        [giveBack.billId, m.number],
      );
    await settleExceptions(c, device, {
      kind: 'cash_received_for_void',
      key: 'billNumber',
      value: m.billNumber!,
      note: `Given back on ${m.number}, approved by ${await userName(c, m.approvedByUserId!)}`,
      userId: m.approvedByUserId!,
      at: received,
    });
  }
  return {
    result: {
      id: m.id,
      status: 'accepted',
      exceptions: [...new Set(findings.map((f) => f.kind))],
      error: null,
    },
    duplicate,
  };
}

/**
 * What the server holds for a pushed give-back (W1-23): its bill by number, the bill's first handover in, an earlier
 * give-back of the bill, and the session's cashier. The bill's lock (`holdBill`) makes two desks' give-backs of one
 * bill wait for each other, so only the first is not a duplicate.
 */
async function voidCashReview(c: pg.ClientBase, m: CashMovementDocument) {
  const billNumber = m.billNumber!;
  await holdBill(c, billNumber);
  const bill = (
    await c.query<{ id: string; status: 'finalized' | 'voided' }>(
      'SELECT id, status FROM erp.sales_documents WHERE number = $1 ORDER BY received_at, id LIMIT 1',
      [billNumber],
    )
  ).rows[0];
  const handover = (
    await c.query<{ amount: string }>(
      `SELECT amount FROM erp.cash_handovers
       WHERE bill_number = $1 AND kind = 'in' AND duplicate_of_id IS NULL ORDER BY at_device LIMIT 1`,
      [billNumber],
    )
  ).rows[0];
  const existing = (
    await c.query<{ id: string; number: string }>(
      `SELECT id, number FROM erp.cash_movements
       WHERE kind = 'void_cash' AND bill_number = $1 AND duplicate_of_id IS NULL AND id <> $2`,
      [billNumber, m.id],
    )
  ).rows[0];
  const session = (
    await c.query<{ cashier_user_id: string }>(
      'SELECT cashier_user_id FROM erp.cash_sessions WHERE id = $1',
      [m.sessionId],
    )
  ).rows[0];
  const users = [m.cashierId, ...(m.approvedByUserId === undefined ? [] : [m.approvedByUserId])];
  const grants = await grantsOf(c, users);
  const findings = reviewVoidCash(m, {
    bill: bill ? { status: bill.status } : null,
    handover: handover ? { amount: money(handover.amount) } : null,
    existing: existing ?? null,
    grantsOf: (id) => grants[id] ?? [],
    sessionCashierId: session?.cashier_user_id ?? null,
    branchId: m.branchId,
  });
  return { findings, existing: existing ?? null, billId: bill?.id ?? null };
}

async function userName(c: pg.ClientBase, id: string): Promise<string> {
  const r = await c.query<{ full_name: string }>('SELECT full_name FROM erp.users WHERE id = $1', [id]);
  return r.rows[0]?.full_name ?? id;
}

/**
 * Marks the open exceptions of `kind` whose details name `value` reviewed, by the server, with a note (W1-23): what
 * they flagged has been put right. Audited as `exception.settled`; a manager can still reopen one (W1-20).
 */
async function settleExceptions(
  c: pg.ClientBase,
  device: Pick<Device, 'tenantId'>,
  e: { kind: ExceptionKind; key: string; value: string; note: string; userId: string; at: Date },
) {
  const { rows } = await c.query<{ id: string }>(
    `UPDATE erp.exceptions SET status = 'reviewed', review_note = $3, reviewed_by_user_id = $4, reviewed_at = $5
     WHERE kind = $1 AND status = 'open' AND details ->> '${e.key}' = $2
     RETURNING id`,
    [e.kind, e.value, e.note, e.userId, e.at],
  );
  for (const r of rows)
    await c.query(
      `INSERT INTO erp.audit_log (tenant_id, at, user_id, action, entity, entity_id, before, after)
       VALUES ($1, $2, $3, 'exception.settled', 'exceptions', $4, $5, $6)`,
      [
        device.tenantId,
        e.at,
        e.userId,
        r.id,
        JSON.stringify({ status: 'open' }),
        JSON.stringify({ status: 'reviewed', note: e.note }),
      ],
    );
}

/** One exception on a collection, cash movement or session document, with its figures (sync spec §6.2). */
async function addCashException(
  c: pg.ClientBase,
  device: Pick<Device, 'tenantId' | 'deviceId'>,
  d: {
    documentType: 'payment' | 'cash_movement' | 'cash_session';
    id: string;
    number: string;
    userId: string;
    businessDate: string;
  },
  f: CashFinding | (VoidCashFinding & { billNumber?: string }),
) {
  const { kind, ...details } = f;
  await addException(c, device, {
    kind,
    documentType: d.documentType,
    documentId: d.id,
    userId: d.userId,
    businessDate: d.businessDate,
    details: { ...details, number: d.number },
  });
}

/**
 * The credit findings on a sale on account (sync spec §6.2, W1-09): judged with the server's balance (every
 * counter's posted sales) and this device's offline on-account sales to the customer that business day. The posting
 * order lock is taken first, so no other posting moves the balance until this sale is posted after it.
 */
async function creditFindings(
  c: pg.ClientBase,
  device: Device,
  d: SaleDocument | ReturnDocument,
  grants: Record<string, RoleGrant[]>,
): Promise<CreditFinding[]> {
  // A refund to account (W1-13) isn't a sale on credit.
  if (d.customerId === null || onAccountAmount(d.payments) <= 0) return [];
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
  device: Pick<Device, 'tenantId' | 'deviceId'>,
  e: {
    kind: ExceptionKind;
    /** Defaults to a sale. */
    documentType?:
      'sales_document' | 'cash_handover' | 'payment' | 'cash_movement' | 'cash_session' | 'sales_void';
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
      e.documentId === null ? null : (e.documentType ?? 'sales_document'),
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
