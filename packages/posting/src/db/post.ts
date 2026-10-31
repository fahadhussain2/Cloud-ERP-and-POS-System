import { withTenant } from '@erp/db';
import type pg from 'pg';

import { postHandover } from '../handover';
import { postSale } from '../sale';
import type { PostingContext, PostingException, PostingResult } from '../types';
import { loadContext, loadHandover, loadSale, loadState } from './load';
import { writePosting } from './write';

// Posting against the database (architecture §5.2 step 4, §7; W1-08; handovers W1-10). The only writer of the ledger
// tables (rule 4). `postDocument` runs inside the caller's tenant transaction (`withTenant`), under its own savepoint:
// a posting that fails is rolled back alone, the document stays accepted (SYN-03) and gets a `posting_failed`
// exception.

export type SourceType = 'sale' | 'cash_handover';

/** Where each kind of document lives, and whom an exception on it belongs to. Constants, never input. */
const SOURCES: Record<SourceType, { table: string; documentType: string; userColumn: string }> = {
  sale: { table: 'sales_documents', documentType: 'sales_document', userColumn: 'salesperson_user_id' },
  cash_handover: { table: 'cash_handovers', documentType: 'cash_handover', userColumn: 'cashier_user_id' },
};

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
       SELECT $1, $2, $3, $6, d.id, d.device_id, d.${src.userColumn}, d.business_date, $5
       FROM erp.${src.table} d WHERE d.id = $4
       ON CONFLICT (tenant_id, document_id) WHERE kind = 'posting_failed' DO NOTHING`,
      [tenantId, kind, SEVERITY[kind], id, details, src.documentType],
    );
    if (r.rowCount)
      await c.query(`UPDATE erp.${src.table} SET exception_count = exception_count + 1 WHERE id = $1`, [id]);
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
  if (type === 'cash_handover') {
    // A duplicate loads as null like a missing row: it is never posted (W1-10).
    const handover = await loadHandover(c, id);
    if (!handover) throw new Error(`no ${type} ${id} to post`);
    const context = await loadContext(c, null);
    return { context, result: postHandover(handover, context) };
  }
  const loaded = await loadSale(c, id);
  if (!loaded) throw new Error(`no ${type} ${id} to post`);
  const context = await loadContext(c, loaded.sale.customerId);
  return { context, result: postSale(loaded.sale, context, await loadState(c, loaded.sale)) };
}

interface Pending {
  id: string;
  type: SourceType;
  received_at: Date;
  device_id: string;
  seq: number;
}

/**
 * Posts every accepted document of the tenant that has no posting yet (sales, and handovers that aren't duplicates),
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
               UNION ALL
               SELECT h.id, 'cash_handover', h.received_at, h.device_id, h.seq FROM erp.cash_handovers h
               WHERE h.duplicate_of_id IS NULL
                 AND NOT EXISTS (SELECT 1 FROM erp.postings p
                                 WHERE p.source_type = 'cash_handover' AND p.source_id = h.id)
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
      const outcome = await withTenant(pool, { tenantId }, (_db, c) =>
        postDocument(c, { tenantId, type, id, now: opts.now() }),
      );
      if (outcome.status === 'posted') counts.posted += 1;
      else if (outcome.status === 'failed') counts.failed += 1;
    }
    if (page.length < pageSize) return counts;
    after = page.at(-1)!;
  }
}
