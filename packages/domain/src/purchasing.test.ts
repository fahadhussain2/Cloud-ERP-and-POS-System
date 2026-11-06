import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import receiptCheckCases from '../golden/receipt-check.json';
import receiptTotalCases from '../golden/receipt-totals.json';
import returnCheckCases from '../golden/return-check.json';
import { money } from './money';
import {
  checkReceipt,
  checkReturn,
  receiptTotals,
  type ReceiptCheckInput,
  type ReceiptTotalsInput,
  type ReturnCheckInput,
} from './purchasing';
import { qty } from './quantity';
import { runGolden, type GoldenFile } from './testing/golden';

// Purchasing in the back office (W1-16, PUR-02, PUR-03): a receipt's totals with the bill discount capitalized, the
// bill-total check and the line warnings, and a return's checks.

runGolden(receiptTotalCases as unknown as GoldenFile<ReceiptTotalsInput>, receiptTotals);
runGolden(receiptCheckCases as unknown as GoldenFile<ReceiptCheckInput>, checkReceipt);
runGolden(returnCheckCases as unknown as GoldenFile<ReturnCheckInput>, checkReturn);

describe('receipt total properties', () => {
  it('the lines always add up to the total, and no value goes below 0', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 1_000_000 }),
            unitCost: fc.integer({ min: 0, max: 10_000_000 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        fc.integer({ min: 0, max: 10_000 }),
        (lines, discountBp) => {
          const input = {
            lines: lines.map((l) => ({
              qty: qty(l.qty),
              unitCost: money(l.unitCost),
              lineDiscount: money(0),
            })),
            billDiscount: money(0),
          };
          const subtotal = receiptTotals(input).subtotal;
          const billDiscount = money(Math.floor((subtotal * discountBp) / 10_000));
          const t = receiptTotals({ ...input, billDiscount });
          expect(t.lines.reduce((s, l) => s + l.value, 0)).toBe(t.total);
          expect(t.total).toBe(subtotal - billDiscount);
          for (const l of t.lines) expect(l.value).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});
