import { money, negate, qty, type Money, type Qty } from '@erp/domain';

import { entryDateOf } from './dates';
import type {
  CostState,
  JournalLine,
  LedgerState,
  PostingContext,
  PostingError,
  PostingException,
  PostingResult,
  PostingRole,
} from './types';

// Building blocks of the back-office postings (purchasing W1-16, stock operations W1-18): accounts by role, the entry
// date and the lock-date exception, costs and balances as the lines change them. Never throws for a business reason:
// `guarded` turns an `Unposted` into a failed result.

export class Unposted extends Error {
  constructor(readonly error: PostingError) {
    super(error.code);
  }
}

export const roleOf = (context: PostingContext, r: PostingRole): string => {
  const account = context.accounts.roles[r];
  if (account === undefined) throw new Unposted({ code: 'role_unmapped', role: r });
  return account;
};
export const bankOf = (context: PostingContext, id: string): string => {
  const account = context.accounts.targets?.[id];
  if (account === undefined) throw new Unposted({ code: 'target_unmapped', targetId: id });
  return account;
};
export const debit = (accountId: string, partyId: string | null, amount: Money): JournalLine => ({
  accountId,
  partyId,
  debit: amount,
  credit: money(0),
});
export const credit = (accountId: string, partyId: string | null, amount: Money): JournalLine => ({
  accountId,
  partyId,
  debit: money(0),
  credit: amount,
});
/** `net` > 0 debits, < 0 credits, 0 is left out. */
export const signed = (accountId: string, partyId: string | null, net: Money): JournalLine[] =>
  net === 0 ? [] : [net > 0 ? debit(accountId, partyId, net) : credit(accountId, partyId, negate(net))];

/** The entry date, and the lock-date exception when it moved. */
export function dated(businessDate: string, context: PostingContext) {
  const entryDate = entryDateOf(businessDate, context.lockDate);
  const exceptions: PostingException[] =
    entryDate === businessDate
      ? []
      : [{ kind: 'posted_after_lock', details: { businessDate, lockDate: context.lockDate! } }];
  return { entryDate, exceptions };
}

export function guarded(build: () => PostingResult): PostingResult {
  try {
    return build();
  } catch (err) {
    if (err instanceof Unposted) return { ok: false, error: err.error };
    throw err;
  }
}

/** Costs and balances as the lines change them, each line seeing the ones before it. */
export function stockState(state: LedgerState) {
  const costs: Record<string, CostState> = {};
  const balances: Record<string, Record<string, Qty>> = {};
  return {
    costs,
    balances,
    costNow: (item: string): CostState =>
      costs[item] ?? state.costs[item] ?? { avgCost: null, onHand: qty(0) },
    move: (loc: string, item: string, delta: Qty): Qty => {
      const now = qty((balances[loc]?.[item] ?? state.balances[loc]?.[item] ?? qty(0)) + delta);
      (balances[loc] ??= {})[item] = now;
      return now;
    },
  };
}
