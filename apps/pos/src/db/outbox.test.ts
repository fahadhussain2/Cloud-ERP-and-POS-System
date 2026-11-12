// @vitest-environment node
import type { PushResult } from '@erp/contracts';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { recordReprint } from './checkout';
import { migrate } from './migrate';
import {
  ackEvents,
  ackPush,
  KEEP_DAYS,
  localHealth,
  outboxBatch,
  pendingEvents,
  pruneDocuments,
  quarantinedRows,
  requeue,
  retryQuarantined,
} from './outbox';
import { applyPull, getSync, recordPinEvent, setSync } from './repo';
import { wrapOo1, type SqlDb } from './sql';

// The outbox side of push (sync spec §6.2–§7, data model §12, rules 7 and 9, W1-07), on real SQLite.

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
let db: SqlDb;

const T0 = Date.parse('2026-11-02T10:15:30.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const id = (seq: number) => `019a3f6e-7b10-7c3a-9d2e-${String(seq).padStart(12, '0')}`;
const SARA = '019a0000-0000-7000-8000-0000000000a1';
const BOSS = '019a0000-0000-7000-8000-0000000000a2';

interface DocOptions {
  createdAtMs?: number;
  /** In the outbox, and how; `false` = already acked (only in local_documents). */
  outbox?: 'pending' | 'quarantined' | false;
  signature?: string | null;
}

/** A finalized bill as W1-06 leaves it: in local_documents and, until acked, in the outbox. */
function addDoc(seq: number, o: DocOptions = {}) {
  const createdAt = iso(o.createdAtMs ?? T0 + seq * 1000);
  const payload = JSON.stringify({ id: id(seq), seq, number: `C03-S${String(seq).padStart(6, '0')}` });
  const signature = o.signature === undefined ? `sig${seq}` : o.signature;
  const status = o.outbox ?? 'pending';
  const acked = status === false;
  db.exec(
    `INSERT INTO local_documents (id, family, seq, number, kind, business_date, payload, created_at, signature)
     VALUES (?, 'S', ?, ?, 'sale', '2026-11-02', ?, ?, ?)`,
    [id(seq), seq, `C03-S${String(seq).padStart(6, '0')}`, payload, createdAt, acked ? signature : null],
  );
  if (status !== false)
    db.exec(
      `INSERT INTO outbox (id, family, seq, payload, signature, status, attempts, created_at)
       VALUES (?, 'S', ?, ?, ?, ?, 0, ?)`,
      [id(seq), seq, payload, signature, status, createdAt],
    );
}

const result = (
  seq: number,
  status: PushResult['status'],
  error: PushResult['error'] = null,
): PushResult => ({
  id: id(seq),
  status,
  exceptions: [],
  error,
});
const outboxSeqs = () =>
  db.selectObjects('SELECT seq, status FROM outbox ORDER BY seq').map((r) => [r['seq'], r['status']]);

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

beforeEach(() => {
  db = wrapOo1(new sqlite3.oo1.DB(':memory:'));
  migrate(db);
});

describe('the next batch', () => {
  it('is the pending rows in sequence order, at most the limit, with their payload and signature', () => {
    for (const seq of [3, 1, 2]) addDoc(seq);
    addDoc(4, { signature: null });
    expect(outboxBatch(db, 3)).toEqual([
      {
        id: id(1),
        family: 'S',
        seq: 1,
        payload: { id: id(1), seq: 1, number: 'C03-S000001' },
        signature: 'sig1',
      },
      {
        id: id(2),
        family: 'S',
        seq: 2,
        payload: { id: id(2), seq: 2, number: 'C03-S000002' },
        signature: 'sig2',
      },
      {
        id: id(3),
        family: 'S',
        seq: 3,
        payload: { id: id(3), seq: 3, number: 'C03-S000003' },
        signature: 'sig3',
      },
    ]);
    expect(outboxBatch(db).map((r) => [r.seq, r.signature])).toEqual([
      [1, 'sig1'],
      [2, 'sig2'],
      [3, 'sig3'],
      [4, null],
    ]);
  });

  it('leaves quarantined rows out: they wait for a manager', () => {
    addDoc(1, { outbox: 'quarantined' });
    addDoc(2);
    expect(outboxBatch(db).map((r) => r.seq)).toEqual([2]);
  });
});

describe('the server’s answer', () => {
  it('removes accepted and duplicate rows, keeps their signature on the local document, quarantines rejected ones', () => {
    for (const seq of [1, 2, 3]) addDoc(seq);
    ackPush(
      db,
      [result(1, 'accepted'), result(2, 'rejected', 'bad_schema'), result(3, 'duplicate')],
      iso(T0 + 5000),
    );
    expect(outboxSeqs()).toEqual([[2, 'quarantined']]);
    const q = db.selectObjects('SELECT last_error, attempts FROM outbox WHERE seq = 2')[0];
    expect(q).toEqual({ last_error: 'bad_schema', attempts: 1 });
    expect(db.selectValue('SELECT signature FROM local_documents WHERE seq = 1')).toBe('sig1');
    expect(db.selectValue('SELECT signature FROM local_documents WHERE seq = 3')).toBe('sig3');
    expect(db.selectValue('SELECT count(*) FROM local_documents')).toBe(3);
  });

  it('raises pushed_through to the highest acked number and records the contact', () => {
    for (const seq of [1, 2, 3]) addDoc(seq);
    ackPush(db, [result(1, 'accepted'), result(2, 'accepted')], iso(T0 + 5000));
    expect(getSync(db, 'pushed_through:S')).toBe('2');
    ackPush(db, [result(3, 'duplicate')], iso(T0 + 6000));
    expect(getSync(db, 'pushed_through:S')).toBe('3');
    expect(getSync(db, 'last_push_at')).toBe(iso(T0 + 6000));
    expect(getSync(db, 'last_contact_at')).toBe(iso(T0 + 6000));
  });

  it('never lowers pushed_through, and ignores an answer for a row no longer in the outbox', () => {
    addDoc(5);
    setSync(db, 'pushed_through:S', '9');
    ackPush(db, [result(5, 'accepted'), result(77, 'duplicate')], iso(T0));
    expect(getSync(db, 'pushed_through:S')).toBe('9');
    expect(outboxSeqs()).toEqual([]);
  });

  it('a pull counts as contact too', () => {
    applyPull(db, {}, 'cursor');
    expect(getSync(db, 'last_contact_at')).not.toBeNull();
  });
});

describe('putting back what the server lacks (SYN-05)', () => {
  it('re-queues the missing ranges from local documents, with their payload and signature', () => {
    for (const seq of [1, 2, 3, 4, 5]) addDoc(seq, { outbox: false });
    setSync(db, 'pushed_through:S', '5');
    expect(requeue(db, [{ family: 'S', through: 5, missing: [[2, 3]] }], T0 + DAY)).toBe(2);
    expect(outboxBatch(db).map((r) => [r.seq, r.signature])).toEqual([
      [2, 'sig2'],
      [3, 'sig3'],
    ]);
  });

  it('after a restore re-queues everything above the server’s through up to pushed_through', () => {
    for (const seq of [1, 2, 3, 4]) addDoc(seq, { outbox: false });
    setSync(db, 'pushed_through:S', '4');
    // A restored server that has nothing from this counter doesn't list the family at all.
    expect(requeue(db, [], T0 + DAY)).toBe(4);
    expect(outboxSeqs()).toEqual([
      [1, 'pending'],
      [2, 'pending'],
      [3, 'pending'],
      [4, 'pending'],
    ]);
  });

  it('puts back nothing when the server is up to date, nor anything already in the outbox', () => {
    for (const seq of [1, 2]) addDoc(seq, { outbox: false });
    addDoc(3);
    setSync(db, 'pushed_through:S', '2');
    expect(requeue(db, [{ family: 'S', through: 2, missing: [] }], T0)).toBe(0);
    expect(requeue(db, [{ family: 'S', through: 0, missing: [] }], T0)).toBe(2);
    expect(requeue(db, [{ family: 'S', through: 0, missing: [[3, 3]] }], T0)).toBe(0);
    expect(db.selectValue('SELECT count(*) FROM outbox')).toBe(3);
  });

  it(`never re-queues a document older than ${KEEP_DAYS} days`, () => {
    addDoc(1, { outbox: false, createdAtMs: T0 - (KEEP_DAYS + 1) * DAY });
    addDoc(2, { outbox: false, createdAtMs: T0 - (KEEP_DAYS - 1) * DAY });
    setSync(db, 'pushed_through:S', '2');
    expect(requeue(db, [], T0)).toBe(1);
    expect(outboxSeqs()).toEqual([[2, 'pending']]);
  });
});

describe('audit events (sync spec §5, POS spec §13)', () => {
  it('sends PIN events and reprints not yet pushed, oldest first, and marks the stored ones', () => {
    recordPinEvent(db, { kind: 'locked', userId: SARA, byUserId: null, at: '2026-11-02T09:00:00.000Z' });
    recordPinEvent(db, { kind: 'unlocked', userId: SARA, byUserId: BOSS, at: '2026-11-02T09:01:00.000Z' });
    const r = recordReprint(db, {
      documentId: id(1),
      number: 'C03-S000001',
      userId: SARA,
      at: '2026-11-02T10:20:00.000Z',
    });
    const events = pendingEvents(db);
    expect(events.map((e) => ({ ...e, id: typeof e.id }))).toEqual([
      { id: 'string', kind: 'pin.locked', at: '2026-11-02T09:00:00.000Z', userId: SARA },
      {
        id: 'string',
        kind: 'pin.unlocked_by_manager',
        at: '2026-11-02T09:01:00.000Z',
        userId: SARA,
        byUserId: BOSS,
      },
      {
        id: 'string',
        kind: 'bill.reprinted',
        at: '2026-11-02T10:20:00.000Z',
        userId: SARA,
        documentId: id(1),
        number: 'C03-S000001',
      },
    ]);
    expect(events[2]!.id).toBe(r.id);
    expect(pendingEvents(db, 2)).toHaveLength(2);

    ackEvents(db, [events[0]!.id, events[2]!.id], iso(T0));
    expect(pendingEvents(db).map((e) => e.kind)).toEqual(['pin.unlocked_by_manager']);
  });
});

describe('needs attention (POS spec §14)', () => {
  it('lists quarantined bills with their error, and Try again puts one back to pending', () => {
    addDoc(1);
    addDoc(2);
    ackPush(db, [result(1, 'rejected', 'unsigned')], iso(T0));
    expect(quarantinedRows(db)).toEqual([
      {
        id: id(1),
        family: 'S',
        seq: 1,
        number: 'C03-S000001',
        error: 'unsigned',
        attempts: 1,
        createdAt: iso(T0 + 1000),
      },
    ]);
    expect(retryQuarantined(db, id(1))).toBe(true);
    expect(retryQuarantined(db, id(2))).toBe(false);
    expect(outboxSeqs()).toEqual([
      [1, 'pending'],
      [2, 'pending'],
    ]);
    expect(quarantinedRows(db)).toEqual([]);
  });
});

describe('keeping 30 days (SYN-01)', () => {
  it('prunes old local documents but never one still in the outbox (rule 9)', () => {
    addDoc(1, { outbox: false, createdAtMs: T0 - 31 * DAY });
    addDoc(2, { outbox: 'quarantined', createdAtMs: T0 - 40 * DAY });
    addDoc(3, { outbox: false, createdAtMs: T0 - 29 * DAY });
    expect(pruneDocuments(db, T0)).toBe(1);
    expect(db.selectObjects('SELECT seq FROM local_documents ORDER BY seq').map((r) => r['seq'])).toEqual([
      2, 3,
    ]);
  });

  it("drops a desk's queue rows handed over more than 7 days ago, never a pending one (W1-10)", () => {
    const at = (days: number) => new Date(T0 - days * DAY).toISOString();
    for (const [id, status, days] of [
      ['old-received', 'received', 8],
      ['old-pending', 'pending', 30],
      ['new-received', 'received', 6],
    ] as const)
      db.exec(
        `INSERT INTO cash_queue (id, number, device_id, salesperson_user_id, created_at_device, business_date, cash_due,
           handover_status, status, row_version)
         VALUES (?, ?, 'c3', 'sara', ?, '2026-11-02', 100, ?, 'finalized', '1')`,
        [id, id, at(days), status],
      );
    pruneDocuments(db, T0);
    expect(db.selectObjects('SELECT id FROM cash_queue ORDER BY id').map((r) => r['id'])).toEqual([
      'new-received',
      'old-pending',
    ]);
  });
});

describe('local health (PLT-09)', () => {
  it('counts waiting and quarantined bills, the oldest, events waiting and the last contact', () => {
    addDoc(1, { createdAtMs: T0 });
    addDoc(2, { outbox: 'quarantined', createdAtMs: T0 + 1000 });
    recordPinEvent(db, { kind: 'locked', userId: SARA, byUserId: null, at: iso(T0) });
    setSync(db, 'last_pull_at', iso(T0 + 2000));
    setSync(db, 'last_push_at', iso(T0 + 3000));
    setSync(db, 'last_contact_at', iso(T0 + 3000));
    expect(localHealth(db)).toEqual({
      outboxCount: 2,
      oldestUnsyncedAt: iso(T0),
      quarantinedCount: 1,
      lastPullAt: iso(T0 + 2000),
      lastPushAt: iso(T0 + 3000),
      lastContactAt: iso(T0 + 3000),
      eventsWaiting: 1,
    });
  });
});
