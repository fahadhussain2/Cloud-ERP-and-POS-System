import type {
  PurchaseRegisterView,
  RatesView,
  SalesCells,
  SalesChoicesView,
  SalesOverTimeView,
  SalesProfitView,
  StockChoicesView,
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
  PurchaseRegisterScreen,
  RatesScreen,
  SalesOverTimeScreen,
  SalesProfitScreen,
} from './SalesReportScreens';

// The sales and purchase reports on the frame (W2-03 plan): sales and gross profit by category, each row opening the
// next level with the period kept; the comparison columns; cost and profit only with cost.view; the purchase
// register's lines; the rates for an item; the charts with their tables; no string left untranslated.

const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
const plain = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');
const r = en.reports.salesReports;

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

const STOCK_CHOICES: StockChoicesView = {
  categories: [{ id: 'c1', name: 'OIL' }],
  makes: [],
  brands: [],
  locations: [{ id: 'l1', code: 'SHOP', name: 'Shop' }],
  suppliers: [{ id: 's1', code: 'S1', name: 'Oil Co' }],
};
const SALES_CHOICES: SalesChoicesView = {
  salesmen: [{ id: 'u1', name: 'Sara' }],
  customers: [{ id: 'p1', code: 'KHAN', name: 'Khan Motors' }],
};
const CHOICES = {
  'GET /api/reports/stock-choices': STOCK_CHOICES,
  'GET /api/reports/sales-choices': SALES_CHOICES,
};

const cells = (sales: number, cost: number | null, bills = 1): SalesCells => ({
  bills,
  qty: 2000,
  sales,
  discount: 1000,
  discountBp: 100,
  cost,
  profit: cost === null ? null : sales - cost,
  marginBp: cost === null ? null : Math.round(((sales - cost) * 10000) / sales),
});

const PROFIT: SalesProfitView = {
  money: MONEY,
  values: true,
  from: '2027-11-01',
  to: '2027-11-30',
  group: 'category',
  compare: 'previous',
  before: { from: '2027-10-01', to: '2027-10-31' },
  since: '2027-01-01',
  rows: [
    {
      key: 'c1',
      name: 'OIL',
      code: null,
      date: null,
      cells: cells(220000, 160000, 3),
      before: {
        sales: 200000,
        profit: 50000,
        salesChange: { amount: 20000, bp: 1000 },
        profitChange: { amount: 10000, bp: 2000 },
      },
    },
    {
      key: '',
      name: '',
      code: null,
      date: null,
      cells: cells(30000, 20000),
      before: {
        sales: 0,
        profit: 0,
        salesChange: { amount: 30000, bp: null },
        profitChange: { amount: 10000, bp: null },
      },
    },
  ],
  truncated: false,
  total: {
    count: 2,
    cells: cells(250000, 180000, 4),
    before: {
      sales: 200000,
      profit: 50000,
      salesChange: { amount: 50000, bp: 2500 },
      profitChange: { amount: 20000, bp: 4000 },
    },
  },
};

describe('the sales report addresses', () => {
  it('open the four sales and purchase reports', () => {
    expect(parseHash(`${href.salesProfit}?group=item`)).toEqual({ screen: 'salesProfit' });
    expect(parseHash(href.purchaseRegister)).toEqual({ screen: 'purchaseRegister' });
    expect(parseHash(`${href.rates}?itemId=i1`)).toEqual({ screen: 'rates' });
    expect(parseHash(href.salesOverTime)).toEqual({ screen: 'salesOverTime' });
    // The W1-20 sales register keeps its own address.
    expect(parseHash(href.salesRegister)).toEqual({ screen: 'salesRegister' });
  });
});

