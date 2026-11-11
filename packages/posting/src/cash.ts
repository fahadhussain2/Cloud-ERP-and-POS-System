import { money, negate, type Money } from '@erp/domain';

import { entryDateOf } from './dates';
import type {
  JournalLine,
  PartyEntry,
  PostingCashMovement,
  PostingCollection,
  PostingContext,
  PostingError,
  PostingException,
  PostingResult,
  PostingRole,
  PostingSessionEvent,
} from './types';

// The desk's other documents in the books (posting rules §4.5, W1-11): collections, cash-outs and safe movements, and
// the session's open (a float other than what stayed) and close (the variance, and what went to the safe). Each posts
// its own amount, so their order doesn't change the books. No stock. Never throws for a business reason.

interface Leg {
  account: string;
  partyId: string | null;
}

/** A business reason the document can't post yet; turned into the result's error, never let out. */
class Unposted extends Error {
  constructor(readonly error: PostingError) {
    super(error.code);
  }
}

function role(context: PostingContext, r: PostingRole): Leg {
  const account = context.accounts.roles[r];
  if (account === undefined) throw new Unposted({ code: 'role_unmapped', role: r });
  return { account, partyId: null };
}

/** `amount` from `credit` to `debit`: two lines, debit first. */
const move = (debit: Leg, credit: Leg, amount: Money): JournalLine[] => [
  { accountId: debit.account, partyId: debit.partyId, debit: amount, credit: money(0) },
  { accountId: credit.account, partyId: credit.partyId, debit: money(0), credit: amount },
];

function posted(
  doc: { number: string; branchId: string; businessDate: string },
  context: PostingContext,
  build: (entryDate: string) => { lines: JournalLine[]; partyEntries: PartyEntry[] },
): PostingResult {
  const entryDate = entryDateOf(doc.businessDate, context.lockDate);
  let built: ReturnType<typeof build>;
  try {
    built = build(entryDate);
  } catch (err) {
    if (err instanceof Unposted) return { ok: false, error: err.error };
    throw err;
  }
  const exceptions: PostingException[] = [];
  if (entryDate !== doc.businessDate)
    exceptions.push({
      kind: 'posted_after_lock',
      details: { businessDate: doc.businessDate, lockDate: context.lockDate! },
    });
  return {
    ok: true,
    posting: {
      entryDate,
      journal: { branchId: doc.branchId, memo: doc.number, lines: built.lines },
      movements: [],
      partyEntries: built.partyEntries,
      exceptions,
      state: { costs: {}, balances: {} },
    },
  };
}

/** Cash → `Dr CASH_DRAWER`, any other method → its account; `Cr AR_CONTROL` with the customer, who owes less. */
export function postCollection(doc: PostingCollection, context: PostingContext): PostingResult {
  return posted(doc, context, (entryDate) => {
    let into: Leg;
    if (doc.method === 'cash') into = role(context, 'CASH_DRAWER');
    else {
      const account = context.accounts.methods[doc.method];
      if (account === undefined || account === null)
        throw new Unposted({ code: 'method_unmapped', method: doc.method });
      into = { account, partyId: null };
    }
    const ar = { ...role(context, 'AR_CONTROL'), partyId: doc.partyId };
    return {
      lines: move(into, ar, doc.amount),
      partyEntries: [
        { partyId: doc.partyId, role: 'customer', amount: negate(doc.amount), dueDate: entryDate },
      ],
    };
  });
}

/**
 * Out of the drawer to the category, supplier, bank or safe; `from_safe` the other way; `void_cash` back to cash in
 * transit (posting rules §4.5).
 */
export function postCashMovement(doc: PostingCashMovement, context: PostingContext): PostingResult {
  return posted(doc, context, (entryDate) => {
    const target = (): Leg => {
      const account = doc.targetId === null ? undefined : context.accounts.targets?.[doc.targetId];
      if (account === undefined) throw new Unposted({ code: 'target_unmapped', targetId: doc.targetId });
      return { account, partyId: null };
    };
    const drawer = role(context, 'CASH_DRAWER');
    switch (doc.kind) {
      case 'expense':
      case 'bank_deposit':
        return { lines: move(target(), drawer, doc.amount), partyEntries: [] };
      case 'supplier_payment': {
        if (doc.partyId === null) throw new Unposted({ code: 'party_missing' });
        const ap = { ...role(context, 'AP_CONTROL'), partyId: doc.partyId };
        return {
          lines: move(ap, drawer, doc.amount),
          partyEntries: [
            { partyId: doc.partyId, role: 'supplier', amount: negate(doc.amount), dueDate: entryDate },
          ],
        };
      }
      case 'to_safe':
        return { lines: move(role(context, 'CASH_SAFE'), drawer, doc.amount), partyEntries: [] };
      case 'from_safe':
        return { lines: move(drawer, role(context, 'CASH_SAFE'), doc.amount), partyEntries: [] };
      // Cash taken for a voided bill, given back (W1-23, D-111): undoes the handover's Dr drawer / Cr in transit.
      case 'void_cash':
        return { lines: move(role(context, 'CASH_IN_TRANSIT'), drawer, doc.amount), partyEntries: [] };
    }
  });
}

/**
 * An open whose float differs from what stayed at the last close, and a close's variance: between `CASH_SHORT_OVER`
 * and `CASH_DRAWER` (less in the drawer = short). A close then moves what didn't stay to `CASH_SAFE`. A desk's first
 * open and a close without a count post nothing.
 */
export function postSession(doc: PostingSessionEvent, context: PostingContext): PostingResult {
  return posted(doc, context, () => {
    const difference =
      doc.event === 'open'
        ? doc.floatExpected === null || doc.openingFloat === null
          ? 0
          : doc.openingFloat - doc.floatExpected
        : (doc.variance ?? 0);
    const lines: JournalLine[] = [];
    if (difference !== 0) {
      const drawer = role(context, 'CASH_DRAWER');
      const shortOver = role(context, 'CASH_SHORT_OVER');
      lines.push(
        ...(difference < 0
          ? move(shortOver, drawer, money(-difference))
          : move(drawer, shortOver, money(difference))),
      );
    }
    if (doc.toSafe > 0)
      lines.push(...move(role(context, 'CASH_SAFE'), role(context, 'CASH_DRAWER'), doc.toSafe));
    return { lines, partyEntries: [] };
  });
}
