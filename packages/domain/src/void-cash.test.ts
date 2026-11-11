import { describe, expect, it } from 'vitest';

import checkCases from '../golden/void-cash-check.json';
import reviewCases from '../golden/void-cash-review.json';
import type { CashMovementDocument } from './cash-movement';
import type { DeskSession } from './cash-session';
import { DomainError } from './errors';
import { money } from './money';
import type { RoleGrant } from './permissions';
import { runGolden, type GoldenFile } from './testing/golden';
import {
  buildVoidCashDocument,
  checkVoidCash,
  reviewVoidCash,
  type VoidCashBill,
  type VoidCashReview,
} from './void-cash';

// Cash taken for a voided bill, given back at the desk (W1-23, D-111): the check, the movement, the server's review.

const BRANCH = '019a0000-0000-7000-8000-0000000000e1';
const CASHIER = '019a0000-0000-7000-8000-0000000000a5';
const MANAGER = '019a0000-0000-7000-8000-0000000000a2';
const grant = (permissions: string[]): RoleGrant[] => [
  { permissions, limits: { maxDiscountBp: 1000, voidWindow: 'same_day_before_handover' }, branchId: null },
];
// …a1 a salesman; …a2 a manager (pos.void); …a5 the cashier; …a6 a cashier without cash.refund.pay; …a9 unknown.
const STAFF: Record<string, readonly RoleGrant[]> = {
  '019a0000-0000-7000-8000-0000000000a1': grant(['pos.sale.create']),
  [MANAGER]: grant(['pos.sale.create', 'pos.void']),
  [CASHIER]: grant(['cash.handover.receive', 'cash.refund.pay']),
  '019a0000-0000-7000-8000-0000000000a6': grant(['cash.handover.receive']),
};
const grantsOf = (userId: string): readonly RoleGrant[] => STAFF[userId] ?? [];

const SESSION: DeskSession = {
  id: '019a6000-0000-7000-8000-000000000051',
  cashierId: CASHIER,
  openingFloat: money(500000),
  status: 'open',
};
const BILL: VoidCashBill = {
  number: 'C03-S000051',
  status: 'voided',
  cashTaken: money(100000),
  givenBack: false,
};

interface CheckCase {
  bill?: Partial<VoidCashBill>;
  session?: Partial<DeskSession> | null;
  cashierId?: string;
  approverId?: string | null;
}

const checkInput = (i: CheckCase) => {
  const cashierId = i.cashierId ?? CASHIER;
  const approverId = i.approverId === undefined ? MANAGER : i.approverId;
  return {
    session: i.session === null ? null : { ...SESSION, ...i.session },
    cashierId,
    grants: grantsOf(cashierId),
    branchId: BRANCH,
    bill: { ...BILL, ...i.bill },
    approverId,
    approverGrants: approverId === null ? [] : grantsOf(approverId),
  };
};

runGolden(checkCases as unknown as GoldenFile<CheckCase>, (i) => checkVoidCash(checkInput(i)));

const CONTEXT = {
  id: '019a7000-0000-7000-8000-000000000012',
  seq: 12,
  deviceId: '019a0000-0000-7000-8000-0000000000d9',
  deviceCode: 'D01',
  branchId: BRANCH,
  // 22:59:30 UTC is 03:59:30 in Karachi: still 2026-11-11's business day (cutoff 04:00).
  createdAtMs: Date.parse('2026-11-11T22:59:30.000Z'),
  timeZone: 'Asia/Karachi',
  cutoffHour: 4,
  clientVersion: '0.9.3',
};

const MOVEMENT: CashMovementDocument = {
  version: 2,
  id: CONTEXT.id,
  family: 'M',
  seq: 12,
  number: 'D01-M000012',
  kind: 'void_cash',
  deviceId: CONTEXT.deviceId,
  branchId: BRANCH,
  sessionId: SESSION.id,
  cashierId: CASHIER,
  amount: money(100000),
  expenseCategoryId: null,
  partyId: null,
  bankAccountId: null,
  targetName: null,
  note: null,
  reference: null,
  billNumber: 'C03-S000051',
  approvedByUserId: MANAGER,
  createdAt: '2026-11-11T22:59:30.000Z',
  businessDate: '2026-11-11',
  clientVersion: '0.9.3',
};

describe('the give-back movement', () => {
  it('is a V2 cash movement of kind void_cash, for the full amount, with the approver', () => {
    expect(buildVoidCashDocument({ ...checkInput({}), context: CONTEXT })).toStrictEqual(MOVEMENT);
  });

  it('refuses what the check refuses, writing nothing', () => {
    let thrown: unknown;
    try {
      buildVoidCashDocument({ ...checkInput({ approverId: CASHIER }), context: CONTEXT });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).code).toBe('approver_is_cashier');
  });
});

interface ReviewCase {
  movement?: Partial<Omit<CashMovementDocument, 'approvedByUserId'>> & { approvedByUserId?: string | null };
  context?: Partial<Omit<VoidCashReview, 'grantsOf' | 'branchId'>>;
}

runGolden(reviewCases as unknown as GoldenFile<ReviewCase>, (i) => {
  const { approvedByUserId, ...rest } = i.movement ?? {};
  const movement: CashMovementDocument = { ...MOVEMENT, ...rest };
  if (approvedByUserId === null) delete movement.approvedByUserId;
  else if (approvedByUserId !== undefined) movement.approvedByUserId = approvedByUserId;
  return reviewVoidCash(movement, {
    bill: { status: 'voided' },
    handover: { amount: money(100000) },
    existing: null,
    sessionCashierId: CASHIER,
    ...i.context,
    grantsOf,
    branchId: BRANCH,
  });
});
