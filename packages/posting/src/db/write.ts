import { costFloor } from '@erp/domain';
import type pg from 'pg';

import type { LedgerState, Posting, PostingContext } from '../types';
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

  // Each kind of row in one statement: an opening has a line per item (about 20,000 for Delux), and the final run may
  // write over a tunnel, so row-by-row round trips would take hours (W1-14).
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
    const lines = posting.journal.lines;
    await c.query(
      `INSERT INTO erp.journal_lines (tenant_id, entry_id, line_no, account_id, party_id, branch_id, debit, credit)
       SELECT $1, $2, l.line_no, l.account_id, l.party_id, $3, l.debit, l.credit
       FROM unnest($4::int[], $5::uuid[], $6::uuid[], $7::bigint[], $8::bigint[])
         AS l (line_no, account_id, party_id, debit, credit)`,
      [
        tenantId,
        entry.rows[0]!.id,
        posting.journal.branchId,
        lines.map((_, i) => i + 1),
        lines.map((l) => l.accountId),
        lines.map((l) => l.partyId),
        lines.map((l) => l.debit),
        lines.map((l) => l.credit),
      ],
    );
  }

  const moves = posting.movements;
  if (moves.length > 0)
    await c.query(
      `INSERT INTO erp.stock_movements (tenant_id, posting_seq, item_id, location_id, qty_delta, unit_cost, value_delta,
         avg_cost_after, source_type, source_id, source_line_id, business_date, posted_at)
       SELECT $1, $2, m.item_id, m.location_id, m.qty::numeric / 1000, m.unit_cost, m.value_delta, m.avg_cost_after,
         $3, $4, m.line_id, $5, $6
       FROM unnest($7::uuid[], $8::uuid[], $9::bigint[], $10::bigint[], $11::bigint[], $12::bigint[], $13::uuid[])
         WITH ORDINALITY AS m (item_id, location_id, qty, unit_cost, value_delta, avg_cost_after, line_id, n)
       ORDER BY m.n`,
      [
        tenantId,
        seq,
        source.type,
        source.id,
        posting.entryDate,
        postedAt,
        moves.map((m) => m.itemId),
        moves.map((m) => m.locationId),
        moves.map((m) => m.qtyDelta),
        moves.map((m) => m.unitCost),
        moves.map((m) => m.valueDelta),
        moves.map((m) => m.avgCostAfter),
        moves.map((m) => m.sourceLineId),
      ],
    );

  const entries = posting.partyEntries;
  if (entries.length > 0) {
    await c.query(
      `INSERT INTO erp.party_ledger_entries (tenant_id, posting_seq, party_id, role, entry_date, due_date, amount,
         source_type, source_id, memo, posted_at)
       SELECT $1, $2, e.party_id, e.role, $3, e.due_date, e.amount, $4, $5, $6, $7
       FROM unnest($8::uuid[], $9::text[], $10::date[], $11::bigint[]) WITH ORDINALITY
         AS e (party_id, role, due_date, amount, n)
       ORDER BY e.n`,
      [
        tenantId,
        seq,
        posting.entryDate,
        source.type,
        source.id,
        posting.journal.memo,
        postedAt,
        entries.map((p) => p.partyId),
        entries.map((p) => p.role),
        entries.map((p) => p.dueDate),
        entries.map((p) => p.amount),
      ],
    );
    // One party may have several entries in one posting: summed first, so the upsert touches each row once.
    await c.query(
      `INSERT INTO erp.party_balances (tenant_id, party_id, role, balance, updated_at)
       SELECT $1, e.party_id, e.role, sum(e.amount), $2
       FROM unnest($3::uuid[], $4::text[], $5::bigint[]) AS e (party_id, role, amount)
       GROUP BY e.party_id, e.role
       ON CONFLICT (tenant_id, party_id, role)
       DO UPDATE SET balance = erp.party_balances.balance + EXCLUDED.balance, updated_at = EXCLUDED.updated_at`,
      [
        tenantId,
        postedAt,
        entries.map((p) => p.partyId),
        entries.map((p) => p.role),
        entries.map((p) => p.amount),
      ],
    );
  }

  const costs = Object.entries(posting.state.costs);
  if (costs.length > 0)
    await c.query(
      `INSERT INTO erp.item_costs (tenant_id, item_id, avg_cost, on_hand, updated_at)
       SELECT $1, k.item_id, k.avg_cost, k.on_hand::numeric / 1000, $2
       FROM unnest($3::uuid[], $4::bigint[], $5::bigint[]) AS k (item_id, avg_cost, on_hand)
       ON CONFLICT (tenant_id, item_id)
       DO UPDATE SET avg_cost = EXCLUDED.avg_cost, on_hand = EXCLUDED.on_hand, updated_at = EXCLUDED.updated_at`,
      [
        tenantId,
        postedAt,
        costs.map(([i]) => i),
        costs.map(([, k]) => k.avgCost),
        costs.map(([, k]) => k.onHand),
      ],
    );
  // An opening's last purchases (migration doc §5): rows its stock lines just wrote.
  const last = posting.lastPurchases ?? [];
  if (last.length > 0)
    await c.query(
      `UPDATE erp.item_costs k SET last_cost = p.cost, last_supplier_id = p.supplier_id, last_receipt_at = p.at
       FROM unnest($1::uuid[], $2::bigint[], $3::uuid[], $4::timestamptz[]) AS p (item_id, cost, supplier_id, at)
       WHERE k.item_id = p.item_id`,
      [
        last.map((p) => p.itemId),
        last.map((p) => p.lastCost),
        last.map((p) => p.lastSupplierId),
        last.map((p) => p.lastReceiptAt),
      ],
    );
  await writeFloors(c, tenantId, posting.state.costs, postedAt);

  const balances = Object.entries(posting.state.balances).flatMap(([locationId, items]) =>
    Object.entries(items).map(([itemId, qty]) => ({ locationId, itemId, qty })),
  );
  if (balances.length > 0)
    await c.query(
      `INSERT INTO erp.stock_balances (tenant_id, item_id, location_id, qty, updated_at)
       SELECT $1, b.item_id, b.location_id, b.qty::numeric / 1000, $2
       FROM unnest($3::uuid[], $4::uuid[], $5::bigint[]) AS b (item_id, location_id, qty)
       ON CONFLICT (tenant_id, item_id, location_id)
       DO UPDATE SET qty = EXCLUDED.qty, updated_at = EXCLUDED.updated_at`,
      [
        tenantId,
        postedAt,
        balances.map((b) => b.itemId),
        balances.map((b) => b.locationId),
        balances.map((b) => b.qty),
      ],
    );
}

