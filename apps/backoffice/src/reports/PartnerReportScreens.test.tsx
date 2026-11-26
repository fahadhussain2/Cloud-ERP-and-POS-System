import type {
  BalanceTrendView,
  CashFlowView,
  CollectionsView,
  OverdueView,
  OverLimitView,
  PartnerLedgerView,
  StatementsView,
  UserActivityView,
} from '@erp/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { href, parseHash, queryOf } from '../router';
import { PrintProvider } from './frame/ReportFrame';
import {
  BalanceTrendScreen,
  CashFlowScreen,
  CollectionsScreen,
  OverdueScreen,
  OverLimitScreen,
  PartnerLedgerScreen,
  StatementsScreen,
  UserActivityScreen,
} from './PartnerReportScreens';

// The customer, supplier and control reports and the cash flow on the frame (W2-04 plan): the ledger with its opening,
// running balance and words for the balance; the statement's heading, ageing and items; one statement a page; the
// trend's "before go-live"; overdue by days; limits not set yet; the register's two sides; what an edit changed; the
// cash flow's months; no string left untranslated.

const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
const plain = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');
const r = en.reports.partnerReports;

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
const untranslated = () => document.body.textContent?.match(/\b(reports|nav)\.[a-zA-Z][\w.-]*/g) ?? [];

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
});
afterEach(cleanup);

const HEADER = {
  name: 'Delux City Auto Corner',
  address: 'Shop 12, Main Road',
  phone: '021 1234567',
  lines: [],
};
const KHAN = {
  id: 'p1',
  code: 'KHAN',
  name: 'Khan Motors',
  address: 'Saddar',
  city: 'Karachi',
  phones: ['0300 1234567'],
  termsDays: 30,
  limit: 120000,
};
const AGEING = { balance: 110000, notDue: 0, days1to30: 110000, days31to60: 0, days61to90: 0, over90: 0 };

const LEDGER: PartnerLedgerView = {
  money: MONEY,
  role: 'customer',
  from: '2027-03-01',
  to: '2027-03-31',
  statement: false,
  header: HEADER,
  party: KHAN,
  opening: 240000,
  lines: [
    {
      date: '2027-03-05',
      dueDate: '2027-04-04',
      kind: 'sale',
      sourceId: 'b1',
      number: 'C01-S000012',
      memo: null,
      debit: 120000,
      credit: 0,
      balance: 360000,
      voided: false,
      items: [{ code: 'OIL001', name: 'ENGINE OIL 4L', qty: 1000, price: 120000, total: 120000 }],
    },
    {
      date: '2027-03-06',
      dueDate: '2027-03-06',
      kind: 'sales_void',
      sourceId: 'v1',
      number: 'C01-V000001',
      memo: null,
      debit: 0,
      credit: 0,
      balance: 360000,
      voided: true,
    },
    {
      date: '2027-03-20',
      dueDate: '2027-03-20',
      kind: 'customer_receipt',
      sourceId: 'cr1',
      number: 'CR-000004',
      memo: 'HBL',
      debit: 0,
      credit: 250000,
      balance: 110000,
      voided: false,
    },
  ],
  byKind: [
    { kind: 'customer_receipt', count: 1, debit: 0, credit: 250000 },
    { kind: 'sale', count: 1, debit: 120000, credit: 0 },
  ],
  debit: 120000,
  credit: 250000,
  closing: 110000,
  ageing: AGEING,
};

describe('the W2-04 report addresses', () => {
  it('open the eight new reports', () => {
    expect(parseHash(href.partnerLedger)).toEqual({ screen: 'partnerLedger' });
    expect(parseHash(href.statements)).toEqual({ screen: 'statements' });
    expect(parseHash(href.balanceTrend)).toEqual({ screen: 'balanceTrend' });
    expect(parseHash(href.overdue)).toEqual({ screen: 'overdue' });
    expect(parseHash(href.overLimit)).toEqual({ screen: 'overLimit' });
    expect(parseHash(href.collections)).toEqual({ screen: 'collections' });
    expect(parseHash(href.userActivity)).toEqual({ screen: 'userActivity' });
    expect(parseHash(href.cashFlow)).toEqual({ screen: 'cashFlow' });
  });
});

