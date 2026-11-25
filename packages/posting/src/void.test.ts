import { money, qty } from '@erp/domain';
import { describe, expect, it } from 'vitest';

import voidCases from '../golden/post-void.json';
import { runGolden, type GoldenFile } from './testing/golden';
import type { LedgerState, Posting, PostingContext, PostingVoid } from './types';
import { postVoid } from './void';

// A void reverses its sale's own posting (posting rules §4.4, W1-12): every journal line swapped, dated the void's
// business date; the stock back at the sale's own unit costs; the customer ledger entry reversed.

interface Input {
  void: PostingVoid;
  /** The voided sale's posting, as stored. */
  original: Posting;
  state: LedgerState;
  context?: { lockDate?: string };
}

const contextOf = (o: Input['context'] = {}): PostingContext => ({
  // A reversal names no role and no method: it swaps the accounts the sale already posted to.
  accounts: { roles: {}, methods: {} },
  lockDate: o.lockDate ?? null,
  customer: null,
});

const file = voidCases as unknown as GoldenFile<Input>;
runGolden(file, (i) => postVoid(i.void, i.original, contextOf(i.context), i.state));

describe('a void and its sale', () => {
  for (const c of file.cases)
    it(`net to nothing in the books: ${c.name}`, () => {
      const r = postVoid(c.input.void, c.input.original, contextOf(c.input.context), c.input.state);
      if (!r.ok) throw new Error(r.error.code);
      const net = new Map<string, number>();
      for (const l of [...c.input.original.journal.lines, ...r.posting.journal.lines]) {
        const key = `${l.accountId}|${l.partyId ?? ''}`;
        net.set(key, (net.get(key) ?? 0) + l.debit - l.credit);
      }
      expect([...net.values()].every((v) => v === 0)).toBe(true);
      const qty = [...c.input.original.movements, ...r.posting.movements].reduce((s, m) => s + m.qtyDelta, 0);
      expect(qty).toBe(0);
      const party = [...c.input.original.partyEntries, ...r.posting.partyEntries].reduce(
        (s, e) => s + e.amount,
        0,
      );
      expect(party).toBe(0);
    });
});

// D-124: a returned line that covered stock sold before it arrived carries a cost correction (a movement with no
// quantity); voiding the bill reverses it as it was, and leaves the item's cost where it was before the bill.
describe('a void of a return that settled a shortfall', () => {
  it('reverses the correction and brings the cost back', async () => {
    const { postSale } = await import('./sale');
    const roles = {
      CASH_IN_TRANSIT: '1120',
      INVENTORY: '1300',
      SALES: '4100',
      SALES_RETURNS: '4110',
      COGS: '5100',
    };
    const before: LedgerState = {
      costs: { pads: { avgCost: money(320000), onHand: qty(-2000) } },
      balances: { shop: { pads: qty(-2000) } },
    };
    const sale = postSale(
      {
        id: 'ret-1',
        number: 'C03-S000415',
        branchId: 'b',
        businessDate: '2026-11-12',
        customerId: null,
        lines: [
          {
            id: 'line-1',
            lineNo: 1,
            itemId: 'pads',
            locationId: 'shop',
            qty: qty(-1000),
            lineTotal: money(-435000),
            taxAmount: money(0),
            returnUnitCost: money(310000),
          },
        ],
        amounts: { billDiscount: money(0), rounding: money(0), taxTotal: money(0) },
        payments: [{ method: 'cash', amount: money(-435000) }],
      },
      { accounts: { roles, methods: { cash: null } }, lockDate: null, customer: null },
      before,
    );
    if (!sale.ok) throw new Error(sale.error.code);
    expect(sale.posting.movements.map((m) => m.qtyDelta)).toEqual([1000, 0]);

    const original: Posting = { ...sale.posting };
    const after = {
      costs: { ...before.costs, ...sale.posting.state.costs },
      balances: sale.posting.state.balances,
    };
    const r = postVoid(
      {
        id: 'v-1',
        number: 'C03-V000001',
        saleNumber: 'C03-S000415',
        branchId: 'b',
        businessDate: '2026-11-12',
      },
      original,
      contextOf(),
      after,
    );
    if (!r.ok) throw new Error(r.error.code);
    expect(r.posting.movements.map((m) => [m.qtyDelta, m.valueDelta])).toEqual([
      [-1000, -310000],
      [0, -10000],
    ]);
    expect(r.posting.state.costs['pads']).toEqual({ avgCost: 320000, onHand: -2000 });
  });
});
