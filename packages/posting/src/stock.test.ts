import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { qty } from '@erp/domain';

import adjustmentCases from '../golden/post-stock-adjustment.json';
import transferCases from '../golden/post-stock-transfer.json';
import { postStockAdjustment, postStockTransfer } from './stock';
import { runGolden, type GoldenFile } from './testing/golden';
import type { LedgerState, PostingContext, PostingStockAdjustment, PostingStockTransfer } from './types';

// Stock operations in the books (posting rules §5.3, §5.4; W1-18): a transfer step moves stock between locations at
// the average with no journal; an adjustment moves it in or out and posts the net value against 5200.

const context = (lockDate: string | null = null, unmapped = false): PostingContext => ({
  accounts: {
    roles: unmapped ? { INVENTORY: '1300' } : { INVENTORY: '1300', INVENTORY_ADJUSTMENT: '5200' },
    methods: {},
  },
  lockDate,
  customer: null,
});

runGolden(
  transferCases as unknown as GoldenFile<{
    transfer: PostingStockTransfer;
    state: LedgerState;
    lockDate?: string;
  }>,
  (i) => postStockTransfer(i.transfer, context(i.lockDate ?? null), i.state),
);
runGolden(
  adjustmentCases as unknown as GoldenFile<{
    adjustment: PostingStockAdjustment;
    state: LedgerState;
    lockDate?: string;
    unmapped?: boolean;
  }>,
  (i) => postStockAdjustment(i.adjustment, context(i.lockDate ?? null, i.unmapped ?? false), i.state),
);

describe('stock operation properties', () => {
  const state = (avg: number | null): LedgerState => ({
    costs: {
      a: { avgCost: avg as never, onHand: qty(10_000) },
      b: { avgCost: avg as never, onHand: qty(10_000) },
    },
    balances: { godown: { a: qty(10_000), b: qty(10_000) } },
  });

  it('a transfer keeps every item’s total and value, and never writes a journal', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('a', 'b'), fc.integer({ min: 1, max: 50_000 })), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.option(fc.integer({ min: 0, max: 10_000_000 })),
        (lines, avg) => {
          const r = postStockTransfer(
            {
              id: 't',
              number: 'TR000001',
              branchId: 'b',
              businessDate: '2026-11-08',
              lines: lines.map(([item, q], n) => ({
                id: `l${n}`,
                itemId: item,
                fromLocationId: 'godown',
                toLocationId: 'shop',
                qty: qty(q),
              })),
            },
            context(),
            state(avg),
          );
          if (!r.ok) throw new Error(r.error.code);
          expect(r.posting.journal.lines).toEqual([]);
          expect(r.posting.state.costs).toEqual({});
          expect(r.posting.movements.reduce((s, m) => s + m.valueDelta, 0)).toBe(0);
          for (const item of ['a', 'b'])
            expect(
              (r.posting.state.balances['godown']?.[item] ?? 10_000) +
                (r.posting.state.balances['shop']?.[item] ?? 0),
            ).toBe(10_000);
        },
      ),
    );
  });

  it('an adjustment always balances, and its journal is the stock’s change in value', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom('a', 'b'),
            fc.integer({ min: -50_000, max: 50_000 }).filter((q) => q !== 0),
          ),
          { minLength: 1, maxLength: 6 },
        ),
        fc.option(fc.integer({ min: 0, max: 10_000_000 })),
        (lines, avg) => {
          const r = postStockAdjustment(
            {
              id: 'a',
              number: 'AD000001',
              branchId: 'b',
              businessDate: '2026-11-08',
              lines: lines.map(([item, q], n) => ({
                id: `l${n}`,
                itemId: item,
                locationId: 'godown',
                qty: qty(q),
              })),
            },
            context(),
            state(avg),
          );
          if (!r.ok) throw new Error(r.error.code);
          const lines_ = r.posting.journal.lines;
          expect(lines_.reduce((s, l) => s + l.debit - l.credit, 0)).toBe(0);
          const inventory = lines_
            .filter((l) => l.accountId === '1300')
            .reduce((s, l) => s + l.debit - l.credit, 0);
          expect(inventory).toBe(r.posting.movements.reduce((s, m) => s + m.valueDelta, 0));
        },
      ),
    );
  });
});