describe('the partner ledger and the statement', () => {
  it('asks for a party first', async () => {
    const { api, calls } = fakeApi({});
    show(<PartnerLedgerScreen api={api} />);
    expect(await screen.findByText(r.ledger.pick.customer)).toBeTruthy();
    expect(calls.some((c) => c.startsWith('/api/reports/partner-ledger'))).toBe(false);
    expect(untranslated()).toEqual([]);
  });

  it('shows the opening, each document with its running balance, the void marked, and who owes whom', async () => {
    window.location.hash = `${href.partnerLedger}?partyId=p1&from=2027-03-01&to=2027-03-31`;
    const { api, calls } = fakeApi({ 'GET /api/reports/partner-ledger': LEDGER });
    show(<PartnerLedgerScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.partnerLedger });
    expect(calls.find((c) => c.startsWith('/api/reports/partner-ledger'))).toContain(
      'role=customer&partyId=p1',
    );
    const rows = within(table).getAllByRole('row');
    expect(plain(rows[1]!.textContent)).toContain(r.kinds.sale);
    expect(within(rows[2]!).getByText(r.voided)).toBeTruthy();
    expect(within(table).getByRole('link', { name: 'C01-S000012' }).getAttribute('href')).toBe(
      href.bill('C01-S000012'),
    );
    const figures = plain(screen.getByLabelText(en.reports.frame.figures).textContent);
    expect(figures).toContain('2,400');
    expect(figures).toContain(r.balance.customer.owed);
    expect(screen.getByRole('table', { name: r.byKind })).toBeTruthy();
    expect(plain(screen.getByRole('table', { name: r.statement.ageing }).textContent)).toContain('1,100');
    // Not a statement: no shop heading.
    expect(screen.queryByText(HEADER.address)).toBeNull();
    expect(untranslated()).toEqual([]);
  });

  it("as a statement with items: the shop's heading, the customer, and each bill's items", async () => {
    window.location.hash = `${href.partnerLedger}?partyId=p1&statement=1&items=1&from=2027-03-01&to=2027-03-31`;
    const { api, calls } = fakeApi({ 'GET /api/reports/partner-ledger': { ...LEDGER, statement: true } });
    show(<PartnerLedgerScreen api={api} />);
    await screen.findByRole('table', { name: en.nav.partnerLedger });
    expect(calls.find((c) => c.startsWith('/api/reports/partner-ledger'))).toContain('statement=1&items=1');
    expect(screen.getByText(HEADER.address)).toBeTruthy();
    // The printed header, the page's title and the statement's own heading all name the customer.
    expect(screen.getAllByText('Khan Motors (KHAN)')).toHaveLength(3);
    expect(screen.getByText(/ENGINE OIL 4L/)).toBeTruthy();
    expect(untranslated()).toEqual([]);
  });

  it('switching to suppliers forgets the customer', async () => {
    window.location.hash = `${href.partnerLedger}?partyId=p1`;
    const { api } = fakeApi({ 'GET /api/reports/partner-ledger': LEDGER });
    show(<PartnerLedgerScreen api={api} />);
    await screen.findByRole('table', { name: en.nav.partnerLedger });
    fireEvent.change(screen.getByLabelText(r.role), { target: { value: 'supplier' } });
    const q = queryOf(window.location.hash);
    expect(q.get('role')).toBe('supplier');
    expect(q.get('partyId')).toBeNull();
  });
});

describe('statements for every customer', () => {
  it('prints one statement a page, each with its heading and ageing', async () => {
    const report: StatementsView = {
      money: MONEY,
      from: '2027-03-01',
      to: '2027-03-31',
      header: HEADER,
      statements: [{ ...LEDGER, party: { ...KHAN, id: 'p2', code: 'BUTT', name: 'Butt Autos' } }, LEDGER],
    };
    const { api } = fakeApi({ 'GET /api/reports/statements': report });
    show(<StatementsScreen api={api} />);
    const butt = await screen.findByRole('region', { name: 'Butt Autos' });
    const khan = screen.getByRole('region', { name: 'Khan Motors' });
    expect(khan.className).toContain('print:break-before-page');
    expect(within(butt).getByText(HEADER.address)).toBeTruthy();
    expect(within(khan).getByRole('table', { name: r.statement.ageing })).toBeTruthy();
    expect(plain(screen.getByLabelText(en.reports.frame.figures).textContent)).toContain('2,200');
    expect(untranslated()).toEqual([]);
  });
});

