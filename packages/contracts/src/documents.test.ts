import { describe, expect, it } from 'vitest';

import { SaleDocumentV1 } from './documents';

// The sale document's wire schema (sync spec §6.1): a counter's finalized bill must pass, a malformed one must not.

const ID = (n: string) => `019a0000-0000-7000-8000-0000000000${n}`;

const sale = () => ({
  version: 1,
  id: '019a3f6e-7b10-7c3a-9d2e-5b8f1a2c3d4e',
  family: 'S',
  seq: 412,
  number: 'C03-S000412',
  kind: 'sale',
  deviceId: ID('d1'),
  branchId: ID('e1'),
  createdAt: '2026-11-02T10:15:30.000Z',
  businessDate: '2026-11-02',
  sellerId: ID('a1'),
  tierId: ID('b1'),
  customerId: null,
  walkinPhone: null,
  lines: [
    {
      lineNo: 1,
      itemId: ID('c1'),
      qty: 2000,
      listPrice: 145000,
      floorPrice: 130000,
      unitPrice: 145000,
      lineDiscount: 0,
      billShare: 3671,
      lineTotal: 286329,
    },
    {
      lineNo: 2,
      itemId: ID('c2'),
      qty: 1000,
      listPrice: 65000,
      floorPrice: 60000,
      unitPrice: 55000,
      lineDiscount: 10000,
      billShare: 696,
      lineTotal: 54304,
    },
    {
      lineNo: 3,
      itemId: ID('c3'),
      qty: 1500,
      listPrice: null,
      floorPrice: null,
      unitPrice: 33300,
      lineDiscount: 0,
      billShare: 633,
      lineTotal: 49317,
    },
  ],
  amounts: {
    subtotal: 404950,
    lineDiscountTotal: 10000,
    billDiscount: 5000,
    rounding: 50,
    taxTotal: 0,
    total: 390000,
  },
  payments: [
    { method: 'cash', amount: 200000, cashReceived: 250000, changeDue: 50000, reference: null },
    { method: 'jazzcash', amount: 190000, cashReceived: null, changeDue: null, reference: 'JC-88123' },
  ],
  cashDue: 200000,
  handoverStatus: 'pending',
  overrides: [
    {
      kind: 'below_floor',
      lineNo: 2,
      requestedBy: ID('a1'),
      approvedBy: ID('a2'),
      reason: 'customer_bargain',
      note: null,
      at: '2026-11-02T10:14:05.000Z',
      values: { list: 65000, floor: 60000, price: 55000 },
    },
    {
      kind: 'below_floor',
      lineNo: null,
      requestedBy: ID('a1'),
      approvedBy: ID('a2'),
      reason: 'other',
      note: 'Owner said so',
      at: '2026-11-02T10:15:00.000Z',
      values: { billDiscount: 5000, lines: [{ lineNo: 1, qty: 2000, unitPrice: 145000 }] },
    },
  ],
  clientVersion: '0.6.0',
});

type Sale = ReturnType<typeof sale>;
const accepts = (doc: unknown) => SaleDocumentV1.safeParse(doc).success;
const without = (key: keyof Sale) => {
  const doc: Partial<Sale> = sale();
  delete doc[key];
  return doc;
};

describe('SaleDocumentV1', () => {
  it("accepts a counter's finalized sale", () => {
    expect(SaleDocumentV1.safeParse(sale()).error).toBeUndefined();
  });

  it('accepts a sale paid without cash and without overrides', () => {
    expect(
      accepts({
        ...sale(),
        payments: [{ method: 'raast', amount: 390000, cashReceived: null, changeDue: null, reference: 'R1' }],
        cashDue: 0,
        handoverStatus: 'not_applicable',
        overrides: [],
      }),
    ).toBe(true);
  });

  it('refuses money that is not whole minor units', () => {
    expect(accepts({ ...sale(), cashDue: 2000.5 })).toBe(false);
    expect(accepts({ ...sale(), amounts: { ...sale().amounts, total: '390000' } })).toBe(false);
  });

  it('refuses a quantity that is not whole thousandths, or not above 0', () => {
    const line = sale().lines[0]!;
    expect(accepts({ ...sale(), lines: [{ ...line, qty: 1.5 }] })).toBe(false);
    expect(accepts({ ...sale(), lines: [{ ...line, qty: 0 }] })).toBe(false);
  });

  it('refuses another version, family or kind', () => {
    expect(accepts({ ...sale(), version: 2 })).toBe(false);
    expect(accepts({ ...sale(), family: 'H' })).toBe(false);
    expect(accepts({ ...sale(), kind: 'return' })).toBe(false);
  });

  it('refuses an id that is not a UUID, a bad date or a bad number', () => {
    expect(accepts({ ...sale(), id: 'doc-1' })).toBe(false);
    expect(accepts({ ...sale(), businessDate: '02/11/2026' })).toBe(false);
    expect(accepts({ ...sale(), createdAt: 'yesterday' })).toBe(false);
    expect(accepts({ ...sale(), number: 'C03-412' })).toBe(false);
  });

  it('refuses an unknown payment method, override kind or reason', () => {
    const p = sale().payments[0]!;
    const o = sale().overrides[0]!;
    expect(accepts({ ...sale(), payments: [{ ...p, method: 'voucher' }] })).toBe(false);
    expect(accepts({ ...sale(), overrides: [{ ...o, kind: 'void' }] })).toBe(false);
    expect(accepts({ ...sale(), overrides: [{ ...o, reason: 'because' }] })).toBe(false);
  });

  it('refuses a document without lines or payments, or missing a field', () => {
    expect(accepts({ ...sale(), lines: [] })).toBe(false);
    expect(accepts({ ...sale(), payments: [] })).toBe(false);
    expect(accepts(without('amounts'))).toBe(false);
    expect(accepts(without('sellerId'))).toBe(false);
  });

  it('refuses fields it does not know', () => {
    expect(accepts({ ...sale(), discountCode: 'X' })).toBe(false);
  });
});
