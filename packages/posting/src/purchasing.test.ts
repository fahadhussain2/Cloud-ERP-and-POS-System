import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { money, qty } from '@erp/domain';

import receiptCases from '../golden/post-goods-receipt.json';
import returnCases from '../golden/post-purchase-return.json';
import paymentCases from '../golden/post-supplier-payment.json';
import { postGoodsReceipt, postPurchaseReturn, postSupplierPayment } from './purchasing';
import { runGolden, type GoldenFile } from './testing/golden';
import type {
  LedgerState,
  PostingContext,
  PostingGoodsReceipt,
  PostingPurchaseReturn,
  PostingSupplierPayment,
} from './types';

// Purchasing in the books (posting rules §5.1, §5.2, §6; W1-16): a goods receipt (stock at its exact net value, the
// average from that value, the supplier's bill, paid by bank or not), a purchase return (out at the average, the
// difference to purchase price variance) and a supplier payment by bank.

const context = (lockDate: string | null = null): PostingContext => ({
  accounts: {
    roles: { INVENTORY: '1300', AP_CONTROL: '2100', COGS: '5100', PURCHASE_PRICE_VARIANCE: '5300' },
    methods: {},
    targets: { 'bank-hbl': '1160' },
  },
  lockDate,
  customer: null,
});
const empty = (): LedgerState => ({ costs: {}, balances: {} });

runGolden(receiptCases as unknown as GoldenFile<{ receipt: PostingGoodsReceipt; state?: LedgerState }>, (i) =>
  postGoodsReceipt(i.receipt, context(), i.state ?? empty()),
);
runGolden(
  returnCases as unknown as GoldenFile<{
    purchaseReturn: PostingPurchaseReturn;
    state?: LedgerState;
    lockDate?: string;
  }>,
  (i) => postPurchaseReturn(i.purchaseReturn, context(i.lockDate ?? null), i.state ?? empty()),
);
runGolden(paymentCases as unknown as GoldenFile<{ payment: PostingSupplierPayment }>, (i) =>
  postSupplierPayment(i.payment, context()),
);

describe('purchasing properties', () => {
  const sum = (lines: { debit: number; credit: number }[]) =>
    lines.reduce((s, l) => s + l.debit - l.credit, 0);
  it('a receipt and a return of it always balance, and the stock goes back to where it was', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ q: fc.integer({ min: 1, max: 100_000 }), v: fc.integer({ min: 0, max: 50_000_000 }) }),
          {
            minLength: 1,
            maxLength: 6,
          },
        ),
        fc.integer({ min: 0, max: 20_000_000 }),
        (lines, returnCost) => {
          const receipt: PostingGoodsReceipt = {
            id: 'gr',
            number: 'GR000001',
            branchId: 'b',
            businessDate: '2026-11-06',
            supplierId: 's',
            dueDate: '2026-12-06',
            total: money(lines.reduce((s, l) => s + l.v, 0)),
            receivedAt: '2026-11-06T10:00:00.000Z',
            paidFrom: null,
            lines: lines.map((l, n) => ({
              id: `l${n}`,
              itemId: `i${n % 3}`,
              locationId: 'shop',
              qty: qty(l.q),
              value: money(l.v),
            })),
          };
          const r = postGoodsReceipt(receipt, context(), empty());
          if (!r.ok) throw new Error(r.error.code);
          expect(sum(r.posting.journal.lines)).toBe(0);
          const back = postPurchaseReturn(
            {
              id: 'pr',
              number: 'PR000001',
              branchId: 'b',
              businessDate: '2026-11-07',
              supplierId: 's',
              lines: lines.map((l, n) => ({
                id: `r${n}`,
                itemId: `i${n % 3}`,
                locationId: 'shop',
                qty: qty(l.q),
                unitCost: money(returnCost),
              })),
            },
            context(),
            r.posting.state,
          );
          if (!back.ok) throw new Error(back.error.code);
          expect(sum(back.posting.journal.lines)).toBe(0);
          for (const q of Object.values(back.posting.state.balances['shop'] ?? {})) expect(q).toBe(0);
        },
      ),
    );
  });
});
