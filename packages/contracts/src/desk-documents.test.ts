import { describe, expect, it } from 'vitest';

import { CashMovementV1, CashMovementV2, CashSessionV2, CustomerCollectionV1 } from './documents';

// The desk's W1-11 wire schemas (cash desk spec): what a desk writes must pass, a malformed one must not.

const ID = (n: string) => `019a0000-0000-7000-8000-0000000000${n}`;
const common = {
  version: 1,
  id: '019a7000-0000-7000-8000-000000000071',
  deviceId: ID('d9'),
  branchId: ID('e1'),
  sessionId: '019a6000-0000-7000-8000-000000000051',
  cashierId: ID('a5'),
  createdAt: '2026-11-02T10:30:00.000Z',
  businessDate: '2026-11-02',
  clientVersion: '0.8.0',
};

const collection = () => ({
  ...common,
  family: 'R',
  seq: 1,
  number: 'D01-R000001',
  partyId: '019a3000-0000-7000-8000-0000000000c1',
  customerCode: 'C0042',
  customerName: 'Ali Autos',
  methodId: '019a1000-0000-7000-8000-000000000101',
  methodCode: 'cash',
  amount: 500000,
  reference: null,
  note: null,
  balanceBefore: 1250000,
});

const movement = () => ({
  ...common,
  family: 'M',
  seq: 4,
  number: 'D01-M000004',
  kind: 'expense',
  amount: 20000,
  expenseCategoryId: '019a1000-0000-7000-8000-000000000201',
  partyId: null,
  bankAccountId: null,
  targetName: 'Tea',
  note: 'tea',
  reference: null,
});

const session = {
  id: '019a6000-0000-7000-8000-000000000081',
  deviceId: ID('d9'),
  branchId: ID('e1'),
  userId: ID('a5'),
  createdAt: '2026-11-02T15:30:00.000Z',
  businessDate: '2026-11-02',
  clientVersion: '0.8.0',
  version: 2,
  family: 'Z',
};
const open = () => ({
  ...session,
  seq: 6,
  number: 'D01-Z000006',
  event: 'open',
  sessionId: session.id,
  openingFloat: 480000,
  expectedCash: null,
  floatExpected: 500000,
  countedCash: null,
  denominations: null,
  variance: null,
  varianceReason: null,
  varianceNote: null,
  acknowledgedByUserId: null,
  leftInDrawer: null,
});
const close = () => ({
  ...open(),
  seq: 7,
  number: 'D01-Z000007',
  event: 'close',
  sessionId: '019a6000-0000-7000-8000-000000000051',
  openingFloat: null,
  floatExpected: null,
  expectedCash: 1564700,
  countedCash: 1534700,
  denominations: { '500000': 2, '100000': 5, '10000': 3, '1000': 4, '100': 7 },
  variance: -30000,
  varianceReason: 'change_error',
  acknowledgedByUserId: ID('a2'),
  leftInDrawer: 500000,
});

describe('CustomerCollectionV1', () => {
  it('takes a cash collection and a Raast one with its reference', () => {
    expect(CustomerCollectionV1.safeParse(collection()).success).toBe(true);
    expect(
      CustomerCollectionV1.safeParse({ ...collection(), methodCode: 'raast', reference: 'TX-1' }).success,
    ).toBe(true);
  });

  it('refuses on account, nothing collected and a wrong family number', () => {
    expect(CustomerCollectionV1.safeParse({ ...collection(), methodCode: 'on_account' }).success).toBe(false);
    expect(CustomerCollectionV1.safeParse({ ...collection(), amount: 0 }).success).toBe(false);
    expect(CustomerCollectionV1.safeParse({ ...collection(), number: 'D01-M000001' }).success).toBe(false);
  });
});

