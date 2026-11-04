import { withTenant } from '@erp/db';
import type pg from 'pg';

import { postCashMovement, postCollection, postSession } from '../cash';
import { postHandover } from '../handover';
import { postSale } from '../sale';
import { postVoid } from '../void';
import type { PostingContext, PostingException, PostingResult } from '../types';
import {
  loadCashMovement,
  loadCollection,
  loadContext,
  loadHandover,
  loadLineCosts,
  loadSale,
  loadSalePosting,
  loadSessionEvent,
  loadState,
  loadStateOf,
  loadVoid,
  withReturnCosts,
} from './load';
import { writePosting } from './write';

// Posting against the database (architecture §5.2 step 4, §7; W1-08; handovers W1-10; collections, cash-outs and
// sessions W1-11). The only writer of the ledger
// tables (rule 4). `postDocument` runs inside the caller's tenant transaction (`withTenant`), under its own savepoint:
// a posting that fails is rolled back alone, the document stays accepted (SYN-03) and gets a `posting_failed`
// exception.

export type SourceType =
  'sale' | 'cash_handover' | 'payment' | 'cash_movement' | 'cash_session' | 'sales_void';

/**
 * Where each kind of document lives, which row holds it, and whom an exception on it belongs to. Constants, never
 * input. A session's open posts under the session's id and its close under the close document's id.
 */
const SOURCES: Record<
  SourceType,
  { table: string; documentType: string; userColumn: string; byClose?: true }
> = {
  sale: { table: 'sales_documents', documentType: 'sales_document', userColumn: 'salesperson_user_id' },
  cash_handover: { table: 'cash_handovers', documentType: 'cash_handover', userColumn: 'cashier_user_id' },
  payment: { table: 'payments', documentType: 'payment', userColumn: 'cashier_user_id' },
  cash_movement: { table: 'cash_movements', documentType: 'cash_movement', userColumn: 'cashier_user_id' },
  cash_session: {
    table: 'cash_sessions',
    documentType: 'cash_session',
    userColumn: 'cashier_user_id',
    byClose: true,
  },
  sales_void: { table: 'sales_voids', documentType: 'sales_void', userColumn: 'voided_by_user_id' },
};

/** The SQL that finds a source's row by the document id in `$n`. */
const rowOf = (src: (typeof SOURCES)[SourceType], n: number, alias = '') =>
  src.byClose ? `(${alias}id = $${n} OR ${alias}close_document_id = $${n})` : `${alias}id = $${n}`;

export type PostOutcome =
  | { status: 'posted'; seq: number; journalNumber: string | null; exceptions: PostingException['kind'][] }
  | { status: 'already_posted' }
  | { status: 'failed'; code: string; message?: string };

const SEVERITY: Record<PostingException['kind'] | 'posting_failed', 'low' | 'medium' | 'high'> = {
  no_cost: 'low',
  negative_stock: 'low',
  posted_after_lock: 'medium',
  posting_failed: 'high',
};

const journalNumber = (n: number) => `J${String(n).padStart(6, '0')}`;

/**
 * Takes the tenant's posting order lock (D-017) for the rest of the caller's transaction and returns the last posting
 * and journal numbers. Push takes it before judging a sale on account (W1-09), so the balance it reads can't move
 * until that sale is posted, and it is the same lock, in the same order, as every posting.
 */
