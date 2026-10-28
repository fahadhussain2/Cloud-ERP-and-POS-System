import type { z } from 'zod';

// Push (sync spec §6.2, SYN-02, SYN-03, SYN-05, W1-07): a counter sends its outbox in sequence order, with its audit
// events and a health snapshot; the server answers per document and with what it holds of the device's series.

/** At most this many documents per push (architecture §5.2). */
export const PUSH_BATCH_MAX = 100;
/** At most this many audit events per push. */
export const PUSH_EVENTS_MAX = 500;

export type DocumentFamily = 'S' | 'H' | 'R' | 'M' | 'Z';

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

/** Exception kinds (data model §10), including W1-07's `discount_over_limit` and `document_inconsistent`. */
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

/** The SSE events on `GET /api/sync/events` (sync spec §8). */
export const SYNC_EVENTS = { changesAvailable: 'changes-available' } as const;

const notBuilt = <T>(name: string) =>
  ({
    safeParse: () => {
      throw new Error(`${name}: not built yet (W1-07)`);
    },
    parse: () => {
      throw new Error(`${name}: not built yet (W1-07)`);
    },
  }) as unknown as z.ZodType<T>;

/** Zod schemas for the above; the API parses requests with them and the counter parses answers. */
export const PushRequestSchema = notBuilt<PushRequest>('PushRequestSchema');
export const PushResponseSchema = notBuilt<PushResponse>('PushResponseSchema');
