import type {
  BalanceSheetView,
  CashBookView,
  DayBookView,
  ExpensesView,
  ProfitLossView,
  TrialBalanceView,
} from '@erp/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { href, parseHash, queryOf } from '../router';
import {
  BalanceSheetScreen,
  CashBookScreen,
  DayBookScreen,
  ExpensesScreen,
  ProfitLossScreen,
  ReportsHomeScreen,
  TrialBalanceScreen,
} from './FinancialScreens';
import { PrintProvider } from './frame/ReportFrame';

// The report frame and the financial statements (W2-01 plan): presets and dates in the address, the filters
// remembered, sorting and search, group subtotals, drill-down links that carry the period, the print header, and no
// string left untranslated.

const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
const plain = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');

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
/** i18next shows the key itself for a missing string: none may be left on the screen. */
const untranslated = () =>
  document.body.textContent?.match(/\b(reports|nav|accounting)\.[a-zA-Z][\w.-]*/g) ?? [];

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
});
afterEach(cleanup);

const r = en.reports;

const TB: TrialBalanceView = {
  money: MONEY,
  from: '2027-11-01',
  to: '2027-11-30',
  level: 'accounts',
  showEmpty: false,
  rows: [
    {
      id: 'g1',
      code: '1000',
      name: 'Assets',
      depth: 0,
      group: true,
      opening: { debit: 500000, credit: 0 },
      movement: { debit: 120000, credit: 20000 },
      closing: { debit: 600000, credit: 0 },
    },
    {
      id: 'a1',
      code: '1110',
      name: 'Cash drawer',
      depth: 1,
      group: false,
      opening: { debit: 500000, credit: 0 },
      movement: { debit: 120000, credit: 20000 },
      closing: { debit: 600000, credit: 0 },
    },
    {
      id: 'a2',
      code: '4100',
      name: 'Sales',
      depth: 0,
      group: false,
      opening: { debit: 0, credit: 500000 },
      movement: { debit: 20000, credit: 120000 },
      closing: { debit: 0, credit: 600000 },
    },
  ],
  totals: {
    opening: { debit: 500000, credit: 500000 },
    movement: { debit: 140000, credit: 140000 },
    closing: { debit: 600000, credit: 600000 },
  },
  balanced: true,
};

describe('the report addresses', () => {
  it('open the Reports home and the six statements, with their filters after a ?', () => {
    expect(parseHash(href.reports)).toEqual({ screen: 'reportsHome' });
    expect(parseHash(`${href.trialBalance}?preset=lastMonth`)).toEqual({ screen: 'trialBalance' });
    expect(parseHash(href.profitLoss)).toEqual({ screen: 'profitLoss' });
    expect(parseHash(href.balanceSheet)).toEqual({ screen: 'balanceSheet' });
    expect(parseHash(href.cashBook)).toEqual({ screen: 'cashBook' });
    expect(parseHash(href.dayBook)).toEqual({ screen: 'dayBook' });
    expect(parseHash(href.expensesReport)).toEqual({ screen: 'expensesReport' });
    expect(parseHash('#/accounting/accounts/a1?from=2027-11-01&to=2027-11-30')).toEqual({
      screen: 'ledger',
      id: 'a1',
    });
  });
});

