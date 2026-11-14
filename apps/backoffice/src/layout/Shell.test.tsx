import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '../i18n';
import en from '../locales/en.json';
import { href, type Route } from '../router';
import { MENU, Shell } from './Shell';

// The back-office frame (W1-28 plan): the menu in seven rows that open and close, the collapsed rail, the badges, the
// top bar with where you are, the account menu and the search for screens.

/** Every permission a menu entry needs: an owner sees everything. */
const EVERYTHING = [
  'admin.users',
  'admin.devices',
  'admin.settings',
  'cust.edit',
  'cust.terms.edit',
  'cat.item.edit',
  'cat.price.edit',
  'cat.label.print',
  'pur.receive',
  'acc.payment.create',
  'acc.receipt.create',
  'acc.expense.create',
  'acc.journal.post',
  'acc.period.close',
  'acc.period.reopen',
  'acc.chart.edit',
  'reports.financial',
  'reports.view',
  'support.trace',
  'inv.transfer',
  'inv.transfer.post',
  'inv.adjust',
  'inv.adjust.approve',
  'cost.view',
];

/** Today's 28 entries with their addresses and permissions (W1-04 to W1-25): the regrouping changes none of them. */
const ENTRIES: Record<string, { href: string; needs: string[] }> = {
  staff: { href: href.staff, needs: ['admin.users', 'admin.devices'] },
  counters: { href: href.counters, needs: ['admin.devices'] },
  shopSettings: { href: href.shopSettings, needs: ['admin.settings'] },
  dayReconciliation: { href: href.dayReconciliation, needs: ['reports.view'] },
  cashVariance: { href: href.cashVariance, needs: ['reports.view'] },
  salesRegister: { href: href.salesRegister, needs: ['reports.view'] },
  overridesReport: { href: href.overridesReport, needs: ['reports.view'] },
  voidsReturns: { href: href.voidsReturns, needs: ['reports.view'] },
  stockReport: { href: href.stockReport, needs: ['reports.view'] },
  ageing: { href: href.ageing, needs: ['reports.view'] },
  exceptions: { href: href.exceptions, needs: ['reports.view'] },
  trace: { href: href.trace(), needs: ['support.trace'] },
  items: { href: href.items, needs: ['cat.item.edit', 'cat.price.edit'] },
  categories: { href: href.categories, needs: ['cat.item.edit', 'cat.price.edit'] },
  labels: { href: href.labels, needs: ['cat.label.print'] },
  customers: { href: href.customers, needs: ['cust.edit', 'cust.terms.edit'] },
  suppliers: { href: href.suppliers, needs: ['pur.receive', 'acc.payment.create'] },
  receipts: { href: href.receipts, needs: ['pur.receive'] },
  purchaseReturns: { href: href.purchaseReturns, needs: ['pur.receive'] },
  transfers: { href: href.transfers, needs: ['inv.transfer', 'inv.transfer.post'] },
  adjustments: { href: href.adjustments, needs: ['inv.adjust', 'inv.adjust.approve'] },
  stockCard: { href: href.stockCards, needs: ['inv.transfer', 'inv.adjust', 'cost.view'] },
  transferNeeded: { href: href.transferNeeded, needs: ['inv.transfer', 'inv.transfer.post'] },
  stockSettings: { href: href.stockSettings, needs: ['admin.settings'] },
  money: {
    href: href.money,
    needs: [
      'acc.receipt.create',
      'acc.payment.create',
      'acc.expense.create',
      'acc.journal.post',
      'acc.period.close',
      'reports.financial',
    ],
  },
  periods: { href: href.periods, needs: ['acc.period.close', 'acc.period.reopen', 'acc.journal.post'] },
  accounts: { href: href.accounts, needs: ['reports.financial'] },
  expenseCategories: { href: href.expenseCategories, needs: ['acc.chart.edit'] },
};

type Props = Partial<ComponentProps<typeof Shell>>;
const shellOf = (p: Props) => (
  <I18nextProvider i18n={i18n}>
    <Shell
      fullName="Fahad Hussain"
      permissions={EVERYTHING}
      route={{ screen: 'items' }}
      onSignOut={() => {}}
      {...p}
    >
      <p>the screen</p>
    </Shell>
  </I18nextProvider>
);
const show = (p: Props = {}) => render(shellOf(p));

const nav = () => screen.getByRole('navigation', { name: en.nav.menu });
/** The menu's rows, top to bottom, by the name each shows. */
const rows = () =>
  [...nav().querySelectorAll('[data-slot="menu-row"]')].map(
    (r) => r.querySelector('[data-slot="menu-label"]')?.textContent ?? r.getAttribute('aria-label'),
  );
