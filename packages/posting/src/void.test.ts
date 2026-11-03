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
