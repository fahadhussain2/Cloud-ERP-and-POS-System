import type { LedgerState, PostingContext, PostingResult, PostingSale } from './types';

// A sale's journal entry, stock movements and customer ledger entry (posting rules §4.1, INV-01, INV-03, ACC-03).
// Each line leaves its location at the item's average cost (D-017); an item with no cost yet leaves at 0 and is
// flagged (owner answer 2 to W1-08). A bill that doesn't add up still posts: the difference goes to SUSPENSE
// (owner answer 3). Never throws for a business reason: what can't be posted comes back as an error.

export function postSale(sale: PostingSale, context: PostingContext, state: LedgerState): PostingResult {
  void sale;
  void context;
  void state;
  throw new Error('postSale is not built yet (W1-08)');
}
