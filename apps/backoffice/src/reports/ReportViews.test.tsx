import type {
  AgeingView,
  BillTraceView,
  ExceptionsView,
  OverridesView,
  SalesRegisterView,
  StockView,
  VoidsReturnsView,
} from '@erp/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { href, parseHash, queryOf } from '../router';
import {
  AgeingScreen,
  ExceptionsScreen,
  OverridesScreen,
  SalesRegisterScreen,
  StockReportScreen,
  TraceScreen,
  VoidsReturnsScreen,
} from './ReportViews';

// The W1-20 report screens (D-110) over a fake API: the register's struck-through void, left out of the totals; the
// ageing buckets and their check against the control account; stock without cost.view; reviewing an exception; a
// bill's trace.

const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
const plain = (s: string) => s.replace(/\s/g, ' ');

function fakeApi(answers: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: Api = (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    // The shop's business date, where the report screens start (W2-05).
    if (key === 'GET /api/shop/today') return Promise.resolve({ status: 200, body: { today: '2026-11-19' } });
    return Promise.resolve(
      key in answers ? { status: 200, body: answers[key] } : { status: 404, body: null },
    );
  };
  return { api, calls };
}
const show = (ui: ReactElement) => render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
});
afterEach(cleanup);
const r = en.reports;
const calledWith = (calls: { path: string }[], prefix: string) =>
  calls.map((c) => c.path).filter((p) => p.startsWith(prefix));

describe('the report addresses', () => {
  it('open the report and support screens', () => {
    expect(parseHash(href.salesRegister)).toEqual({ screen: 'salesRegister' });
    expect(parseHash(href.ageing)).toEqual({ screen: 'ageing' });
    expect(parseHash(href.exceptions)).toEqual({ screen: 'exceptions' });
    expect(parseHash(href.trace('S-C1-000001'))).toEqual({ screen: 'trace', number: 'S-C1-000001' });
    expect(parseHash(href.trace())).toEqual({ screen: 'trace', number: null });
  });
});

