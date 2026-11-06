import pg from 'pg';

import { emptyState, withChanges } from '../replay';
import { postCashMovement, postCollection, postSession } from '../cash';
import { postHandover } from '../handover';
import { postOpening } from '../opening';
import { postGoodsReceipt, postPurchaseReturn, postSupplierPayment } from '../purchasing';
import { postSale } from '../sale';
import { postVoid } from '../void';
import type { LedgerState, Posting, PostingContext, PostingResult } from '../types';
import {
  loadCashMovement,
  loadCollection,
  loadGoodsReceipt,
  loadHandover,
  loadOpening,
  loadPurchaseReturn,
  loadSale,
  loadSessionEvent,
  loadSupplierPayment,
  loadVoid,
  withReturnCosts,
  type LineCost,
} from './load';
import type { SourceType } from './post';
import { writePosting } from './write';

// The rebuild (ACC-02, architecture §7, W1-08). The check replays every posting in memory, in `postings` order with
// each one's recorded context, and compares the result with the stored ledgers; it reads one snapshot and writes
// nothing. Apply rewrites the derived rows from the same replay, as the owner role, and never on a locked period.

export interface RebuildCheck {
  /** One readable line per difference; empty when the ledgers match the documents. */
  differences: string[];
}

export class RebuildRefused extends Error {
  constructor(readonly code: 'locked_period') {
    super(`rebuild refused: ${code}`);
  }
}

interface Replayed {
  seq: number;
  sourceType: SourceType;
  sourceId: string;
  postedAt: Date;
  context: PostingContext;
  /** null when the document can no longer be posted (a difference in itself). */
  posting: Posting | null;
  journalNumber: string | null;
}

/** Every posting of the tenant again, from its document and its recorded context. */
async function replayTenant(c: pg.ClientBase): Promise<{ steps: Replayed[]; state: LedgerState }> {
  const rows = await c.query<{
    seq: string;
    source_type: SourceType;
    source_id: string;
    posted_at: Date;
    context: PostingContext;
  }>('SELECT seq, source_type, source_id, posted_at, context FROM erp.postings ORDER BY seq');
  let state = emptyState();
  let journals = 0;
  const steps: Replayed[] = [];
  // Each sale's replayed posting, for its void to swap (W1-12).
  const sales = new Map<string, Posting>();
  // How each sold line left the stock, for a return of it (W1-13).
  const lineCosts = new Map<string, LineCost>();
  for (const r of rows.rows) {
    let result: PostingResult | null;
    if (r.source_type === 'cash_handover') {
      const handover = await loadHandover(c, r.source_id);
      result = handover ? postHandover(handover, r.context) : null;
    } else if (r.source_type === 'payment') {
      const doc = await loadCollection(c, r.source_id);
      result = doc ? postCollection(doc, r.context) : null;
    } else if (r.source_type === 'cash_movement') {
      const doc = await loadCashMovement(c, r.source_id);
      result = doc ? postCashMovement(doc, r.context) : null;
    } else if (r.source_type === 'cash_session') {
      const doc = await loadSessionEvent(c, r.source_id);
      result = doc ? postSession(doc, r.context) : null;
    } else if (r.source_type === 'opening') {
      const doc = await loadOpening(c, r.source_id);
      result = doc ? postOpening(doc, r.context, state) : null;
    } else if (r.source_type === 'goods_receipt') {
      const doc = await loadGoodsReceipt(c, r.source_id);
      result = doc ? postGoodsReceipt(doc, r.context, state) : null;
    } else if (r.source_type === 'purchase_return') {
      const doc = await loadPurchaseReturn(c, r.source_id);
      result = doc ? postPurchaseReturn(doc, r.context, state) : null;
    } else if (r.source_type === 'supplier_payment') {
      const doc = await loadSupplierPayment(c, r.source_id);
      result = doc ? postSupplierPayment(doc, r.context) : null;
    } else if (r.source_type === 'sales_void') {
      const v = await loadVoid(c, r.source_id);
      const original = v ? sales.get(v.saleId) : undefined;
      result = v && original ? postVoid(v.void, original, r.context, state) : null;
    } else {
      const loaded = await loadSale(c, r.source_id);
      // A return takes its original lines' costs from their replayed movements (W1-13).
      const sale = loaded && withReturnCosts(loaded.sale, loaded.originals, (line) => lineCosts.get(line));
      result = sale ? postSale(sale, r.context, state) : null;
    }
    const posting = result?.ok ? result.posting : null;
    if (posting && r.source_type === 'sale') {
      sales.set(r.source_id, posting);
      for (const m of posting.movements)
        if (m.qtyDelta < 0)
          lineCosts.set(m.sourceLineId, { unitCost: m.unitCost, avgCostAfter: m.avgCostAfter });
    }
    if (posting) state = withChanges(state, posting.state);
    const journalNumber =
      posting && posting.journal.lines.length > 0 ? `J${String((journals += 1)).padStart(6, '0')}` : null;
    steps.push({
      seq: Number(r.seq),
      sourceType: r.source_type,
      sourceId: r.source_id,
      postedAt: r.posted_at,
      context: r.context,
      posting,
      journalNumber,
    });
  }
  return { steps, state };
}