/**
 * The floor from cost for each item whose average a posting set (CAT-06, D-092, W1-14): written when it changed,
 * marked deleted when the item has no cost or its category no margin. Unchanged floors aren't touched, so a sale
 * doesn't send its items to every counter again.
 */
export async function writeFloors(
  c: pg.ClientBase,
  tenantId: string,
  costs: LedgerState['costs'],
  at: Date,
): Promise<void> {
  const items = Object.keys(costs);
  if (items.length === 0) return;
  const { rows } = await c.query<{ id: string; margin: string | null }>(
    `SELECT i.id, c.pricing_rule->>'floor_min_margin_bp' AS margin
     FROM erp.items i LEFT JOIN erp.categories c ON c.id = i.category_id
     WHERE i.id = ANY($1::uuid[])`,
    [items],
  );
  const floors = rows.map((r) => ({
    itemId: r.id,
    floor: costFloor(costs[r.id]!.avgCost, r.margin === null ? null : Number(r.margin)),
  }));
  const set = floors.filter((f) => f.floor !== null);
  const unset = floors.filter((f) => f.floor === null).map((f) => f.itemId);
  if (set.length > 0)
    await c.query(
      `INSERT INTO erp.item_floors (tenant_id, item_id, floor, updated_at)
       SELECT $1, f.item_id, f.floor, $2 FROM unnest($3::uuid[], $4::bigint[]) AS f (item_id, floor)
       ON CONFLICT (tenant_id, item_id) DO UPDATE SET floor = EXCLUDED.floor, updated_at = EXCLUDED.updated_at,
         deleted_at = NULL
       WHERE erp.item_floors.floor IS DISTINCT FROM EXCLUDED.floor OR erp.item_floors.deleted_at IS NOT NULL`,
      [tenantId, at, set.map((f) => f.itemId), set.map((f) => f.floor)],
    );
  if (unset.length > 0)
    await c.query(
      `UPDATE erp.item_floors SET deleted_at = $1, updated_at = $1
       WHERE item_id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [at, unset],
    );
}
