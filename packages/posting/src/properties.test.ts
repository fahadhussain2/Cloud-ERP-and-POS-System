import type { Money, PaymentMethodCode, Qty } from '@erp/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { emptyState, replay, type ReplayStep } from './replay';
import { postSale } from './sale';
import type { LedgerState, PostingContext, PostingSale } from './types';

// Properties of every posted sale (posting rules §1, invariant 2; rule 4): balanced, one-sided lines, cost lines
// equal to the stock movements, and a replay that doesn't depend on where it is split.

const CONTEXT: PostingContext = {
  accounts: {
    roles: {
      CASH_IN_TRANSIT: '1120',
      SUSPENSE: '1190',
      AR_CONTROL: '1200',
      INVENTORY: '1300',
      TAX_PAYABLE: '2300',
      SALES: '4100',
      SALES_DISCOUNT: '4120',
      ROUNDING: '4210',
      COGS: '5100',
    },
    methods: { cash: null, raast: '1160', jazzcash: '1170', card: '1180', on_account: null },
  },
  lockDate: null,
  customer: { paymentTermsDays: 15 },
};

const ITEMS = ['item-a', 'item-b', 'item-c', 'item-d'];
const LOCATIONS = ['loc-shop', 'loc-godown'];
const METHODS: PaymentMethodCode[] = ['cash', 'raast', 'jazzcash', 'card', 'on_account'];

const amount = (max: number) => fc.integer({ min: 0, max }).map((n) => n as Money);

const sale = (id: number): fc.Arbitrary<PostingSale> =>
  fc
    .record({
      lines: fc.array(
        fc.record({
          itemId: fc.constantFrom(...ITEMS),
          locationId: fc.constantFrom(...LOCATIONS),
          qty: fc.integer({ min: 1, max: 50_000 }).map((n) => n as Qty),
          lineTotal: amount(5_000_000),
          taxAmount: amount(100_000),
        }),
        { minLength: 1, maxLength: 6 },
      ),
      billDiscount: amount(100_000),
      rounding: fc.integer({ min: -99, max: 99 }).map((n) => n as Money),
      payments: fc.array(fc.record({ method: fc.constantFrom(...METHODS), amount: amount(5_000_000) }), {
        minLength: 1,
        maxLength: 3,
      }),
    })
    .map((s) => ({
      id: `sale-${id}`,
      number: `C03-S${String(id).padStart(6, '0')}`,
      branchId: 'br-main',
      businessDate: '2026-11-02',
      customerId: 'party-khan',
      lines: s.lines.map((l, i) => ({ ...l, id: `sale-${id}-line-${i + 1}`, lineNo: i + 1 })),
      amounts: {
        billDiscount: s.billDiscount,
        rounding: s.rounding,
        taxTotal: s.lines.reduce((t, l) => t + l.taxAmount, 0) as Money,
      },
      payments: s.payments,
    }));

const state: fc.Arbitrary<LedgerState> = fc
  .record({
    costs: fc.dictionary(
      fc.constantFrom(...ITEMS),
      fc.record({
        avgCost: fc.option(amount(2_000_000), { nil: null }),
        onHand: fc.integer({ min: -20_000, max: 200_000 }).map((n) => n as Qty),
      }),
    ),
    balances: fc.dictionary(
      fc.constantFrom(...LOCATIONS),
      fc.dictionary(
        fc.constantFrom(...ITEMS),
        fc.integer({ min: -20_000, max: 200_000 }).map((n) => n as Qty),
      ),
    ),
  })
  .map((s) => s);

