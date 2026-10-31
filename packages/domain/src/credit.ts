import { DomainError } from './errors';
import { add, money, sub, sum, type Money } from './money';
import { can, type RoleGrant } from './permissions';
import type { SaleDocument, SaleDocumentOverride } from './sale-document';

// Credit control (POS spec §15, POS-07, D-013, D-085, D-096): a sale on account against the customer's limit, and,
// while the counter is offline, against the per-counter daily cap. The counter decides with `checkCredit`; the server
// re-checks every on-account sale with what it knows from all counters (`reviewCredit`), flagging, never refusing
// (D-011).

/** A customer's credit terms as pulled (sync spec §3). */
export interface CreditAccount {
  creditAllowed: boolean;
  /** null = no limit (D-085). */
  creditLimit: Money | null;
  /** The most this counter sells the customer on account in a business day while offline. */
  offlineDailyCap: Money;
}

/** What an over-limit or over-cap sale needs an approval for (data model §5 override kinds). */
export type CreditNeed = 'credit_limit' | 'offline_cap';

/** Why a sale may go over the limit or the cap (owner answer 2 to W1-09). */
export const CREDIT_REASONS = ['pay_soon', 'regular_customer', 'owner_instruction', 'other'] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];

export interface CreditInput {
  /** null: a walk-in, or a party without a customer account. */
  account: CreditAccount | null;
  /** The pulled balance: positive = the customer owes, negative = an advance. */
  balance: Money;
  /** This counter's on-account amounts for the customer that the pulled balance can't include yet. */
  unsynced: Money;
  offline: boolean;
  /** This counter's on-account amounts for the customer made while offline on this business date. */
  offlineToday: Money;
  /** The bill's on-account part. */
  amount: Money;
}

export type CreditCheck =
  | { allowed: false; reason: 'no_account' | 'credit_not_allowed' }
  | {
      allowed: true;
      /** Empty: no approval needed. In this order: the limit, then the cap. */
      needs: CreditNeed[];
      /** balance + unsynced + amount. */
      after: Money;
      /** limit − balance − unsynced, before this bill (negative when already over); null without a limit. */
      available: Money | null;
      overLimitBy: Money;
      /** Offline only: what is left of today's cap before this bill (never below 0); null online. */
      capLeft: Money | null;
      overCapBy: Money;
    };

const atLeastZero = (m: Money): Money => (m > 0 ? m : money(0));

/** May this amount go on account, and does it need an approval? Exactly at the limit or the cap is fine. */
export function checkCredit(input: CreditInput): CreditCheck {
  const { account, balance, unsynced, offline, offlineToday, amount } = input;
  for (const [name, value] of [
    ['amount', amount],
    ['unsynced', unsynced],
    ['offlineToday', offlineToday],
  ] as const) {
    if (money(value) < 0) throw new DomainError('negative_amount', `${name} can't be negative: ${value}`);
  }
  if (account === null) return { allowed: false, reason: 'no_account' };
  if (!account.creditAllowed) return { allowed: false, reason: 'credit_not_allowed' };
  const owed = add(balance, unsynced);
  const after = add(owed, amount);
  const limit = account.creditLimit;
  const overLimitBy = limit === null ? money(0) : atLeastZero(sub(after, limit));
  const cap = account.offlineDailyCap;
  const overCapBy = offline ? atLeastZero(sub(add(offlineToday, amount), cap)) : money(0);
  const needs: CreditNeed[] = [];
  if (overLimitBy > 0) needs.push('credit_limit');
  if (overCapBy > 0) needs.push('offline_cap');
  return {
    allowed: true,
    needs,
    after,
    available: limit === null ? null : sub(limit, owed),
    overLimitBy,
    capLeft: offline ? atLeastZero(sub(cap, offlineToday)) : null,
    overCapBy,
  };
}