describe('the sales register', () => {
  it('strikes the voided bill through and shows the totals the server counted without it', async () => {
    const view: SalesRegisterView = {
      money: MONEY,
      from: '2026-11-10',
      to: '2026-11-10',
      bills: [
        {
          id: 'b1',
          number: 'S-C1-000001',
          kind: 'sale',
          status: 'finalized',
          businessDate: '2026-11-10',
          createdAt: '2026-11-10T06:00:00.000Z',
          deviceCode: 'C1',
          salespersonName: 'Sara',
          customerName: null,
          total: 240000,
          payments: [{ methodCode: 'cash', methodName: 'Cash', amount: 240000 }],
          voidNumber: null,
          voidReason: null,
        },
        {
          id: 'b2',
          number: 'S-C1-000002',
          kind: 'sale',
          status: 'voided',
          businessDate: '2026-11-10',
          createdAt: '2026-11-10T06:10:00.000Z',
          deviceCode: 'C1',
          salespersonName: 'Sara',
          customerName: null,
          total: 360000,
          payments: [{ methodCode: 'cash', methodName: 'Cash', amount: 360000 }],
          voidNumber: 'V-C1-000001',
          voidReason: 'wrong_price',
        },
      ],
      totals: {
        bills: 1,
        voided: 1,
        total: 240000,
        bySalesperson: [{ id: 'u1', name: 'Sara', bills: 1, total: 240000 }],
        byCounter: [{ code: 'C1', bills: 1, total: 240000 }],
        byTender: [{ code: 'cash', name: 'Cash', amount: 240000 }],
      },
    };
    show(<SalesRegisterScreen api={fakeApi({ 'GET /api/reports/sales-register': view }).api} />);
    const list = await screen.findByRole('table', { name: r.register.list });
    const voided = within(list).getByText('S-C1-000002');
    expect(voided.closest('.line-through')).toBeTruthy();
    expect(within(list).getByText('Voided V-C1-000001')).toBeTruthy();
    expect(screen.getByRole('link', { name: r.csv }).getAttribute('href')).toContain('format=csv');
    // The key figures are the server's, the voided bill left out (W2-04 answer 8: no figure moves).
    const figures = screen.getByRole('region', { name: r.frame.figures });
    expect(plain(figures.textContent ?? '')).toMatch(/Bills1Net salesRs 2,400Voided1/);
    // No support.trace: the numbers are plain text.
    expect(within(list).queryByRole('link')).toBeNull();
  });

  it("opens a bill's trace for someone who may trace, and narrows the bills by a search", async () => {
    const view: SalesRegisterView = {
      money: MONEY,
      from: '2026-11-19',
      to: '2026-11-19',
      bills: ['S-C1-000001', 'S-C2-000009'].map((number, i) => ({
        id: `b${i}`,
        number,
        kind: 'sale' as const,
        status: 'finalized' as const,
        businessDate: '2026-11-19',
        createdAt: '2026-11-19T06:00:00.000Z',
        deviceCode: i === 0 ? 'C1' : 'C2',
        salespersonName: i === 0 ? 'Sara' : 'Bilal',
        customerName: null,
        total: 1000,
        payments: [],
        voidNumber: null,
        voidReason: null,
      })),
      totals: { bills: 2, voided: 0, total: 2000, bySalesperson: [], byCounter: [], byTender: [] },
    };
    show(
      <SalesRegisterScreen
        api={fakeApi({ 'GET /api/reports/sales-register': view }).api}
        permissions={['reports.view', 'support.trace']}
      />,
    );
    const list = await screen.findByRole('table', { name: r.register.list });
    expect(within(list).getByRole('link', { name: 'S-C1-000001' }).getAttribute('href')).toBe(
      href.trace('S-C1-000001'),
    );
    fireEvent.change(screen.getByLabelText(r.frame.search), { target: { value: 'bilal' } });
    expect(within(list).queryByText('S-C1-000001')).toBeNull();
    expect(within(list).getByText('S-C2-000009')).toBeTruthy();
  });
});

describe('overrides', () => {
  it('lists each approval with its prices, a dash for the floor without cost, and the counts by kind', async () => {
    const view: OverridesView = {
      money: MONEY,
      from: '2026-11-19',
      to: '2026-11-19',
      overrides: [
        {
          id: 'o1',
          kind: 'below_list',
          billNumber: 'S-C1-000003',
          businessDate: '2026-11-19',
          at: '2026-11-19T07:00:00.000Z',
          itemCode: 'OIL001',
          itemName: 'ENGINE OIL 4L',
          requestedByName: 'Sara',
          approvedByName: 'Imran',
          reasonCode: 'regular',
          note: 'old customer',
          listPrice: 300000,
          unitPrice: 280000,
          floorPrice: null,
        },
      ],
      byRequester: [{ name: 'Sara', count: 1 }],
      byApprover: [{ name: 'Imran', count: 1 }],
      byKind: [{ kind: 'below_list', count: 1 }],
    };
    const f = fakeApi({ 'GET /api/reports/overrides': view });
    show(<OverridesScreen api={f.api} />);
    const list = await screen.findByRole('table', { name: r.ovr.list });
    expect(calledWith(f.calls, '/api/reports/overrides')).toEqual([
      '/api/reports/overrides?from=2026-11-19&to=2026-11-19',
    ]);
    const row = within(list).getAllByRole('row')[1]!;
    expect(plain(row.textContent ?? '')).toContain('regular: old customer');
    expect(plain(row.textContent ?? '')).toMatch(/Rs 3,000.*Rs 2,800.*—$/);
    const byKind = screen.getByRole('table', { name: r.ovr.byKind });
    expect(plain(byKind.textContent ?? '')).toContain(`${r.ovr.kinds.below_list}1`);
  });
});

