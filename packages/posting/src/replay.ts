import type { LedgerState, PostingContext, PostingResult, PostingSale } from './types';

// Postings one after another, carrying the costs and balances along (rule 4): the live path posts one step, the
// rebuild check replays them all in `postings` order and must arrive at the same rows.

export interface ReplayStep {
  sale: PostingSale;
  context: PostingContext;
}

export const emptyState = (): LedgerState => ({ costs: {}, balances: {} });

/** Each step's result, and the state after the last one. A step that can't post leaves the state as it was. */
export function replay(
  steps: readonly ReplayStep[],
  state: LedgerState,
): { results: PostingResult[]; state: LedgerState } {
  void steps;
  void state;
  throw new Error('replay is not built yet (W1-08)');
}
