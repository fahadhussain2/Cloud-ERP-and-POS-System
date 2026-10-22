import { DomainError } from './errors';

// Exact integer helpers shared by money and quantity (D-079). Products are computed in bigint, so nothing
// is ever rounded by floating point.

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** Back from bigint to a safe JS integer, or out_of_range. Never returns -0. */
export function toSafeNumber(value: bigint): number {
  if (value > MAX || value < -MAX)
    throw new DomainError('out_of_range', `${value} is outside the safe range`);
  return Number(value);
}

/** A safe integer, or not_integer / out_of_range. Normalizes -0 to 0. */
export function safeInteger(value: number, what: string): number {
  if (!Number.isInteger(value))
    throw new DomainError('not_integer', `${what} must be a whole number: ${value}`);
  if (!Number.isSafeInteger(value))
    throw new DomainError('out_of_range', `${what} is outside the safe range`);
  return value === 0 ? 0 : value;
}

/** numerator / denominator, rounded half away from zero (2.5 → 3, −2.5 → −3). The denominator is positive. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = 2n * (remainder < 0n ? -remainder : remainder);
  if (twice < denominator) return quotient;
  return numerator < 0n ? quotient - 1n : quotient + 1n;
}

const DECIMAL = /^(-)?(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d+))?$/;

/**
 * Exact decimal text → integer scaled by 10^scale, with no floats. Accepts an optional minus, thousands
 * separators in groups of three, and up to `scale` decimals. Anything else is an error, never a guess.
 */
export function parseDecimal(text: string, scale: number): bigint {
  const match = DECIMAL.exec(text.trim());
  if (!match || (match[2] === '' && match[3] === undefined)) {
    throw new DomainError('invalid_number', `not a number: "${text}"`);
  }
  const whole = match[2]!.replaceAll(',', '') || '0';
  const fraction = match[3] ?? '';
  if (fraction.length > scale) {
    throw new DomainError('too_many_decimals', `"${text}" has more than ${scale} decimals`);
  }
  const value = BigInt(whole + fraction.padEnd(scale, '0'));
  return match[1] ? -value : value;
}
