import { describe, expect, it } from 'vitest';

import { CashHandoverV1, CashSessionV1 } from './documents';

// The cash desk's wire schemas (W1-10, cash desk spec): what a desk writes must pass, a malformed one must not.

const ID = (n: string) => `019a0000-0000-7000-8000-0000000000${n}`;

const handover = () => ({
  version: 1,
  id: '019a7000-0000-7000-8000-000000000071',
  family: 'H',
  seq: 31,
  number: 'D01-H000031',
  kind: 'in',
  deviceId: ID('d9'),
  branchId: ID('e1'),
  sessionId: '019a6000-0000-7000-8000-000000000051',
  cashierId: ID('a5'),
  billNumber: 'C03-S000412',
  saleDocumentId: '019a5000-0000-7000-8000-000000000412',
  amount: 432000,
  cashReceived: 1000000,
  changeGiven: 568000,
  correctedFrom: 500000,
  method: 'scan',
  createdAt: '2026-11-02T10:16:02.000Z',
  businessDate: '2026-11-02',
  clientVersion: '0.8.0',
});

const open = () => ({
  version: 1,
  id: '019a6000-0000-7000-8000-000000000051',
  family: 'Z',
  seq: 3,
  number: 'D01-Z000003',
  event: 'open',
  sessionId: '019a6000-0000-7000-8000-000000000051',
  deviceId: ID('d9'),
  branchId: ID('e1'),
  userId: ID('a5'),
  openingFloat: 500000,
  expectedCash: null,
  createdAt: '2026-11-02T05:02:00.000Z',
  businessDate: '2026-11-02',
  clientVersion: '0.8.0',
});

const close = () => ({
  ...open(),
  id: '019a6000-0000-7000-8000-000000000081',
  seq: 4,
  number: 'D01-Z000004',
  event: 'close',
  openingFloat: null,
  expectedCash: 887000,
});

describe('CashHandoverV1', () => {
  it('accepts a handover in, a code-only scan and a payout', () => {
    expect(CashHandoverV1.safeParse(handover()).success).toBe(true);
    const scanned = {
      ...handover(),
      saleDocumentId: null,
      cashReceived: null,
      changeGiven: null,
      correctedFrom: null,
    };
    expect(CashHandoverV1.safeParse(scanned).success).toBe(true);
    const payout = {
      ...scanned,
      kind: 'payout',
      billNumber: 'C03-S000415',
      saleDocumentId: '019a5000-0000-7000-8000-000000000415',
      amount: 45000,
      method: 'queue',
    };
    expect(CashHandoverV1.safeParse(payout).success).toBe(true);
  });

  it.each([
    ['a payout with cash received', { kind: 'payout' }],
    ['an amount of 0', { amount: 0 }],
    ['a negative amount', { amount: -45000 }],
    ['another family', { family: 'S' }],
    ['a number in another series', { number: 'D01-S000031' }],
    ['a bill number that is not a sale', { billNumber: 'D01-H000001' }],
    ['an unknown method', { method: 'manual' }],
    ['paisa as a float', { amount: 4320.5 }],
    ['an extra field', { note: 'x' }],
  ])('refuses %s', (_name, change) => {
    expect(CashHandoverV1.safeParse({ ...handover(), ...change }).success).toBe(false);
  });
});

describe('CashSessionV1', () => {
  it('accepts an open with its float and a close with the expected cash', () => {
    expect(CashSessionV1.safeParse(open()).success).toBe(true);
    expect(CashSessionV1.safeParse(close()).success).toBe(true);
    expect(CashSessionV1.safeParse({ ...close(), expectedCash: -2000 }).success).toBe(true);
  });

  it.each([
    ['an open without a float', open, { openingFloat: null }],
    ['an open that names another session', open, { sessionId: ID('51') }],
    ['an open with an expected cash', open, { expectedCash: 500000 }],
    ['a negative float', open, { openingFloat: -100 }],
    ['a close without the expected cash', close, { expectedCash: null }],
    ['a close with a float', close, { openingFloat: 500000 }],
    ['a close that is its own session', close, { sessionId: '019a6000-0000-7000-8000-000000000081' }],
  ])('refuses %s', (_name, base, change) => {
    expect(CashSessionV1.safeParse({ ...base(), ...change }).success).toBe(false);
  });
});