describe('voids and returns', () => {
  it('lists the voids with the bill issued in their place, and two equal returned lines both', async () => {
    const line = {
      billNumber: 'R-C1-000002',
      businessDate: '2026-11-19',
      salespersonName: 'Sara',
      itemCode: 'OIL001',
      itemName: 'ENGINE OIL 4L',
      qty: 1000,
      amount: 300000,
      reasonCode: 'wrong_item',
      condition: 'resellable' as const,
      originalBillNumber: null,
    };
    const view: VoidsReturnsView = {
      money: MONEY,
      from: '2026-11-19',
      to: '2026-11-19',
      voids: [
        {
          number: 'V-C1-000001',
          saleNumber: 'S-C1-000004',
          businessDate: '2026-11-19',
          at: '2026-11-19T08:00:00.000Z',
          reasonCode: 'wrong_price',
          note: null,
          voidedByName: 'Sara',
          approvedByName: 'Imran',
          saleTotal: 450000,
          reissueNumber: 'S-C1-000005',
        },
      ],
      returns: [line, line],
      voidsByReason: [{ reason: 'wrong_price', count: 1 }],
      returnsByReason: [{ reason: 'wrong_item', count: 2, amount: 600000 }],
      returnsByCondition: [{ condition: 'resellable', count: 2, amount: 600000 }],
    };
    show(<VoidsReturnsScreen api={fakeApi({ 'GET /api/reports/voids-returns': view }).api} />);
    const voids = await screen.findByRole('table', { name: r.vr.voids });
    expect(plain(within(voids).getAllByRole('row')[1]!.textContent ?? '')).toMatch(
      /V-C1-000001S-C1-000004wrong_priceSaraImranS-C1-000005Rs 4,500/,
    );
    const returns = screen.getByRole('table', { name: r.vr.returns });
    expect(within(returns).getAllByText(r.vr.noReceipt)).toHaveLength(2);
    const byCondition = screen.getByRole('table', { name: r.vr.returnsByCondition });
    expect(plain(byCondition.textContent ?? '')).toContain(`${r.vr.condition.resellable}2Rs 6,000`);
  });
});

describe('ageing', () => {
  it('shows the five buckets and says the total equals Accounts receivable', async () => {
    const view: AgeingView = {
      money: MONEY,
      side: 'customers',
      asOf: '2026-11-10',
      rows: [
        {
          partyId: 'p1',
          code: 'C0077',
          name: 'Rehman Autos',
          termsDays: 30,
          balance: 150000,
          notDue: 50000,
          days1to30: 0,
          days31to60: 0,
          days61to90: 0,
          over90: 100000,
        },
      ],
      totals: { balance: 150000, notDue: 50000, days1to30: 0, days31to60: 0, days61to90: 0, over90: 100000 },
      controlBalance: 150000,
    };
    show(<AgeingScreen api={fakeApi({ 'GET /api/reports/ageing': view }).api} />);
    const table = await screen.findByRole('table', { name: r.ageing.customers });
    for (const b of Object.values(r.ageing.buckets)) expect(within(table).getByText(b)).toBeTruthy();
    expect(plain(screen.getByText(/^Equals Accounts receivable/).textContent ?? '')).toMatch(/Rs 1,500/);
  });
});

