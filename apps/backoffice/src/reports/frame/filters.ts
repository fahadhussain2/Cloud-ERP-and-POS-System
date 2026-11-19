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
 * last ones used; changing them moves to a new address (so Back undoes it) and remembers them.
 */
export function useFilters(report: string): [Filters, (next: Filters) => void] {
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

  const set = useCallback(
    (next: Filters) => {
      const to = withQuery(baseOf(window.location.hash), next);
      remember(report, to.includes('?') ? to.slice(to.indexOf('?') + 1) : '');
      window.location.hash = to;
      // Drawn from the new address at once: the browser's hashchange comes later, and a box or a choice must not look
      // unchanged until it does.
      setHash(window.location.hash);
    },
    [report],
  );
  return [plain(saved ? new URLSearchParams(saved) : query), set];
}

/** The API's query for these filters. */
export const apiQuery = (filters: Filters) => new URLSearchParams(filters).toString();