const group = (name: string) => within(nav()).getByRole('button', { name });
const link = (name: string) => within(nav()).queryByRole('link', { name });
const badge = (count: number) => en.nav.badge.replace('{{count}}', String(count));
/** Radix opens its menus on a pointer press or a key; the keyboard is the one jsdom has. */
const openMenu = (trigger: HTMLElement) => fireEvent.keyDown(trigger, { key: 'Enter' });

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the menu', () => {
  it('shows seven rows for an owner, Settings last', () => {
    show();
    expect(rows()).toEqual([
      en.nav.customers,
      en.nav.groups.catalog,
      en.nav.groups.purchasing,
      en.nav.groups.stock,
      en.nav.groups.accounting,
      en.nav.groups.reports,
      en.nav.groups.settings,
    ]);
  });

  it('keeps every one of the 28 entries once, with its address and permissions', () => {
    const entries = MENU.flatMap((g) => g.items);
    expect(entries.map((i) => i.key).sort()).toEqual(Object.keys(ENTRIES).sort());
    for (const i of entries) expect({ href: i.href, needs: [...i.needs] }).toEqual(ENTRIES[i.key]);
  });

  it('opens the group of the current screen and marks its entry; the others stay closed', () => {
    show({ route: { screen: 'items' } });
    expect(group(en.nav.groups.catalog).getAttribute('aria-expanded')).toBe('true');
    expect(link(en.nav.items)?.getAttribute('aria-current')).toBe('page');
    expect(link(en.nav.categories)?.getAttribute('aria-current')).toBeNull();
    expect(group(en.nav.groups.stock).getAttribute('aria-expanded')).toBe('false');
    expect(link(en.nav.transfers)).toBeNull();
  });

  it('opens the list’s group on a detail screen: an item opens Catalog, a person opens Settings', () => {
    const { rerender } = show({ route: { screen: 'item', id: 'i1' } });
    expect(link(en.nav.items)?.getAttribute('aria-current')).toBe('page');
    rerender(shellOf({ route: { screen: 'person', id: 'u1' } }));
    expect(group(en.nav.groups.settings).getAttribute('aria-expanded')).toBe('true');
    expect(link(en.nav.staff)?.getAttribute('aria-current')).toBe('page');
  });

  it('opens and closes a group on a click, keeps it open on another screen and after a reload', () => {
    const { rerender } = show({ route: { screen: 'items' } });
    fireEvent.click(group(en.nav.groups.stock));
    expect(link(en.nav.transfers)?.getAttribute('href')).toBe(href.transfers);
    fireEvent.click(group(en.nav.groups.catalog));
    expect(link(en.nav.items)).toBeNull();

    rerender(shellOf({ route: { screen: 'money' } }));
    expect(link(en.nav.transfers)).not.toBeNull();
    expect(link(en.nav.money)?.getAttribute('aria-current')).toBe('page');

    cleanup();
    show({ route: { screen: 'customers' } });
    expect(group(en.nav.groups.stock).getAttribute('aria-expanded')).toBe('true');
    expect(group(en.nav.groups.accounting).getAttribute('aria-expanded')).toBe('true');
    expect(group(en.nav.groups.catalog).getAttribute('aria-expanded')).toBe('false');
  });

  it('ignores remembered groups that no longer exist, and a remembered state it can’t read', () => {
    localStorage.setItem(
      'erp.backoffice.menu',
      JSON.stringify({ open: ['people', 'stock'], collapsed: 'no' }),
    );
    show({ route: { screen: 'customers' } });
    expect(group(en.nav.groups.stock).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: en.nav.collapse })).toBeDefined();
    cleanup();
    localStorage.setItem('erp.backoffice.menu', '{not json');
    show();
    expect(rows()).toHaveLength(7);
  });

  it('shows a group with one entry the person may open as a direct link, and no group with none', () => {
    show({ permissions: ['support.trace', 'cat.label.print'], route: { screen: 'labels', source: null } });
    expect(rows()).toEqual([en.nav.labels, en.nav.trace]);
    expect(link(en.nav.labels)?.getAttribute('aria-current')).toBe('page');
    expect(link(en.nav.trace)?.getAttribute('href')).toBe(href.trace());
    expect(within(nav()).queryAllByRole('button', { expanded: false })).toHaveLength(0);
  });

  it('shows no menu entries to someone who may open none', () => {
    show({ permissions: ['pos.sale.create'], route: { screen: 'home' } });
    expect(screen.queryByRole('navigation', { name: en.nav.menu })).toBeNull();
    expect(screen.getByText('the screen')).toBeDefined();
  });

  it('puts a count on its entry, and on the group while the group is closed', () => {
    show({ route: { screen: 'items' }, badges: { exceptions: 3 } });
    expect(within(group(en.nav.groups.reports)).getByLabelText(badge(3))).toBeDefined();
    fireEvent.click(group(en.nav.groups.reports));
    expect(within(group(en.nav.groups.reports)).queryByLabelText(badge(3))).toBeNull();
    expect(within(link(en.nav.exceptions)!).getByLabelText(badge(3))).toBeDefined();
  });

  it('shows no count at 0', () => {
    show({ route: { screen: 'exceptions' }, badges: { exceptions: 0 } });
    expect(screen.queryByLabelText(badge(0))).toBeNull();
  });
});