describe('stock', () => {
  const view: StockView = {
    money: MONEY,
    values: false,
    rows: [
      {
        itemId: 'i1',
        itemCode: 'OIL001',
        itemName: 'ENGINE OIL 4L',
        categoryName: 'Oil',
        locationCode: 'SHOP',
        qty: 8000,
        avgCost: null,
        value: null,
      },
    ],
    truncated: false,
    byLocation: [{ code: 'SHOP', name: 'Shop', qty: 8000, value: null }],
    byCategory: [{ name: 'Oil', qty: 8000, value: null }],
    total: { qty: 8000, value: null },
    noCost: 0,
  };
  it('shows quantities only when the server sends no values (no cost.view)', async () => {
    show(<StockReportScreen api={fakeApi({ 'GET /api/reports/stock': view }).api} />);
    const list = await screen.findByRole('table', { name: r.stock.list });
    expect(within(list).queryByText(r.stock.value)).toBeNull();
    expect(within(list).getByText('8')).toBeTruthy();
  });

  it('searches the server once typing stops and keeps the search and "below zero" in the address', async () => {
    window.location.hash = href.stockReport;
    const f = fakeApi({ 'GET /api/reports/stock': view });
    show(<StockReportScreen api={f.api} />);
    await screen.findByRole('table', { name: r.stock.list });
    expect(calledWith(f.calls, '/api/reports/stock')).toEqual(['/api/reports/stock?q=']);
    fireEvent.change(screen.getByLabelText(r.stock.search), { target: { value: 'oil 4l ' } });
    await waitFor(() =>
      expect(calledWith(f.calls, '/api/reports/stock')).toContain('/api/reports/stock?q=oil+4l'),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: r.stock.below }));
    await waitFor(() =>
      expect(calledWith(f.calls, '/api/reports/stock')).toContain('/api/reports/stock?q=oil+4l&below=1'),
    );
    expect(Object.fromEntries(queryOf(window.location.hash))).toEqual({ q: 'oil 4l', below: '1' });
    // Typing that stops before the wait sends nothing in between.
    expect(calledWith(f.calls, '/api/reports/stock')).toHaveLength(3);
  });
});

describe('exceptions', () => {
  const view: ExceptionsView = {
    from: '2026-11-10',
    to: '2026-11-10',
    exceptions: [
      {
        id: 'e1',
        kind: 'negative_stock',
        severity: 'high',
        businessDate: '2026-11-10',
        createdAt: '2026-11-10T06:00:00.000Z',
        deviceCode: 'C1',
        userName: null,
        documentType: 'sale',
        documentNumber: 'S-C1-000001',
        details: { item: 'OIL001' },
        status: 'open',
        reviewedByName: null,
        reviewedAt: null,
        reviewNote: null,
      },
    ],
    byKind: [{ kind: 'negative_stock', open: 1, total: 1 }],
  };

  it('a manager marks one reviewed with a note', async () => {
    const f = fakeApi({ 'GET /api/reports/exceptions': view, 'POST /api/reports/exceptions/e1/review': {} });
    show(<ExceptionsScreen api={f.api} permissions={['reports.view', 'exceptions.review']} />);
    expect(await screen.findByText(r.exc.kinds.negative_stock)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: r.exc.review }));
    fireEvent.change(screen.getByLabelText(r.exc.note), { target: { value: 'Counted: 8 on the shelf' } });
    fireEvent.click(screen.getByRole('button', { name: r.exc.save }));
    await waitFor(() =>
      expect(f.calls.find((c) => c.method === 'POST')?.body).toEqual({
        status: 'reviewed',
        note: 'Counted: 8 on the shelf',
      }),
    );
  });

  it('offers no review without exceptions.review', async () => {
    show(
      <ExceptionsScreen
        api={fakeApi({ 'GET /api/reports/exceptions': view }).api}
        permissions={['reports.view']}
      />,
    );
    expect(await screen.findByText(r.exc.kinds.negative_stock)).toBeTruthy();
    expect(screen.queryByRole('button', { name: r.exc.review })).toBeNull();
  });
});

