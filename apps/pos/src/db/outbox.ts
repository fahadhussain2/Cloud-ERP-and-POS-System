import {
  PUSH_BATCH_MAX,
  PUSH_EVENTS_MAX,
  type DeviceHealth,
  type DocumentFamily,
  type PushEvent,
  type PushResult,
  type SeriesState,
} from '@erp/contracts';

import type { SqlDb } from './sql';

// The outbox side of push (sync spec §6.2–§7, data model §12, rules 7 and 9, W1-07): what to send next, what the
// server's answer changes, what to put back after a restore, and the audit events waiting. Runs in the database
// worker. A row leaves the outbox only on an `accepted` or `duplicate` answer; nothing here ever drops a rejected one.

/** This counter keeps its own documents this long, for reprints and re-push after a restore (SYN-01, SYN-05). */
export const KEEP_DAYS = 30;

export interface OutboxRow {
  id: string;
  family: DocumentFamily;
  seq: number;
  payload: unknown;
  /** null until signed (POS spec §12: push signs a row left unsigned). */
  signature: string | null;
}

/** A refused bill, kept under *Needs attention* (POS spec §14). */
export interface QuarantinedRow {
  id: string;
  family: DocumentFamily;
  seq: number;
  number: string;
  error: string;
  attempts: number;
  createdAt: string;
}

/** What the counter knows of its own health; the page adds the browser's storage figures (PLT-09). */
export interface LocalHealth extends Pick<
  DeviceHealth,
  'outboxCount' | 'oldestUnsyncedAt' | 'quarantinedCount' | 'lastPullAt'
> {
  lastPushAt: string | null;
  /** The last successful push or pull: what the offline warnings count from (SYN-06). */
  lastContactAt: string | null;
  /** PIN events and reprints not yet in the server's audit log. */
  eventsWaiting: number;
}

const notBuilt = (...args: unknown[]): never => {
  throw new Error(`not built yet (W1-07): ${args.length} arguments`);
};

/** The next pending rows, at most `limit`, in `seq` order within each family. Quarantined rows wait. */
export function outboxBatch(db: SqlDb, limit: number = PUSH_BATCH_MAX): OutboxRow[] {
  return notBuilt(db, limit);
}

/**
 * Applies the server's answer in one transaction: `accepted` and `duplicate` rows leave the outbox (their signature
 * kept on the local document) and raise `pushed_through:<family>`; `rejected` rows are quarantined with the error.
 * Records `last_push_at` and `last_contact_at`.
 */
export function ackPush(db: SqlDb, results: readonly PushResult[], at: string): void {
  return notBuilt(db, results, at);
}

/**
 * Puts back in the outbox what the server says it lacks (sync spec §7): its missing ranges, and everything between its
 * `through` and this counter's `pushed_through`, from `local_documents`, at most KEEP_DAYS old, skipping rows already
 * in the outbox. Returns how many were put back.
 */
export function requeue(db: SqlDb, series: readonly SeriesState[], nowMs: number): number {
  return notBuilt(db, series, nowMs);
}

/** PIN events and reprints not yet pushed, oldest first, at most `limit`. */
export function pendingEvents(db: SqlDb, limit: number = PUSH_EVENTS_MAX): PushEvent[] {
  return notBuilt(db, limit);
}

/** Marks the events the server stored as pushed. */
export function ackEvents(db: SqlDb, ids: readonly string[], at: string): void {
  return notBuilt(db, ids, at);
}

export function quarantinedRows(db: SqlDb): QuarantinedRow[] {
  return notBuilt(db);
}

/** *Try again* (a manager, POS spec §14): the row goes back to pending. False when it isn't quarantined. */
export function retryQuarantined(db: SqlDb, id: string): boolean {
  return notBuilt(db, id);
}

/** Drops local documents older than KEEP_DAYS, never one still in the outbox (rule 9). Returns how many. */
export function pruneDocuments(db: SqlDb, nowMs: number): number {
  return notBuilt(db, nowMs);
}

export function localHealth(db: SqlDb): LocalHealth {
  return notBuilt(db);
}
