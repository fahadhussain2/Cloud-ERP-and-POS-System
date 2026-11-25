import { divRound, money, mulQty, qty, sub, type Money, type Qty } from '@erp/domain';

import type { CostState } from './types';

// Weighted average cost per item, tenant-wide, valued in posting order (INV-02, posting rules §5.1, D-017).
//
// Stock sold before it arrived (D-124): while on-hand is below zero every unit short was sold at the average, so the
// average stays as it is until stock comes back to 0 or above. Stock that comes in meanwhile first covers the
// shortfall, and the difference between what the covering units really cost and the average they were sold at is a
// correction to cost of goods sold (`shortfallCorrection`), posted with the incoming stock.

/** Stock still short after it came in: the average the short units were sold at stays (D-124). */
const stillShort = (state: CostState, onHand: Qty) => state.onHand < 0 && onHand < 0;

/**
 * The cost after a receipt: `(on_hand × avg + qty × net_unit_cost) / (on_hand + qty)`, rounded half away from zero,
 * or the receipt's cost when nothing (or less than nothing) was on hand or no cost was known; unchanged while the
 * stock stays below zero (D-124).
 */
export function averageAfterReceipt(state: CostState, receipt: { qty: Qty; netUnitCost: Money }): CostState {
  const onHand = qty(state.onHand + receipt.qty);
  if (stillShort(state, onHand)) return { avgCost: state.avgCost, onHand };
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
  if (stillShort(state, onHand)) return { avgCost: state.avgCost, onHand };
  const own = () => money(Number(divRound(BigInt(receipt.value) * 1000n, BigInt(receipt.qty))));
  if (state.avgCost === null || state.onHand <= 0) return { avgCost: own(), onHand };
  const total = BigInt(state.onHand) * BigInt(state.avgCost) + BigInt(receipt.value) * 1000n;
  return { avgCost: money(Number(divRound(total, BigInt(onHand)))), onHand };
}

/**
 * Stock of `value` for `quantity` (above 0) coming in while on-hand is below zero (D-124): the n = min(−on hand, qty)
 * units that cover the shortfall were sold at the average (0 when none was known). The correction is their real cost
 * (value × n ÷ qty, half away from zero; the whole value when n = qty) less that; above 0 it is Dr COGS / Cr INVENTORY.
 * 0 when nothing was short.
 */
export function shortfallCorrection(state: CostState, incoming: { qty: Qty; value: Money }): Money {
  if (state.onHand >= 0 || incoming.qty <= 0) return money(0);
  const covering = qty(Math.min(0 - state.onHand, incoming.qty));
  const real =
    covering === incoming.qty
      ? incoming.value
      : money(Number(divRound(BigInt(incoming.value) * BigInt(covering), BigInt(incoming.qty))));
  return sub(real, costOf(covering, state.avgCost));
}

/** A goods receipt's line (W1-16, D-124): the cost after it, and the correction for any shortfall it covers. */
export function settleShortfall(
  state: CostState,
  incoming: { qty: Qty; value: Money },
): { after: CostState; correction: Money } {
  return { after: averageAfterValue(state, incoming), correction: shortfallCorrection(state, incoming) };
}