describe('the trial balance on the frame', () => {
  it('shows groups with their subtotals, the totals, and that it balances; an account opens its ledger for the period', async () => {
    window.location.hash = href.trialBalance;
    const { api, calls } = fakeApi({ 'GET /api/reports/trial-balance': TB });
    show(<TrialBalanceScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.trialBalance });
    expect(calls[0]).toBe('/api/reports/trial-balance?preset=thisMonth&level=accounts&empty=hide');
    const rows = within(table).getAllByRole('row');
    expect(rows[1]!.getAttribute('data-kind')).toBe('group');
    expect(plain(rows[1]!.textContent)).toContain('Assets');
    expect(rows.at(-1)!.getAttribute('data-kind')).toBe('total');
    expect(plain(rows.at(-1)!.textContent)).toContain('6,000');
    expect(within(table).getByRole('link', { name: 'Cash drawer' }).getAttribute('href')).toBe(
      '#/accounting/accounts/a1?from=2027-11-01&to=2027-11-30',
    );
    expect(screen.getByText(r.tb.balanced)).toBeDefined();
    expect(screen.getByRole('link', { name: r.csv }).getAttribute('href')).toBe(`${calls[0]}&format=csv`);
    expect(untranslated()).toEqual([]);
  });

  it('puts a preset in the address, then two dates, and remembers them for next time', async () => {
    window.location.hash = href.trialBalance;
    const { api } = fakeApi({ 'GET /api/reports/trial-balance': TB });
    show(<TrialBalanceScreen api={api} />);
    await screen.findByRole('table', { name: en.nav.trialBalance });
    fireEvent.change(screen.getByLabelText(r.frame.period), { target: { value: 'lastMonth' } });
    expect(Object.fromEntries(queryOf(window.location.hash))).toEqual({
      preset: 'lastMonth',
      level: 'accounts',
    });
    fireEvent.change(screen.getByLabelText(r.frame.from), { target: { value: '2027-10-15' } });
    expect(Object.fromEntries(queryOf(window.location.hash))).toMatchObject({
      from: '2027-10-15',
      to: '2027-11-30',
    });
    cleanup();

    // Opened again with nothing in its address: the last filters come back.
    window.location.hash = href.trialBalance;
    const again = fakeApi({ 'GET /api/reports/trial-balance': TB });
    show(<TrialBalanceScreen api={again.api} />);
    await screen.findByRole('table', { name: en.nav.trialBalance });
    expect(again.calls[0]).toContain('from=2027-10-15');
  });

  it('narrows the list by a search, and prints a header with the shop, the report and its period', async () => {
    window.location.hash = href.trialBalance;
    const { api } = fakeApi({ 'GET /api/reports/trial-balance': TB });
    show(<TrialBalanceScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.trialBalance });
    fireEvent.change(screen.getByRole('searchbox', { name: r.frame.search }), { target: { value: 'sales' } });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    const header = document.querySelector('[data-slot="print-header"]')!;
    expect(plain(header.textContent)).toContain('Delux City Auto Corner');
    expect(plain(header.textContent)).toContain(en.nav.trialBalance);
    expect(plain(header.textContent)).toContain('2027-11-01 – 2027-11-30');
    expect(plain(header.textContent)).toContain('Alia');
  });

  it('explains a range that is too long', async () => {
    window.location.hash = `${href.trialBalance}?from=2026-01-01&to=2027-12-31`;
    const api: Api = () => Promise.resolve({ status: 400, body: { error: 'range_too_long' } });
    show(<TrialBalanceScreen api={api} />);
    expect(await screen.findByText(r.frame.tooLong)).toBeDefined();
  });
});

const section = (rows: { id: string; code: string; name: string; amounts: number[] }[], total: number[]) => ({
  rows: rows.map((x) => ({ ...x, depth: 0, group: false, role: null })),
  total,
});

describe('the profit and loss', () => {
  it('against the period before: the change in rupees and %, margins, and the stock and purchases panel', async () => {
    window.location.hash = href.profitLoss;
    const view: ProfitLossView = {
      money: MONEY,
      from: '2027-11-01',
      to: '2027-11-30',
      compare: 'previous',
      periods: [
        { from: '2027-11-01', to: '2027-11-30' },
        { from: '2027-10-01', to: '2027-10-31' },
      ],
      revenue: section(
        [{ id: 's', code: '4100', name: 'Sales', amounts: [170000, 100000] }],
        [170000, 100000],
      ),
      costOfSales: section(
        [{ id: 'c', code: '5100', name: 'Cost of goods sold', amounts: [114000, 70000] }],
        [114000, 70000],
      ),
      grossProfit: [56000, 30000],
      grossMargin: [3294, 3000],
      expenses: section(
        [{ id: 'e', code: '6100', name: 'Salaries', amounts: [30000, 32000] }],
        [30000, 32000],
      ),
      netProfit: [26000, -2000],
      netMargin: [1529, -200],
      stock: {
        opening: 300000,
        purchases: 0,
        purchaseReturns: 0,
        adjustments: 0,
        other: 0,
        closing: 186000,
        stockUsed: 114000,
        costOfGoodsSold: 114000,
        difference: 0,
      },
    };
    const { api } = fakeApi({ 'GET /api/reports/profit-loss': view });
    show(<ProfitLossScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.profitLoss });
    const net = within(table)
      .getAllByRole('row')
      .find((row) => row.textContent?.startsWith(r.pl.netProfit))!;
    expect(plain(net.textContent)).toContain('280'); // 260 − (−20)
    expect(plain(net.textContent)).toContain('1,400.0%');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toContain(r.pl.changePct);
    expect(screen.getByRole('table', { name: r.pl.stock.title })).toBeDefined();
    expect(screen.queryByText(r.pl.stock.difference)).toBeNull();
    expect(within(table).getByRole('link', { name: 'Sales' }).getAttribute('href')).toBe(
      '#/accounting/accounts/s?from=2027-11-01&to=2027-11-30',
    );
    fireEvent.change(screen.getByLabelText(r.pl.compare), { target: { value: 'months' } });
    expect(Object.fromEntries(queryOf(window.location.hash))).toEqual({
      preset: 'thisMonth',
      compare: 'months',
    });
    expect(untranslated()).toEqual([]);
  });
});

