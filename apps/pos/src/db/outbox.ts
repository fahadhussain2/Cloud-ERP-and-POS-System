import {
  PUSH_BATCH_MAX,
  PUSH_EVENTS_MAX,
  type DeviceHealth,
  type DocumentFamily,
  type PushEvent,
  type PushResult,
  type SeriesState,
} from '@erp/contracts';

import { getSync, setSync } from './repo';
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

const DAY_MS = 86_400_000;
/** A TEXT column's value; NULL as null. */
const text = (v: unknown) => (typeof v === 'string' ? v : null);
const changes = (db: SqlDb) => Number(db.selectValue('SELECT changes()'));
const daysAgo = (nowMs: number) => new Date(nowMs - KEEP_DAYS * DAY_MS).toISOString();

/** The next pending rows, at most `limit`, in `seq` order within each family. Quarantined rows wait. */
export const outboxBatch = (db: SqlDb, limit: number = PUSH_BATCH_MAX): OutboxRow[] =>
  db
    .selectObjects(
      `SELECT id, family, seq, payload, signature FROM outbox WHERE status = 'pending'
       ORDER BY family, seq LIMIT ?`,
      [limit],
    )
    .map((r) => ({
      id: String(r['id']),
      family: String(r['family']) as DocumentFamily,
      seq: Number(r['seq']),
      payload: JSON.parse(String(r['payload'])) as unknown,
      signature: text(r['signature']),
    }));

/**
 * Applies the server's answer in one transaction: `accepted` and `duplicate` rows leave the outbox (their signature
 * kept on the local document) and raise `pushed_through:<family>`; `rejected` rows are quarantined with the error.
 * Records `last_push_at` and `last_contact_at`.
 */
export function ackPush(db: SqlDb, results: readonly PushResult[], at: string): void {
  db.transaction(() => {
    const acked = new Map<string, number>();
    for (const r of results) {
      const [row] = db.selectObjects('SELECT family, seq, signature FROM outbox WHERE id = ?', [r.id]);
      // An answer for a row no longer here (a copy sent twice): nothing to do.
      if (!row) continue;
      if (r.status === 'rejected') {
        db.exec(
          "UPDATE outbox SET status = 'quarantined', last_error = ?, attempts = attempts + 1 WHERE id = ?",
          [r.error ?? 'rejected', r.id],
        );
        continue;
      }
      db.exec('UPDATE local_documents SET signature = coalesce(?, signature) WHERE id = ?', [
        text(row['signature']),
        r.id,
      ]);
      db.exec('DELETE FROM outbox WHERE id = ?', [r.id]);
      const family = String(row['family']);
      acked.set(family, Math.max(acked.get(family) ?? 0, Number(row['seq'])));
    }
    for (const [family, seq] of acked) {
      if (seq > Number(getSync(db, `pushed_through:${family}`) ?? 0))
        setSync(db, `pushed_through:${family}`, String(seq));
    }
    setSync(db, 'last_push_at', at);
    setSync(db, 'last_contact_at', at);
  });
}

/**
 * Puts back in the outbox what the server says it lacks (sync spec §7): its missing ranges, and everything between its
 * `through` and this counter's `pushed_through`, from `local_documents`, at most KEEP_DAYS old, skipping rows already
 * in the outbox. Returns how many were put back.
 */
export function requeue(db: SqlDb, series: readonly SeriesState[], nowMs: number): number {
  const families = new Set([
    ...db.selectObjects('SELECT DISTINCT family FROM local_documents').map((r) => String(r['family'])),
    ...series.map((s) => s.family),
  ]);
  return db.transaction(() => {
    let added = 0;
    for (const family of families) {
      // A family the server doesn't list: it has nothing of it (a restore), so its through is 0.
      const s = series.find((x) => x.family === family);
      const through = s?.through ?? 0;
      const pushed = Number(getSync(db, `pushed_through:${family}`) ?? 0);
      for (const [from, to] of [[through + 1, pushed], ...(s?.missing ?? [])] as [number, number][]) {
        if (to < from) continue;
        db.exec(
          `INSERT INTO outbox (id, family, seq, payload, signature, status, attempts, created_at)
           SELECT id, family, seq, payload, signature, 'pending', 0, created_at FROM local_documents
           WHERE family = ? AND seq BETWEEN ? AND ? AND created_at >= ? AND id NOT IN (SELECT id FROM outbox)`,
          [family, from, to, daysAgo(nowMs)],
        );
        added += changes(db);
      }
    }
    return added;
  });
}

