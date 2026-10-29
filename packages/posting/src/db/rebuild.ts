import type pg from 'pg';

// The rebuild (ACC-02, architecture §7, W1-08). The check replays every posting in memory, in `postings` order with
// each one's recorded context, and compares the result with the stored ledgers; it reads one snapshot and writes
// nothing. Apply rewrites the derived rows from the same replay, as the owner role, and never on a locked period.

export interface RebuildCheck {
  /** One readable line per difference; empty when the ledgers match the documents. */
  differences: string[];
}

export function checkRebuild(pool: pg.Pool, tenantId: string): Promise<RebuildCheck> {
  void pool;
  void tenantId;
  return Promise.reject(new Error('checkRebuild is not built yet (W1-08)'));
}

export class RebuildRefused extends Error {
  constructor(readonly code: 'locked_period') {
    super(`rebuild refused: ${code}`);
  }
}

/** Rewrites the tenant's ledgers from the replay; throws `RebuildRefused` when a posting is on or before the lock date. */
export function applyRebuild(
  ownerUrl: string,
  tenantId: string,
  opts: { userId: string | null; now: Date },
): Promise<{ postings: number }> {
  void ownerUrl;
  void tenantId;
  void opts;
  return Promise.reject(new Error('applyRebuild is not built yet (W1-08)'));
}
