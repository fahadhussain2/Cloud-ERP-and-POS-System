import type pg from 'pg';

import type { Posting, PostingContext } from '../types';
import type { SourceType } from './post';

// Writing one posting's rows (rule 4): the order-of-record row, the journal entry and lines, the stock movements,
// the party entries, and the balances beside them. Used by live posting and by the rebuild's apply, which keeps the
// existing order-of-record row. The caller holds the tenant's `posting_state` lock and passes the seq and journal
// number it took.

export interface Numbers {
  seq: number;
  /** null when the posting has no journal lines. */
  journalNumber: string | null;
}

export async function writePosting(
  c: pg.ClientBase,
  tenantId: string,
  source: { type: SourceType; id: string },
  posting: Posting,
  context: PostingContext,
  numbers: Numbers,
  postedAt: Date,
  opts: { orderRow: boolean } = { orderRow: true },
): Promise<void> {
  const { seq } = numbers;
  if (opts.orderRow)
    await c.query(
      `INSERT INTO erp.postings (tenant_id, seq, source_type, source_id, entry_date, posted_at, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, seq, source.type, source.id, posting.entryDate, postedAt, JSON.stringify(context)],
    );

  if (numbers.journalNumber !== null) {
    const entry = await c.query<{ id: string }>(
      `INSERT INTO erp.journal_entries (tenant_id, number, entry_date, source_type, source_id, memo, posting_seq,
         posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        tenantId,
        numbers.journalNumber,
        posting.entryDate,
        source.type,
        source.id,
        posting.journal.memo,
        seq,
        postedAt,
      ],
    );
    for (const [i, l] of posting.journal.lines.entries())
      await c.query(
        `INSERT INTO erp.journal_lines (tenant_id, entry_id, line_no, account_id, party_id, branch_id, debit, credit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tenantId,
          entry.rows[0]!.id,
          i + 1,
          l.accountId,
          l.partyId,
          posting.journal.branchId,
          l.debit,
          l.credit,
        ],
      );
  }

  for (const m of posting.movements)
    await c.query(
      `INSERT INTO erp.stock_movements (tenant_id, posting_seq, item_id, location_id, qty_delta, unit_cost, value_delta,
         avg_cost_after, source_type, source_id, source_line_id, business_date, posted_at)
       VALUES ($1, $2, $3, $4, $5::numeric / 1000, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        tenantId,
        seq,
        m.itemId,
        m.locationId,
        m.qtyDelta,
        m.unitCost,
        m.valueDelta,
        m.avgCostAfter,
        source.type,
        source.id,
        m.sourceLineId,
        posting.entryDate,
        postedAt,
      ],
    );

  for (const p of posting.partyEntries) {
    await c.query(
      `INSERT INTO erp.party_ledger_entries (tenant_id, posting_seq, party_id, role, entry_date, due_date, amount,
         source_type, source_id, memo, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        tenantId,
        seq,
        p.partyId,
        p.role,
        posting.entryDate,
        p.dueDate,
        p.amount,
        source.type,
        source.id,
        posting.journal.memo,
        postedAt,
      ],
    );
    await c.query(
      `INSERT INTO erp.party_balances (tenant_id, party_id, role, balance, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, party_id, role)
       DO UPDATE SET balance = erp.party_balances.balance + EXCLUDED.balance, updated_at = EXCLUDED.updated_at`,
      [tenantId, p.partyId, p.role, p.amount, postedAt],
    );
  }

  for (const [itemId, cost] of Object.entries(posting.state.costs))
    await c.query(
      `INSERT INTO erp.item_costs (tenant_id, item_id, avg_cost, on_hand, updated_at)
       VALUES ($1, $2, $3, $4::numeric / 1000, $5)
       ON CONFLICT (tenant_id, item_id)
       DO UPDATE SET avg_cost = EXCLUDED.avg_cost, on_hand = EXCLUDED.on_hand, updated_at = EXCLUDED.updated_at`,
      [tenantId, itemId, cost.avgCost, cost.onHand, postedAt],
    );
  for (const [locationId, items] of Object.entries(posting.state.balances))
    for (const [itemId, qty] of Object.entries(items))
      await c.query(
        `INSERT INTO erp.stock_balances (tenant_id, item_id, location_id, qty, updated_at)
         VALUES ($1, $2, $3, $4::numeric / 1000, $5)
         ON CONFLICT (tenant_id, item_id, location_id)
         DO UPDATE SET qty = EXCLUDED.qty, updated_at = EXCLUDED.updated_at`,
        [tenantId, itemId, locationId, qty, postedAt],
      );
}
