import { postSale } from './sale';
import type { LedgerState, PostingContext, PostingResult, PostingSale } from './types';

// Postings one after another, carrying the costs and balances along (rule 4): the live path posts one step, the
// rebuild check replays them all in `postings` order and must arrive at the same rows.

export interface ReplayStep {
  sale: PostingSale;
  context: PostingContext;
}

export const emptyState = (): LedgerState => ({ costs: {}, balances: {} });

/** `state` with the changes of one posting laid over it. */
export function withChanges(state: LedgerState, changes: LedgerState): LedgerState {
  const balances = { ...state.balances };
  for (const [loc, items] of Object.entries(changes.balances)) balances[loc] = { ...balances[loc], ...items };
  return { costs: { ...state.costs, ...changes.costs }, balances };
}

/** Each step's result, and the state after the last one. A step that can't post leaves the state as it was. */
export function replay(
  steps: readonly ReplayStep[],
  state: LedgerState,
): { results: PostingResult[]; state: LedgerState } {
  const results: PostingResult[] = [];
  let current = state;
  for (const s of steps) {
    const r = postSale(s.sale, s.context, current);
    if (r.ok) current = withChanges(current, r.posting.state);
    results.push(r);
  }
  return { results, state: current };
}