describe('posting properties', () => {
  it('posts every generated sale as a balanced entry of one-sided, non-zero lines', () => {
    fc.assert(
      fc.property(sale(1), state, (s, st) => {
        const r = postSale(s, CONTEXT, st);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const lines = r.posting.journal.lines;
        const debits = lines.reduce((t, l) => t + l.debit, 0);
        const credits = lines.reduce((t, l) => t + l.credit, 0);
        expect(debits).toBe(credits);
        for (const l of lines) {
          expect(l.debit >= 0 && l.credit >= 0).toBe(true);
          expect(l.debit === 0 || l.credit === 0).toBe(true);
          expect(l.debit + l.credit).toBeGreaterThan(0);
        }
      }),
    );
  });

  it('values COGS and INVENTORY at exactly minus the movements’ value, one movement per line', () => {
    fc.assert(
      fc.property(sale(1), state, (s, st) => {
        const r = postSale(s, CONTEXT, st);
        if (!r.ok) throw new Error(r.error.code);
        const value = 0 - r.posting.movements.reduce((t, m) => t + m.valueDelta, 0);
        const cogs = r.posting.journal.lines.filter((l) => l.accountId === '5100');
        const inventory = r.posting.journal.lines.filter((l) => l.accountId === '1300');
        expect(cogs.reduce((t, l) => t + l.debit, 0)).toBe(value);
        expect(inventory.reduce((t, l) => t + l.credit, 0)).toBe(value);
        expect(r.posting.movements.map((m) => m.sourceLineId)).toEqual(s.lines.map((l) => l.id));
      }),
    );
  });

  it('moves stock by exactly the quantities sold, per item and location', () => {
    fc.assert(
      fc.property(sale(1), state, (s, st) => {
        const r = postSale(s, CONTEXT, st);
        if (!r.ok) throw new Error(r.error.code);
        for (const [loc, items] of Object.entries(r.posting.state.balances))
          for (const [item, after] of Object.entries(items)) {
            const sold = s.lines
              .filter((l) => l.locationId === loc && l.itemId === item)
              .reduce((t, l) => t + l.qty, 0);
            expect(after).toBe((st.balances[loc]?.[item] ?? 0) - sold);
          }
      }),
    );
  });

  it('gives the same results and state however the replay is split', () => {
    const steps = fc
      .array(fc.nat(), { minLength: 2, maxLength: 8 })
      .chain((ids) => fc.tuple(...ids.map((_, i) => sale(i + 1))))
      .map((sales): ReplayStep[] => sales.map((s) => ({ sale: s, context: CONTEXT })));
    fc.assert(
      fc.property(steps, state, fc.nat(), (all, st, at) => {
        const cut = 1 + (at % (all.length - 1));
        const whole = replay(all, st);
        const first = replay(all.slice(0, cut), st);
        const rest = replay(all.slice(cut), first.state);
        expect([...first.results, ...rest.results]).toStrictEqual(whole.results);
        expect(rest.state).toStrictEqual(whole.state);
      }),
    );
  });

  it('starts a replay from nothing known', () => {
    expect(emptyState()).toStrictEqual({ costs: {}, balances: {} });
  });

  it('leaves the state as it was after a step that can’t be posted', () => {
    const unmapped: PostingContext = {
      ...CONTEXT,
      accounts: { ...CONTEXT.accounts, methods: { raast: null } },
    };
    const s: PostingSale = {
      id: 'sale-1',
      number: 'C03-S000001',
      branchId: 'br-main',
      businessDate: '2026-11-02',
      customerId: null,
      lines: [
        {
          id: 'l1',
          lineNo: 1,
          itemId: 'item-a',
          locationId: 'loc-shop',
          qty: 1000 as Qty,
          lineTotal: 1000 as Money,
          taxAmount: 0 as Money,
        },
      ],
      amounts: { billDiscount: 0 as Money, rounding: 0 as Money, taxTotal: 0 as Money },
      payments: [{ method: 'raast', amount: 1000 as Money }],
    };
    const start: LedgerState = {
      costs: { 'item-a': { avgCost: 500 as Money, onHand: 1000 as Qty } },
      balances: {},
    };
    const r = replay([{ sale: s, context: unmapped }], start);
    expect(r.results).toEqual([{ ok: false, error: { code: 'method_unmapped', method: 'raast' } }]);
    expect(r.state).toStrictEqual(start);
  });

  it('throws, rather than posting, on amounts outside the safe range', () => {
    const huge = Number.MAX_SAFE_INTEGER as Money;
    const s: PostingSale = {
      id: 'sale-1',
      number: 'C03-S000001',
      branchId: 'br-main',
      businessDate: '2026-11-02',
      customerId: null,
      lines: [1, 2].map((n) => ({
        id: `l${n}`,
        lineNo: n,
        itemId: 'item-a',
        locationId: 'loc-shop',
        qty: 1000 as Qty,
        lineTotal: huge,
        taxAmount: 0 as Money,
      })),
      amounts: { billDiscount: 0 as Money, rounding: 0 as Money, taxTotal: 0 as Money },
      payments: [{ method: 'cash', amount: 1000 as Money }],
    };
    expect(() => postSale(s, CONTEXT, emptyState())).toThrow(/safe range/);
  });
});