describe('sales and gross profit', () => {
  it('opens by category, compared with the period before; a category opens its items for the period', async () => {
    window.location.hash = href.salesProfit;
    const { api, calls } = fakeApi({ 'GET /api/reports/sales-profit': PROFIT, ...CHOICES });
    show(<SalesProfitScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.salesProfit });
    expect(calls).toContain('/api/reports/sales-profit?preset=thisMonth&group=category&compare=previous');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      r.group.category,
      r.bills,
      r.qty,
      r.sales,
      r.discount,
      r.cost,
      r.profit,
      r.margin,
      r.beforeSales,
      r.change,
    ]);
    expect(within(table).getByRole('link', { name: 'OIL' }).getAttribute('href')).toBe(
      '#/reports/sales-profit?preset=thisMonth&group=item&compare=previous&categoryId=c1',
    );
    // Items with no category: named, but they can't be filtered to.
    expect(within(table).getByText(r.none.category).closest('a')).toBeNull();
    const total = within(table).getAllByRole('row').at(-1)!;
    expect(plain(total.textContent)).toContain('2,500');
    expect(plain(total.textContent)).toContain('28.0%');
    expect(plain(screen.getByLabelText(en.reports.frame.figures).textContent)).toContain('25.0%');
    expect(untranslated()).toEqual([]);
  });

  it('puts the grouping, the comparison and the filters in the address', async () => {
    window.location.hash = href.salesProfit;
    const { api } = fakeApi({ 'GET /api/reports/sales-profit': PROFIT, ...CHOICES });
    show(<SalesProfitScreen api={api} />);
    await screen.findByRole('table', { name: en.nav.salesProfit });
    fireEvent.change(screen.getByLabelText(r.groupBy), { target: { value: 'salesman' } });
    fireEvent.change(screen.getByLabelText(en.reports.pl.compare), { target: { value: 'last-year' } });
    fireEvent.change(await screen.findByLabelText(r.filter.customerId), { target: { value: 'walk-in' } });
    expect(Object.fromEntries(queryOf(window.location.hash))).toEqual({
      preset: 'thisMonth',
      group: 'salesman',
      compare: 'last-year',
      customerId: 'walk-in',
    });
  });

  it('by bill, a bill opens its trace; without cost.view there is no cost, profit or margin', async () => {
    window.location.hash = `${href.salesProfit}?group=bill`;
    const noCost = { ...cells(120000, null), qty: 1000 };
    const { api } = fakeApi({
      'GET /api/reports/sales-profit': {
        ...PROFIT,
        values: false,
        group: 'bill',
        compare: 'none',
        before: null,
        rows: [
          {
            key: 'd1',
            name: 'C01-S000001',
            code: 'C01-S000001',
            date: '2027-11-02',
            cells: noCost,
            before: null,
          },
        ],
        total: { count: 1, cells: noCost, before: null },
      } satisfies SalesProfitView,
      ...CHOICES,
    });
    show(<SalesProfitScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.salesProfit });
    expect(
      within(table)
        .getByRole('link', { name: /C01-S000001/ })
        .getAttribute('href'),
    ).toBe('#/support/trace/C01-S000001');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([r.group.bill, r.bills, r.qty, r.sales, r.discount]);
  });
});

