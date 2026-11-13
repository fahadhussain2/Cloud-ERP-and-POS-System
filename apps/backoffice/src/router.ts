import { useEffect, useState } from 'react';

// Screen addresses in the hash (W1-04 plan): a reload or the back button keeps your place, and the back-office host
// needs no server change. A dozen screens don't need a router library.

export type Route =
  | { screen: 'home' }
  | { screen: 'staff' }
  | { screen: 'person'; id: string }
  | { screen: 'counters' }
  | { screen: 'shopSettings' }
  | { screen: 'dayReconciliation' }
  | { screen: 'cashVariance' }
  | { screen: 'salesRegister' }
  | { screen: 'overridesReport' }
  | { screen: 'voidsReturns' }
  | { screen: 'stockReport' }
  | { screen: 'ageing' }
  | { screen: 'exceptions' }
  | { screen: 'trace'; number: string | null }
  | { screen: 'items' }
  | { screen: 'item'; id: string }
  | { screen: 'newItem' }
  | { screen: 'categories' }
  | { screen: 'labels'; source: { receipt: string } | { items: string[] } | null }
  | { screen: 'customers' }
  | { screen: 'customer'; id: string }
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
  | { screen: 'stockSettings' }
  | { screen: 'money' }
  | { screen: 'accountingDocument'; type: string; id: string }
  | { screen: 'voucher'; id: string }
  | { screen: 'periods' }
  | { screen: 'accounts' }
  | { screen: 'ledger'; id: string }
  | { screen: 'expenseCategories' };

export const href = {
  staff: '#/staff',
  person: (id: string) => `#/staff/${encodeURIComponent(id)}`,
  counters: '#/counters',
  shopSettings: '#/shop',
  dayReconciliation: '#/reports/day',
  cashVariance: '#/reports/variance',
  // The W1-20 reports and support (D-110).
  salesRegister: '#/reports/sales',
  overridesReport: '#/reports/overrides',
  voidsReturns: '#/reports/voids',
  stockReport: '#/reports/stock',
  ageing: '#/reports/ageing',
  exceptions: '#/reports/exceptions',
  trace: (number?: string) => (number ? `#/support/trace/${encodeURIComponent(number)}` : '#/support/trace'),
  items: '#/catalog',
  item: (id: string) => `#/catalog/items/${encodeURIComponent(id)}`,
  newItem: '#/catalog/new',
  categories: '#/catalog/categories',
  labels: '#/catalog/labels',
  /** A posted goods receipt's labels, by its id or number. */
  receiptLabels: (ref: string) => `#/catalog/labels/receipt/${encodeURIComponent(ref)}`,
  /** A relabel of the items picked on the items screen. */
  itemLabels: (ids: readonly string[]) => `#/catalog/labels/items/${ids.map(encodeURIComponent).join(',')}`,
  customers: '#/sales/customers',
  customer: (id: string) => `#/sales/customers/${encodeURIComponent(id)}`,
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
  money: '#/accounting/money',
  accountingDocument: (type: string, id: string) =>
    `#/accounting/documents/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
  /** `new` for a new voucher. */
  voucher: (id: string) => `#/accounting/vouchers/${encodeURIComponent(id)}`,
  periods: '#/accounting/periods',
  accounts: '#/accounting/accounts',
  ledger: (id: string) => `#/accounting/accounts/${encodeURIComponent(id)}`,
  expenseCategories: '#/accounting/categories',
} as const;

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'staff' && parts[1]) return { screen: 'person', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'staff') return { screen: 'staff' };
  if (parts[0] === 'counters') return { screen: 'counters' };
  if (parts[0] === 'shop' && parts.length === 1) return { screen: 'shopSettings' };
  if (parts[0] === 'reports' && parts[1] === 'day') return { screen: 'dayReconciliation' };
  if (parts[0] === 'reports' && parts[1] === 'variance') return { screen: 'cashVariance' };
  if (parts[0] === 'reports' && parts[1] === 'sales') return { screen: 'salesRegister' };
  if (parts[0] === 'reports' && parts[1] === 'overrides') return { screen: 'overridesReport' };
  if (parts[0] === 'reports' && parts[1] === 'voids') return { screen: 'voidsReturns' };
  if (parts[0] === 'reports' && parts[1] === 'stock') return { screen: 'stockReport' };
  if (parts[0] === 'reports' && parts[1] === 'ageing') return { screen: 'ageing' };
  if (parts[0] === 'reports' && parts[1] === 'exceptions') return { screen: 'exceptions' };
  if (parts[0] === 'support' && parts[1] === 'trace')
    return { screen: 'trace', number: parts[2] ? decodeURIComponent(parts[2]) : null };
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
  if (parts[0] === 'sales' && parts[1] === 'customers' && parts[2])
    return { screen: 'customer', id: decodeURIComponent(parts[2]) };
  if (parts[0] === 'sales' && parts[1] === 'customers') return { screen: 'customers' };
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
  if (parts[0] === 'accounting') {
    if (parts[1] === 'documents' && parts[2] && parts[3])
      return {
        screen: 'accountingDocument',
        type: decodeURIComponent(parts[2]),
        id: decodeURIComponent(parts[3]),
      };
    if (parts[1] === 'vouchers' && parts[2]) return { screen: 'voucher', id: decodeURIComponent(parts[2]) };
    if (parts[1] === 'periods') return { screen: 'periods' };
    if (parts[1] === 'accounts' && parts[2]) return { screen: 'ledger', id: decodeURIComponent(parts[2]) };
    if (parts[1] === 'accounts') return { screen: 'accounts' };
    if (parts[1] === 'categories') return { screen: 'expenseCategories' };
    return { screen: 'money' };
  }
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

/** Goes to another screen (the address changes, the route follows), with a refusal for it to show when it opens. */
export function navigate(to: string, refusal?: string): void {
  carried = refusal === undefined ? null : { to, text: refusal };
  window.location.hash = to;
}

// A document screen opens afresh after a save: a new draft at its own address, an existing one when it reloads.
// A refusal shown just before would be lost, so it is kept here for the screen at that address, read once.
// Going anywhere else drops it.
let carried: { to: string; text: string } | null = null;

/** Keeps a refusal for the screen at `to`, which shows it when it next opens. */
export function carry(to: string, text: string): void {
  carried = { to, text };
}

/** The refusal kept for the screen at `to`, once; null when there is none. */
export function takeCarried(to: string): string | null {
  if (carried?.to !== to) return null;
  const { text } = carried;
  carried = null;
  return text;
}
