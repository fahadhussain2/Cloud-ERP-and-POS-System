import { z } from 'zod';

// Push (sync spec §6.2, SYN-02, SYN-03, SYN-05, W1-07): a counter sends its outbox in sequence order, with its audit
// events and a health snapshot; the server answers per document and with what it holds of the device's series.

/** At most this many documents per push (architecture §5.2). */
export const PUSH_BATCH_MAX = 100;
/** At most this many audit events per push. */
export const PUSH_EVENTS_MAX = 500;

export type DocumentFamily = 'S' | 'H' | 'R' | 'M' | 'Z' | 'V';

/** Why the server refuses a document: it can't be trusted or stored (SYN-03). Anything else is accepted. */
export const REJECT_CODES = [
  'unsigned',
  'bad_signature',
  'bad_schema',
  'id_conflict',
  'seq_conflict',
  'unknown_reference',
  'wrong_device',
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

/** Exception kinds (data model §10) a push can record, including W1-07's and W1-10's. */
export const EXCEPTION_KINDS = [
  'below_floor_no_override',
  'discount_over_limit',
  'document_inconsistent',
  'credit_limit_exceeded',
  'offline_cap_exceeded',
  'negative_stock',
  'missing_handover',
  'handover_amount_mismatch',
  'cash_received_for_void',
  'seq_gap',
  'clock_skew',
  'revoked_device_doc',
  'bad_signature',
  // The cash desk (W1-10): a second handover of one bill, and a cashier the server says may not take cash; (W1-11) a
  // collection, cash-out or close by someone without the permission, and a float other than what stayed at close.
  'duplicate_handover',
  'handover_not_permitted',
  'cash_not_permitted',
  'float_mismatch',
  // Voids (W1-12): an approver or a day the rules don't allow, and a second void of one bill.
  'void_not_permitted',
  'duplicate_void',
  // Returns (W1-13): more back than sold, an original that can't be returned, a refund other than the rules give, an
  // approval missing or from someone without the permission.
  'return_over_quantity',
  'return_original_invalid',
  'return_price_mismatch',
  'return_not_permitted',
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/** An outbox row as it is sent. The payload is checked per document, so one malformed bill can't refuse the batch. */
export interface PushDocument {
  /** The document's UUIDv7: the idempotency key (rule 7). */
  id: string;
  family: DocumentFamily;
  seq: number;
  payload: unknown;
  /** base64url ECDSA P1363 over canonicalJson(payload) (D-082); null = unsigned, refused as `unsigned`. */
  signature: string | null;
}

/** The counter's health (PLT-09, architecture §11.3), sent with every push. */
export interface DeviceHealth {
  outboxCount: number;
  oldestUnsyncedAt: string | null;
  quarantinedCount: number;
  storagePersisted: boolean;
  /** `navigator.storage.estimate()`, in bytes; null when the browser doesn't say. */
  storageUsage: number | null;
  storageQuota: number | null;
  lastPullAt: string | null;
}

/** Audit events kept on the counter (sync spec §5, POS spec §13); `id` is device-made and becomes the audit row's id. */
export type PushEvent =
  | { id: string; kind: 'pin.locked'; at: string; userId: string }
  | { id: string; kind: 'pin.unlocked_by_manager'; at: string; userId: string; byUserId: string }
  | { id: string; kind: 'bill.reprinted'; at: string; userId: string; documentId: string; number: string };

export interface PushRequest {
  clientVersion: string;
  schemaVersion: number;
  /** The counter's clock when it sent this (clock skew, architecture §4.4). */
  deviceClock: string;
  health: DeviceHealth;
  /** At most PUSH_BATCH_MAX, unique ids, in ascending `seq` within each family. Empty = the start-up handshake. */
  documents: PushDocument[];
  events: PushEvent[];
}

export interface PushResult {
  id: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  /** The exceptions recorded for it (none when rejected, except `bad_signature`). */
  exceptions: ExceptionKind[];
  /** Why it was rejected; null otherwise. */
  error: RejectCode | null;
}

/** What the server holds of one of the device's series: every seq from 1 to `through`, and the gaps above it. */
export interface SeriesState {
  family: DocumentFamily;
  through: number;
  /** Inclusive ranges the server is missing, below the highest seq it has. */
  missing: [number, number][];
}

export interface PushResponse {
  serverTime: string;
  /** One per pushed document, in the request's order. */
  results: PushResult[];
  /** Every family the device has documents in on the server. */
  series: SeriesState[];
  /** The event ids now stored (new or already there). */
  events: string[];
}

/** The SSE events on `GET /api/sync/events` (sync spec §8); `queue-changed` goes to cash desks only (W1-10). */
export const SYNC_EVENTS = { changesAvailable: 'changes-available', queueChanged: 'queue-changed' } as const;

const Instant = z.iso.datetime();
const Family = z.enum(['S', 'H', 'R', 'M', 'Z', 'V']);
const Count = z.int().nonnegative();

const PushDocumentSchema = z.strictObject({
  id: z.uuid(),
  family: Family,
  seq: z.int().positive(),
  payload: z.unknown(),
  signature: z.string().min(1).max(200).nullable(),
});

const PushEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: z.uuid(), kind: z.literal('pin.locked'), at: Instant, userId: z.uuid() }),
  z.strictObject({
    id: z.uuid(),
    kind: z.literal('pin.unlocked_by_manager'),
    at: Instant,
    userId: z.uuid(),
    byUserId: z.uuid(),
  }),
  z.strictObject({
    id: z.uuid(),
    kind: z.literal('bill.reprinted'),
    at: Instant,
    userId: z.uuid(),
    documentId: z.uuid(),
    number: z.string().min(1).max(40),
  }),
]);

