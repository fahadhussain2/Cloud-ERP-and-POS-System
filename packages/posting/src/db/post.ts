import { withTenant } from '@erp/db';
import type pg from 'pg';

import { postSale } from '../sale';
import type { PostingException } from '../types';
import { loadContext, loadSale, loadState } from './load';
import { writePosting } from './write';

// Posting against the database (architecture §5.2 step 4, §7; W1-08). The only writer of the ledger tables (rule 4).
// `postDocument` runs inside the caller's tenant transaction (`withTenant`), under its own savepoint: a posting that
// fails is rolled back alone, the document stays accepted (SYN-03) and gets a `posting_failed` exception.

export type SourceType = 'sale';

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

export async function postDocument(
  c: pg.ClientBase,
  source: { tenantId: string; type: SourceType; id: string; now: Date },
): Promise<PostOutcome> {
  const { tenantId, id } = source;
  // Postings of a tenant run one at a time, in a recorded order (D-017). Checked again once the lock is held, so two
  // catch-ups can't post the same document.
  await c.query('INSERT INTO erp.posting_state (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenantId]);
  const numbers = await c.query<{ last_seq: string; last_journal_no: string }>(
    'SELECT last_seq, last_journal_no FROM erp.posting_state WHERE tenant_id = $1 FOR UPDATE',
    [tenantId],
  );
  const posted = await c.query('SELECT 1 FROM erp.postings WHERE source_type = $1 AND source_id = $2', [
    source.type,
    id,
  ]);
  if (posted.rowCount) return { status: 'already_posted' };

  const loaded = await loadSale(c, id);
  if (!loaded) throw new Error(`no ${source.type} ${id} to post`);
  const exception = async (kind: PostingException['kind'] | 'posting_failed', details: object) => {
    const r = await c.query(
      `INSERT INTO erp.exceptions (tenant_id, kind, severity, document_type, document_id, device_id, user_id,
         business_date, details)
       VALUES ($1, $2, $3, 'sales_document', $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, document_id) WHERE kind = 'posting_failed' DO NOTHING`,
      [
        tenantId,
        kind,
        SEVERITY[kind],
        id,
        loaded.deviceId,
        loaded.sellerId,
        loaded.sale.businessDate,
        details,
      ],
    );
    if (r.rowCount)
      await c.query('UPDATE erp.sales_documents SET exception_count = exception_count + 1 WHERE id = $1', [
        id,
      ]);
  };

  await c.query('SAVEPOINT posting');
  try {
    const context = await loadContext(c, loaded.sale.customerId);
    const result = postSale(loaded.sale, context, await loadState(c, loaded.sale));
    if (!result.ok) {
      await c.query('ROLLBACK TO SAVEPOINT posting');
      await exception('posting_failed', { code: result.error.code });
      return { status: 'failed', code: result.error.code };
    }
    const p = result.posting;
    const seq = Number(numbers.rows[0]!.last_seq) + 1;
    const journal = p.journal.lines.length > 0 ? Number(numbers.rows[0]!.last_journal_no) + 1 : null;
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
    // A bug or a database error must not lose the sale: it stays accepted, unposted and flagged.
    await c.query('ROLLBACK TO SAVEPOINT posting');
    const message = (err as Error).message;
    await exception('posting_failed', { code: 'internal_error', message });
    return { status: 'failed', code: 'internal_error', message };
  }
}

/**
 * Posts every accepted document of the tenant that has no posting yet, in arrival order: oldest received first, and a
 * counter's documents of one push (received together) in their sequence order.
 */
export async function postPending(
  pool: pg.Pool,
  tenantId: string,
  opts: { now: () => Date },
): Promise<{ posted: number; failed: number }> {
  const pending = await withTenant(
    pool,
    { tenantId },
    async (_db, c) =>
      (
        await c.query<{ id: string }>(
          `SELECT d.id FROM erp.sales_documents d
         WHERE NOT EXISTS (SELECT 1 FROM erp.postings p WHERE p.source_type = 'sale' AND p.source_id = d.id)
         ORDER BY d.received_at, d.device_id, d.seq LIMIT 500`,
        )
      ).rows,
  );
  const counts = { posted: 0, failed: 0 };
  for (const { id } of pending) {
    const outcome = await withTenant(pool, { tenantId }, (_db, c) =>
      postDocument(c, { tenantId, type: 'sale', id, now: opts.now() }),
    );
    if (outcome.status === 'posted') counts.posted += 1;
    else if (outcome.status === 'failed') counts.failed += 1;
  }
  return counts;
}