describe('the collapsed menu', () => {
  it('folds into a rail of named icons; a group lists its screens beside it; the choice is remembered', () => {
    show({ route: { screen: 'items' }, badges: { exceptions: 2 } });
    fireEvent.click(screen.getByRole('button', { name: en.nav.collapse }));
    expect(link(en.nav.items)).toBeNull();
    expect(link(en.nav.customers)?.getAttribute('aria-label')).toBe(en.nav.customers);
    for (const name of ['catalog', 'purchasing', 'stock', 'accounting', 'reports', 'settings'] as const)
      expect(group(en.nav.groups[name]).getAttribute('aria-haspopup')).toBe('menu');
    expect(within(group(en.nav.groups.reports)).getByLabelText(badge(2))).toBeDefined();

    openMenu(group(en.nav.groups.stock));
    const flyout = screen.getByRole('menu');
    expect(within(flyout).getByRole('menuitem', { name: en.nav.transfers }).getAttribute('href')).toBe(
      href.transfers,
    );
    expect(within(flyout).getAllByRole('menuitem')).toHaveLength(4);

    cleanup();
    show();
    expect(screen.getByRole('button', { name: en.nav.expand })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: en.nav.expand }));
    expect(link(en.nav.items)?.getAttribute('aria-current')).toBe('page');
  });

  it('marks the current screen in its group’s list', () => {
    localStorage.setItem('erp.backoffice.menu', JSON.stringify({ open: [], collapsed: true }));
    show({ route: { screen: 'adjustments' } });
    openMenu(group(en.nav.groups.stock));
    expect(screen.getByRole('menuitem', { name: en.nav.adjustments }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('is always the rail in a narrow window, with no button to expand it', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
    );
    show({ route: { screen: 'items' } });
    expect(link(en.nav.items)).toBeNull();
    expect(group(en.nav.groups.catalog).getAttribute('aria-haspopup')).toBe('menu');
    expect(screen.queryByRole('button', { name: en.nav.expand })).toBeNull();
    expect(screen.queryByRole('button', { name: en.nav.collapse })).toBeNull();
  });
});

describe('the top bar', () => {
  const bar = () => screen.getByRole('banner');

  it('says where you are: the group and the entry, also on a detail screen', () => {
    const { rerender } = show({ route: { screen: 'item', id: 'i1' } });
    expect(within(bar()).getByText(en.nav.groups.catalog)).toBeDefined();
    expect(within(bar()).getByText(en.nav.items)).toBeDefined();
    rerender(shellOf({ route: { screen: 'customer', id: 'c1' } }));
    expect(within(bar()).getByText(en.nav.groups.sales)).toBeDefined();
    expect(within(bar()).getByText(en.nav.customers)).toBeDefined();
  });

  it('holds the account menu: the name, and Sign out', () => {
    const onSignOut = vi.fn();
    show({ onSignOut });
    const account = within(bar()).getByRole('button', {
      name: en.nav.account.replace('{{name}}', 'Fahad Hussain'),
    });
    expect(within(account).getByText('Fahad Hussain')).toBeDefined();
    openMenu(account);
    fireEvent.click(screen.getByRole('menuitem', { name: en.nav.signOut }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});

describe('the search for screens', () => {
  const box = () => screen.getByRole('combobox', { name: en.nav.searchLabel });
  const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
  const options = () => screen.queryAllByRole('option').map((o) => o.textContent);

  it('opens with Ctrl K, narrows as you type, and Enter opens the chosen screen', () => {
    show();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: en.nav.searchTitle })).toBeDefined();
    type('trans');
    expect(options()).toEqual([
      `${en.nav.transfers}${en.nav.groups.stock}`,
      `${en.nav.transferNeeded}${en.nav.groups.stock}`,
    ]);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(window.location.hash).toBe(href.transferNeeded);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens from the top bar too, and finds a screen by its group’s name', () => {
    show();
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: en.nav.search }));
    type('settings');
    expect(options()).toHaveLength(4);
    fireEvent.click(screen.getAllByRole('option')[2]!);
    expect(window.location.hash).toBe(href.shopSettings);
  });

  it('never lists a screen the person may not open', () => {
    show({ permissions: ['cat.item.edit'], route: { screen: 'items' } as Route });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    type('trace');
    expect(options()).toEqual([]);
    expect(screen.getByText(en.nav.searchNone)).toBeDefined();
    type('');
    expect(options()).toEqual([
      `${en.nav.items}${en.nav.groups.catalog}`,
      `${en.nav.categories}${en.nav.groups.catalog}`,
    ]);
  });
});
