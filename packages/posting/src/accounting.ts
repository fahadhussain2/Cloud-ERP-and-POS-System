import { money, negate, sum } from '@erp/domain';

import { bankOf, credit, debit, dated, guarded, roleOf, Unposted } from './build';
import type {
  JournalLine,
  PartyEntry,
  Posting,
  PostingContext,
  PostingCustomerReceipt,
  PostingExpense,
  PostingFundTransfer,
  PostingJournalVoucher,
  PostingResult,
  PostingReversal,
} from './types';

// Back-office accounting in the books (posting rules §6; ACC-04, ACC-05; W1-19; D-108): a customer receipt by bank, an
// expense from a bank or the safe, a transfer between them with its charges, a journal voucher as entered, and the
// reversal of any of them (every line swapped). Never throws for a business reason. Bank accounts and expense
// categories reach their accounts through `context.accounts.targets`; the safe is CASH_SAFE.

const noStock = (): Pick<Posting, 'movements' | 'state'> => ({
  movements: [],
  state: { costs: {}, balances: {} },
});

/** A bank account's account, or the safe's (null). */
const placeOf = (context: PostingContext, bankAccountId: string | null) =>
  bankAccountId === null ? roleOf(context, 'CASH_SAFE') : bankOf(context, bankAccountId);

/** Dr the bank / Cr AR_CONTROL (the customer); the customer owes less. */
export function postCustomerReceipt(doc: PostingCustomerReceipt, context: PostingContext): PostingResult {
  return guarded(() => {
    const ar = roleOf(context, 'AR_CONTROL');
    const bank = bankOf(context, doc.bankAccountId);
    const { entryDate, exceptions } = dated(doc.businessDate, context);
    return {
      ok: true,
      posting: {
        entryDate,
        journal: {
          branchId: doc.branchId,
          memo: doc.number,
          lines: [debit(bank, null, doc.amount), credit(ar, doc.customerId, doc.amount)],
        },
        partyEntries: [
          { partyId: doc.customerId, role: 'customer', amount: negate(doc.amount), dueDate: entryDate },
        ],
        exceptions,
        ...noStock(),
      },
    };
  });
}

/** Dr the category's account / Cr the bank it was paid from, or CASH_SAFE. */
export function postExpense(doc: PostingExpense, context: PostingContext): PostingResult {
  return guarded(() => {
    const category = bankOf(context, doc.categoryId);
    const from = placeOf(context, doc.paidFrom);
    const { entryDate, exceptions } = dated(doc.businessDate, context);
    return {
      ok: true,
      posting: {
        entryDate,
        journal: {
          branchId: doc.branchId,
          memo: doc.number,
          lines: [debit(category, null, doc.amount), credit(from, null, doc.amount)],
        },
        partyEntries: [],
        exceptions,
        ...noStock(),
      },
    };
  });
}

/** Dr the destination (amount − charges), Dr the charges' account / Cr the source (amount) (owner answer 6). */
export function postFundTransfer(doc: PostingFundTransfer, context: PostingContext): PostingResult {
  return guarded(() => {
    const to = placeOf(context, doc.to);
    let charges: string | null = null;
    if (doc.charges > 0) {
      if (doc.chargesCategoryId === null) throw new Unposted({ code: 'target_unmapped', targetId: null });
      charges = bankOf(context, doc.chargesCategoryId);
    }
    const from = placeOf(context, doc.from);
    const { entryDate, exceptions } = dated(doc.businessDate, context);
    const lines: JournalLine[] = [
      debit(to, null, money(doc.amount - doc.charges)),
      ...(charges === null ? [] : [debit(charges, null, doc.charges)]),
      credit(from, null, doc.amount),
    ];
    return {
      ok: true,
      posting: {
        entryDate,
        journal: { branchId: doc.branchId, memo: doc.number, lines },
        partyEntries: [],
        exceptions,
        ...noStock(),
      },
    };
  });
}

/**
 * The lines as entered. A line on AR_CONTROL writes a customer entry of debit − credit, one on AP_CONTROL a supplier
 * entry of credit − debit, due on the entry date; either without its party is `party_missing`.
 */
export function postJournalVoucher(doc: PostingJournalVoucher, context: PostingContext): PostingResult {
  return guarded(() => {
    const { entryDate, exceptions } = dated(doc.businessDate, context);
    const ar = context.accounts.roles.AR_CONTROL;
    const ap = context.accounts.roles.AP_CONTROL;
    const partyEntries: PartyEntry[] = [];
    const lines: JournalLine[] = doc.lines.map((l) => {
      const role = l.accountId === ar ? 'customer' : l.accountId === ap ? 'supplier' : null;
      if (role !== null) {
        if (l.partyId === null) throw new Unposted({ code: 'party_missing' });
        const amount = role === 'customer' ? l.debit - l.credit : l.credit - l.debit;
        partyEntries.push({ partyId: l.partyId, role, amount: money(amount), dueDate: entryDate });
      }
      return {
        accountId: l.accountId,
        partyId: role === null ? null : l.partyId,
        debit: l.debit,
        credit: l.credit,
      };
    });
    if (sum(lines.map((l) => l.debit)) !== sum(lines.map((l) => l.credit)))
      throw new Error(`journal voucher ${doc.number} doesn't balance`);
    return {
      ok: true,
      posting: {
        entryDate,
        journal: { branchId: doc.branchId, memo: `${doc.number} ${doc.narration}`, lines },
        partyEntries,
        exceptions,
        ...noStock(),
      },
    };
  });
}

/** Every line of the original's journal swapped, each party entry reversed on its own due date (rule 3, D-108). */
export function postReversal(
  doc: PostingReversal,
  original: Posting,
  context: PostingContext,
): PostingResult {
  const { entryDate, exceptions } = dated(doc.businessDate, context);
  return {
    ok: true,
    posting: {
      entryDate,
      journal: {
        branchId: doc.branchId,
        memo: `${doc.number} ${doc.originalNumber}`,
        lines: original.journal.lines.map((l) => ({
          accountId: l.accountId,
          partyId: l.partyId,
          debit: money(l.credit),
          credit: money(l.debit),
        })),
      },
      partyEntries: original.partyEntries.map((e) => ({ ...e, amount: negate(e.amount) })),
      exceptions,
      ...noStock(),
    },
  };
}
