import type pg from 'pg';

// Posting against the database (architecture §5.2 step 4, §7; W1-08). The only writer of the ledger tables (rule 4).
// `postDocument` runs inside the caller's tenant transaction (`withTenant`), under its own savepoint: a posting that
// fails is rolled back alone, the document stays accepted (SYN-03) and gets a `posting_failed` exception.

export type SourceType = 'sale';

export type PostOutcome =
  | { status: 'posted'; seq: number; journalNumber: string }
  | { status: 'already_posted' }
  | { status: 'failed'; code: string };

export function postDocument(
  c: pg.ClientBase,
  source: { tenantId: string; type: SourceType; id: string; now: Date },
): Promise<PostOutcome> {
  void c;
  void source;
  return Promise.reject(new Error('postDocument is not built yet (W1-08)'));
}

/** Posts every accepted document of the tenant that has no posting yet, oldest received first. */
export function postPending(
  pool: pg.Pool,
  tenantId: string,
  opts: { now: () => Date },
): Promise<{ posted: number; failed: number }> {
  void pool;
  void tenantId;
  void opts;
  return Promise.reject(new Error('postPending is not built yet (W1-08)'));
}
