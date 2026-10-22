import { DomainError } from './errors';
import { toSafeNumber } from './exact';
import type { Money } from './money';

/**
 * Splits `total` over `weights` (e.g. a bill discount over line amounts) by largest remainder, so the parts
 * always sum exactly to the total (posting rules §1.7, D-079). Each part is the exact share rounded toward
 * zero; the leftover minor units go one each to the largest remainders. Ties go to the larger weight, then the
 * earlier line, so the POS and the API always produce the same split. A negative total mirrors the positive.
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) throw new DomainError('bad_weights', 'nothing to allocate over');
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) {
      throw new DomainError('bad_weights', `weights must be whole numbers, zero or more: ${w}`);
    }
  }
  const sumW = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (sumW === 0n) throw new DomainError('bad_weights', 'all weights are zero');

  const signed = BigInt(total);
  const negative = signed < 0n;
  const abs = negative ? -signed : signed;
  const parts = weights.map((w, i) => {
    const product = abs * BigInt(w);
    return { i, w, share: product / sumW, remainder: product % sumW };
  });

  let leftover = abs - parts.reduce((s, p) => s + p.share, 0n);
  const byRemainder = [...parts].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    if (a.w !== b.w) return b.w - a.w;
    return a.i - b.i;
  });
  for (const p of byRemainder) {
    if (leftover === 0n) break;
    p.share += 1n;
    leftover -= 1n;
  }
  return parts.map((p) => toSafeNumber(negative ? -p.share : p.share) as Money);
}
