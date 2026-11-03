import { money, negate, qty, type Qty } from '@erp/domain';

import { averageAfterReceipt } from './cost';
import { entryDateOf } from './dates';
import type {
  CostState,
  LedgerState,
  Posting,
  PostingContext,
  PostingException,
  PostingResult,
  PostingVoid,
  StockMovement,
} from './types';

// A void reverses its sale's own posting (posting rules §4.4, W1-12): every journal line swapped, dated the void's
// business date; each stock movement back at the sale's own unit cost (the average recomputed as a receipt at that
// cost); each customer entry reversed on its own due date. A line that left with no cost comes back at 0 and leaves
// the average as it is. Stock coming back never goes below zero, so the sale's exceptions aren't raised again. It
// names no role and no method, so it never fails for a mapping.

export function postVoid(
  voided: PostingVoid,
  original: Posting,
  context: PostingContext,
  state: LedgerState,
): PostingResult {
  const entryDate = entryDateOf(voided.businessDate, context.lockDate);
  const exceptions: PostingException[] = [];
  if (entryDate !== voided.businessDate)
    exceptions.push({
      kind: 'posted_after_lock',
      details: { businessDate: voided.businessDate, lockDate: context.lockDate! },
    });

  const costs: Record<string, CostState> = {};
  const balances: Record<string, Record<string, Qty>> = {};
  const costNow = (item: string) => costs[item] ?? state.costs[item] ?? { avgCost: null, onHand: qty(0) };
  const balanceNow = (loc: string, item: string) =>
    balances[loc]?.[item] ?? state.balances[loc]?.[item] ?? qty(0);
  const movements: StockMovement[] = original.movements.map((m) => {
    const back = qty(0 - m.qtyDelta);
    const before = costNow(m.itemId);
    const after =
      m.avgCostAfter === null
        ? { avgCost: before.avgCost, onHand: qty(before.onHand + back) }
        : averageAfterReceipt(before, { qty: back, netUnitCost: m.unitCost });
    costs[m.itemId] = after;
    (balances[m.locationId] ??= {})[m.itemId] = qty(balanceNow(m.locationId, m.itemId) + back);
    return {
      sourceLineId: m.sourceLineId,
      itemId: m.itemId,
      locationId: m.locationId,
      qtyDelta: back,
      unitCost: m.unitCost,
      valueDelta: negate(m.valueDelta),
      avgCostAfter: after.avgCost,
    };
  });

  return {
    ok: true,
    posting: {
      entryDate,
      journal: {
        branchId: voided.branchId,
        memo: `${voided.number} ${voided.saleNumber}`,
        lines: original.journal.lines.map((l) => ({
          accountId: l.accountId,
          partyId: l.partyId,
          debit: money(l.credit),
          credit: money(l.debit),
        })),
      },
      movements,
      partyEntries: original.partyEntries.map((e) => ({ ...e, amount: negate(e.amount) })),
      exceptions,
      state: { costs, balances },
    },
  };
}
