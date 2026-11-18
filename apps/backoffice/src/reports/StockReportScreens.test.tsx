import type {
  AnalysisView,
  DeadStockView,
  ReorderView,
  StockAtView,
  StockChoicesView,
  StockLedgerView,
  StockMovementCells,
  StockMovementView,
} from '@erp/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { href, parseHash, queryOf } from '../router';
import { ReportsHomeScreen } from './FinancialScreens';
import { PrintProvider } from './frame/ReportFrame';
import {
  DeadStockScreen,
  InventoryAnalysisScreen,
  ReorderScreen,
  StockAtScreen,
  StockLedgerScreen,
  StockMovementScreen,
} from './StockReportScreens';

// The stock reports on the frame (W2-02 plan): groups by category then make with their counts and subtotals, items
// opening their stock ledger for the period, filters in the address, transfer columns only per location, values only
// with cost.view, the reorder list's flags, dead and slow, the analysis' classes, and no string left untranslated.

const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
const plain = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');
const r = en.reports.stockReports;

function fakeApi(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const api: Api = (method, path) => {
    calls.push(path);
    const key = `${method} ${path.split('?')[0]}`;
    return Promise.resolve(
      key in answers ? { status: 200, body: answers[key] } : { status: 404, body: null },
    );
  };
  return { api, calls };
}
const show = (ui: ReactElement) =>
  render(
    <I18nextProvider i18n={i18n}>
      <PrintProvider value={{ shopName: 'Delux City Auto Corner', userName: 'Alia' }}>{ui}</PrintProvider>
    </I18nextProvider>,
  );
const untranslated = () =>
  document.body.textContent?.match(/\b(reports|nav|inventory)\.[a-zA-Z][\w.-]*/g) ?? [];

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
});
afterEach(cleanup);

const CHOICES: StockChoicesView = {
  categories: [
    { id: 'c1', name: 'BRAKES' },
    { id: 'c2', name: 'OIL' },
  ],
  makes: [{ id: 'm1', name: 'Honda' }],
  brands: [],
  locations: [
    { id: 'l1', code: 'SHOP', name: 'Shop' },
    { id: 'l2', code: 'GODOWN', name: 'Godown' },
  ],
  suppliers: [{ id: 's1', code: 'S1', name: 'Oil Co' }],
};

const AT: StockAtView = {
  money: MONEY,
  values: true,
  at: '2027-11-30',
  group: 'category',
  locationId: null,
  negativeOnly: false,
  lines: [
    {
      kind: 'group',
      depth: 0,
      path: ['BRAKES'],
      name: 'BRAKES',
      count: 1,
      cells: { qty: 7000, value: 350000 },
    },
    {
      kind: 'group',
      depth: 1,
      path: ['BRAKES', 'Honda'],
      name: 'Honda',
      count: 1,
      cells: { qty: 7000, value: 350000 },
    },
    {
      kind: 'row',
      depth: 2,
      itemId: 'i1',
      code: 'PAD001',
      name: 'BRAKE PAD CIVIC',
      location: null,
      cells: { qty: 7000, value: 350000 },
    },
    { kind: 'group', depth: 0, path: ['OIL'], name: 'OIL', count: 1, cells: { qty: 1500, value: 30000 } },
    { kind: 'group', depth: 1, path: ['OIL', ''], name: '', count: 1, cells: { qty: 1500, value: 30000 } },
    {
      kind: 'row',
      depth: 2,
      itemId: 'i2',
      code: 'OIL001',
      name: 'ENGINE OIL',
      location: null,
      cells: { qty: 1500, value: 30000 },
    },
  ],
  truncated: false,
  total: { count: 2, qty: 8500, value: 380000 },
};

