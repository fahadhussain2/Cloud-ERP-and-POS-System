import { describe, expect, it } from 'vitest';

import { money, type Money } from '@erp/domain';

import handoverCases from '../golden/post-handover.json';
import { postHandover } from './handover';
import { postSale } from './sale';
import { runGolden, type GoldenFile } from './testing/golden';
import type { JournalLine, PostingContext, PostingHandover, PostingRole } from './types';

// Delux's accounts by code (posting rules §2).
const ROLES: Partial<Record<PostingRole, string>> = {
  CASH_DRAWER: '1110',
  CASH_IN_TRANSIT: '1120',
  SUSPENSE: '1190',
  INVENTORY: '1300',
  SALES: '4100',
  COGS: '5100',
};

interface Input {
  handover: PostingHandover;
  context?: { lockDate?: string; withoutRoles?: PostingRole[] };
}

function contextOf(o: Input['context'] = {}): PostingContext {
  const roles = { ...ROLES };
  for (const r of o.withoutRoles ?? []) delete roles[r];
  return { accounts: { roles, methods: { cash: null } }, lockDate: o.lockDate ?? null, customer: null };
}

runGolden(handoverCases as unknown as GoldenFile<Input>, (i) =>
  postHandover(i.handover, contextOf(i.context)),
);

// Posting rules §4.5's control property: once every cash bill is handed over, cash in transit is back to 0, and the
// handover's order against its bill doesn't change the books (an offline scan often arrives first).
describe('a cash bill and its handover, in either order', () => {
  const sale = {
    id: 'sale-1',
    number: 'C03-S000412',
    branchId: 'br-main',
    businessDate: '2026-11-02',
    customerId: null,
    lines: [
      {
        id: 'line-1',
        lineNo: 1,
        itemId: 'item-pads',
        locationId: 'loc-shop',
        qty: 1000 as never,
        lineTotal: money(432000),
        taxAmount: money(0),
      },
    ],
    amounts: { billDiscount: money(0), rounding: money(0), taxTotal: money(0) },
    payments: [{ method: 'cash' as const, amount: money(432000) }],
  };
  const handover: PostingHandover = {
    id: 'handover-1',
    number: 'D01-H000031',
    billNumber: 'C03-S000412',
    branchId: 'br-main',
    businessDate: '2026-11-02',
    kind: 'in',
    amount: money(432000),
  };
  const state = { costs: { 'item-pads': { avgCost: money(310000), onHand: 5000 as never } }, balances: {} };

  const balances = (lines: JournalLine[]): Record<string, Money> => {
    const out: Record<string, number> = {};
    for (const l of lines) out[l.accountId] = (out[l.accountId] ?? 0) + l.debit - l.credit;
    return out as Record<string, Money>;
  };
  const linesOf = (r: ReturnType<typeof postHandover> | ReturnType<typeof postSale>): JournalLine[] => {
    if (!r.ok) throw new Error(`not posted: ${r.error.code}`);
    return r.posting.journal.lines;
  };

  it('leaves cash in transit at 0 and the drawer holding the cash due', () => {
    const ctx = contextOf();
    const saleFirst = balances([
      ...linesOf(postSale(sale, ctx, state)),
      ...linesOf(postHandover(handover, ctx)),
    ]);
    const handoverFirst = balances([
      ...linesOf(postHandover(handover, ctx)),
      ...linesOf(postSale(sale, ctx, state)),
    ]);
    expect(saleFirst).toStrictEqual(handoverFirst);
    expect(saleFirst['1120']).toBe(0);
    expect(saleFirst['1110']).toBe(432000);
  });
});