describe('Trace a bill', () => {
  it("lists the bill's steps in words", async () => {
    const trace: BillTraceView = {
      money: MONEY,
      bill: {
        id: 'b1',
        number: 'S-C1-000001',
        kind: 'sale',
        status: 'finalized',
        businessDate: '2026-11-10',
        total: 240000,
        deviceCode: 'C1',
        salespersonName: 'Sara',
        handoverStatus: 'received',
      },
      steps: [
        {
          at: '2026-11-10T06:00:00.000Z',
          step: 'created',
          source: 'counter',
          detail: { device: 'C1', salesman: 'Sara', total: 240000 },
        },
        { at: '2026-11-10T06:00:05.000Z', step: 'posted', source: 'books', detail: { journal: 'J000001' } },
      ],
    };
    show(
      <TraceScreen api={fakeApi({ 'GET /api/support/bills/S-C1-000001': trace }).api} number="S-C1-000001" />,
    );
    expect(await screen.findByText('Posted to the books: J000001')).toBeTruthy();
    expect(plain(screen.getByText(/^Made on C1 by Sara/).textContent ?? '')).toMatch(/Rs 2,400/);
  });

  it('says when no such bill is here', async () => {
    show(<TraceScreen api={fakeApi({}).api} number="S-X" />);
    expect(await screen.findByText('No bill S-X in this shop.')).toBeTruthy();
  });
});

// W2-04 answer 8: the W1 reports on the frame keep a preset in the address and remember it, but never two dates, so
// they open on the shop's business date again (D-117).
describe('the dates of a W1 report on the frame', () => {
  it('remember a preset, worked out on the business date, and forget two dates', async () => {
    window.location.hash = href.salesRegister;
    const f = fakeApi({});
    show(<SalesRegisterScreen api={f.api} />);
    await waitFor(() =>
      expect(calledWith(f.calls, '/api/reports/sales-register')).toEqual([
        '/api/reports/sales-register?from=2026-11-19&to=2026-11-19',
      ]),
    );
    fireEvent.change(screen.getByLabelText(r.frame.period), { target: { value: 'weekToToday' } });
    expect(Object.fromEntries(queryOf(window.location.hash))).toEqual({ preset: 'weekToToday' });
    await waitFor(() =>
      expect(calledWith(f.calls, '/api/reports/sales-register')).toContain(
        '/api/reports/sales-register?from=2026-11-12&to=2026-11-19',
      ),
    );
    cleanup();

    window.location.hash = href.salesRegister;
    const again = fakeApi({});
    show(<SalesRegisterScreen api={again.api} />);
    await waitFor(() =>
      expect(calledWith(again.calls, '/api/reports/sales-register')).toEqual([
        '/api/reports/sales-register?from=2026-11-12&to=2026-11-19',
      ]),
    );
    fireEvent.change(screen.getByLabelText(r.frame.from), { target: { value: '2026-11-01' } });
    expect(Object.fromEntries(queryOf(window.location.hash))).toEqual({
      from: '2026-11-01',
      to: '2026-11-19',
    });
    cleanup();

    // Two dates stay in the address (a shared link), but the report opens on the business date again.
    window.location.hash = href.salesRegister;
    const third = fakeApi({});
    show(<SalesRegisterScreen api={third.api} />);
    await waitFor(() =>
      expect(calledWith(third.calls, '/api/reports/sales-register')).toEqual([
        '/api/reports/sales-register?from=2026-11-19&to=2026-11-19',
      ]),
    );
  });
});

// W2-05: the dates a report starts on come from the shop's business date (the API), not this browser's calendar.
// The browser's clock is set days away from the shop's day (19 November), so the test holds anywhere.
describe("the shop's business date (W2-05)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('a register opens on it, and the ageing is as on it', async () => {
    const register = fakeApi({});
    show(<SalesRegisterScreen api={register.api} />);
    await waitFor(() =>
      expect(register.calls.map((c) => c.path)).toContain(
        '/api/reports/sales-register?from=2026-11-19&to=2026-11-19',
      ),
    );
    cleanup();
    const ageing = fakeApi({});
    show(<AgeingScreen api={ageing.api} />);
    await waitFor(() =>
      expect(ageing.calls.map((c) => c.path)).toContain('/api/reports/ageing?side=customers&asOf=2026-11-19'),
    );
  });
});
