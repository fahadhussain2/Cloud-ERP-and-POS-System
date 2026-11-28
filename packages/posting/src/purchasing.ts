import { add, money, mulQty, negate, qty, sum } from '@erp/domain';

import { bankOf, credit, debit, dated, guarded, roleOf, signed, stockState } from './build';
import { averageAfterValue, settleShortfall } from './cost';
import type {
  JournalLine,
  LastPurchase,
  LedgerState,
  PartyEntry,
  PostingContext,
  PostingGoodsReceipt,
  PostingPurchaseReturn,
  PostingResult,
  PostingSupplierPayment,
  StockMovement,
} from './types';

// Purchasing in the books (posting rules §5.1, §5.2, §6; W1-16): a goods receipt (stock at each line's exact net
// value, the average from that value, the supplier's bill, paid by bank or not), a purchase return (out at the
// average, the difference to purchase price variance) and a supplier payment by bank. Never throws for a business
// reason.

/** Dr INVENTORY Σ values, Cr AP_CONTROL (the supplier) the total; paid by bank also Dr AP_CONTROL / Cr the bank. */
export function postGoodsReceipt(
  receipt: PostingGoodsReceipt,
  context: PostingContext,
  state: LedgerState,
): PostingResult {
  return guarded(() => {
    const values = sum(receipt.lines.map((l) => l.value));
    if (values !== receipt.total) return { ok: false, error: { code: 'total_mismatch' } };
    const inventory = roleOf(context, 'INVENTORY');
    const ap = roleOf(context, 'AP_CONTROL');
    const bank = receipt.paidFrom === null ? null : bankOf(context, receipt.paidFrom);
    const { entryDate, exceptions } = dated(receipt.businessDate, context);

    const s = stockState(state);
    const movements: StockMovement[] = [];
    const last = new Map<string, LastPurchase>();
    let corrections = money(0);
    for (const l of receipt.lines) {
      const { after, correction } = settleShortfall(s.costNow(l.itemId), { qty: l.qty, value: l.value });
      s.costs[l.itemId] = after;
      s.move(l.locationId, l.itemId, l.qty);
      const unitCost = averageAfterValue(
        { avgCost: null, onHand: qty(0) },
        { qty: l.qty, value: l.value },
      ).avgCost!;
      movements.push({
        sourceLineId: l.id,
        itemId: l.itemId,
        locationId: l.locationId,
        qtyDelta: l.qty,
        unitCost,
        valueDelta: l.value,
        avgCostAfter: after.avgCost,
      });
      // D-124: the units that covered stock sold before it arrived, at what they really cost.
      if (correction !== 0) {
        corrections = add(corrections, correction);
        movements.push({
          sourceLineId: l.id,
          itemId: l.itemId,
          locationId: l.locationId,
          qtyDelta: qty(0),
          unitCost: money(0),
          valueDelta: negate(correction),
          avgCostAfter: after.avgCost,
        });
      }
      last.set(l.itemId, {
        itemId: l.itemId,
        lastCost: unitCost,
        lastSupplierId: receipt.supplierId,
        lastReceiptAt: receipt.receivedAt,
      });
    }

    const lines: JournalLine[] = [
      debit(inventory, null, values),
      credit(ap, receipt.supplierId, receipt.total),
    ];
    const partyEntries: PartyEntry[] = [
      { partyId: receipt.supplierId, role: 'supplier', amount: receipt.total, dueDate: receipt.dueDate },
    ];
    if (bank !== null) {
      lines.push(debit(ap, receipt.supplierId, receipt.total), credit(bank, null, receipt.total));
      partyEntries.push({
        partyId: receipt.supplierId,
        role: 'supplier',
        amount: negate(receipt.total),
        dueDate: entryDate,
      });
    }
    if (corrections !== 0) {
      const cogs = roleOf(context, 'COGS');
      lines.push(...signed(cogs, null, corrections), ...signed(inventory, null, negate(corrections)));
    }
    return {
      ok: true,
      posting: {
        entryDate,
        journal: {
          branchId: receipt.branchId,
          memo: receipt.number,
          lines: lines.filter((l) => l.debit + l.credit > 0),
        },
        movements,
        partyEntries: partyEntries.filter((p) => p.amount !== 0),
        exceptions,
        state: { costs: s.costs, balances: s.balances },
        lastPurchases: [...last.values()],
      },
    };
  });
}

