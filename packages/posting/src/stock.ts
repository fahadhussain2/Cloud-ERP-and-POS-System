import { money, mulQty, negate, qty, type Money } from '@erp/domain';

import { credit, dated, debit, guarded, roleOf, stockState } from './build';
import type {
  JournalLine,
  LedgerState,
  PostingContext,
  PostingResult,
  PostingStockAdjustment,
  PostingStockTransfer,
  StockMovement,
} from './types';

// Stock operations in the books (posting rules §5.3, §5.4; INV-04, INV-05; W1-18; D-107). A transfer step moves stock
// between locations at the item's average (per item, not per location, D-017) with no journal; an adjustment moves it
// in or out at the average and posts the net value against INVENTORY_ADJUSTMENT. Stock below 0 is flagged, never
// refused (INV-03). Never throws for a business reason.

/** Out of each line's from location and into its to location, at the average; costs unchanged. */
export function postStockTransfer(
  transfer: PostingStockTransfer,
  context: PostingContext,
  state: LedgerState,
): PostingResult {
  return guarded(() => {
    const { entryDate, exceptions } = dated(transfer.businessDate, context);
    const s = stockState(state);
    const movements: StockMovement[] = [];
    for (const l of transfer.lines) {
      const avg = s.costNow(l.itemId).avgCost;
      const value = mulQty(l.qty, avg ?? money(0));
      const out = s.move(l.fromLocationId, l.itemId, qty(0 - l.qty));
      if (out < 0)
        exceptions.push({
          kind: 'negative_stock',
          details: { itemId: l.itemId, locationId: l.fromLocationId, balance: out },
        });
      s.move(l.toLocationId, l.itemId, l.qty);
      const unitCost = avg ?? money(0);
      movements.push(
        {
          sourceLineId: l.id,
          itemId: l.itemId,
          locationId: l.fromLocationId,
          qtyDelta: qty(0 - l.qty),
          unitCost,
          valueDelta: money(0 - value),
          avgCostAfter: avg,
        },
        {
          sourceLineId: l.id,
          itemId: l.itemId,
          locationId: l.toLocationId,
          qtyDelta: l.qty,
          unitCost,
          valueDelta: value,
          avgCostAfter: avg,
        },
      );
    }
    return {
      ok: true,
      posting: {
        entryDate,
        journal: { branchId: transfer.branchId, memo: transfer.number, lines: [] },
        movements,
        partyEntries: [],
        exceptions,
        // The average and the quantity on hand don't move: only the balances per location.
        state: { costs: {}, balances: s.balances },
      },
    };
  });
}

/**
 * Each line into (found) or out of (gone) its location at the average; the net value as one pair: a gain
 * Dr INVENTORY / Cr INVENTORY_ADJUSTMENT, a loss the reverse, none when it nets to 0.
 */
export function postStockAdjustment(
  doc: PostingStockAdjustment,
  context: PostingContext,
  state: LedgerState,
): PostingResult {
  return guarded(() => {
    const inventory = roleOf(context, 'INVENTORY');
    const adjustment = roleOf(context, 'INVENTORY_ADJUSTMENT');
    const { entryDate, exceptions } = dated(doc.businessDate, context);
    const s = stockState(state);
    const movements: StockMovement[] = [];
    const flagged = new Set<string>();
    let net = 0;
    for (const l of doc.lines) {
      const before = s.costNow(l.itemId);
      if (before.avgCost === null && !flagged.has(l.itemId)) {
        flagged.add(l.itemId);
        exceptions.push({ kind: 'no_cost', details: { itemId: l.itemId } });
      }
      const unitCost = before.avgCost ?? money(0);
      const size = mulQty(qty(Math.abs(l.qty)), unitCost);
      const value: Money = l.qty > 0 ? size : money(0 - size);
      s.costs[l.itemId] = { avgCost: before.avgCost, onHand: qty(before.onHand + l.qty) };
      const balance = s.move(l.locationId, l.itemId, l.qty);
      if (balance < 0)
        exceptions.push({
          kind: 'negative_stock',
          details: { itemId: l.itemId, locationId: l.locationId, balance },
        });
      net += value;
      movements.push({
        sourceLineId: l.id,
        itemId: l.itemId,
        locationId: l.locationId,
        qtyDelta: l.qty,
        unitCost,
        valueDelta: value,
        avgCostAfter: before.avgCost,
      });
    }
    const lines: JournalLine[] =
      net > 0
        ? [debit(inventory, null, money(net)), credit(adjustment, null, money(net))]
        : net < 0
          ? [debit(adjustment, null, negate(money(net))), credit(inventory, null, negate(money(net)))]
          : [];
    return {
      ok: true,
      posting: {
        entryDate,
        journal: { branchId: doc.branchId, memo: doc.number, lines },
        movements,
        partyEntries: [],
        exceptions,
        state: { costs: s.costs, balances: s.balances },
      },
    };
  });
}
