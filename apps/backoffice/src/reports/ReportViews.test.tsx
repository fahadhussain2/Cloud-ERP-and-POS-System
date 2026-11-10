import type { AgeingView, BillTraceView, ExceptionsView, SalesRegisterView, StockView } from '@erp/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { href, parseHash } from '../router';
import {
  AgeingScreen,
  ExceptionsScreen,
  SalesRegisterScreen,
  StockReportScreen,
  TraceScreen,
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
    return Promise.resolve(
      key in answers ? { status: 200, body: answers[key] } : { status: 404, body: null },
    );
  };
  return { api, calls };
}
const show = (ui: ReactElement) => render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
afterEach(cleanup);
const r = en.reports;

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
    expect(voided.className).toContain('line-through');
    expect(within(list).getByText('Voided V-C1-000001')).toBeTruthy();
    expect(screen.getByRole('link', { name: r.csv }).getAttribute('href')).toContain('format=csv');
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
  it('shows quantities only when the server sends no values (no cost.view)', async () => {
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
    show(<StockReportScreen api={fakeApi({ 'GET /api/reports/stock': view }).api} />);
    const list = await screen.findByRole('table', { name: r.stock.list });
    expect(within(list).queryByText(r.stock.value)).toBeNull();
    expect(within(list).getByText('8')).toBeTruthy();
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
