import creditCases from '../golden/credit.json';
import reviewCases from '../golden/credit-review.json';
import { checkCredit, reviewCredit, type CreditAccount, type CreditInput } from './credit';
import { money, type Money } from './money';
import type { RoleGrant } from './permissions';
import type { SaleDocument } from './sale-document';
import { runGolden, type GoldenFile } from './testing/golden';

// The JSON amounts are already whole minor units.
runGolden(creditCases as unknown as GoldenFile<CreditInput>, (i) => checkCredit(i));

// The staff the server knows (see the golden file's description).
const grant = (permissions: string[]): RoleGrant[] => [
  { permissions, limits: { maxDiscountBp: 1000, voidWindow: 'none' }, branchId: null },
];
const STAFF: Record<string, readonly RoleGrant[]> = {
  '019a0000-0000-7000-8000-0000000000a1': grant(['pos.sale.create', 'pos.credit.sell']),
  '019a0000-0000-7000-8000-0000000000a2': grant([
    'pos.sale.create',
    'pos.credit.sell',
    'pos.credit.over_limit',
  ]),
  '019a0000-0000-7000-8000-0000000000a4': grant(['pos.sale.create']),
};

// A Rs 20,000 bill fully on account to customer …f1; each case changes what it needs.
const BASE: SaleDocument = {
  version: 1,
  id: '019a5000-0000-7000-8000-000000000201',
  family: 'S',
  seq: 600,
  number: 'C03-S000600',
  kind: 'sale',
  deviceId: '019a0000-0000-7000-8000-0000000000d1',
  branchId: '019a0000-0000-7000-8000-0000000000e1',
  createdAt: '2026-11-02T10:15:30.000Z',
  businessDate: '2026-11-02',
  sellerId: '019a0000-0000-7000-8000-0000000000a1',
  tierId: '019a0000-0000-7000-8000-0000000000b1',
  customerId: '019a0000-0000-7000-8000-0000000000f1',
  walkinPhone: null,
  lines: [
    {
      lineNo: 1,
      itemId: '019a0000-0000-7000-8000-0000000000c1',
      qty: 1000 as SaleDocument['lines'][number]['qty'],
      listPrice: money(2000000),
      floorPrice: money(1600000),
      unitPrice: money(2000000),
      lineDiscount: money(0),
      billShare: money(0),
      lineTotal: money(2000000),
    },
  ],
  amounts: {
    subtotal: money(2000000),
    lineDiscountTotal: money(0),
    billDiscount: money(0),
    rounding: money(0),
    taxTotal: money(0),
    total: money(2000000),
  },
  payments: [
    { method: 'on_account', amount: money(2000000), cashReceived: null, changeDue: null, reference: null },
  ],
  cashDue: money(0),
  handoverStatus: 'not_applicable',
  overrides: [],
  clientVersion: '0.7.0',
};

interface ReviewInput {
  document: Partial<SaleDocument>;
  context: { account: CreditAccount | null; balanceBefore: Money; offlineTodayBefore: Money };
}

runGolden(reviewCases as unknown as GoldenFile<ReviewInput>, (i) =>
  reviewCredit({ ...BASE, ...i.document }, { ...i.context, grants: STAFF }),
);
