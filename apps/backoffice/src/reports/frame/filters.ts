import { useCallback, useEffect, useState } from 'react';

import { queryOf, withQuery } from '../../router';

// A report's filters (W2-01 plan, owner answer 6): they live in the screen's address after a `?`, so a link can be
// shared and Back returns to the last filters; each report also remembers the last ones used, in this browser only.
// A convenience: storage that is off or unreadable just means nothing is remembered.

const KEY = (report: string) => `erp.backoffice.report.${report}`;

export type Filters = Record<string, string>;

function remembered(report: string): string | null {
  try {
    return localStorage.getItem(KEY(report));
  } catch {
    return null;
  }
}

function remember(report: string, query: string): void {
  try {
    localStorage.setItem(KEY(report), query);
  } catch {
    // Storage off or full: the filters still work, they just aren't remembered.
  }
}

const baseOf = (hash: string) => hash.split('?')[0] || '#/';
const plain = (q: URLSearchParams): Filters => Object.fromEntries(q.entries());

/**
 * The report's filters and a way to change them. Opening a report with no filters in its address brings back the
 * last ones used; changing them moves to a new address (so Back undoes it) and remembers them. `forget` names filters
 * that stay in the address but are never remembered: the W1 reports' dates, so they open on the shop's business date
 * each time (D-117) while a preset, a branch or a side is remembered.
 */
export function useFilters(
  report: string,
  { forget = [] }: { forget?: readonly string[] } = {},
): [Filters, (next: Filters) => void] {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const follow = () => setHash(window.location.hash);
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  const query = queryOf(hash);
  const saved = query.size === 0 ? remembered(report) : null;
  useEffect(() => {
    // Brought back into the address in place, so Back still leaves the report rather than undoing the restore. The
    // screen already reads them from `saved` until the next change of address.
    if (saved) window.history.replaceState(null, '', `${baseOf(window.location.hash)}?${saved}`);
  }, [saved]);

  const forgotten = forget.join(',');
  const set = useCallback(
    (next: Filters) => {
      const kept = Object.fromEntries(
        Object.entries(next).filter(([k]) => !forgotten.split(',').includes(k)),
      );
      remember(report, withQuery('', kept).slice(1));
      window.location.hash = withQuery(baseOf(window.location.hash), next);
    },
    [report, forgotten],
  );
  return [plain(saved ? new URLSearchParams(saved) : query), set];
}

/** The API's query for these filters. */
export const apiQuery = (filters: Filters) => new URLSearchParams(filters).toString();

/**
 * The filters now: the address's, which a change before the screen caught up (two quick changes) already moved, else
 * the ones the screen was drawn with.
 */
export function current(filters: Filters): Filters {
  const q = queryOf(window.location.hash);
  return q.size > 0 ? Object.fromEntries(q) : filters;
}

/** Only the filters a screen keeps, without empty ones. */
export const only = (f: Filters, keys: readonly string[]): Filters =>
  Object.fromEntries(keys.filter((k) => f[k]).map((k) => [k, f[k]!]));
