import { useEffect, useState } from 'react';

// Screen addresses in the hash (W1-04 plan): a reload or the back button keeps your place, and the back-office host
// needs no server change. A dozen screens don't need a router library.

export type Route =
  | { screen: 'home' }
  | { screen: 'staff' }
  | { screen: 'person'; id: string }
  | { screen: 'counters' }
  | { screen: 'dayReconciliation' }
  | { screen: 'cashVariance' }
  | { screen: 'items' }
  | { screen: 'item'; id: string }
  | { screen: 'newItem' }
  | { screen: 'categories' };

export const href = {
  staff: '#/staff',
  person: (id: string) => `#/staff/${encodeURIComponent(id)}`,
  counters: '#/counters',
  dayReconciliation: '#/reports/day',
  cashVariance: '#/reports/variance',
  items: '#/catalog',
  item: (id: string) => `#/catalog/items/${encodeURIComponent(id)}`,
  newItem: '#/catalog/new',
  categories: '#/catalog/categories',
} as const;

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'staff' && parts[1]) return { screen: 'person', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'staff') return { screen: 'staff' };
  if (parts[0] === 'counters') return { screen: 'counters' };
  if (parts[0] === 'reports' && parts[1] === 'day') return { screen: 'dayReconciliation' };
  if (parts[0] === 'reports' && parts[1] === 'variance') return { screen: 'cashVariance' };
  if (parts[0] === 'catalog' && parts[1] === 'items' && parts[2])
    return { screen: 'item', id: decodeURIComponent(parts[2]) };
  if (parts[0] === 'catalog' && parts[1] === 'new') return { screen: 'newItem' };
  if (parts[0] === 'catalog' && parts[1] === 'categories') return { screen: 'categories' };
  if (parts[0] === 'catalog') return { screen: 'items' };
  return { screen: 'home' };
}

/** The current screen, following the address. */
export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const follow = () => setHash(window.location.hash);
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  return parseHash(hash);
}
