import sessionCases from '../golden/cash-session.json';
import documentCases from '../golden/handover-document.json';
import reviewCases from '../golden/handover-review.json';
import handoverCases from '../golden/handover.json';
import queueCases from '../golden/queue.json';
import { buildSessionDocument, expectedCash, type DeskSession } from './cash-session';
import {
  buildHandoverDocument,
  checkHandover,
  queueGroups,
  reviewHandover,
  type CashHandoverDocument,
  type HandoverInput,
  type HandoverMethod,
  type LocalHandover,
  type QueueEntry,
} from './handover';
import { money, type Money } from './money';
import type { RoleGrant } from './permissions';
import { runGolden, type GoldenFile } from './testing/golden';

// The JSON amounts are already whole minor units (Rs 1 = 100).
const RS = money(100);
const DESK = '019a0000-0000-7000-8000-0000000000d9';
const BRANCH = '019a0000-0000-7000-8000-0000000000e1';
const CASHIER = '019a0000-0000-7000-8000-0000000000a5';

const grant = (permissions: string[]): RoleGrant[] => [
  { permissions, limits: { maxDiscountBp: 1000, voidWindow: 'none' }, branchId: null },
];
// The staff the desk and the server know (see each golden file's description); …a9 is unknown.
const STAFF: Record<string, readonly RoleGrant[]> = {
  '019a0000-0000-7000-8000-0000000000a1': grant(['pos.sale.create']),
  '019a0000-0000-7000-8000-0000000000a2': grant([
    'pos.sale.create',
    'cash.session.close',
    'cash.variance.approve',
  ]),
  [CASHIER]: grant(['pos.sale.create', 'cash.handover.receive', 'cash.refund.pay', 'cash.session.close']),
  '019a0000-0000-7000-8000-0000000000a6': grant(['cash.handover.receive']),
};
const grantsOf = (userId: string): readonly RoleGrant[] => STAFF[userId] ?? [];

const SESSION: DeskSession = {
  id: '019a6000-0000-7000-8000-000000000051',
  cashierId: CASHIER,
  openingFloat: money(500000),
  status: 'open',
};

type CheckCase = Partial<Pick<HandoverInput, 'session' | 'cashierId' | 'existing'>> &
  Pick<HandoverInput, 'target'> & { cashReceived?: Money };

const checkInput = (i: CheckCase): HandoverInput => {
  const cashierId = i.cashierId ?? CASHIER;
  return {
    session: i.session === undefined ? SESSION : i.session,
    cashierId,
    grants: grantsOf(cashierId),
    branchId: BRANCH,
    increment: RS,
    target: i.target,
    cashReceived: i.cashReceived ?? null,
    existing: i.existing ?? [],
  };
};

runGolden(handoverCases as unknown as GoldenFile<CheckCase>, (i) => checkHandover(checkInput(i)));

const CONTEXT = {
  id: '019a7000-0000-7000-8000-000000000071',
  deviceId: DESK,
  deviceCode: 'D01',
  branchId: BRANCH,
  timeZone: 'Asia/Karachi',
  cutoffHour: 4,
  clientVersion: '0.8.0',
};

runGolden(
  documentCases as unknown as GoldenFile<
    CheckCase & { seq: number; createdAt: string; method: HandoverMethod }
  >,
  (i) =>
    buildHandoverDocument({
      ...checkInput(i),
      method: i.method,
      context: { ...CONTEXT, seq: i.seq, createdAtMs: Date.parse(i.createdAt) },
    }),
);

runGolden(
  queueCases as unknown as GoldenFile<{
    entries: QueueEntry[];
    local: LocalHandover[];
    sellers: Record<string, string>;
  }>,
  (i) => queueGroups(i),
);

// D01-H000031: an 'in' of Rs 4,320 for C03-S000412 from the queue; each case changes what it needs.
const BASE: CashHandoverDocument = {
  version: 1,
  id: '019a7000-0000-7000-8000-000000000071',
  family: 'H',
  seq: 31,
  number: 'D01-H000031',
  kind: 'in',
  deviceId: DESK,
  branchId: BRANCH,
  sessionId: SESSION.id,
  cashierId: CASHIER,
  billNumber: 'C03-S000412',
  saleDocumentId: '019a5000-0000-7000-8000-000000000412',
  amount: money(432000),
  cashReceived: money(500000),
  changeGiven: money(68000),
  correctedFrom: null,
  method: 'queue',
  createdAt: '2026-11-02T10:16:02.000Z',
  businessDate: '2026-11-02',
  clientVersion: '0.8.0',
};

interface ReviewCase {
  handover: Partial<CashHandoverDocument>;
  context: {
    bill: { id: string; cashDue: Money } | null;
    existing: { id: string; number: string } | null;
  };
}

runGolden(reviewCases as unknown as GoldenFile<ReviewCase>, (i) => {
  const handover = { ...BASE, ...i.handover };
  return reviewHandover(handover, { ...i.context, grants: grantsOf(handover.cashierId), branchId: BRANCH });
});

interface SessionCase {
  expected?: { openingFloat: Money; handovers: { kind: 'in' | 'payout'; amount: Money }[] };
  open?: { current: DeskSession | null; userId: string; openingFloat: Money; seq: number; createdAt: string };
  close?: {
    current: DeskSession | null;
    handovers: { kind: 'in' | 'payout'; amount: Money }[];
    userId: string;
    seq: number;
    createdAt: string;
  };
}

const SESSION_CONTEXT = { ...CONTEXT, id: '019a6000-0000-7000-8000-000000000081', increment: RS };

runGolden(sessionCases as unknown as GoldenFile<SessionCase>, (i) => {
  if (i.expected !== undefined) return expectedCash(i.expected);
  const e = (i.open ?? i.close)!;
  return buildSessionDocument({
    event: i.open !== undefined ? 'open' : 'close',
    current: e.current,
    userId: e.userId,
    grants: grantsOf(e.userId),
    openingFloat: i.open?.openingFloat ?? null,
    handovers: i.close?.handovers ?? [],
    context: { ...SESSION_CONTEXT, seq: e.seq, createdAtMs: Date.parse(e.createdAt) },
  });
});