describe('CashMovementV1', () => {
  it('takes each kind with exactly its own field', () => {
    expect(CashMovementV1.safeParse(movement()).success).toBe(true);
    const supplier = {
      ...movement(),
      kind: 'supplier_payment',
      expenseCategoryId: null,
      partyId: '019a3000-0000-7000-8000-0000000000c2',
    };
    expect(CashMovementV1.safeParse(supplier).success).toBe(true);
    const safe = { ...movement(), kind: 'to_safe', expenseCategoryId: null, targetName: null, note: null };
    expect(CashMovementV1.safeParse(safe).success).toBe(true);
  });

  it('refuses a missing or extra field, and an expense without a note', () => {
    expect(CashMovementV1.safeParse({ ...movement(), expenseCategoryId: null }).success).toBe(false);
    expect(CashMovementV1.safeParse({ ...movement(), bankAccountId: ID('b1') }).success).toBe(false);
    expect(CashMovementV1.safeParse({ ...movement(), note: null }).success).toBe(false);
  });
});

describe('CashMovementV2 (W1-23)', () => {
  const giveBack = () => ({
    ...common,
    version: 2,
    family: 'M',
    seq: 12,
    number: 'D01-M000012',
    kind: 'void_cash',
    amount: 100000,
    expenseCategoryId: null,
    partyId: null,
    bankAccountId: null,
    targetName: null,
    note: null,
    reference: null,
    billNumber: 'C03-S000051',
    approvedByUserId: ID('a2'),
  });

  it('takes cash given back for a voided bill, and the V1 kinds as version 2', () => {
    expect(CashMovementV2.safeParse(giveBack()).success).toBe(true);
    expect(CashMovementV2.safeParse({ ...movement(), version: 2 }).success).toBe(true);
  });

  it.each([
    ['no bill', { billNumber: undefined }],
    ['a void number for the bill', { billNumber: 'C03-V000001' }],
    ['no approver', { approvedByUserId: undefined }],
    ['the cashier approving', { approvedByUserId: ID('a5') }],
    ['a category', { expenseCategoryId: ID('c1') }],
    ['a target name', { targetName: 'Petty cash' }],
  ])('refuses a give-back with %s', (_name, change) => {
    expect(CashMovementV2.safeParse({ ...giveBack(), ...change }).success).toBe(false);
  });

  it('refuses a cash-out naming a bill or an approver', () => {
    expect(CashMovementV2.safeParse({ ...movement(), version: 2, billNumber: 'C03-S000051' }).success).toBe(
      false,
    );
    expect(CashMovementV2.safeParse({ ...movement(), version: 2, approvedByUserId: ID('a2') }).success).toBe(
      false,
    );
  });

  it('V1 still refuses void_cash', () => {
    expect(CashMovementV1.safeParse({ ...giveBack(), version: 1 }).success).toBe(false);
  });
});

describe('CashSessionV2', () => {
  it('takes an open and a counted close', () => {
    expect(CashSessionV2.safeParse(open()).success).toBe(true);
    expect(CashSessionV2.safeParse({ ...open(), floatExpected: null }).success).toBe(true);
    expect(CashSessionV2.safeParse(close()).success).toBe(true);
    expect(CashSessionV2.safeParse({ ...close(), acknowledgedByUserId: null }).success).toBe(true);
  });

  it('refuses a close whose variance is not counted − expected, or without a reason', () => {
    expect(CashSessionV2.safeParse({ ...close(), variance: -100 }).success).toBe(false);
    expect(CashSessionV2.safeParse({ ...close(), varianceReason: null }).success).toBe(false);
    expect(CashSessionV2.safeParse({ ...close(), leftInDrawer: 1534800 }).success).toBe(false);
    expect(CashSessionV2.safeParse({ ...close(), countedCash: null }).success).toBe(false);
  });

  it('refuses an exact close with a reason, and an open with a count', () => {
    const exact = { ...close(), countedCash: 1564700, variance: 0 };
    expect(CashSessionV2.safeParse(exact).success).toBe(false);
    expect(
      CashSessionV2.safeParse({ ...exact, varianceReason: null, acknowledgedByUserId: null }).success,
    ).toBe(true);
    expect(CashSessionV2.safeParse({ ...open(), countedCash: 100 }).success).toBe(false);
  });
});
