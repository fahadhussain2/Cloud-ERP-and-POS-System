import reviewCases from '../golden/cash-review.json';
import drawerCases from '../golden/drawer.json';
import type { CashMovementDocument } from './cash-movement';
import type { CashSessionDocument, DeskSession } from './cash-session';
import type { CustomerCollectionDocument } from './collection';
import {
  checkClose,
  countDrawer,
  denominations,
  reviewDeskDocument,
  reviewSession,
  type VarianceReason,
} from './drawer';
import { money, type Money } from './money';
import { BRANCH, CASHIER, DESK, grantsOf, RS, SESSION } from './testing/desk';
import { runGolden, type GoldenFile } from './testing/golden';

interface DrawerCase {
  denominations?: string;
  count?: { currency: string; counts: Record<string, number> };
  close?: {
    session?: DeskSession | null;
    userId?: string;
    counts: Record<string, number>;
    expected: Money;
    reason?: VarianceReason;
    note?: string;
    acknowledgerId?: string | null;
    leftInDrawer?: Money;
  };
}

runGolden(drawerCases as unknown as GoldenFile<DrawerCase>, (i) => {
  if (i.denominations !== undefined) return denominations(i.denominations);
  if (i.count !== undefined) return countDrawer(i.count.currency, i.count.counts);
  const c = i.close!;
  const userId = c.userId ?? CASHIER;
  const ack = c.acknowledgerId ?? null;
  return checkClose({
    session: c.session === undefined ? SESSION : c.session,
    userId,
    grants: grantsOf(userId),
    branchId: BRANCH,
    increment: RS,
    currency: 'PKR',
    counts: c.counts,
    expected: c.expected,
    reason: c.reason ?? null,
    note: c.note ?? null,
    acknowledger: ack === null ? null : { userId: ack, grants: grantsOf(ack) },
    leftInDrawer: c.leftInDrawer ?? null,
  });
});

const COMMON = {
  id: '019a7000-0000-7000-8000-000000000071',
  deviceId: DESK,
  branchId: BRANCH,
  createdAt: '2026-11-02T10:30:00.000Z',
  businessDate: '2026-11-02',
  clientVersion: '0.8.0',
};

const BASES = {
  R: {
    ...COMMON,
    version: 1,
    family: 'R',
    seq: 1,
    number: 'D01-R000001',
    sessionId: SESSION.id,
    cashierId: CASHIER,
    partyId: '019a3000-0000-7000-8000-0000000000c1',
    customerCode: 'C0042',
    customerName: 'Ali Autos',
    methodId: '019a1000-0000-7000-8000-000000000101',
    methodCode: 'cash',
    amount: money(500000),
    reference: null,
    note: null,
    balanceBefore: money(1250000),
  } satisfies CustomerCollectionDocument,
  M: {
    ...COMMON,
    version: 1,
    family: 'M',
    seq: 4,
    number: 'D01-M000004',
    kind: 'expense',
    sessionId: SESSION.id,
    cashierId: CASHIER,
    amount: money(20000),
    expenseCategoryId: '019a1000-0000-7000-8000-000000000201',
    partyId: null,
    bankAccountId: null,
    targetName: 'Tea',
    note: 'tea',
    reference: null,
  } satisfies CashMovementDocument,
  open: {
    ...COMMON,
    version: 2,
    family: 'Z',
    seq: 6,
    number: 'D01-Z000006',
    event: 'open',
    sessionId: COMMON.id,
    userId: CASHIER,
    openingFloat: money(500000),
    expectedCash: null,
    floatExpected: money(500000),
    countedCash: null,
    denominations: null,
    variance: null,
    varianceReason: null,
    varianceNote: null,
    acknowledgedByUserId: null,
    leftInDrawer: null,
  } satisfies CashSessionDocument,
  close: {
    ...COMMON,
    version: 2,
    family: 'Z',
    seq: 7,
    number: 'D01-Z000007',
    event: 'close',
    sessionId: SESSION.id,
    userId: CASHIER,
    openingFloat: null,
    expectedCash: money(1564700),
    floatExpected: null,
    countedCash: money(1534700),
    denominations: { '500000': 2, '100000': 5, '10000': 3, '1000': 4, '100': 7 },
    variance: money(-30000),
    varianceReason: 'change_error',
    varianceNote: null,
    acknowledgedByUserId: '019a0000-0000-7000-8000-0000000000a2',
    leftInDrawer: money(500000),
  } satisfies CashSessionDocument,
};

interface ReviewCase {
  doc: keyof typeof BASES;
  changes?: Record<string, unknown>;
  sessionCashierId?: string | null;
}

runGolden(reviewCases as unknown as GoldenFile<ReviewCase>, (i) => {
  const doc = { ...BASES[i.doc], ...i.changes };
  if (doc.family === 'Z')
    return reviewSession(doc, {
      grantsOf,
      sessionCashierId: i.sessionCashierId === undefined ? CASHIER : i.sessionCashierId,
      branchId: BRANCH,
    });
  return reviewDeskDocument(doc, {
    grants: grantsOf((doc as { cashierId: string }).cashierId),
    branchId: BRANCH,
  });
});
