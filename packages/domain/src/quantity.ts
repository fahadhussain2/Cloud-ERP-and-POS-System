import { parseDecimal, safeInteger, toSafeNumber } from './exact';

declare const qtyBrand: unique symbol;

/** A quantity in thousandths of a unit: 2 pieces = 2000, 1.5 m = 1500 (CLAUDE.md rule 1, D-079). */
export type Qty = number & { readonly [qtyBrand]: true };

/** Thousandths per unit. */
export const QTY_SCALE = 1000;

export function qty(value: number): Qty {
  return safeInteger(value, 'a quantity') as Qty;
}

/** Typed text → thousandths, exactly: "1.5" → 1500. More than 3 decimals is an error. */
export function parseQty(text: string): Qty {
  return toSafeNumber(parseDecimal(text, 3)) as Qty;
}
