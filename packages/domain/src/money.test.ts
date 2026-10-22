import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import moneyCases from '../golden/money.json';
import mulBpCases from '../golden/mul-bp.json';
import mulQtyCases from '../golden/mul-qty.json';
import parseMoneyCases from '../golden/parse-money.json';
import { add, money, mulBp, mulQty, negate, parseMoney, sub, sum } from './money';
import { qty } from './quantity';
import { runGolden, type GoldenFile } from './testing/golden';

interface MoneyInput {
  op: string;
  value?: number | string;
  a?: number;
  b?: number;
  values?: number[];
}

runGolden(moneyCases as GoldenFile<MoneyInput>, (i) => {
  switch (i.op) {
    case 'money':
      return money(i.value!);
    case 'add':
      return add(money(i.a!), money(i.b!));
    case 'sub':
      return sub(money(i.a!), money(i.b!));
    case 'negate':
      return negate(money(i.a!));
    default:
      return sum(i.values!.map((v) => money(v)));
  }
});
runGolden(mulQtyCases as GoldenFile<{ qty: number; unitPrice: number }>, (i) =>
  mulQty(qty(i.qty), money(i.unitPrice)),
);
runGolden(mulBpCases as GoldenFile<{ amount: number; bp: number }>, (i) => mulBp(money(i.amount), i.bp));
runGolden(parseMoneyCases as GoldenFile<{ text: string; minorUnits: number }>, (i) =>
  parseMoney(i.text, i.minorUnits),
);

describe('money properties', () => {
  it('a returned line rounds exactly like the sale, negative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (q, p) => {
          expect(mulQty(qty(-q), money(p))).toBe(-mulQty(qty(q), money(p)) || 0);
        },
      ),
    );
  });

  it('parses any amount written with two decimals back to the same paisa', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 }), (v) => {
        const abs = Math.abs(v);
        const sign = v < 0 ? '-' : '';
        const text = `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
        expect(parseMoney(text, 2)).toBe(v);
      }),
    );
  });

  it('never returns -0', () => {
    expect(Object.is(negate(money(0)), 0)).toBe(true);
    expect(Object.is(mulQty(qty(-1), money(1)), 0)).toBe(true);
  });
});