describe('the stock report addresses', () => {
  it('open the six stock reports, with their filters after a ?', () => {
    expect(parseHash(`${href.stockAt}?group=brand`)).toEqual({ screen: 'stockAt' });
    expect(parseHash(href.stockMovement)).toEqual({ screen: 'stockMovement' });
    expect(parseHash(`${href.stockLedger}?itemId=i1`)).toEqual({ screen: 'stockLedger' });
    expect(parseHash(href.reorder)).toEqual({ screen: 'reorder' });
    expect(parseHash(href.deadStock)).toEqual({ screen: 'deadStock' });
    expect(parseHash(href.inventoryAnalysis)).toEqual({ screen: 'inventoryAnalysis' });
    expect(parseHash(href.stockReport)).toEqual({ screen: 'stockReport' });
  });
});

describe('stock at a date', () => {
  it('groups by category then make, with counts and subtotals; an item opens its ledger', async () => {
    window.location.hash = href.stockAt;
    const { api, calls } = fakeApi({
      'GET /api/reports/stock-at': AT,
      'GET /api/reports/stock-choices': CHOICES,
    });
    show(<StockAtScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.stockAt });
    expect(calls).toContain('/api/reports/stock-at?group=category');
    const rows = within(table).getAllByRole('row');
    expect(rows.map((x) => x.getAttribute('data-kind'))).toEqual([
      null,
      'group',
      'group',
      'account',
      'group',
      'group',
      'account',
      'total',
    ]);
    expect(plain(rows[1]!.textContent)).toContain('BRAKES (1)');
    expect(plain(rows[5]!.textContent)).toContain(`${r.noGroup.make} (1)`);
    expect(plain(rows.at(-1)!.textContent)).toContain('8.5');
    expect(plain(rows.at(-1)!.textContent)).toContain('3,800');
    expect(within(table).getByRole('link', { name: 'BRAKE PAD CIVIC' }).getAttribute('href')).toBe(
      '#/reports/stock-ledger?itemId=i1&from=2027-11-30&to=2027-11-30',
    );
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([r.item, r.qty, r.value]);
    expect(untranslated()).toEqual([]);
  });

  it('puts the grouping, a category and "only below zero" in the address', async () => {
    window.location.hash = href.stockAt;
    const { api } = fakeApi({ 'GET /api/reports/stock-at': AT, 'GET /api/reports/stock-choices': CHOICES });
    show(<StockAtScreen api={api} />);
    await screen.findByRole('table', { name: en.nav.stockAt });
    fireEvent.change(screen.getByLabelText(r.groupBy), { target: { value: 'brand' } });
    fireEvent.change(await screen.findByLabelText(r.filter.categoryId), { target: { value: 'c1' } });
    fireEvent.click(screen.getByLabelText(r.at.negative));
    expect(Object.fromEntries(queryOf(window.location.hash))).toEqual({
      group: 'brand',
      categoryId: 'c1',
      negative: 'only',
    });
  });

  it('shows no value column without cost.view', async () => {
    window.location.hash = href.stockAt;
    const { api } = fakeApi({
      'GET /api/reports/stock-at': {
        ...AT,
        values: false,
        lines: AT.lines.map((l) => ({ ...l, cells: { ...l.cells, value: null } })),
        total: { ...AT.total, value: null },
      },
      'GET /api/reports/stock-choices': CHOICES,
    });
    show(<StockAtScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.stockAt });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([r.item, r.qty]);
    expect(screen.queryByText(r.value)).toBeNull();
  });
});

const qv = (qty: number, value: number | null = qty * 10) => ({ qty, value });
const cells = (o: Partial<Record<keyof StockMovementCells, number>>): StockMovementCells => ({
  opening: qv(o.opening ?? 0),
  openings: qv(o.openings ?? 0),
  purchases: qv(o.purchases ?? 0),
  purchaseReturns: qv(o.purchaseReturns ?? 0),
  sales: qv(o.sales ?? 0),
  salesReturns: qv(o.salesReturns ?? 0),
  adjustments: qv(o.adjustments ?? 0),
  transfersIn: qv(o.transfersIn ?? 0),
  transfersOut: qv(o.transfersOut ?? 0),
  closing: qv(o.closing ?? 0),
});

