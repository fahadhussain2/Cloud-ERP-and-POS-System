import { describe, expect, it } from 'vitest';

import voidDocuments from '../../domain/golden/void-document.json';
import { SaleDocumentV1, SaleVoidV1 } from './documents';

// The void's wire schema (family V, POS spec §18, W1-12) and the reissue's link on a sale: every void the domain builds
// passes, a malformed one doesn't.

const built = voidDocuments.cases.flatMap((c) => ('expected' in c ? [c.expected] : []));
const voided = () => ({ ...built[0]! }) as Record<string, unknown>;

describe('SaleVoidV1', () => {
  it('takes every void the domain builds', () => {
    expect(built.length).toBeGreaterThan(3);
    for (const d of built) expect(SaleVoidV1.safeParse(d).success, String(d.number)).toBe(true);
  });

  it.each([
    ['another family', { family: 'S' }],
    ['a bill number for its own', { number: 'C03-S000001' }],
    ['a void number for the bill', { saleNumber: 'C03-V000001' }],
    ['an unknown reason', { reason: 'changed_mind' }],
    ['"other" without a note', { reason: 'other', note: null }],
    ['an empty note', { note: '' }],
    ['a note of 201 characters', { note: 'x'.repeat(201) }],
    ['a bill with cash said to need nothing from the desk', { handoverSeen: 'not_applicable' }],
    ['a bill without cash said to be pending at the desk', { saleCashDue: 0 }],
    ['a handed-over bill', { handoverSeen: 'received' }],
    ['an unknown field', { extra: 1 }],
    ['money with paisa as a fraction', { saleTotal: 4320.5 }],
  ])('refuses %s', (_name, change) => {
    expect(SaleVoidV1.safeParse({ ...voided(), ...change }).success).toBe(false);
  });
});

describe('a reissue on the sale document', () => {
  const sale = () => ({
    version: 1,
    id: '019a3f70-0000-7000-8000-00000000f004',
    family: 'S',
    seq: 414,
    number: 'C03-S000414',
    kind: 'sale',
    deviceId: '019a0000-0000-7000-8000-0000000000d1',
    branchId: '019a0000-0000-7000-8000-0000000000e1',
    createdAt: '2026-11-03T09:30:00.000Z',
    businessDate: '2026-11-03',
    sellerId: '019a0000-0000-7000-8000-0000000000a1',
    tierId: '019a0000-0000-7000-8000-0000000000b1',
    customerId: null,
    walkinPhone: null,
    lines: [
      {
        lineNo: 1,
        itemId: '019a0000-0000-7000-8000-0000000000c1',
        qty: 1000,
        listPrice: 145000,
        floorPrice: 140000,
        unitPrice: 145000,
        lineDiscount: 0,
        billShare: 0,
        lineTotal: 145000,
      },
    ],
    amounts: {
      subtotal: 145000,
      lineDiscountTotal: 0,
      billDiscount: 0,
      rounding: 0,
      taxTotal: 0,
      total: 145000,
    },
    payments: [{ method: 'raast', amount: 145000, cashReceived: null, changeDue: null, reference: 'RST-1' }],
    cashDue: 0,
    handoverStatus: 'not_applicable',
    overrides: [],
    clientVersion: '0.9.0',
  });

  it('is optional, and names a bill by id and number', () => {
    expect(SaleDocumentV1.safeParse(sale()).success).toBe(true);
    const reissueOf = { id: '019a5000-0000-7000-8000-000000000412', number: 'C03-S000412' };
    expect(SaleDocumentV1.safeParse({ ...sale(), reissueOf }).success).toBe(true);
    expect(
      SaleDocumentV1.safeParse({ ...sale(), reissueOf: { ...reissueOf, number: 'C03-V000001' } }).success,
    ).toBe(false);
    expect(SaleDocumentV1.safeParse({ ...sale(), reissueOf: null }).success).toBe(false);
  });
});
