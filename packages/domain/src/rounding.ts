import { DomainError } from './errors';
import { divRound, toSafeNumber } from './exact';
import { sub, type Money } from './money';

export interface CashRounding {
  rounded: Money;
  /** rounded − amount; posted to the rounding account (POS-15). */
  adjustment: Money;
}

/** Rounds to the nearest multiple of the tenant's increment (Delux: 100 = Rs 1), half away from zero. */
export function roundCash(amount: Money, increment: Money): CashRounding {
  if (increment <= 0)
    throw new DomainError('invalid_increment', `the rounding increment must be positive: ${increment}`);
  const step = BigInt(increment);
  const rounded = toSafeNumber(divRound(BigInt(amount), step) * step) as Money;
  return { rounded, adjustment: sub(rounded, amount) };
}