describe('the balance trend', () => {
  it('shows before go-live for dates the books have nothing for, and each name opens its ledger', async () => {
    const dates = ['2027-03-31', '2027-03-16', '2027-02-28', '2027-01-31', '2026-12-31', '2026-09-30'];
    const report: BalanceTrendView = {
      money: MONEY,
      role: 'customer',
      asOf: '2027-03-31',
      dates,
      since: '2027-01-01',
      rows: [
        {
          partyId: 'p1',
          code: 'KHAN',
          name: 'Khan Motors',
          balances: [110000, 160000, 360000, 240000, null, null],
          change: -250000,
        },
      ],
      totals: [110000, 160000, 360000, 240000, null, null],
      control: [110000, 160000, 360000, 240000, null, null],
    };
    const { api } = fakeApi({ 'GET /api/reports/balance-trend': report });
    show(<BalanceTrendScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.balanceTrend });
    expect(within(table).getAllByText(r.beforeGoLive).length).toBeGreaterThanOrEqual(2);
    expect(
      within(table)
        .getByRole('link', { name: /Khan Motors/ })
        .getAttribute('href'),
    ).toBe(`${href.partnerLedger}?role=customer&partyId=p1&from=2026-12-31&to=2027-03-31`);
    expect(screen.getByRole('img', { name: /Customers/ })).toBeTruthy();
    expect(untranslated()).toEqual([]);
  });
});

describe('overdue and over the limit', () => {
  it('lists the most overdue first, and puts the days in the address', async () => {
    const report: OverdueView = {
      money: MONEY,
      asOf: '2027-03-31',
      days: 30,
      rows: [
        {
          partyId: 'p2',
          code: 'BUTT',
          name: 'Butt Autos',
          phones: [],
          balance: 120000,
          overdue: 120000,
          oldestDate: '2027-02-14',
          oldestLate: 45,
          lastPayment: null,
          limit: null,
          termsDays: null,
        },
      ],
      totals: { balance: 120000, overdue: 120000 },
    };
    const { api } = fakeApi({ 'GET /api/reports/overdue': report });
    show(<OverdueScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.overdue });
    const row = plain(within(table).getAllByRole('row')[1]!.textContent);
    expect(row).toContain('45');
    expect(row).toContain(r.overdue.never);
    expect(row).toContain(r.noLimit);
    fireEvent.change(screen.getByLabelText(r.overdue.by), { target: { value: '0' } });
    expect(queryOf(window.location.hash).get('days')).toBe('0');
    expect(screen.getByRole('option', { name: r.overdue.more_zero })).toBeTruthy();
    expect(untranslated()).toEqual([]);
  });

  it('says when no customer has a limit yet', async () => {
    const report: OverLimitView = { money: MONEY, asOf: '2027-03-31', rows: [], withLimit: 0 };
    const { api } = fakeApi({ 'GET /api/reports/over-limit': report });
    show(<OverLimitScreen api={api} />);
    expect(await screen.findByText(new RegExp(r.limits.noneSet))).toBeTruthy();
    expect(screen.getByRole('link', { name: en.nav.customers }).getAttribute('href')).toBe(href.customers);
    expect(untranslated()).toEqual([]);
  });
});

