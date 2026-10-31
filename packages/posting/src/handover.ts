import { money } from '@erp/domain';

import { entryDateOf } from './dates';
import type { PostingContext, PostingException, PostingHandover, PostingResult, PostingRole } from './types';

// A cash handover moves its amount from cash in transit into the drawer; a refund payout moves it back (posting rules
// §4.5, W1-10). It posts its own amount, so its order against its bill doesn't change the books: an offline scan
// often arrives before the counter's bill. No stock, no party. Never throws for a business reason.

export function postHandover(handover: PostingHandover, context: PostingContext): PostingResult {
  const roles: PostingRole[] = ['CASH_DRAWER', 'CASH_IN_TRANSIT'];
  const accounts: string[] = [];
  for (const r of roles) {
    const id = context.accounts.roles[r];
    if (id === undefined) return { ok: false, error: { code: 'role_unmapped', role: r } };
    accounts.push(id);
  }
  const [drawer, transit] = accounts as [string, string];
  const [debit, credit] = handover.kind === 'in' ? [drawer, transit] : [transit, drawer];

  const entryDate = entryDateOf(handover.businessDate, context.lockDate);
  const exceptions: PostingException[] = [];
  if (entryDate !== handover.businessDate)
    exceptions.push({
      kind: 'posted_after_lock',
      details: { businessDate: handover.businessDate, lockDate: context.lockDate! },
    });

  return {
    ok: true,
    posting: {
      entryDate,
      journal: {
        branchId: handover.branchId,
        memo: `${handover.number} ${handover.billNumber}`,
        lines: [
          { accountId: debit, partyId: null, debit: handover.amount, credit: money(0) },
          { accountId: credit, partyId: null, debit: money(0), credit: handover.amount },
        ],
      },
      movements: [],
      partyEntries: [],
      exceptions,
      state: { costs: {}, balances: {} },
    },
  };
}
