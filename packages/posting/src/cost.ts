import type { Money, Qty } from '@erp/domain';

import type { CostState } from './types';

// Weighted average cost per item, tenant-wide, valued in posting order (INV-02, posting rules §5.1, D-017).

/**
 * The cost after a receipt: `(on_hand × avg + qty × net_unit_cost) / (on_hand + qty)`, rounded half away from zero,
 * or the receipt's cost when nothing (or less than nothing) was on hand or no cost was known.
 */
export function averageAfterReceipt(state: CostState, receipt: { qty: Qty; netUnitCost: Money }): CostState {
  void state;
  void receipt;
  throw new Error('averageAfterReceipt is not built yet (W1-08)');
}