describe('collections and payments', () => {
  it('shows each side with its totals by how and by whom', async () => {
    const report: CollectionsView = {
      money: MONEY,
      side: 'received',
      from: '2027-03-31',
      to: '2027-03-31',
      rows: [
        {
          date: '2027-03-31',
          kind: 'payment',
          sourceId: 'pm1',
          number: 'D01-R000001',
          partyId: 'p1',
          partyCode: 'KHAN',
          partyName: 'Khan Motors',
          how: 'Cash',
          counter: 'D01',
          by: 'Nadia',
          reference: null,
          amount: 50000,
        },
      ],
      byMethod: [{ name: 'Cash', count: 1, amount: 50000 }],
      byPerson: [{ name: 'Nadia', count: 1, amount: 50000 }],
      total: 50000,
    };
    const { api } = fakeApi({ 'GET /api/reports/collections': report });
    show(<CollectionsScreen api={api} />);
    await screen.findByRole('table', { name: r.register.title.received });
    expect(screen.getByRole('heading', { name: r.register.title.received })).toBeTruthy();
    expect(plain(screen.getByRole('table', { name: r.register.byPerson }).textContent)).toContain('Nadia');
    fireEvent.change(screen.getByLabelText(r.register.side), { target: { value: 'paid' } });
    expect(queryOf(window.location.hash).get('side')).toBe('paid');
    expect(untranslated()).toEqual([]);
  });
});

describe('user activity', () => {
  it("shows who did what, an edit's changed fields, and that the screen holds the newest only", async () => {
    const report: UserActivityView = {
      from: '2027-03-31',
      to: '2027-03-31',
      users: [{ id: 'u1', name: 'Tariq' }],
      rows: [
        {
          at: '2027-03-31T06:00:00.000Z',
          userId: 'u1',
          userName: 'Tariq',
          device: null,
          kind: 'items',
          action: 'update',
          entity: 'item_prices',
          entityId: 'ip1',
          label: null,
          changes: [{ field: 'price', before: 120000, after: 125000 }],
        },
        {
          at: '2027-03-31T05:00:00.000Z',
          userId: 'u1',
          userName: 'Tariq',
          device: 'C01',
          kind: 'sign_in',
          action: 'login.failed',
          entity: 'users',
          entityId: 'u1',
          label: null,
          changes: [],
        },
      ],
      count: 2500,
    };
    const { api } = fakeApi({ 'GET /api/reports/user-activity': report });
    show(<UserActivityScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.userActivity });
    expect(within(table).getByText('120000 → 125000', { exact: false })).toBeTruthy();
    expect(within(table).getByText(r.activity.records.item_prices)).toBeTruthy();
    expect(within(table).getByText(r.activity.actions.login.failed)).toBeTruthy();
    expect(within(table).getByText(r.backOffice)).toBeTruthy();
    expect(screen.getByText(/2,000|2000/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(r.kind), { target: { value: 'sign_in' } });
    expect(queryOf(window.location.hash).get('kind')).toBe('sign_in');
    expect(untranslated()).toEqual([]);
  });
});

describe('the cash flow', () => {
  it('shows each class by month, expenses by account, and each month opens the cash book', async () => {
    const report: CashFlowView = {
      money: MONEY,
      from: '2027-02-15',
      to: '2027-03-31',
      columns: [
        { from: '2027-02-15', to: '2027-02-28', opening: 1000000, net: 50000, closing: 1050000 },
        { from: '2027-03-01', to: '2027-03-31', opening: 1050000, net: -20000, closing: 1030000 },
      ],
      rows: [
        { cls: 'sales', account: null, amounts: [50000, 0], total: 50000 },
        {
          cls: 'expenses',
          account: { id: 'a1', code: '5100', name: 'Electricity' },
          amounts: [0, -20000],
          total: -20000,
        },
      ],
      total: { opening: 1000000, net: 30000, closing: 1030000 },
    };
    const { api } = fakeApi({ 'GET /api/reports/cash-flow': report });
    show(<CashFlowScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.cashFlow });
    expect(within(table).getByText(r.flow.classes.sales)).toBeTruthy();
    expect(within(table).getByText('5100 Electricity')).toBeTruthy();
    expect(within(table).getByRole('link', { name: '2027-03' }).getAttribute('href')).toBe(
      `${href.cashBook}?from=2027-03-01&to=2027-03-31`,
    );
    expect(plain(within(table).getAllByRole('row').at(-1)!.textContent)).toContain('10,300');
    expect(untranslated()).toEqual([]);
  });
});
