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