/** The counter's credit figures when it finalizes a bill with an on-account payment. */
export interface CreditView {
  account: CreditAccount | null;
  balance: Money;
  /** When the balance was pulled (ISO 8601); null before the first pull. */
  balanceAsOf: string | null;
  unsynced: Money;
  offline: boolean;
  offlineToday: Money;
}

/** An approval to go over the limit or the cap, given at finalize for that bill (POS spec §15). */
export interface CreditApproval {
  requestedBy: string;
  approvedBy: string;
  reason: CreditReason;
  note: string | null;
  at: string;
}

/** The bill's on-account part. */
export const onAccountAmount = (payments: readonly { method: string; amount: Money }[]): Money =>
  sum(payments.filter((p) => p.method === 'on_account').map((p) => p.amount));

/** Why the server flags an on-account sale. */
export type CreditCause = 'no_approval' | 'not_permitted' | 'credit_not_allowed' | 'seller_not_permitted';

export type CreditFinding =
  | {
      kind: 'credit_limit_exceeded';
      cause: CreditCause;
      amount: Money;
      /** The server's balance before this bill (every counter's sales). */
      balance: Money;
      limit: Money | null;
      overBy: Money;
    }
  | {
      kind: 'offline_cap_exceeded';
      cause: 'no_approval' | 'not_permitted';
      amount: Money;
      /** This device's offline on-account total for the customer on the business date, before this bill. */
      offlineToday: Money;
      cap: Money;
      overBy: Money;
    };

export interface CreditReviewContext {
  /** The customer's account on the server now; null when the party has none. */
  account: CreditAccount | null;
  balanceBefore: Money;
  offlineTodayBefore: Money;
  /** The roles the server holds, by user id, for the seller and every approver on the document. */
  grants: Readonly<Record<string, readonly RoleGrant[]>>;
}

/**
 * The server's credit findings on a synced sale (sync spec §6.2): the limit against the server's own balance, and
 * for a bill made offline the device's cap for the day. Nothing for a sale without an on-account payment.
 */
export function reviewCredit(document: SaleDocument, context: CreditReviewContext): CreditFinding[] {
  const amount = onAccountAmount(document.payments);
  if (amount === 0) return [];
  const { account, balanceBefore: balance, offlineTodayBefore: offlineToday } = context;
  const limit = account?.creditLimit ?? null;
  const overBy = limit === null ? money(0) : atLeastZero(sub(add(balance, amount), limit));
  const grantsOf = (userId: string) => context.grants[userId] ?? [];
  const limitFinding = (cause: CreditCause): CreditFinding => ({
    kind: 'credit_limit_exceeded',
    cause,
    amount,
    balance,
    limit,
    overBy,
  });
  if (!can(grantsOf(document.sellerId), 'pos.credit.sell', document.branchId))
    return [limitFinding('seller_not_permitted')];
  if (account === null || !account.creditAllowed) return [limitFinding('credit_not_allowed')];

  // An approval of the kind covers it when the server says its approver may give it.
  const uncovered = (kind: CreditNeed): 'no_approval' | 'not_permitted' | null => {
    const given = document.overrides.filter((o: SaleDocumentOverride) => o.kind === kind);
    if (given.length === 0) return 'no_approval';
    return given.some((o) => can(grantsOf(o.approvedBy), 'pos.credit.over_limit', document.branchId))
      ? null
      : 'not_permitted';
  };
  const findings: CreditFinding[] = [];
  if (overBy > 0) {
    const cause = uncovered('credit_limit');
    if (cause !== null) findings.push(limitFinding(cause));
  }
  const cap = account.offlineDailyCap;
  const overCapBy = atLeastZero(sub(add(offlineToday, amount), cap));
  if (document.credit?.offline === true && overCapBy > 0) {
    const cause = uncovered('offline_cap');
    if (cause !== null)
      findings.push({ kind: 'offline_cap_exceeded', cause, amount, offlineToday, cap, overBy: overCapBy });
  }
  return findings;
}
