import { DomainError } from './errors';
import { divRound, parseDecimal, safeInteger, toSafeNumber } from './exact';
import { QTY_SCALE, type Qty } from './quantity';

declare const moneyBrand: unique symbol;

/** An amount in the currency's minor units (paisa, fils), as a safe integer (CLAUDE.md rule 1, D-079). */
export type Money = number & { readonly [moneyBrand]: true };

const INTEGER_TEXT = /^-?\d+$/;

/** From a number, or from the database's bigint text. Fractions and unsafe values are refused. */
export function money(value: number | string): Money {
  if (typeof value === 'string') {
    if (!INTEGER_TEXT.test(value))
      throw new DomainError('not_integer', `an amount must be whole minor units: "${value}"`);
    return toSafeNumber(BigInt(value)) as Money;
  }
  return safeInteger(value, 'an amount') as Money;
}

export const add = (a: Money, b: Money): Money => money(a + b);
export const sub = (a: Money, b: Money): Money => money(a - b);
export const negate = (a: Money): Money => money(-(a as number));
export const sum = (values: readonly Money[]): Money => values.reduce(add, money(0));

/** Quantity × unit price, rounded half away from zero to the minor unit: 1.5 m at Rs 200 → Rs 300. */
export function mulQty(quantity: Qty, unitPrice: Money): Money {
  return toSafeNumber(divRound(BigInt(quantity) * BigInt(unitPrice), BigInt(QTY_SCALE))) as Money;
}

/** Amount × rate in basis points (1% = 100 bp), rounded half away from zero. */
export function mulBp(amount: Money, basisPoints: number): Money {
  if (!Number.isSafeInteger(basisPoints)) {
    throw new DomainError('invalid_basis_points', `basis points must be a whole number: ${basisPoints}`);
  }
  return toSafeNumber(divRound(BigInt(amount) * BigInt(basisPoints), 10_000n)) as Money;
}

/** Typed text → minor units, exactly: "1,250.50" with 2 minor units → 125050. Extra decimals are an error. */
export function parseMoney(text: string, minorUnits: number): Money {
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 3) {
    throw new DomainError('invalid_minor_units', `minor units must be 0 to 3: ${minorUnits}`);
  }
  return toSafeNumber(parseDecimal(text, minorUnits)) as Money;
}