/** Thousandths as the database prints numeric(14,3): 1500 → "1.500", −2000 → "-2.000". */
function qtyText(thousandths: number): string {
  const abs = Math.abs(thousandths);
  return `${thousandths < 0 ? '-' : ''}${Math.trunc(abs / 1000)}.${String(abs % 1000).padStart(3, '0')}`;
}

/** What the replay says the ledger rows are, as comparable text keyed by table and seq. */
function expectedRows(steps: Replayed[], state: LedgerState) {
  const rows = new Map<string, string[]>();
  const add = (key: string, row: string) => rows.set(key, [...(rows.get(key) ?? []), row]);
  const parties = new Map<string, number>();
  for (const s of steps) {
    const p = s.posting;
    if (!p) {
      add(`postings ${s.seq}`, 'can no longer be posted');
      continue;
    }
    add(`postings ${s.seq}`, p.entryDate);
    if (s.journalNumber !== null) {
      add(`journal_entries ${s.seq}`, `${s.journalNumber} ${p.entryDate} ${p.journal.memo}`);
      for (const [i, l] of p.journal.lines.entries())
        add(
          `journal_lines ${s.seq}`,
          `${i + 1} ${l.accountId} ${l.partyId ?? '-'} ${p.journal.branchId} ${l.debit} ${l.credit}`,
        );
    }
    for (const m of p.movements)
      add(
        `stock_movements ${s.seq}`,
        `${m.sourceLineId} ${m.itemId} ${m.locationId} ${qtyText(m.qtyDelta)} ${m.unitCost} ${m.valueDelta} ${m.avgCostAfter ?? '-'} ${p.entryDate}`,
      );
    for (const e of p.partyEntries) {
      add(`party_ledger_entries ${s.seq}`, `${e.partyId} ${e.role} ${p.entryDate} ${e.dueDate} ${e.amount}`);
      parties.set(`${e.partyId} ${e.role}`, (parties.get(`${e.partyId} ${e.role}`) ?? 0) + e.amount);
    }
  }
  for (const [loc, items] of Object.entries(state.balances))
    for (const [item, q] of Object.entries(items))
      if (q !== 0) add('stock_balances', `${item} ${loc} ${qtyText(q)}`);
  for (const [item, k] of Object.entries(state.costs))
    if (k.avgCost !== null || k.onHand !== 0)
      add('item_costs', `${item} ${k.avgCost ?? '-'} ${qtyText(k.onHand)}`);
  for (const [party, balance] of parties) if (balance !== 0) add('party_balances', `${party} ${balance}`);
  return rows;
}

/** The stored ledger rows, as the same text. */
async function storedRows(c: pg.ClientBase) {
  const rows = new Map<string, string[]>();
  const read = async (sql: string) => {
    for (const r of (await c.query<{ key: string; row: string }>(sql)).rows)
      rows.set(r.key, [...(rows.get(r.key) ?? []), r.row]);
  };
  await read(`SELECT 'postings ' || seq AS key, entry_date::text AS row FROM erp.postings`);
  await read(`SELECT 'journal_entries ' || posting_seq AS key, number || ' ' || entry_date || ' ' || coalesce(memo, '')
              AS row FROM erp.journal_entries`);
  await read(`SELECT 'journal_lines ' || e.posting_seq AS key,
                l.line_no || ' ' || l.account_id || ' ' || coalesce(l.party_id::text, '-') || ' ' || l.branch_id || ' '
                || l.debit || ' ' || l.credit AS row
              FROM erp.journal_lines l JOIN erp.journal_entries e ON e.id = l.entry_id ORDER BY l.line_no`);
  await read(`SELECT 'stock_movements ' || posting_seq AS key,
                coalesce(source_line_id::text, '-') || ' ' || item_id || ' ' || location_id || ' ' || qty_delta || ' '
                || unit_cost || ' ' || value_delta || ' ' || coalesce(avg_cost_after::text, '-') || ' ' || business_date
                AS row
              FROM erp.stock_movements`);
  await read(`SELECT 'party_ledger_entries ' || posting_seq AS key,
                party_id || ' ' || role || ' ' || entry_date || ' ' || due_date || ' ' || amount AS row
              FROM erp.party_ledger_entries`);
  await read(`SELECT 'stock_balances' AS key, item_id || ' ' || location_id || ' ' || qty AS row
              FROM erp.stock_balances WHERE qty <> 0`);
  await read(`SELECT 'item_costs' AS key, item_id || ' ' || coalesce(avg_cost::text, '-') || ' ' || on_hand AS row
              FROM erp.item_costs WHERE avg_cost IS NOT NULL OR on_hand <> 0`);
  await read(`SELECT 'party_balances' AS key, party_id || ' ' || role || ' ' || balance AS row
              FROM erp.party_balances WHERE balance <> 0`);
  return rows;
}

