import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '../i18n';
import en from '../locales/en.json';
import { href, type Route } from '../router';
import { REPORTS } from '../reports/catalog';
import { MENU, Shell } from './Shell';

// The back-office frame (W1-28 plan): the menu in seven rows that open and close, the collapsed rail, the badges, the
// top bar with where you are, the account menu and the search for screens.

/** The nine reports of W1-11 and W1-20, now on the Reports home: each keeps its address and permission. */
const MOVED: Record<string, { href: string; needs: string[] }> = {
  dayReconciliation: { href: href.dayReconciliation, needs: ['reports.view'] },
  cashVariance: { href: href.cashVariance, needs: ['reports.view'] },
  salesRegister: { href: href.salesRegister, needs: ['reports.view'] },
  overridesReport: { href: href.overridesReport, needs: ['reports.view'] },
  voidsReturns: { href: href.voidsReturns, needs: ['reports.view'] },
  stockReport: { href: href.stockReport, needs: ['reports.view'] },
  ageing: { href: href.ageing, needs: ['reports.view'] },
  exceptions: { href: href.exceptions, needs: ['reports.view'] },
  trace: { href: href.trace(), needs: ['support.trace'] },
};

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

/**
 * The menu's entries with their addresses and permissions (W1-04 to W1-25): the regrouping changed none of them, and the
 * nine reports moved onto the Reports home with theirs (W2-01, MOVED).
 */
const ENTRIES: Record<string, { href: string; needs: string[] }> = {
  dashboard: { href: href.dashboard, needs: ['dashboard.view'] },
  staff: { href: href.staff, needs: ['admin.users', 'admin.devices'] },
  counters: { href: href.counters, needs: ['admin.devices'] },
  shopSettings: { href: href.shopSettings, needs: ['admin.settings'] },
  // Every report on one page (W2-01, owner answer 1): anyone who may open one of them.
  reports: {
    href: href.reports,
    needs: ['reports.financial', 'reports.view', 'admin.users', 'support.trace'],
  },
  items: { href: href.items, needs: ['cat.item.edit', 'cat.price.edit'] },
  categories: { href: href.categories, needs: ['cat.item.edit', 'cat.price.edit'] },
  labels: { href: href.labels, needs: ['cat.label.print'] },
  customers: { href: href.customers, needs: ['cust.edit', 'cust.terms.edit'] },
  // A bill's details (W2-10, D-125): Sales becomes a group of two.
  bills: { href: href.bill(), needs: ['reports.view'] },
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
      username="fahad"
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
      en.nav.groups.sales,
      en.nav.groups.catalog,
      en.nav.groups.purchasing,
      en.nav.groups.stock,
      en.nav.groups.accounting,
      en.nav.reports,
      en.nav.groups.settings,
    ]);
  });

  it('keeps every entry once, with its address and permissions; Reports opens the Reports home', () => {
    const entries = MENU.flatMap((g) => g.items);
    expect(entries.map((i) => i.key).sort()).toEqual(Object.keys(ENTRIES).sort());
    for (const i of entries) expect({ href: i.href, needs: [...i.needs] }).toEqual(ENTRIES[i.key]);
  });

  it('keeps each report that moved to the Reports home at its address, with its permission', () => {
    for (const [key, entry] of Object.entries(MOVED)) {
      const r = REPORTS.find((x) => x.key === key);
      expect({ key, href: r?.href, needs: [...(r?.needs ?? [])] }).toEqual({ key, ...entry });
    }
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
    expect(rows()).toEqual([en.nav.labels, en.nav.reports]);
    expect(link(en.nav.labels)?.getAttribute('aria-current')).toBe('page');
    expect(link(en.nav.reports)?.getAttribute('href')).toBe(href.reports);
    expect(within(nav()).queryAllByRole('button', { expanded: false })).toHaveLength(0);
  });

  it('shows no menu entries to someone who may open none', () => {
    show({ permissions: ['pos.sale.create'], route: { screen: 'home' } });
    expect(screen.queryByRole('navigation', { name: en.nav.menu })).toBeNull();
    expect(screen.getByText('the screen')).toBeDefined();
  });

  it('puts a count on its entry: the open exceptions on Reports', () => {
    show({ route: { screen: 'items' }, badges: { reports: 3 } });
    expect(within(link(en.nav.reports)!).getByLabelText(badge(3))).toBeDefined();
  });

  it('lights Reports up on any report, and the top bar names the report', () => {
    show({ route: { screen: 'trialBalance' } });
    expect(link(en.nav.reports)?.getAttribute('aria-current')).toBe('page');
    expect(within(screen.getByRole('banner')).getByText(en.nav.trialBalance)).toBeDefined();
  });

  it('shows no count at 0', () => {
    show({ route: { screen: 'exceptions' }, badges: { reports: 0 } });
    expect(screen.queryByLabelText(badge(0))).toBeNull();
  });
});