export async function holdPostingOrder(
  c: pg.ClientBase,
  tenantId: string,
): Promise<{ lastSeq: number; lastJournalNo: number }> {
  await c.query('INSERT INTO erp.posting_state (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenantId]);
  const { rows } = await c.query<{ last_seq: string; last_journal_no: string }>(
    'SELECT last_seq, last_journal_no FROM erp.posting_state WHERE tenant_id = $1 FOR UPDATE',
    [tenantId],
  );
  return { lastSeq: Number(rows[0]!.last_seq), lastJournalNo: Number(rows[0]!.last_journal_no) };
}

export async function postDocument(
  c: pg.ClientBase,
  source: { tenantId: string; type: SourceType; id: string; now: Date },
): Promise<PostOutcome> {
  const { tenantId, id } = source;
  const src = SOURCES[source.type];
  // The document's own row gives an exception its device, person and day, so one can be written even when the
  // posting failed before the document was read.
  const exception = async (kind: PostingException['kind'] | 'posting_failed', details: object) => {
    const r = await c.query(
      `INSERT INTO erp.exceptions (tenant_id, kind, severity, document_type, document_id, device_id, user_id,
         business_date, details)
       SELECT $1, $2, $3, $6, $4, d.device_id, d.${src.userColumn}, d.business_date, $5
       FROM erp.${src.table} d WHERE ${rowOf(src, 4, 'd.')}
       ON CONFLICT (tenant_id, document_id) WHERE kind = 'posting_failed' DO NOTHING`,
      [tenantId, kind, SEVERITY[kind], id, details, src.documentType],
    );
    if (r.rowCount)
      await c.query(
        `UPDATE erp.${src.table} SET exception_count = exception_count + 1 WHERE ${rowOf(src, 1)}`,
        [id],
      );
  };

  // Everything from the lock on is under the savepoint: whatever fails, the sale stays accepted (SYN-03).
  await c.query('SAVEPOINT posting');
  try {
    // Postings of a tenant run one at a time, in a recorded order (D-017). Checked again once the lock is held, so
    // two catch-ups can't post the same document.
    const numbers = await holdPostingOrder(c, tenantId);
    const posted = await c.query('SELECT 1 FROM erp.postings WHERE source_type = $1 AND source_id = $2', [
      source.type,
      id,
    ]);
    if (posted.rowCount) {
      await c.query('RELEASE SAVEPOINT posting');
      return { status: 'already_posted' };
    }
    const { context, result } = await compute(c, source.type, id);
    if (!result.ok) {
      await c.query('ROLLBACK TO SAVEPOINT posting');
      await exception('posting_failed', { code: result.error.code });
      return { status: 'failed', code: result.error.code };
    }
    const p = result.posting;
    const seq = numbers.lastSeq + 1;
    const journal = p.journal.lines.length > 0 ? numbers.lastJournalNo + 1 : null;
    await c.query(
      'UPDATE erp.posting_state SET last_seq = $2, last_journal_no = coalesce($3, last_journal_no) WHERE tenant_id = $1',
      [tenantId, seq, journal],
    );
    await writePosting(
      c,
      tenantId,
      { type: source.type, id },
      p,
      context,
      { seq, journalNumber: journal === null ? null : journalNumber(journal) },
      source.now,
    );
    for (const e of p.exceptions) await exception(e.kind, e.details);
    // A bill held by an earlier failure is posted now: say so on its exception, which stays for review.
    await c.query(
      `UPDATE erp.exceptions SET details = details || jsonb_build_object('postedAt', $2::timestamptz)
       WHERE document_id = $1 AND kind = 'posting_failed'`,
      [id, source.now],
    );
    await c.query('RELEASE SAVEPOINT posting');
    return {
      status: 'posted',
      seq,
      journalNumber: journal === null ? null : journalNumber(journal),
      exceptions: [...new Set(p.exceptions.map((e) => e.kind))].sort(),
    };
  } catch (err) {
    // A bug, a lock timeout or a database error must not lose the sale: it stays accepted, unposted and flagged.
    await c.query('ROLLBACK TO SAVEPOINT posting');
    const message = (err as Error).message;
    await exception('posting_failed', { code: 'internal_error', message });
    return { status: 'failed', code: 'internal_error', message };
  }
}

/** Loads a document and posts it in memory against the settings and state as they are now. */
async function compute(
  c: pg.ClientBase,
  type: SourceType,
  id: string,
): Promise<{ context: PostingContext; result: PostingResult }> {
  const missing = () => new Error(`no ${type} ${id} to post`);
  if (type === 'cash_handover') {
    // A duplicate loads as null like a missing row: it is never posted (W1-10).
    const handover = await loadHandover(c, id);
    if (!handover) throw missing();
    const context = await loadContext(c, null);
    return { context, result: postHandover(handover, context) };
  }
  if (type === 'payment') {
    const doc = await loadCollection(c, id);
    if (!doc) throw missing();
    const context = await loadContext(c, null);
    return { context, result: postCollection(doc, context) };
  }
  if (type === 'cash_movement') {
    const doc = await loadCashMovement(c, id);
    if (!doc) throw missing();
    const context = await loadContext(c, null, doc.targetId);
    return { context, result: postCashMovement(doc, context) };
  }
  if (type === 'cash_session') {
    const doc = await loadSessionEvent(c, id);
    if (!doc) throw missing();
    const context = await loadContext(c, null);
    return { context, result: postSession(doc, context) };
  }
  if (type === 'sales_void') {
    // A duplicate, or a void whose bill hasn't arrived, loads as null: it never posts (W1-12).
    const v = await loadVoid(c, id);
    if (!v) throw missing();
    const context = await loadContext(c, null);
    const original = await loadSalePosting(c, v.saleId);
    if (original === null) return { context, result: { ok: false, error: { code: 'sale_not_posted' } } };
    const state = await loadStateOf(
      c,
      original.movements.map((m) => m.itemId),
      original.movements.map((m) => m.locationId),
    );
    return { context, result: postVoid(v.void, original, context, state) };
  }
  const loaded = await loadSale(c, id);
  if (!loaded) throw new Error(`no ${type} ${id} to post`);
  const context = await loadContext(c, loaded.sale.customerId);
  // A return comes back at its original lines' costs, so it posts only after them (W1-13).
  const costs = await loadLineCosts(c, [...loaded.originals.values()]);
  const sale = withReturnCosts(loaded.sale, loaded.originals, (line) => costs.get(line));
  if (sale === null) return { context, result: { ok: false, error: { code: 'original_not_posted' } } };
  return { context, result: postSale(sale, context, await loadState(c, sale)) };
}

/** Returns of this bill that are waiting for it to post (W1-13): accepted, not posted yet, oldest first. */
export async function waitingReturns(c: pg.ClientBase, billId: string): Promise<string[]> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT d.id FROM erp.sales_documents d
     WHERE EXISTS (SELECT 1 FROM erp.sales_lines r JOIN erp.sales_lines o ON o.id = r.original_line_id
                   WHERE r.document_id = d.id AND o.document_id = $1)
       AND NOT EXISTS (SELECT 1 FROM erp.postings p WHERE p.source_type = 'sale' AND p.source_id = d.id)
     ORDER BY d.received_at, d.id`,
    [billId],
  );
  return rows.map((r) => r.id);
}

interface Pending {
  id: string;
  type: SourceType;
  received_at: Date;
  device_id: string;
  seq: number;
}

/**
 * Posts every accepted document of the tenant that has no posting yet (sales, handovers that aren't duplicates,
 * collections, cash movements, session opens and closes),
 * in arrival order: oldest received first, and a device's documents of one push (received together) in their
 * sequence order. It pages through all of them, so documents that never post can't hold back the ones behind them.
 */
export async function postPending(
  pool: pg.Pool,
  tenantId: string,
  opts: { now: () => Date; pageSize?: number },
): Promise<{ posted: number; failed: number }> {
  const pageSize = opts.pageSize ?? 500;
  const counts = { posted: 0, failed: 0 };
  let after: Pending | null = null;
  for (;;) {
    const from: Pending | null = after;
    const page: Pending[] = await withTenant(
      pool,
      { tenantId },
      async (_db, c) =>
        (
          await c.query<Pending>(
            `SELECT * FROM (
               SELECT d.id, 'sale' AS type, d.received_at, d.device_id, d.seq FROM erp.sales_documents d
               WHERE NOT EXISTS (SELECT 1 FROM erp.postings p WHERE p.source_type = 'sale' AND p.source_id = d.id)
                 -- A return posts once the bill it returns has posted (W1-13).
                 AND NOT EXISTS (SELECT 1 FROM erp.sales_lines rl JOIN erp.sales_lines ol ON ol.id = rl.original_line_id
                                 WHERE rl.document_id = d.id
                                   AND NOT EXISTS (SELECT 1 FROM erp.postings p
                                                   WHERE p.source_type = 'sale' AND p.source_id = ol.document_id))
               UNION ALL
               SELECT h.id, 'cash_handover', h.received_at, h.device_id, h.seq FROM erp.cash_handovers h
               WHERE h.duplicate_of_id IS NULL
                 AND NOT EXISTS (SELECT 1 FROM erp.postings p
                                 WHERE p.source_type = 'cash_handover' AND p.source_id = h.id)
               UNION ALL
               SELECT r.id, 'payment', r.received_at, r.device_id, r.seq FROM erp.payments r
               WHERE NOT EXISTS (SELECT 1 FROM erp.postings p WHERE p.source_type = 'payment' AND p.source_id = r.id)
               UNION ALL
               SELECT m.id, 'cash_movement', m.received_at, m.device_id, m.seq FROM erp.cash_movements m
               WHERE NOT EXISTS (SELECT 1 FROM erp.postings p
                                 WHERE p.source_type = 'cash_movement' AND p.source_id = m.id)
               UNION ALL
               SELECT z.id, 'cash_session', z.created_at, z.device_id, (z.payload->>'seq')::int
               FROM erp.cash_sessions z
               WHERE NOT EXISTS (SELECT 1 FROM erp.postings p
                                 WHERE p.source_type = 'cash_session' AND p.source_id = z.id)
               UNION ALL
               -- A void posts once its bill has posted (it swaps the bill's posting, W1-12).
               SELECT v.id, 'sales_void', v.received_at, v.device_id, v.seq FROM erp.sales_voids v
               WHERE v.duplicate_of_id IS NULL AND v.sale_document_id IS NOT NULL
                 AND EXISTS (SELECT 1 FROM erp.postings p WHERE p.source_type = 'sale' AND p.source_id = v.sale_document_id)
                 AND NOT EXISTS (SELECT 1 FROM erp.postings p WHERE p.source_type = 'sales_void' AND p.source_id = v.id)
               UNION ALL
               SELECT z.close_document_id, 'cash_session', z.closed_at, z.device_id, (z.close_payload->>'seq')::int
               FROM erp.cash_sessions z
               WHERE z.close_document_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM erp.postings p
                                 WHERE p.source_type = 'cash_session' AND p.source_id = z.close_document_id)
             ) pending
             WHERE $1::timestamptz IS NULL
                OR (received_at, device_id, type, seq) > ($1, $2::uuid, $3::text, $4::int)
             ORDER BY received_at, device_id, type, seq LIMIT $5`,
            [
              from?.received_at ?? null,
              from?.device_id ?? null,
              from?.type ?? null,
              from?.seq ?? null,
              pageSize,
            ],
          )
        ).rows,
    );
    for (const { id, type } of page) {
      const outcome = await withTenant(pool, { tenantId }, async (_db, c) => {
        const o = await postDocument(c, { tenantId, type, id, now: opts.now() });
        // A return held back for this bill posts right after it (W1-13), in the same transaction.
        if (o.status === 'posted' && type === 'sale')
          for (const r of await waitingReturns(c, id)) {
            const after = await postDocument(c, { tenantId, type: 'sale', id: r, now: opts.now() });
            if (after.status === 'posted') counts.posted += 1;
            else if (after.status === 'failed') counts.failed += 1;
          }
        return o;
      });
      if (outcome.status === 'posted') counts.posted += 1;
      else if (outcome.status === 'failed') counts.failed += 1;
    }
    if (page.length < pageSize) return counts;
    after = page.at(-1)!;
  }
}