/**
 * Dr AP_CONTROL (the supplier) Σ qty × the return's unit cost; Cr INVENTORY Σ qty × the average (no cost known: the
 * return's own, flagged); the difference to PURCHASE_PRICE_VARIANCE. The average doesn't change.
 */
export function postPurchaseReturn(
  doc: PostingPurchaseReturn,
  context: PostingContext,
  state: LedgerState,
): PostingResult {
  return guarded(() => {
    const ap = roleOf(context, 'AP_CONTROL');
    const inventory = roleOf(context, 'INVENTORY');
    const { entryDate, exceptions } = dated(doc.businessDate, context);
    const s = stockState(state);
    const movements: StockMovement[] = [];
    const flagged = new Set<string>();
    let owed = money(0);
    for (const l of doc.lines) {
      const before = s.costNow(l.itemId);
      if (before.avgCost === null && !flagged.has(l.itemId)) {
        flagged.add(l.itemId);
        exceptions.push({ kind: 'no_cost', details: { itemId: l.itemId } });
      }
      const unit = before.avgCost ?? l.unitCost;
      s.costs[l.itemId] = { avgCost: before.avgCost, onHand: qty(before.onHand - l.qty) };
      const balance = s.move(l.locationId, l.itemId, qty(negate(money(l.qty))));
      if (balance < 0)
        exceptions.push({
          kind: 'negative_stock',
          details: { itemId: l.itemId, locationId: l.locationId, balance },
        });
      owed = money(owed + mulQty(l.qty, l.unitCost));
      movements.push({
        sourceLineId: l.id,
        itemId: l.itemId,
        locationId: l.locationId,
        qtyDelta: qty(negate(money(l.qty))),
        unitCost: unit,
        valueDelta: negate(mulQty(l.qty, unit)),
        avgCostAfter: before.avgCost,
      });
    }
    const stock = negate(sum(movements.map((m) => m.valueDelta)));
    const variance = money(stock - owed);
    const lines: JournalLine[] = [
      ...signed(ap, doc.supplierId, owed),
      ...signed(inventory, null, negate(stock)),
      ...(variance === 0 ? [] : signed(roleOf(context, 'PURCHASE_PRICE_VARIANCE'), null, variance)),
    ];
    return {
      ok: true,
      posting: {
        entryDate,
        journal: { branchId: doc.branchId, memo: doc.number, lines },
        movements,
        partyEntries:
          owed === 0
            ? []
            : [{ partyId: doc.supplierId, role: 'supplier', amount: negate(owed), dueDate: entryDate }],
        exceptions,
        state: { costs: s.costs, balances: s.balances },
      },
    };
  });
}

/** Dr AP_CONTROL (the supplier) / Cr the bank's account. */
export function postSupplierPayment(doc: PostingSupplierPayment, context: PostingContext): PostingResult {
  return guarded(() => {
    const ap = roleOf(context, 'AP_CONTROL');
    const bank = bankOf(context, doc.bankAccountId);
    const { entryDate, exceptions } = dated(doc.businessDate, context);
    return {
      ok: true,
      posting: {
        entryDate,
        journal: {
          branchId: doc.branchId,
          memo: doc.number,
          lines: [debit(ap, doc.supplierId, doc.amount), credit(bank, null, doc.amount)],
        },
        movements: [],
        partyEntries: [
          { partyId: doc.supplierId, role: 'supplier', amount: negate(doc.amount), dueDate: entryDate },
        ],
        exceptions,
        state: { costs: {}, balances: {} },
      },
    };
  });
}