function compare(expected: Map<string, string[]>, stored: Map<string, string[]>): string[] {
  const differences: string[] = [];
  const keys = [...new Set([...expected.keys(), ...stored.keys()])].sort();
  for (const key of keys) {
    // Lines keep their order; the other rows are compared as sets.
    const ordered = key.startsWith('journal_lines');
    const want = ordered ? (expected.get(key) ?? []) : [...(expected.get(key) ?? [])].sort();
    const have = ordered ? (stored.get(key) ?? []) : [...(stored.get(key) ?? [])].sort();
    const missing = want.filter((r, i) => (ordered ? have[i] !== r : !have.includes(r)));
    const extra = have.filter((r, i) => (ordered ? want[i] !== r : !want.includes(r)));
    for (const r of missing) differences.push(`${key}: expected ${r}`);
    for (const r of extra) differences.push(`${key}: found ${r}`);
  }
  return differences;
}

const tenantSession = async (c: pg.ClientBase, tenantId: string, userId: string | null) => {
  await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
    tenantId,
    userId ?? '',
  ]);
};

export async function checkRebuild(pool: pg.Pool, tenantId: string): Promise<RebuildCheck> {
  const c = await pool.connect();
  try {
    // One snapshot for the replay and the comparison; live postings carry on meanwhile.
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await tenantSession(c, tenantId, null);
    const { steps, state } = await replayTenant(c);
    return { differences: compare(expectedRows(steps, state), await storedRows(c)) };
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** Rewrites the tenant's ledgers from the replay; throws `RebuildRefused` when a posting is on or before the lock date. */
export async function applyRebuild(
  ownerUrl: string,
  tenantId: string,
  opts: { userId: string | null; now: Date },
): Promise<{ postings: number }> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await tenantSession(c, tenantId, opts.userId);
    // No live posting while the ledgers are rewritten.
    await c.query('INSERT INTO erp.posting_state (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenantId]);
    await c.query('SELECT 1 FROM erp.posting_state WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
    // Rewriting a locked period needs an explicit, audited unlock first (architecture §7).
    const locked = await c.query(
      `SELECT 1 FROM erp.postings p, erp.tenants t WHERE t.lock_date IS NOT NULL AND p.entry_date <= t.lock_date
       LIMIT 1`,
    );
    if (locked.rowCount) throw new RebuildRefused('locked_period');

    const { steps } = await replayTenant(c);
    for (const table of [
      'journal_lines',
      'journal_entries',
      'stock_movements',
      'party_ledger_entries',
      'item_costs',
    ])
      await c.query(`DELETE FROM erp.${table}`);
    // Synced balance rows can't be deleted (rule 8's change feed): they are zeroed and written again.
    await c.query('UPDATE erp.stock_balances SET qty = 0, updated_at = $1', [opts.now]);
    await c.query('UPDATE erp.party_balances SET balance = 0, updated_at = $1', [opts.now]);
    // Floors follow the averages written below; an item left with no cost keeps its floor deleted (W1-14).
    await c.query('UPDATE erp.item_floors SET deleted_at = $1, updated_at = $1 WHERE deleted_at IS NULL', [
      opts.now,
    ]);
    let journals = 0;
    for (const s of steps) {
      if (!s.posting)
        throw new Error(`posting ${s.seq} (${s.sourceType} ${s.sourceId}) can no longer be posted`);
      await c.query('UPDATE erp.postings SET entry_date = $2 WHERE seq = $1', [s.seq, s.posting.entryDate]);
      if (s.journalNumber !== null) journals += 1;
      await writePosting(
        c,
        tenantId,
        { type: s.sourceType, id: s.sourceId },
        s.posting,
        s.context,
        { seq: s.seq, journalNumber: s.journalNumber },
        s.postedAt,
        { orderRow: false },
      );
    }
    await c.query('UPDATE erp.posting_state SET last_journal_no = $2 WHERE tenant_id = $1', [
      tenantId,
      journals,
    ]);
    await c.query(
      `INSERT INTO erp.audit_log (tenant_id, user_id, action, entity, after)
       VALUES ($1, $2, 'posting.rebuild', 'postings', $3)`,
      [tenantId, opts.userId, JSON.stringify({ postings: steps.length, journals, at: opts.now })],
    );
    await c.query('COMMIT');
    return { postings: steps.length };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}