const DeviceHealthSchema = z.strictObject({
  outboxCount: Count,
  oldestUnsyncedAt: Instant.nullable(),
  quarantinedCount: Count,
  storagePersisted: z.boolean(),
  storageUsage: Count.nullable(),
  storageQuota: Count.nullable(),
  lastPullAt: Instant.nullable(),
});

/** Zod schemas for the above; the API parses requests with them and the counter parses answers. */
export const PushRequestSchema: z.ZodType<PushRequest> = z
  .strictObject({
    clientVersion: z.string().min(1).max(40),
    schemaVersion: z.int().positive(),
    deviceClock: Instant,
    health: DeviceHealthSchema,
    documents: z.array(PushDocumentSchema).max(PUSH_BATCH_MAX),
    events: z.array(PushEventSchema).max(PUSH_EVENTS_MAX),
  })
  .superRefine((r, ctx) => {
    // Ascending seq within each family (architecture §5.2), and each document once.
    const last = new Map<string, number>();
    const ids = new Set<string>();
    r.documents.forEach((d, i) => {
      const before = last.get(d.family);
      if ((before !== undefined && d.seq <= before) || ids.has(d.id))
        ctx.addIssue({
          code: 'custom',
          path: ['documents', i],
          message: 'out of sequence order, or sent twice',
        });
      last.set(d.family, d.seq);
      ids.add(d.id);
    });
  });

export const PushResponseSchema: z.ZodType<PushResponse> = z.strictObject({
  serverTime: Instant,
  results: z.array(
    z.strictObject({
      id: z.uuid(),
      status: z.enum(['accepted', 'duplicate', 'rejected']),
      exceptions: z.array(z.enum(EXCEPTION_KINDS)),
      error: z.enum(REJECT_CODES).nullable(),
    }),
  ),
  series: z.array(
    z.strictObject({
      family: Family,
      through: Count,
      missing: z.array(z.tuple([z.int().positive(), z.int().positive()])),
    }),
  ),
  events: z.array(z.uuid()),
});

/**
 * The live cash desk status of one of the device's own bills (W1-12, sync spec §6.2): what the server knows of the bill
 * and of any handover of its number, an offline scan whose bill hasn't arrived included. Asked before a void.
 * `GET /api/sync/bills/status?number=C03-S000412` (device token).
 */
export const BillStatusResponseSchema = z.strictObject({
  /** The server has the bill. */
  known: z.boolean(),
  status: z.enum(['finalized', 'voided']).nullable(),
  /** The bill's own status, or `received` / `paid_out` from a handover of its number when the bill isn't there. */
  handoverStatus: z.enum(['not_applicable', 'pending', 'received', 'paid_out']).nullable(),
  handedOverAt: z.iso.datetime().nullable(),
  /** Who took the cash, for the counter to say so. */
  cashierName: z.string().nullable(),
});
export type BillStatusResponse = z.infer<typeof BillStatusResponseSchema>;