function movement(group: 'none' | 'location'): StockMovementView {
  const pad = cells({ purchases: 8000, transfersIn: 6000, transfersOut: -6000, sales: -1000, closing: 7000 });
  return {
    money: MONEY,
    values: true,
    from: '2027-11-01',
    to: '2027-11-30',
    group,
    locationId: null,
    lines: [
      { kind: 'row', depth: 0, itemId: 'i1', code: 'PAD001', name: 'BRAKE PAD', location: null, cells: pad },
    ],
    truncated: false,
    total: { count: 1, ...pad },
  };
}

describe('stock movement', () => {
  it('hides the transfers over all locations, shows them per location, and switches to value', async () => {
    window.location.hash = `${href.stockMovement}?group=none`;
    const { api, calls } = fakeApi({
      'GET /api/reports/stock-movement': movement('none'),
      'GET /api/reports/stock-choices': CHOICES,
    });
    show(<StockMovementScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.stockMovement });
    expect(calls).toContain('/api/reports/stock-movement?preset=thisMonth&group=none');
    const heads = () =>
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent);
    expect(heads()).not.toContain(r.movement.cols.transfersIn);
    expect(heads()).not.toContain(r.movement.cols.openings);
    expect(heads()).toContain(r.movement.cols.purchases);
    expect(within(table).getByRole('link', { name: 'BRAKE PAD' }).getAttribute('href')).toBe(
      '#/reports/stock-ledger?itemId=i1&from=2027-11-01&to=2027-11-30',
    );
    fireEvent.change(screen.getByLabelText(r.movement.show), { target: { value: 'value' } });
    expect(queryOf(window.location.hash).get('show')).toBe('value');
    cleanup();

    window.location.hash = `${href.stockMovement}?group=location`;
    const per = fakeApi({
      'GET /api/reports/stock-movement': movement('location'),
      'GET /api/reports/stock-choices': CHOICES,
    });
    show(<StockMovementScreen api={per.api} />);
    const t2 = await screen.findByRole('table', { name: en.nav.stockMovement });
    expect(
      within(t2)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toContain(r.movement.cols.transfersOut);
    expect(untranslated()).toEqual([]);
  });
});

const LEDGER: StockLedgerView = {
  money: MONEY,
  values: true,
  item: { id: 'i1', code: 'PAD001', name: 'BRAKE PAD CIVIC' },
  from: '2027-11-01',
  to: '2027-11-30',
  locationId: null,
  opening: qv(0, 0),
  lines: [
    {
      seq: 1,
      date: '2027-11-02',
      kind: 'goods_receipt',
      documentId: 'g1',
      number: 'GRN-1',
      locationCode: 'GODOWN',
      qty: 8000,
      value: 400000,
      balance: 8000,
      balanceValue: 400000,
    },
    {
      seq: 3,
      date: '2027-11-30',
      kind: 'sale',
      documentId: 's1',
      number: 'C1-S000001',
      locationCode: 'SHOP',
      qty: -1000,
      value: -50000,
      balance: 7000,
      balanceValue: 350000,
    },
  ],
  truncated: false,
  in: qv(8000, 400000),
  out: qv(-1000, -50000),
  closing: qv(7000, 350000),
};

describe('the stock ledger', () => {
  it('asks for an item first; with one, each line opens its document', async () => {
    window.location.hash = href.stockLedger;
    const none = fakeApi({ 'GET /api/reports/stock-choices': CHOICES });
    show(<StockLedgerScreen api={none.api} />);
    expect(await screen.findByText(r.ledger.pick)).toBeDefined();
    expect(none.calls.some((c) => c.startsWith('/api/reports/stock-ledger'))).toBe(false);
    cleanup();

    window.location.hash = `${href.stockLedger}?itemId=i1`;
    const { api, calls } = fakeApi({
      'GET /api/reports/stock-ledger': LEDGER,
      'GET /api/reports/stock-choices': CHOICES,
    });
    show(<StockLedgerScreen api={api} />);
    const table = await screen.findByRole('table', { name: r.ledger.lines });
    expect(calls).toContain('/api/reports/stock-ledger?itemId=i1&preset=thisMonth');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('PAD001 BRAKE PAD CIVIC');
    expect(within(table).getByRole('link', { name: 'GRN-1' }).getAttribute('href')).toBe(
      '#/purchasing/receipts/g1',
    );
    expect(within(table).getByRole('link', { name: 'C1-S000001' }).getAttribute('href')).toBe(
      href.trace('C1-S000001'),
    );
    expect(within(table).getByText(r.kinds.goods_receipt)).toBeDefined();
    expect(plain(screen.getByLabelText(en.reports.frame.figures).textContent)).toContain(r.ledger.closing);
    expect(untranslated()).toEqual([]);
  });
});