describe('the balance sheet', () => {
  it('balances against the end of last month, with the profit for the year in equity', async () => {
    window.location.hash = href.balanceSheet;
    const view: BalanceSheetView = {
      money: MONEY,
      at: '2027-11-30',
      compareAt: '2027-10-31',
      columns: [{ at: '2027-11-30' }, { at: '2027-10-31' }],
      assets: section(
        [{ id: 'a', code: '1110', name: 'Cash drawer', amounts: [476000, 550000] }],
        [476000, 550000],
      ),
      liabilities: section(
        [{ id: 'l', code: '2100', name: 'Suppliers', amounts: [50000, 150000] }],
        [50000, 150000],
      ),
      equity: section(
        [{ id: 'q', code: '3300', name: 'Opening balance equity', amounts: [400000, 400000] }],
        [426000, 400000],
      ),
      profitForYear: [26000, 0],
      earlierProfit: [0, 0],
      earlierInRetained: true,
      liabilitiesAndEquity: [476000, 550000],
      difference: [0, 0],
    };
    const { api, calls } = fakeApi({ 'GET /api/reports/balance-sheet': view });
    show(<BalanceSheetScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.balanceSheet });
    expect(calls[0]).toBe('/api/reports/balance-sheet');
    expect(screen.getByRole('link', { name: r.csv }).getAttribute('href')).toBe(
      '/api/reports/balance-sheet?format=csv',
    );
    expect(within(table).getByText(r.bs.profitForYear)).toBeDefined();
    expect(within(table).queryByText(r.bs.difference)).toBeNull();
    expect(screen.getAllByText(r.tb.balanced).length).toBeGreaterThan(0);
    expect(untranslated()).toEqual([]);
  });
});

