import { describe, expect, it } from 'vitest';

import { money, type Money, type PaymentMethodCode } from '@erp/domain';

import cashCases from '../golden/post-cash.json';
import { postCashMovement, postCollection, postSession } from './cash';
import { postHandover } from './handover';
import { runGolden, type GoldenFile } from './testing/golden';
import type {
  JournalLine,
  PostingCashMovement,
  PostingCollection,
  PostingContext,
  PostingResult,
  PostingRole,
  PostingSessionEvent,
} from './types';

// Delux's accounts by code (posting rules §2).
const ROLES: Partial<Record<PostingRole, string>> = {
  CASH_DRAWER: '1110',
  CASH_IN_TRANSIT: '1120',
  CASH_SAFE: '1130',
  AR_CONTROL: '1200',
  AP_CONTROL: '2100',
  CASH_SHORT_OVER: '6500',
};
const METHODS: Partial<Record<PaymentMethodCode, string | null>> = { cash: null, raast: '1160' };
const TARGETS: Record<string, string> = { 'cat-tea': '6310', 'bank-soneri': '1150' };

interface Input {
  collection?: PostingCollection;
  movement?: PostingCashMovement;
  session?: PostingSessionEvent;
  context?: { lockDate?: string; withoutRoles?: PostingRole[] };
}

function contextOf(o: Input['context'] = {}): PostingContext {
  const roles = { ...ROLES };
  for (const r of o.withoutRoles ?? []) delete roles[r];
  return {
    accounts: { roles, methods: METHODS, targets: TARGETS },
    lockDate: o.lockDate ?? null,
    customer: null,
  };
}

runGolden(cashCases as unknown as GoldenFile<Input>, (i) => {
  const context = contextOf(i.context);
  if (i.collection) return postCollection(i.collection, context);
  if (i.movement) return postCashMovement(i.movement, context);
  return postSession(i.session, context);
});

// Posting rules §4.5 and owner answer 3 to W1-11: after a day of desk documents and a counted close, the drawer's
// account holds exactly what stayed in the drawer, whatever order the documents posted in.
describe('a desk day in the books, in any order', () => {
  const day = '2026-11-02';
  const common = { branchId: 'br-main', businessDate: day };
  const ctx = contextOf();
  const steps: (() => PostingResult)[] = [
    () =>
      postHandover(
        {
          ...common,
          id: 'h-1',
          number: 'D01-H000001',
          billNumber: 'C03-S000001',
          kind: 'in',
          amount: money(1029700),
        },
        ctx,
      ),
    () =>
      postHandover(
        {
          ...common,
          id: 'h-2',
          number: 'D01-H000002',
          billNumber: 'C03-S000002',
          kind: 'payout',
          amount: money(45000),
        },
        ctx,
      ),
    () =>
      postCollection(
        {
          ...common,
          id: 'r-1',
          number: 'D01-R000001',
          partyId: 'cust-ali',
          method: 'cash',
          amount: money(500000),
        },
        ctx,
      ),
    () =>
      postCollection(
        {
          ...common,
          id: 'r-2',
          number: 'D01-R000002',
          partyId: 'cust-ali',
          method: 'raast',
          amount: money(900000),
        },
        ctx,
      ),
    () =>
      postCashMovement(
        {
          ...common,
          id: 'm-1',
          number: 'D01-M000001',
          kind: 'expense',
          amount: money(20000),
          partyId: null,
          targetId: 'cat-tea',
        },
        ctx,
      ),
    () =>
      postCashMovement(
        {
          ...common,
          id: 'm-2',
          number: 'D01-M000002',
          kind: 'to_safe',
          amount: money(400000),
          partyId: null,
          targetId: null,
        },
        ctx,
      ),
    // Float 5,000 + 10,297 − 450 + 5,000 − 200 − 4,000 = 15,647 expected; counted 15,347 (Rs 300 short); 5,000 stays.
    () =>
      postSession(
        {
          ...common,
          id: 'z-2',
          number: 'D01-Z000002',
          event: 'close',
          openingFloat: null,
          floatExpected: null,
          variance: money(-30000),
          toSafe: money(1034700),
        },
        ctx,
      ),
  ];

  const drawer = (order: number[]): Money => {
    let total = 500000; // the opening float, already in the drawer's account
    for (const n of order) {
      const r = steps[n]!();
      if (!r.ok) throw new Error(`not posted: ${r.error.code}`);
      for (const l of r.posting.journal.lines) if (l.accountId === '1110') total += l.debit - l.credit;
    }
    return money(total);
  };

  it('leaves Rs 5,000 in the drawer account, as in the drawer', () => {
    expect(drawer([0, 1, 2, 3, 4, 5, 6])).toBe(500000);
  });

  it('ends the same in reverse order', () => {
    expect(drawer([6, 5, 4, 3, 2, 1, 0])).toBe(500000);
  });

  it('balances every entry', () => {
    for (const s of steps) {
      const r = s();
      if (!r.ok) throw new Error(`not posted: ${r.error.code}`);
      const lines = r.posting.journal.lines;
      expect(lines.reduce((a, l) => a + l.debit, 0)).toBe(lines.reduce((a, l) => a + l.credit, 0));
    }
  });
});
