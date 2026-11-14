import {
  ChartColumn,
  Landmark,
  Package,
  SlidersHorizontal,
  Tag,
  Truck,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { href, type Route } from '../router';

// The back office's menu (W1-04, regrouped by W1-28): seven groups, the setup screens together under Settings at the
// foot. It lists only screens that exist and that this person may open (W1-04 owner answer 4); each later task adds
// its entry here. Addresses and permissions are the screens' own and don't change with the grouping.

export interface MenuItem {
  key:
    | 'staff'
    | 'counters'
    | 'shopSettings'
    | 'dayReconciliation'
    | 'cashVariance'
    | 'salesRegister'
    | 'overridesReport'
    | 'voidsReturns'
    | 'stockReport'
    | 'ageing'
    | 'exceptions'
    | 'trace'
    | 'items'
    | 'categories'
    | 'labels'
    | 'customers'
    | 'suppliers'
    | 'receipts'
    | 'purchaseReturns'
    | 'transfers'
    | 'adjustments'
    | 'stockCard'
    | 'transferNeeded'
    | 'stockSettings'
    | 'money'
    | 'periods'
    | 'accounts'
    | 'expenseCategories';
  href: string;
  /** Any of these permissions opens the screen. */
  needs: readonly string[];
  /** Routes that light this entry up. */
  screens: readonly Route['screen'][];
}

export type GroupKey = 'sales' | 'catalog' | 'purchasing' | 'stock' | 'accounting' | 'reports' | 'settings';

export interface MenuGroup {
  group: GroupKey;
  icon: LucideIcon;
  items: readonly MenuItem[];
}

export const MENU: readonly MenuGroup[] = [
  {
    // Customers (W1-22, D-109): who buys on account, at which tier, and what they owe. One entry, so a direct link.
    group: 'sales',
    icon: Users,
    items: [
      {
        key: 'customers',
        href: href.customers,
        needs: ['cust.edit', 'cust.terms.edit'],
        screens: ['customers', 'customer'],
      },
    ],
  },
  {
    // Catalog maintenance (W1-15): items with their codes, vehicles and prices; the categories' floor margin; labels
    // from a posted receipt or a relabel (W1-17).
    group: 'catalog',
    icon: Tag,
    items: [
      {
        key: 'items',
        href: href.items,
        needs: ['cat.item.edit', 'cat.price.edit'],
        screens: ['items', 'item', 'newItem'],
      },
      {
        key: 'categories',
        href: href.categories,
        needs: ['cat.item.edit', 'cat.price.edit'],
        screens: ['categories'],
      },
      { key: 'labels', href: href.labels, needs: ['cat.label.print'], screens: ['labels'] },
    ],
  },
  {
    // Purchasing (W1-16): suppliers and their ledgers, goods receipts, purchase returns.
    group: 'purchasing',
    icon: Truck,
    items: [
      {
        key: 'suppliers',
        href: href.suppliers,
        needs: ['pur.receive', 'acc.payment.create'],
        screens: ['suppliers', 'supplier'],
      },
      { key: 'receipts', href: href.receipts, needs: ['pur.receive'], screens: ['receipts', 'receipt'] },
      {
        key: 'purchaseReturns',
        href: href.purchaseReturns,
        needs: ['pur.receive'],
        screens: ['purchaseReturns', 'purchaseReturn'],
      },
    ],
  },
  {
    // Stock operations (W1-18): transfers, adjustments, an item's stock card, Transfer needed.
    group: 'stock',
    icon: Package,
    items: [
      {
        key: 'transfers',
        href: href.transfers,
        needs: ['inv.transfer', 'inv.transfer.post'],
        screens: ['transfers', 'transfer'],
      },
      {
        key: 'adjustments',
        href: href.adjustments,
        needs: ['inv.adjust', 'inv.adjust.approve'],
        screens: ['adjustments', 'adjustment'],
      },
      {
        key: 'stockCard',
        href: href.stockCards,
        needs: ['inv.transfer', 'inv.adjust', 'cost.view'],
        screens: ['stockCard'],
      },
      {
        key: 'transferNeeded',
        href: href.transferNeeded,
        needs: ['inv.transfer', 'inv.transfer.post'],
        screens: ['transferNeeded'],
      },
    ],
  },
  {
    // Back-office accounting (W1-19, D-108): money in and out, journal vouchers, the chart, the lock date.
    group: 'accounting',
    icon: Landmark,
    items: [
      {
        key: 'money',
        href: href.money,
        needs: [
          'acc.receipt.create',
          'acc.payment.create',
          'acc.expense.create',
          'acc.journal.post',
          'acc.period.close',
          'reports.financial',
        ],
        screens: ['money', 'accountingDocument', 'voucher'],
      },
      { key: 'accounts', href: href.accounts, needs: ['reports.financial'], screens: ['accounts', 'ledger'] },
      {
        key: 'periods',
        href: href.periods,
        needs: ['acc.period.close', 'acc.period.reopen', 'acc.journal.post'],
        screens: ['periods'],
      },
      {
        key: 'expenseCategories',
        href: href.expenseCategories,
        needs: ['acc.chart.edit'],
        screens: ['expenseCategories'],
      },
    ],
  },
  {
    // The cash reports (W1-11, CSH-08, RPT-02), the W1-20 reports and support (D-110).
    group: 'reports',
    icon: ChartColumn,
    items: [
      {
        key: 'dayReconciliation',
        href: href.dayReconciliation,
        needs: ['reports.view'],
        screens: ['dayReconciliation'],
      },
      { key: 'cashVariance', href: href.cashVariance, needs: ['reports.view'], screens: ['cashVariance'] },
      { key: 'salesRegister', href: href.salesRegister, needs: ['reports.view'], screens: ['salesRegister'] },
      {
        key: 'overridesReport',
        href: href.overridesReport,
        needs: ['reports.view'],
        screens: ['overridesReport'],
      },
      { key: 'voidsReturns', href: href.voidsReturns, needs: ['reports.view'], screens: ['voidsReturns'] },
      { key: 'stockReport', href: href.stockReport, needs: ['reports.view'], screens: ['stockReport'] },
      { key: 'ageing', href: href.ageing, needs: ['reports.view'], screens: ['ageing'] },
      { key: 'exceptions', href: href.exceptions, needs: ['reports.view'], screens: ['exceptions'] },
      { key: 'trace', href: href.trace(), needs: ['support.trace'], screens: ['trace'] },
    ],
  },
  {
    // Set once and rarely changed: the people (W1-04), the counters, the shop's name and bill header (W1-25, D-112)
    // and the stock settings (W1-18).
    group: 'settings',
    icon: SlidersHorizontal,
    items: [
      {
        key: 'staff',
        href: href.staff,
        needs: ['admin.users', 'admin.devices'],
        screens: ['staff', 'person'],
      },
      { key: 'counters', href: href.counters, needs: ['admin.devices'], screens: ['counters'] },
      { key: 'shopSettings', href: href.shopSettings, needs: ['admin.settings'], screens: ['shopSettings'] },
      {
        key: 'stockSettings',
        href: href.stockSettings,
        needs: ['admin.settings'],
        screens: ['stockSettings'],
      },
    ],
  },
];

const GROUPS = new Set<string>(MENU.map((g) => g.group));

export const allowed = (item: MenuItem, permissions: readonly string[]) =>
  item.needs.some((p) => permissions.includes(p));

/** The groups with the entries this person may open; a group with none left out. */
export const menuFor = (permissions: readonly string[]): MenuGroup[] =>
  MENU.map((g) => ({ ...g, items: g.items.filter((i) => allowed(i, permissions)) })).filter(
    (g) => g.items.length > 0,
  );

/** Where a screen sits in the menu: a detail screen sits with its list (an item under Catalog → Items). */
export function placeOf(screen: Route['screen']): { group: GroupKey; item: MenuItem } | null {
  for (const g of MENU) {
    const item = g.items.find((i) => i.screens.includes(screen));
    if (item) return { group: g.group, item };
  }
  return null;
}

// Which groups are open and whether the menu is folded into the rail, remembered in this browser only (W1-28). A
// convenience: anything unreadable, or a group that no longer exists, is ignored.

const STATE_KEY = 'erp.backoffice.menu';

export interface MenuState {
  open: GroupKey[];
  collapsed: boolean;
}

export function readMenuState(): MenuState {
  try {
    const v = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as Partial<
      Record<keyof MenuState, unknown>
    > | null;
    const open = Array.isArray(v?.open) ? v.open : [];
    return {
      open: open.filter((g): g is GroupKey => typeof g === 'string' && GROUPS.has(g)),
      collapsed: v?.collapsed === true,
    };
  } catch {
    return { open: [], collapsed: false };
  }
}

export function writeMenuState(state: MenuState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage off or full: the menu still works, it just isn't remembered.
  }
}