const REORDER: ReorderView = {
  money: MONEY,
  values: true,
  today: '2027-11-30',
  since: '2027-01-01',
  rows: [
    {
      itemId: 'i1',
      code: 'PAD001',
      name: 'BRAKE PAD',
      category: 'BRAKES',
      supplierId: 's1',
      supplier: 'Oil Co',
      onHand: 7000,
      min: 8000,
      max: 20000,
      order: 13000,
      levelsNeedFixing: false,
      lastCost: 50000,
      orderValue: 650000,
      lastReceipt: '2027-10-26',
      sold30: 1000,
      sold90: 1000,
      daysOfCover: 287,
    },
    {
      itemId: 'i2',
      code: 'BELT001',
      name: 'FAN BELT',
      category: 'BELTS',
      supplierId: null,
      supplier: null,
      onHand: 0,
      min: 4000,
      max: 3000,
      order: 4000,
      levelsNeedFixing: true,
      lastCost: null,
      orderValue: null,
      lastReceipt: null,
      sold30: 0,
      sold90: 0,
      daysOfCover: 0,
    },
  ],
  suppliers: [
    { supplierId: 's1', supplier: 'Oil Co', count: 1, value: 650000 },
    { supplierId: null, supplier: null, count: 1, value: 0 },
  ],
  truncated: false,
  total: { count: 2, value: 650000 },
};

describe('the reorder list', () => {
  it('lists what to order by supplier, flags levels to fix, and filters one supplier', async () => {
    window.location.hash = href.reorder;
    const { api } = fakeApi({
      'GET /api/reports/reorder': REORDER,
      'GET /api/reports/stock-choices': CHOICES,
    });
    show(<ReorderScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.reorder });
    const rows = within(table).getAllByRole('row');
    expect(plain(rows[1]!.textContent)).toContain('Oil Co');
    expect(plain(rows[1]!.textContent)).toContain('13');
    expect(plain(rows[2]!.textContent)).toContain(r.noGroup.supplier);
    expect(within(rows[2]!).getByText(r.reorder.fixLevels)).toBeDefined();
    expect(screen.getByText('Sales counted since 2027-01-01')).toBeDefined();
    expect(screen.getByRole('link', { name: en.reports.csv }).getAttribute('href')).toBe(
      '/api/reports/reorder?format=csv',
    );
    fireEvent.change(await screen.findByLabelText(r.filter.supplierId), { target: { value: 's1' } });
    expect(queryOf(window.location.hash).get('supplierId')).toBe('s1');
    expect(untranslated()).toEqual([]);
  });
});

const DEAD: DeadStockView = {
  money: MONEY,
  values: true,
  today: '2027-11-30',
  since: '2027-01-01',
  days: 90,
  rows: [
    {
      itemId: 'i3',
      code: 'HOSE001',
      name: 'FUEL HOSE',
      category: 'HOSES',
      make: null,
      kind: 'dead',
      onHand: 1500,
      value: 30000,
      lastSale: null,
      lastReceipt: '2027-03-01',
      sold90: 0,
      daysSinceSale: null,
      daysOfCover: null,
    },
    {
      itemId: 'i1',
      code: 'PAD001',
      name: 'BRAKE PAD',
      category: 'BRAKES',
      make: 'Honda',
      kind: 'slow',
      onHand: 7000,
      value: 350000,
      lastSale: '2027-11-29',
      lastReceipt: '2027-10-26',
      sold90: 1000,
      daysSinceSale: 1,
      daysOfCover: 630,
    },
  ],
  truncated: false,
  totals: {
    dead: { count: 1, value: 30000 },
    notSoldSinceGoLive: { count: 0, value: 0 },
    slow: { count: 1, value: 350000 },
  },
};

