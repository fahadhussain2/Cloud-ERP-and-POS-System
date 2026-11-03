import documentCases from '../golden/void-document.json';
import reviewCases from '../golden/void-review.json';
import checkCases from '../golden/void.json';
import { money } from './money';
import { BRANCH, CONTEXT, COUNTER, grantsOf } from './testing/counter';
import { runGolden, type GoldenFile } from './testing/golden';
import {
  buildVoidDocument,
  checkVoid,
  reviewVoid,
  type CashDeskStatus,
  type SaleVoidDocument,
  type VoidableBill,
  type VoidReason,
  type VoidReview,
} from './void';

// Voiding a bill on the counter that made it (POS-11, PRD W5, D-002, POS spec §18, W1-12): the check, the void
// document (family V), and the server's review of it.

const MANAGER = '019a0000-0000-7000-8000-0000000000a2';

// C03-S000412: Rs 4,320 in cash, finalized on this counter today (2026-11-03), not handed over yet.
const BILL: VoidableBill = {
  id: '019a5000-0000-7000-8000-000000000412',
  number: 'C03-S000412',
  deviceId: COUNTER,
  businessDate: '2026-11-03',
  total: money(432000),
  cashDue: money(432000),
  status: 'finalized',
};

interface CheckCase {
  bill?: Partial<VoidableBill>;
  approverId?: string;
  deskStatus?: CashDeskStatus;
  today?: string;
  reason?: VoidReason | null;
  note?: string | null;
}

const checkInput = (i: CheckCase) => {
  const approverId = i.approverId ?? MANAGER;
  return {
    bill: { ...BILL, ...i.bill },
    deviceId: COUNTER,
    branchId: BRANCH,
    deskStatus: i.deskStatus ?? 'pending',
    approverId,
    approverGrants: grantsOf(approverId),
    reason: i.reason === undefined ? 'wrong_price' : i.reason,
    note: i.note ?? null,
  };
};

runGolden(checkCases as unknown as GoldenFile<CheckCase>, (i) =>
  checkVoid({ ...checkInput(i), today: i.today ?? '2026-11-03' }),
);

runGolden(
  documentCases as unknown as GoldenFile<CheckCase & { userId: string; seq: number; createdAt: string }>,
  (i) =>
    buildVoidDocument({
      ...checkInput(i),
      userId: i.userId,
      context: { ...CONTEXT, seq: i.seq, createdAtMs: Date.parse(i.createdAt) },
    }),
);

// C03-V000001: the manager voids C03-S000412 at 14:20 (09:20 UTC) on 2026-11-03, before its handover.
const VOID: SaleVoidDocument = {
  version: 1,
  id: CONTEXT.id,
  family: 'V',
  seq: 1,
  number: 'C03-V000001',
  deviceId: COUNTER,
  branchId: BRANCH,
  saleId: BILL.id,
  saleNumber: BILL.number,
  saleBusinessDate: BILL.businessDate,
  saleTotal: BILL.total,
  saleCashDue: BILL.cashDue,
  userId: '019a0000-0000-7000-8000-0000000000a1',
  approvedBy: MANAGER,
  reason: 'wrong_price',
  note: null,
  handoverSeen: 'pending',
  createdAt: '2026-11-03T09:20:00.000Z',
  businessDate: '2026-11-03',
  clientVersion: CONTEXT.clientVersion,
};

interface ReviewCase {
  void: Partial<SaleVoidDocument>;
  context: Omit<VoidReview, 'grants' | 'branchId'>;
}

runGolden(reviewCases as unknown as GoldenFile<ReviewCase>, (i) => {
  const document = { ...VOID, ...i.void };
  return reviewVoid(document, { ...i.context, grants: grantsOf(document.approvedBy), branchId: BRANCH });
});
