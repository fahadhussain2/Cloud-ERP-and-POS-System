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
  | { screen: 'categories' }
  | { screen: 'labels'; source: { receipt: string } | { items: string[] } | null }
  | { screen: 'suppliers' }
  | { screen: 'supplier'; id: string }
  | { screen: 'receipts' }
  | { screen: 'receipt'; id: string }
  | { screen: 'purchaseReturns' }
  | { screen: 'purchaseReturn'; id: string }
  | { screen: 'transfers' }
  | { screen: 'transfer'; id: string }
  | { screen: 'adjustments' }
  | { screen: 'adjustment'; id: string }
  | { screen: 'stockCard'; itemId: string | null }
  | { screen: 'transferNeeded' }
  | { screen: 'stockSettings' };

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
  labels: '#/catalog/labels',
  /** A posted goods receipt's labels, by its id or number. */
  receiptLabels: (ref: string) => `#/catalog/labels/receipt/${encodeURIComponent(ref)}`,
  /** A relabel of the items picked on the items screen. */
  itemLabels: (ids: readonly string[]) => `#/catalog/labels/items/${ids.map(encodeURIComponent).join(',')}`,
  suppliers: '#/purchasing/suppliers',
  supplier: (id: string) => `#/purchasing/suppliers/${encodeURIComponent(id)}`,
  receipts: '#/purchasing/receipts',
  /** `new` for a new receipt. */
  receipt: (id: string) => `#/purchasing/receipts/${encodeURIComponent(id)}`,
  purchaseReturns: '#/purchasing/returns',
  /** `new`, or `new-<receipt id>` for a return from that receipt. */
  purchaseReturn: (id: string) => `#/purchasing/returns/${encodeURIComponent(id)}`,
  transfers: '#/stock/transfers',
  /** `new`, or `needed` for a Godown → Shop transfer of what Transfer needed lists. */
  transfer: (id: string) => `#/stock/transfers/${encodeURIComponent(id)}`,
  adjustments: '#/stock/adjustments',
  /** `new` for a new adjustment. */
  adjustment: (id: string) => `#/stock/adjustments/${encodeURIComponent(id)}`,
  stockCards: '#/stock/card',
  stockCard: (itemId: string) => `#/stock/card/${encodeURIComponent(itemId)}`,
  transferNeeded: '#/stock/needed',
  stockSettings: '#/stock/settings',
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
  if (parts[0] === 'catalog' && parts[1] === 'labels') {
    if (parts[2] === 'receipt' && parts[3])
      return { screen: 'labels', source: { receipt: decodeURIComponent(parts[3]) } };
    if (parts[2] === 'items' && parts[3])
      return {
        screen: 'labels',
        source: { items: parts[3].split(',').filter(Boolean).map(decodeURIComponent) },
      };
    return { screen: 'labels', source: null };
  }
  if (parts[0] === 'catalog') return { screen: 'items' };
  if (parts[0] === 'purchasing' && parts[1] === 'suppliers' && parts[2])
    return { screen: 'supplier', id: decodeURIComponent(parts[2]) };
  if (parts[0] === 'purchasing' && parts[1] === 'suppliers') return { screen: 'suppliers' };
  if (parts[0] === 'purchasing' && parts[1] === 'receipts' && parts[2])
    return { screen: 'receipt', id: decodeURIComponent(parts[2]) };
  if (parts[0] === 'purchasing' && parts[1] === 'receipts') return { screen: 'receipts' };
  if (parts[0] === 'purchasing' && parts[1] === 'returns' && parts[2])
    return { screen: 'purchaseReturn', id: decodeURIComponent(parts[2]) };
  if (parts[0] === 'purchasing' && parts[1] === 'returns') return { screen: 'purchaseReturns' };
  if (parts[0] === 'stock' && parts[1] === 'transfers' && parts[2])
    return { screen: 'transfer', id: decodeURIComponent(parts[2]) };
  if (parts[0] === 'stock' && parts[1] === 'transfers') return { screen: 'transfers' };
  if (parts[0] === 'stock' && parts[1] === 'adjustments' && parts[2])
    return { screen: 'adjustment', id: decodeURIComponent(parts[2]) };
  if (parts[0] === 'stock' && parts[1] === 'adjustments') return { screen: 'adjustments' };
  if (parts[0] === 'stock' && parts[1] === 'card')
    return { screen: 'stockCard', itemId: parts[2] ? decodeURIComponent(parts[2]) : null };
  if (parts[0] === 'stock' && parts[1] === 'needed') return { screen: 'transferNeeded' };
  if (parts[0] === 'stock' && parts[1] === 'settings') return { screen: 'stockSettings' };
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

/** Goes to another screen (the address changes, the route follows). */
export function navigate(to: string): void {
  window.location.hash = to;
}
