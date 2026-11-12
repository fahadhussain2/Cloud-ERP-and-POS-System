import { describe, expect, it } from 'vitest';

import returnDocuments from '../../domain/golden/return-document.json';
import { SaleDocumentV1, SaleDocumentV2 } from './documents';

// The return's wire schema (SaleDocumentV2, sync spec §6.1, POS spec §19, W1-13): every return or exchange the domain
// builds passes, a malformed one doesn't, and a plain sale stays version 1.

const built = returnDocuments.cases.flatMap((c) => ('expected' in c ? [c.expected] : []));
const first = () => structuredClone(built[0]!) as unknown as Record<string, unknown> & { lines: object[] };

describe('SaleDocumentV2', () => {
  it('takes every return and exchange the domain builds', () => {
    expect(built.length).toBeGreaterThan(8);
    for (const d of built) expect(SaleDocumentV2.safeParse(d).success, d.kind).toBe(true);
  });

  it('is not a version 1 sale', () => {
    for (const d of built) expect(SaleDocumentV1.safeParse(d).success).toBe(false);
  });

  const line = (change: Record<string, unknown>) => {
    const d = first();
    d.lines = [{ ...d.lines[0], ...change }];
    return d;
  };

  it.each([
    ['version 1', { version: 1 }],
    ['the kind sale', { kind: 'sale' }],
    ['an exchange without sold lines', { kind: 'exchange' }],
    ['no returned line', { lines: [] }],
    ['both an original and no receipt', { noReceipt: { ref: null } }],
    ['neither an original nor no receipt', { returnOf: undefined }],
    ['a refund total of 0', { amounts: { ...(first().amounts as object), returnTotal: 0 } }],
    [
      'a payment of 0',
      { payments: [{ method: 'cash', amount: 0, cashReceived: null, changeDue: null, reference: null }] },
    ],
    ['an unknown field', { extra: 1 }],
  ])('refuses %s', (_name, change) => {
    expect(SaleDocumentV2.safeParse({ ...first(), ...change }).success).toBe(false);
  });

  it.each([
    ['a returned line that adds', { qty: 1000 }],
    ['a refund as a positive total', { lineTotal: 435000 }],
    ['a discount on a returned line', { lineDiscount: 100 }],
    ['an unknown reason', { reason: 'lost' }],
    ['an unknown condition', { condition: 'broken' }],
    ['an empty note', { note: '' }],
    ['a note of 201 characters', { note: 'x'.repeat(201) }],
    ['no original line on a return with a receipt', { returnOf: null }],
  ])('refuses %s', (_name, change) => {
    expect(SaleDocumentV2.safeParse(line(change)).success).toBe(false);
  });

  it('refuses an original line on a return without a receipt', () => {
    const d = built.find((x) => 'noReceipt' in x)!;
    const bad = structuredClone(d) as unknown as { lines: Record<string, unknown>[] };
    bad.lines[0]!.returnOf = { documentId: d.id, number: 'C03-S000412', lineNo: 1 };
    expect(SaleDocumentV2.safeParse(bad).success).toBe(false);
  });

  it('refuses sold lines before the returned ones', () => {
    const d = built.find((x) => x.kind === 'exchange')!;
    const swapped = { ...d, lines: [...d.lines].reverse() };
    expect(SaleDocumentV2.safeParse(swapped).success).toBe(false);
  });
});