describe('the purchase register', () => {
  const REGISTER: PurchaseRegisterView = {
    money: MONEY,
    values: true,
    from: '2027-11-01',
    to: '2027-11-30',
    supplierId: null,
    withLines: true,
    rows: [
      {
        kind: 'receipt',
        id: 'g1',
        number: 'GR-0001',
        date: '2027-11-02',
        supplierId: 's1',
        supplier: 'Oil Co',
        supplierBillNo: 'B-77',
        supplierBillDate: '2027-11-01',
        location: 'SHOP',
        paidBy: 'account',
        dueDate: '2027-12-02',
        lineCount: 1,
        qty: 10000,
        total: 1000000,
        lines: [
          { itemId: 'i1', code: 'OIL001', name: 'ENGINE OIL', qty: 10000, rate: 100000, value: 1000000 },
        ],
      },
      {
        kind: 'return',
        id: 'r1',
        number: 'PR-0001',
        date: '2027-11-03',
        supplierId: 's1',
        supplier: 'Oil Co',
        supplierBillNo: 'B-77',
        supplierBillDate: '2027-11-01',
        location: 'SHOP',
        paidBy: 'account',
        dueDate: null,
        lineCount: 1,
        qty: -1000,
        total: -100000,
        lines: [],
      },
    ],
    suppliers: [{ supplierId: 's1', name: 'Oil Co', count: 2, total: 900000 }],
    total: { count: 2, receipts: 1000000, returns: -100000, net: 900000 },
  };

  it('lists each document with its lines, opening the receipt and the return', async () => {
    window.location.hash = `${href.purchaseRegister}?lines=1`;
    const { api, calls } = fakeApi({ 'GET /api/reports/purchase-register': REGISTER, ...CHOICES });
    show(<PurchaseRegisterScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.purchaseRegister });
    expect(calls).toContain('/api/reports/purchase-register?preset=thisMonth&lines=1');
    expect(within(table).getByRole('link', { name: 'GR-0001' }).getAttribute('href')).toBe(
      href.receipt('g1'),
    );
    expect(within(table).getByRole('link', { name: 'PR-0001' }).getAttribute('href')).toBe(
      href.purchaseReturn('r1'),
    );
    expect(plain(table.textContent)).toContain('OIL001');
    expect(plain(screen.getByRole('table', { name: r.register.bySupplier }).textContent)).toContain('9,000');
    expect(plain(screen.getByLabelText(en.reports.frame.figures).textContent)).toContain('9,000');
    expect(untranslated()).toEqual([]);
  });
});

describe('purchase and sale rates', () => {
  it('asks for an item or a party first; for an item, both sides and the spread', async () => {
    window.location.hash = href.rates;
    const RATES: RatesView = {
      money: MONEY,
      values: true,
      from: '2027-01-01',
      to: '2027-12-31',
      item: { id: 'i1', code: 'OIL001', name: 'ENGINE OIL' },
      party: null,
      purchases: [
        {
          kind: 'receipt',
          documentId: 'g1',
          number: 'GR-0001',
          date: '2027-11-02',
          party: 'Oil Co',
          salesman: null,
          itemId: 'i1',
          code: 'OIL001',
          name: 'ENGINE OIL',
          qty: 10000,
          listPrice: null,
          rate: 100000,
          netRate: 100000,
          value: 1000000,
        },
      ],
      sales: [
        {
          kind: 'sale',
          documentId: 'd1',
          number: 'C01-S000001',
          date: '2027-11-03',
          party: null,
          salesman: 'Sara',
          itemId: 'i1',
          code: 'OIL001',
          name: 'ENGINE OIL',
          qty: 1000,
          listPrice: 120000,
          rate: 115000,
          netRate: 114000,
          value: 114000,
        },
      ],
      purchaseStats: {
        count: 1,
        qty: 10000,
        value: 1000000,
        average: 100000,
        lowest: 100000,
        highest: 100000,
        last: 100000,
      },
      saleStats: {
        count: 1,
        qty: 1000,
        value: 114000,
        average: 114000,
        lowest: 114000,
        highest: 114000,
        last: 114000,
      },
      spread: { amount: 14000, marginBp: 1228 },
    };
    const { api } = fakeApi({ 'GET /api/reports/rates': RATES });
    show(<RatesScreen api={api} />);
    expect(await screen.findByText(r.rates.pick)).toBeDefined();
    cleanup();
    window.location.hash = `${href.rates}?itemId=i1`;
    show(<RatesScreen api={api} />);
    const sales = await screen.findByRole('table', { name: r.rates.sales });
    expect(within(sales).getByRole('link', { name: 'C01-S000001' }).getAttribute('href')).toBe(
      '#/support/trace/C01-S000001',
    );
    expect(plain(sales.textContent)).toContain(r.walkIn);
    expect(screen.getByRole('table', { name: r.rates.purchases })).toBeDefined();
    const figures = plain(screen.getByLabelText(en.reports.frame.figures).textContent);
    expect(figures).toContain(r.rates.spread);
    expect(figures).toContain('12.3%');
    expect(untranslated()).toEqual([]);
  });
});

