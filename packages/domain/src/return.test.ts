import { describe, expect, it } from 'vitest';

import exchangeCases from '../golden/exchange-totals.json';
import noReceiptCases from '../golden/no-receipt-price.json';
import refundTenderCases from '../golden/refund-tender.json';
import billCases from '../golden/return-bill.json';
import documentCases from '../golden/return-document.json';
import lineCases from '../golden/return-lines.json';
import policyCases from '../golden/return-policy.json';
import reviewCases from '../golden/return-review.json';
import type { Bill } from './bill';
import type { CreditView } from './credit';
import { money, type Money } from './money';
import { qty, type Qty } from './quantity';
import {
  addReturn,
  buildReturnDocument,
  canApproveReturn,
  lowestPrice90,
  refundFor,
  removeReturn,
  returnable,
  returnedOf,
  returnNeeds,
  reviewReturn,
  type ItemPolicy,
  type OriginalLine,
  type PricedLine,
  type Returned,
  type ReturnApprovalBy,
  type ReturnApprovalKind,
  type ReturnDocument,
  type ReturnLineInput,
  type ReturnReviewOriginal,
  type ReturnSource,
} from './return';
import { reviewSale } from './review-sale';
import { saleTotal } from './sale-document';
import { checkTender, settleTender, type Tender, type TenderLine } from './tender';
import { BRANCH } from './testing/counter';
import { runGolden, type GoldenFile } from './testing/golden';
import { DELUX_METHODS } from './testing/methods';
import { RETURN_STAFF, returnGrantsOf } from './testing/returns';

// Returns and exchanges (POS-12, PRD W6, W7, D-005, D-006, D-051, W1-13): what may come back and for how much, what
// it needs, the bill and the document, and the server's review.

const RS = money(100);

runGolden(lineCases as unknown as GoldenFile<{ line: OriginalLine; returned: Returned; qty: Qty }>, (i) => {
  const refund = refundFor(i.line, i.returned, i.qty);
  return { returnable: returnable(i.line, i.returned), refund };
});

runGolden(
  policyCases as unknown as GoldenFile<{
    seller: string;
    approver?: string;
    original: string | null;
    today: string;
    windowDays: number;
    items: ItemPolicy[];
  }>,
  (i) => {
    const check = returnNeeds({
      sellerGrants: returnGrantsOf(i.seller),
      branchId: BRANCH,
      original: i.original === null ? null : { businessDate: i.original },
      today: i.today,
      windowDays: i.windowDays,
      items: i.items,
    });
    return {
      ...check,
      approverMay:
        i.approver === undefined ? null : canApproveReturn(returnGrantsOf(i.approver), BRANCH, check.needs),
    };
  },
);

runGolden(
  noReceiptCases as unknown as GoldenFile<{
    itemId: string;
    today: string;
    sales: PricedLine[];
    fallback: Money | null;
  }>,
  (i) => lowestPrice90(i),
);

runGolden(
  billCases as unknown as GoldenFile<{
    bill: Bill;
    source: ReturnSource;
    lines: ReturnLineInput[];
    needs: ReturnApprovalKind[];
    approval: ReturnApprovalBy | null;
  }>,
  (i) => addReturn(i.bill, i).returns,
);

runGolden(exchangeCases as unknown as GoldenFile<{ bill: Bill; increment: number }>, (i) =>
  saleTotal(i.bill, money(i.increment)),
);

interface TenderCase {
  total: Money;
  payments: TenderLine[];
  cashReceived: Money | null;
  hasCustomerAccount: boolean;
}
runGolden(refundTenderCases as unknown as GoldenFile<TenderCase>, (i) => {
  // These cases never have a credit customer: on account to pay is refused, as for a sale.
  const input = {
    total: i.total,
    increment: RS,
    methods: DELUX_METHODS,
    tender: { payments: i.payments, cashReceived: i.cashReceived },
    hasCreditCustomer: false,
    hasReturns: true,
    hasCustomerAccount: i.hasCustomerAccount,
  };
  const problem = checkTender(input);
  return { problem, settlement: problem === null ? settleTender(input) : null };
});

// The fixed part of every document case's context (see the golden file's description).
const COUNTER = {
  deviceId: '019a0000-0000-7000-8000-0000000000d1',
  deviceCode: 'C03',
  branchId: BRANCH,
  timeZone: 'Asia/Karachi',
  cutoffHour: 4,
  increment: RS,
  clientVersion: '0.10.0',
};

interface DocumentCase {
  bill: Bill;
  tender: Tender;
  sellerMaxDiscountBp: number;
  context: { id: string; seq: number; createdAtMs: number };
  customer: { id: string | null; walkinPhone: string | null };
  credit: CreditView | null;
  refundApproval: ReturnApprovalBy | null;
}
const build = (i: DocumentCase) =>
  buildReturnDocument({
    bill: i.bill,
    tender: i.tender,
    methods: DELUX_METHODS,
    sellerMaxDiscountBp: i.sellerMaxDiscountBp,
    customer: i.customer,
    credit: i.credit,
    creditApproval: null,
    refundApproval: i.refundApproval,
    context: { ...COUNTER, ...i.context },
  });
const documents = documentCases as unknown as GoldenFile<DocumentCase>;
runGolden(documents, build);

describe('every built return reviews clean with the counter’s own rules (rule 2)', () => {
  for (const c of documents.cases.filter((x) => x.error === undefined))
    it(c.name, () => {
      const d = build(c.input);
      expect(
        reviewSale(d, {
          deviceCode: 'C03',
          timeZone: 'Asia/Karachi',
          cutoffHour: 4,
          increment: RS,
          methods: DELUX_METHODS,
          grants: RETURN_STAFF,
        }),
      ).toStrictEqual([]);
    });
});

runGolden(
  reviewCases as unknown as GoldenFile<{
    document: ReturnDocument;
    original: ReturnReviewOriginal | null;
    windowDays: number;
    items: Record<string, ItemPolicy>;
  }>,
  (i) => reviewReturn(i.document, { ...i, grants: RETURN_STAFF }),
);

describe('returnedOf', () => {
  it('adds up the returned lines of one original line, as positive figures', () => {
    expect(
      returnedOf([
        { qty: qty(-1000), lineTotal: money(-333333) },
        { qty: qty(-500), lineTotal: money(-166667) },
      ]),
    ).toStrictEqual({ qty: 1500, refund: 500000 });
  });
  it('is nothing for no returns', () => {
    expect(returnedOf([])).toStrictEqual({ qty: 0, refund: 0 });
  });
});

describe('removeReturn', () => {
  it('takes the returned lines off the bill again', () => {
    const bill = documents.cases[0]!.input.bill;
    expect(removeReturn(bill)).toStrictEqual({ ...bill, returns: null });
  });
});

describe('reviewSale on a return', () => {
  it('flags a returned line that adds money instead of refunding it', () => {
    const d = build(documents.cases[0]!.input);
    const odd = { ...d, lines: [{ ...d.lines[0]!, lineTotal: money(435000) }] };
    expect(
      reviewSale(odd, {
        deviceCode: 'C03',
        timeZone: 'Asia/Karachi',
        cutoffHour: 4,
        increment: RS,
        methods: DELUX_METHODS,
        grants: RETURN_STAFF,
      }),
    ).toContainEqual({ kind: 'document_inconsistent', lineNo: 1, code: 'line_amounts', problem: null });
  });
});