describe('the collapsed menu', () => {
  it('folds into a rail of named icons; a group lists its screens beside it; the choice is remembered', () => {
    show({ route: { screen: 'items' }, badges: { reports: 2 } });
    fireEvent.click(screen.getByRole('button', { name: en.nav.collapse }));
    expect(link(en.nav.items)).toBeNull();
    for (const name of ['sales', 'catalog', 'purchasing', 'stock', 'accounting', 'settings'] as const)
      expect(group(en.nav.groups[name]).getAttribute('aria-haspopup')).toBe('menu');
    expect(link(en.nav.reports)?.getAttribute('aria-describedby')).toBeTruthy();

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

  it('holds no account: it is at the foot of the side menu', () => {
    show();
    expect(within(bar()).queryByRole('button', { name: accountName })).toBeNull();
    expect(within(bar()).getByRole('button', { name: en.nav.search })).toBeDefined();
  });
});

const accountName = en.nav.account.replace('{{name}}', 'Fahad Hussain');

describe('the account', () => {
  const account = () => within(screen.getByRole('complementary')).getByRole('button', { name: accountName });

  it('sits at the foot of the side menu with the name and username', () => {
    show();
    expect(within(account()).getByText('Fahad Hussain')).toBeDefined();
    expect(within(account()).getByText('fahad')).toBeDefined();
  });

  it('opens a menu with the theme buttons, the person’s choice pressed, and Sign out', () => {
    const onSignOut = vi.fn();
    show({ onSignOut, theme: 'light' });
    openMenu(account());
    const theme = screen.getByRole('group', { name: en.nav.theme });
    const choice = (name: string) => within(theme).getByRole('button', { name });
    expect(choice(en.nav.themes.light).getAttribute('aria-pressed')).toBe('true');
    expect(choice(en.nav.themes.system).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('menuitem', { name: en.nav.signOut }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  // W2-07 (PLT-13, owner answer 3): System · Light · Dark, icons only, each named; a press asks for that theme.
  it('lets the person choose System, Light or Dark, icons only', () => {
    const onTheme = vi.fn();
    show({ theme: 'system', onTheme });
    openMenu(account());
    const theme = screen.getByRole('group', { name: en.nav.theme });
    for (const name of [en.nav.themes.system, en.nav.themes.light, en.nav.themes.dark]) {
      const b = within(theme).getByRole<HTMLButtonElement>('button', { name });
      expect(b.disabled).toBe(false);
      expect(b.textContent).toBe('');
      expect(b.title).toBe(name);
    }
    fireEvent.click(within(theme).getByRole('button', { name: en.nav.themes.dark }));
    expect(onTheme).toHaveBeenCalledWith('dark');
  });

  it('says what System follows now', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('dark'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    show({ theme: 'system' });
    openMenu(account());
    expect(screen.getByText(en.nav.themes.followsSystem.replace('{{mode}}', 'dark'))).toBeDefined();
  });

  it('says when a choice could not be saved for other computers', () => {
    show({ theme: 'dark', themeNotSaved: true });
    openMenu(account());
    expect(screen.getByText(en.nav.themeNotSaved)).toBeDefined();
  });

  it('shows the dark pill text on the count, not white (--bad-ink)', () => {
    show({ badges: { reports: 3 } });
    const pill = screen.getByLabelText(badge(3));
    expect(pill.className).toContain('text-bad-ink');
    expect(pill.className).not.toContain('text-white');
  });

  it('is there for someone who may open no screen, so they can sign out', () => {
    show({ permissions: ['pos.sale.create'], route: { screen: 'home' } });
    expect(account()).toBeDefined();
  });

  it('stays in the rail as the avatar alone, still named', () => {
    localStorage.setItem('erp.backoffice.menu', JSON.stringify({ open: [], collapsed: true }));
    show();
    expect(within(account()).queryByText('Fahad Hussain')).toBeNull();
    openMenu(account());
    expect(screen.getByRole('menuitem', { name: en.nav.signOut })).toBeDefined();
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

  it('finds each report by its own name, though the menu shows only the Reports home', () => {
    show();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    type('trial');
    expect(options()).toEqual([`${en.nav.trialBalance}${en.nav.groups.reports}`]);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(window.location.hash).toBe(href.trialBalance);
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