describe('the cash book, the day book and the expenses', () => {
  it('cash book: each account with its days and lines; a transfer is marked; a line opens its document', async () => {
    window.location.hash = href.cashBook;
    const view: CashBookView = {
      money: MONEY,
      from: '2027-11-01',
      to: '2027-11-03',
      accountId: null,
      choices: [{ id: 'd', code: '1110', name: 'Cash drawer' }],
      accounts: [
        {
          id: 'd',
          code: '1110',
          name: 'Cash drawer',
          opening: 1000,
          in: 500,
          out: 300,
          closing: 1200,
          days: [
            { date: '2027-11-01', opening: 1000, in: 500, out: 200, closing: 1300 },
            { date: '2027-11-03', opening: 1300, in: 0, out: 100, closing: 1200 },
          ],
          lines: [
            {
              date: '2027-11-01',
              journalNumber: 'J000001',
              sourceType: 'cash_handover',
              sourceId: 'h1',
              number: 'H-D1-000001',
              memo: 'H-D1-000001 handover',
              partyName: null,
              debit: 500,
              credit: 0,
              balance: 1500,
              transfer: true,
            },
            {
              date: '2027-11-03',
              journalNumber: 'J000002',
              sourceType: 'expense',
              sourceId: 'x1',
              number: 'EX000001',
              memo: 'EX000001 tea',
              partyName: null,
              debit: 0,
              credit: 100,
              balance: 1400,
              transfer: false,
            },
          ],
          truncated: false,
        },
      ],
    };
    const { api } = fakeApi({ 'GET /api/reports/cash-book': view });
    show(<CashBookScreen api={api} />);
    const lines = await screen.findByRole('table', { name: '1110 Cash drawer' });
    expect(within(lines).getByText(r.cash.transfer)).toBeDefined();
    expect(within(lines).getByRole('link', { name: 'EX000001' }).getAttribute('href')).toBe(
      href.accountingDocument('expense', 'x1'),
    );
    expect(
      screen.getByRole('table', { name: r.cash.days.replace('{{account}}', '1110 Cash drawer') }),
    ).toBeDefined();
    expect(untranslated()).toEqual([]);
  });

  it('day book: entries with their lines, sortable by amount, a reversal marked; filtered by type', async () => {
    window.location.hash = href.dayBook;
    const entry = (
      id: string,
      n: string,
      amount: number,
      reversal: boolean,
    ): DayBookView['entries'][number] => ({
      id,
      date: '2027-11-08',
      journalNumber: n,
      sourceType: 'journal_voucher',
      sourceId: `v${id}`,
      number: `JV${id}`,
      memo: `JV${id}`,
      reversal,
      debit: amount,
      credit: amount,
      lines: [
        {
          accountId: 'a',
          accountCode: '6100',
          accountName: 'Salaries',
          partyName: null,
          debit: amount,
          credit: 0,
          memo: null,
        },
        {
          accountId: 'b',
          accountCode: '1150',
          accountName: 'Bank',
          partyName: null,
          debit: 0,
          credit: amount,
          memo: null,
        },
      ],
    });
    const view: DayBookView = {
      money: MONEY,
      from: '2027-11-08',
      to: '2027-11-08',
      type: null,
      entries: [entry('1', 'J000001', 7000, true), entry('2', 'J000002', 3000, false)],
      totals: { entries: 2, debit: 10000, credit: 10000 },
      truncated: false,
    };
    const { api } = fakeApi({ 'GET /api/reports/day-book': view });
    show(<DayBookScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.dayBook });
    expect(within(table).getAllByText(r.dayBook.reversal)).toHaveLength(1);
    expect(within(table).getAllByText('Salaries')).toHaveLength(2);
    const journals = () =>
      within(table)
        .getAllByText(/^J00000\d$/)
        .map((x) => x.textContent);
    expect(journals()).toEqual(['J000001', 'J000002']);
    fireEvent.click(within(table).getByRole('button', { name: r.dayBook.amount }));
    expect(journals()).toEqual(['J000002', 'J000001']);
    fireEvent.change(screen.getByLabelText(r.dayBook.type), { target: { value: 'expense' } });
    expect(queryOf(window.location.hash).get('type')).toBe('expense');
    expect(untranslated()).toEqual([]);
  });

  it('expenses: each account month by month with its total', async () => {
    window.location.hash = href.expensesReport;
    const view: ExpensesView = {
      money: MONEY,
      from: '2027-10-01',
      to: '2027-11-30',
      months: [
        { from: '2027-10-01', to: '2027-10-31' },
        { from: '2027-11-01', to: '2027-11-30' },
      ],
      rows: [
        {
          id: 'e',
          code: '6100',
          name: 'Salaries',
          depth: 0,
          group: false,
          role: null,
          amounts: [30000, 32000, 62000],
        },
      ],
      total: [30000, 32000, 62000],
    };
    const { api, calls } = fakeApi({ 'GET /api/reports/expenses': view });
    show(<ExpensesScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.expensesReport });
    expect(calls[0]).toBe('/api/reports/expenses?preset=thisYear');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([r.frame.account, '2027-10', '2027-11', r.expenses.total]);
    expect(untranslated()).toEqual([]);
  });
});

describe('the Reports home', () => {
  it('lists the reports this person may open, by section; the search narrows them', async () => {
    show(<ReportsHomeScreen permissions={['reports.view']} badges={{ reports: 2 }} />);
    expect(screen.queryByText(r.home.sections.accounts)).toBeNull();
    expect(screen.getByRole('link', { name: new RegExp(en.nav.salesRegister) }).getAttribute('href')).toBe(
      href.salesRegister,
    );
    expect(
      within(screen.getByRole('link', { name: new RegExp(en.nav.exceptions) })).getByText(/2/),
    ).toBeDefined();
    fireEvent.change(screen.getByRole('searchbox', { name: r.home.search }), { target: { value: 'ageing' } });
    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(1));
    expect(untranslated()).toEqual([]);
  });

  it('shows the financial statements to the accountant', () => {
    show(<ReportsHomeScreen permissions={['reports.financial']} />);
    expect(screen.getByText(r.home.sections.accounts)).toBeDefined();
    expect(screen.getByRole('link', { name: new RegExp(en.nav.trialBalance) }).getAttribute('href')).toBe(
      href.trialBalance,
    );
    expect(screen.queryByText(r.home.sections.sales)).toBeNull();
  });
});