describe('dead and slow stock', () => {
  it('totals dead and slow stock at the top, and shows one kind or the other', async () => {
    window.location.hash = href.deadStock;
    const { api, calls } = fakeApi({
      'GET /api/reports/dead-stock': DEAD,
      'GET /api/reports/stock-choices': CHOICES,
    });
    show(<DeadStockScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.deadStock });
    expect(calls).toContain('/api/reports/dead-stock?days=90');
    expect(plain(screen.getByLabelText(en.reports.frame.figures).textContent)).toContain('1 · Rs');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText(r.dead.never)).toBeDefined();
    fireEvent.change(screen.getByLabelText(r.dead.kind), { target: { value: 'slow' } });
    expect(queryOf(window.location.hash).get('kind')).toBe('slow');
    expect(untranslated()).toEqual([]);
  });

  it('asks for another number of days', async () => {
    window.location.hash = href.deadStock;
    const { api } = fakeApi({
      'GET /api/reports/dead-stock': DEAD,
      'GET /api/reports/stock-choices': CHOICES,
    });
    show(<DeadStockScreen api={api} />);
    await screen.findByRole('table', { name: en.nav.deadStock });
    fireEvent.change(screen.getByLabelText(r.dead.days), { target: { value: '30' } });
    expect(queryOf(window.location.hash).get('days')).toBe('30');
  });
});

const ANALYSIS: AnalysisView = {
  money: MONEY,
  values: true,
  from: '2026-12-01',
  to: '2027-11-30',
  since: '2027-01-01',
  rows: [
    {
      itemId: 'i2',
      code: 'OIL001',
      name: 'ENGINE OIL',
      category: 'OIL',
      qtySold: 1000,
      sales: 120000,
      profit: 20000,
      salesClass: 'A',
      profitClass: 'A',
      onHand: 9000,
      stockValue: 900000,
      daysOfCover: 3285,
    },
  ],
  truncated: false,
  classes: {
    A: { count: 1, sales: 120000, profit: 20000 },
    B: { count: 0, sales: 0, profit: 0 },
    C: { count: 0, sales: 0, profit: 0 },
  },
  unsold: { count: 1, value: 30000 },
  costOfSales: 100000,
  openingValue: 0,
  closingValue: 930000,
  turnover: 22,
};

describe('inventory analysis', () => {
  it('opens on the last 12 months, with the classes and the turnover', async () => {
    window.location.hash = href.inventoryAnalysis;
    const { api, calls } = fakeApi({
      'GET /api/reports/inventory-analysis': ANALYSIS,
      'GET /api/reports/stock-choices': CHOICES,
    });
    show(<InventoryAnalysisScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.inventoryAnalysis });
    expect(calls).toContain('/api/reports/inventory-analysis?');
    expect(screen.getByLabelText<HTMLInputElement>(en.reports.frame.from).value).toBe('2026-12-01');
    const figures = plain(screen.getByLabelText(en.reports.frame.figures).textContent);
    expect(figures).toContain('Class A');
    expect(figures).toContain('0.22×');
    expect(within(table).getByRole('link', { name: 'OIL001' }).getAttribute('href')).toBe(
      '#/reports/stock-ledger?itemId=i2',
    );
    expect(untranslated()).toEqual([]);
  });
});

describe('the Reports home', () => {
  it('lists the stock reports for anyone with reports.view', () => {
    show(<ReportsHomeScreen permissions={['reports.view']} />);
    for (const key of [
      'stockLedger',
      'stockAt',
      'stockMovement',
      'reorder',
      'deadStock',
      'inventoryAnalysis',
    ] as const)
      expect(screen.getByRole('link', { name: new RegExp(en.nav[key]) })).toBeDefined();
    expect(untranslated()).toEqual([]);
  });
});