/** PIN events and reprints not yet pushed, oldest first, at most `limit`. */
export const pendingEvents = (db: SqlDb, limit: number = PUSH_EVENTS_MAX): PushEvent[] =>
  db
    .selectObjects(
      `SELECT id, kind, user_id, by_user_id, NULL AS document_id, NULL AS number, at FROM pin_events
         WHERE pushed_at IS NULL
       UNION ALL
       SELECT id, 'reprint', user_id, NULL, document_id, number, at FROM reprints WHERE pushed_at IS NULL
       ORDER BY at, id LIMIT ?`,
      [limit],
    )
    .map((r): PushEvent => {
      const base = { id: String(r['id']), at: String(r['at']), userId: String(r['user_id']) };
      if (r['kind'] === 'locked') return { ...base, kind: 'pin.locked' };
      if (r['kind'] === 'unlocked')
        return { ...base, kind: 'pin.unlocked_by_manager', byUserId: String(r['by_user_id']) };
      return {
        ...base,
        kind: 'bill.reprinted',
        documentId: String(r['document_id']),
        number: String(r['number']),
      };
    });

/** Marks the events the server stored as pushed. */
export function ackEvents(db: SqlDb, ids: readonly string[], at: string): void {
  db.transaction(() => {
    for (const id of ids) {
      db.exec('UPDATE pin_events SET pushed_at = ? WHERE id = ? AND pushed_at IS NULL', [at, id]);
      db.exec('UPDATE reprints SET pushed_at = ? WHERE id = ? AND pushed_at IS NULL', [at, id]);
    }
  });
}

export const quarantinedRows = (db: SqlDb): QuarantinedRow[] =>
  db
    .selectObjects(
      `SELECT id, family, seq, json_extract(payload, '$.number') AS number, last_error, attempts, created_at
       FROM outbox WHERE status = 'quarantined' ORDER BY family, seq`,
    )
    .map((r) => ({
      id: String(r['id']),
      family: String(r['family']) as DocumentFamily,
      seq: Number(r['seq']),
      number: String(r['number']),
      error: String(r['last_error']),
      attempts: Number(r['attempts']),
      createdAt: String(r['created_at']),
    }));

/** *Try again* (a manager, POS spec §14): the row goes back to pending. False when it isn't quarantined. */
export function retryQuarantined(db: SqlDb, id: string): boolean {
  db.exec("UPDATE outbox SET status = 'pending', last_error = NULL WHERE id = ? AND status = 'quarantined'", [
    id,
  ]);
  return changes(db) === 1;
}

/** Drops local documents older than KEEP_DAYS, never one still in the outbox (rule 9). Returns how many. */
export function pruneDocuments(db: SqlDb, nowMs: number): number {
  db.exec('DELETE FROM local_documents WHERE created_at < ? AND id NOT IN (SELECT id FROM outbox)', [
    daysAgo(nowMs),
  ]);
  return changes(db);
}

export function localHealth(db: SqlDb): LocalHealth {
  const [o] = db.selectObjects(
    `SELECT count(*) AS n, min(created_at) AS oldest, coalesce(sum(status = 'quarantined'), 0) AS quarantined
     FROM outbox`,
  );
  const eventsWaiting = Number(
    db.selectValue(
      `SELECT (SELECT count(*) FROM pin_events WHERE pushed_at IS NULL)
            + (SELECT count(*) FROM reprints WHERE pushed_at IS NULL)`,
    ),
  );
  return {
    outboxCount: Number(o?.['n'] ?? 0),
    oldestUnsyncedAt: text(o?.['oldest']),
    quarantinedCount: Number(o?.['quarantined'] ?? 0),
    lastPullAt: getSync(db, 'last_pull_at'),
    lastPushAt: getSync(db, 'last_push_at'),
    lastContactAt: getSync(db, 'last_contact_at'),
    eventsWaiting,
  };
}
