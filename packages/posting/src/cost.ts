import { divRound, money, mulQty, qty, type Money, type Qty } from '@erp/domain';

import type { CostState } from './types';

// Weighted average cost per item, tenant-wide, valued in posting order (INV-02, posting rules §5.1, D-017).

/**
 * The cost after a receipt: `(on_hand × avg + qty × net_unit_cost) / (on_hand + qty)`, rounded half away from zero,
 * or the receipt's cost when nothing (or less than nothing) was on hand or no cost was known.
 */
export function averageAfterReceipt(state: CostState, receipt: { qty: Qty; netUnitCost: Money }): CostState {
  const onHand = qty(state.onHand + receipt.qty);
  if (state.avgCost === null || state.onHand <= 0) return { avgCost: receipt.netUnitCost, onHand };
  const value =
    BigInt(state.onHand) * BigInt(state.avgCost) + BigInt(receipt.qty) * BigInt(receipt.netUnitCost);
  return { avgCost: money(Number(divRound(value, BigInt(onHand)))), onHand };
}

/** What `quantity` costs at the item's average, rounded half away from zero; 0 when no cost is known yet. */
export const costOf = (quantity: Qty, avgCost: Money | null): Money =>
  avgCost === null ? money(0) : mulQty(quantity, avgCost);

/**
 * The cost after a goods receipt of `value` (paisa, the bill discount already in it) for `quantity` (W1-16): the same
 * average as averageAfterReceipt but from the line's exact value, so a rounded unit cost never shifts it.
 */
export function averageAfterValue(state: CostState, receipt: { qty: Qty; value: Money }): CostState {
  const onHand = qty(state.onHand + receipt.qty);
  const own = () => money(Number(divRound(BigInt(receipt.value) * 1000n, BigInt(receipt.qty))));
  if (state.avgCost === null || state.onHand <= 0) return { avgCost: own(), onHand };
  const total = BigInt(state.onHand) * BigInt(state.avgCost) + BigInt(receipt.value) * 1000n;
  return { avgCost: money(Number(divRound(total, BigInt(onHand)))), onHand };
}
