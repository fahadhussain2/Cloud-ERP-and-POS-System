import { DomainError } from './errors';
import { mulBp, type Money } from './money';

// The floor from cost (CAT-06, PRD Q2, D-092, W1-14). The server works it out whenever an item's average changes and
// sends it to the counters (`item_floors`); the counter's floor is the item's explicit floor, else this, else the
// list price.

/**
 * `avgCost` × (10,000 + `marginBp`) / 10,000, half away from zero (D-079). No cost known, or a category without a
 * margin: none.
 */
export function costFloor(avgCost: Money | null, marginBp: number | null | undefined): Money | null {
  if (avgCost === null || marginBp === null || marginBp === undefined) return null;
  if (!Number.isSafeInteger(marginBp) || marginBp < 0)
    throw new DomainError(
      'invalid_basis_points',
      `a floor margin must be a whole number of basis points ≥ 0: ${marginBp}`,
    );
  return mulBp(avgCost, 10_000 + marginBp);
}