describe('sales over time', () => {
  const grid = () => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const bills = grid();
  bills[0]![10] = 2;
  const OVER: SalesOverTimeView = {
    money: MONEY,
    values: true,
    from: '2027-11-01',
    to: '2027-11-03',
    compare: 'previous',
    before: { from: '2027-10-29', to: '2027-10-31' },
    since: '2027-01-01',
    step: 'day',
    trend: [
      { from: '2027-11-01', to: '2027-11-01', bills: 2, sales: 200000, profit: 50000 },
      { from: '2027-11-02', to: '2027-11-02', bills: 0, sales: 0, profit: 0 },
      { from: '2027-11-03', to: '2027-11-03', bills: 1, sales: 50000, profit: 10000 },
    ],
    beforeTrend: [
      { from: '2027-10-29', to: '2027-10-29', bills: 1, sales: 100000, profit: 20000 },
      { from: '2027-10-30', to: '2027-10-30', bills: 0, sales: 0, profit: 0 },
      { from: '2027-10-31', to: '2027-10-31', bills: 0, sales: 0, profit: 0 },
    ],
    grid: { bills, sales: grid(), hours: { first: 10, last: 12 } },
    by: 'sales',
    top: [{ itemId: 'i1', code: 'OIL001', name: 'ENGINE OIL', qty: 2000, sales: 220000, profit: 60000 }],
    bottom: [],
    discounts: {
      bySalesman: [
        {
          key: 'u1',
          name: 'Sara',
          listSales: 260000,
          sales: 250000,
          discount: 10000,
          discountBp: 385,
          approvals: 1,
        },
      ],
      byDay: [],
      total: {
        key: '',
        name: '',
        listSales: 260000,
        sales: 250000,
        discount: 10000,
        discountBp: 385,
        approvals: 1,
      },
    },
  };

  it('draws the trend with its comparison, the busy hours and the top items, each with a table', async () => {
    window.location.hash = href.salesOverTime;
    const { api } = fakeApi({ 'GET /api/reports/sales-over-time': OVER, ...CHOICES });
    show(<SalesOverTimeScreen api={api} />);
    expect(await screen.findByRole('img', { name: r.overTime.trend.day })).toBeDefined();
    expect(screen.getByRole('table', { name: r.overTime.trendTable })).toBeDefined();
    const hours = screen.getByRole('table', { name: r.overTime.hours });
    // Monday at 10: two bills.
    expect(within(hours).getAllByRole('row')[1]!.querySelectorAll('td')[0]!.getAttribute('title')).toContain(
      '2 bills',
    );
    expect(screen.getByRole('list', { name: r.overTime.top }).textContent).toContain('OIL001');
    expect(
      within(screen.getByRole('table', { name: r.overTime.topTable }))
        .getByRole('link')
        .getAttribute('href'),
    ).toBe('#/reports/rates?itemId=i1');
    const discounts = screen.getByRole('table', { name: r.overTime.bySalesman });
    expect(within(discounts).getByRole('link', { name: '1' }).getAttribute('href')).toBe(
      href.overridesReport,
    );
    fireEvent.change(screen.getByLabelText(r.overTime.measure), { target: { value: 'sales' } });
    expect(queryOf(window.location.hash).get('measure')).toBe('sales');
    expect(untranslated()).toEqual([]);
  });
});

describe('the Reports home', () => {
  it('lists the sales and purchase reports for anyone with reports.view', () => {
    show(<ReportsHomeScreen permissions={['reports.view']} />);
    for (const key of ['salesProfit', 'purchaseRegister', 'rates', 'salesOverTime'] as const)
      expect(screen.getByRole('link', { name: new RegExp(en.nav[key]) })).toBeDefined();
    expect(untranslated()).toEqual([]);
  });
});
