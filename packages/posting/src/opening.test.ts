import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { money, qty } from '@erp/domain';

import openingCases from '../golden/post-opening.json';
import { postOpening } from './opening';
import { runGolden, type GoldenFile } from './testing/golden';
import type { LedgerState, PostingContext, PostingOpening, PostingRole } from './types';

// The opening balances at cutover (posting rules §7, migration doc §4, W1-14): stock into its location at the legacy
// cost, one AR or AP line and party entry per customer or supplier, the counted drawer and the bank statements, and
// the balance to Opening balance equity. A posting like any other, so the ledgers stay rebuildable (rule 4).

// Delux's accounts by code (posting rules §2).
const ROLES: Partial<Record<PostingRole, string>> = {
  CASH_DRAWER: '1110',
  AR_CONTROL: '1200',
  INVENTORY: '1300',
  AP_CONTROL: '2100',
  OPENING_BALANCE_EQUITY: '3300',
  COGS: '5100',
};

interface Input {
  opening: PostingOpening;
  state?: LedgerState;
  context?: { lockDate?: string; withoutRoles?: PostingRole[] };
}

function contextOf(o: Input['context'] = {}): PostingContext {
  const roles = { ...ROLES };
  for (const r of o.withoutRoles ?? []) delete roles[r];
  return { accounts: { roles, methods: {} }, lockDate: o.lockDate ?? null, customer: null };
}

runGolden(openingCases as unknown as GoldenFile<Input>, (i) =>
  postOpening(i.opening, contextOf(i.context), i.state ?? { costs: {}, balances: {} }),
);

describe('opening properties', () => {
  const stockLine = fc.record({
    qty: fc.integer({ min: -50_000, max: 500_000 }).filter((q) => q !== 0),
    unitCost: fc.option(fc.integer({ min: 0, max: 50_000_000 }), { nil: null }),
  });
  const partyLine = fc.record({
    role: fc.constantFrom('customer' as const, 'supplier' as const),
    amount: fc.integer({ min: -100_000_000, max: 100_000_000 }),
  });
  const accountLine = fc.record({
    accountId: fc.constantFrom('1110', '1160'),
    amount: fc.integer({ min: -100_000_000, max: 100_000_000 }),
  });

  it('always balances, and the Inventory line is Σ the movements', () => {
    fc.assert(
      fc.property(
        fc.array(stockLine, { maxLength: 8 }),
        fc.array(partyLine, { maxLength: 8 }),
        fc.array(accountLine, { maxLength: 3 }),
        (stock, parties, accounts) => {
          const opening: PostingOpening = {
            id: 'opening-1',
            label: 'p',
            branchId: 'br-main',
            businessDate: '2027-01-01',
            stock: stock.map((s, i) => ({
              id: `s-${i}`,
              itemId: `item-${i}`,
              locationId: 'loc-shop',
              qty: qty(s.qty),
              unitCost: s.unitCost === null ? null : money(s.unitCost),
              lastPurchase: null,
            })),
            parties: parties.map((p, i) => ({
              id: `p-${i}`,
              partyId: `party-${i}`,
              role: p.role,
              amount: money(p.amount),
            })),
            accounts: accounts.map((a, i) => ({
              id: `a-${i}`,
              accountId: a.accountId,
              amount: money(a.amount),
            })),
          };
          const r = postOpening(opening, contextOf(), { costs: {}, balances: {} });
          if (!r.ok) throw new Error(r.error.code);
          const lines = r.posting.journal.lines;
          const debits = lines.reduce((s, l) => s + l.debit, 0);
          const credits = lines.reduce((s, l) => s + l.credit, 0);
          expect(debits).toBe(credits);
          for (const l of lines) expect((l.debit === 0) !== (l.credit === 0)).toBe(true);
          const value = r.posting.movements.reduce((s, m) => s + m.valueDelta, 0);
          const inventory = lines
            .filter((l) => l.accountId === '1300')
            .reduce((s, l) => s + l.debit - l.credit, 0);
          expect(inventory).toBe(value);
          const partyTotal = r.posting.partyEntries.reduce((s, e) => s + e.amount, 0);
          expect(partyTotal).toBe(parties.reduce((s, p) => s + p.amount, 0));
        },
      ),
    );
  });
});
