import type { CashVarianceResponse, DayReconciliationResponse } from '@erp/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import { CashVarianceScreen, DayReconciliationScreen } from './ReportsScreens';

// The cash reports (W1-11, CSH-08, RPT-02) over a fake API: the day's status and what holds it, the sessions with
// their variance and acknowledgement, the missing handovers, and a manager's later acknowledgement.

const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
const session = (over: Partial<DayReconciliationResponse['sessions'][number]>) => ({
  id: 's1',
  number: 'D01-Z000011',
  deviceCode: 'D01',
  cashierName: 'Ali',
  status: 'closed' as const,
  openingFloat: 500000,
  handedIn: 929700,
  paidOut: 45000,
  cashCollections: 500000,
  cashOuts: {
    expense: 20000,
    supplier_payment: 0,
    bank_deposit: 0,
    to_safe: 400000,
    from_safe: 0,
    void_cash: 0,
  },
  expected: 1464700,
  deskExpected: 1464700,
  expectedDiffers: false,
  counted: 1434700,
  variance: -30000,
  varianceReason: 'change_error',
  acknowledgement: 'waiting' as const,
  acknowledgedByName: null,
  ...over,
});
const DAY = (acknowledged: boolean): DayReconciliationResponse => ({
  money: MONEY,
  branchId: 'b1',
  businessDate: '2026-11-02',
  status: 'provisional',
  holds: [{ kind: 'device_not_heard', deviceCode: 'C04', lastContactAt: '2026-11-02T09:05:00.000Z' }],
  sessions: [
    acknowledged ? session({ acknowledgement: 'acknowledged', acknowledgedByName: 'Imran' }) : session({}),
  ],
  missingHandovers: [
    {
      sellerId: 'u1',
      sellerName: 'Usman',
      bills: [{ number: 'C03-S000412', createdAt: '2026-11-02T09:00:00.000Z', kind: 'in', amount: 432000 }],
      toCollect: 432000,
      toPayOut: 0,
    },
  ],
  unmatchedScans: [],
  exceptions: [{ kind: 'negative_stock', severity: 'low', count: 3 }],
  cashInTransit: 432000,
  totalVariance: -30000,
  voidCash: [
    { billNumber: 'C03-S000051', voidNumber: 'C03-V000004', amount: 100000, givenBack: null },
    {
      billNumber: 'C03-S000047',
      voidNumber: 'C03-V000003',
      amount: 45000,
      givenBack: { number: 'D01-M000012', businessDate: '2026-11-03' },
    },
  ],
});

function fakeApi() {
  const calls: string[] = [];
  let acknowledged = false;
  const api: Api = (method, path) => {
    calls.push(`${method} ${path}`);
    if (path === '/api/shop/today') return Promise.resolve({ status: 200, body: { today: '2026-11-19' } });
    if (path === '/api/branches')
      return Promise.resolve({ status: 200, body: [{ id: 'b1', code: 'MAIN', name: 'Main shop' }] });
    if (path.startsWith('/api/reports/day-reconciliation'))
      return Promise.resolve({ status: 200, body: DAY(acknowledged) });
    if (path === '/api/reports/cash-sessions/s1/acknowledge') {
      acknowledged = true;
      return Promise.resolve({ status: 200, body: { id: 's1' } });
    }
    if (path.startsWith('/api/reports/cash-variance'))
      return Promise.resolve({
        status: 200,
        body: {
          money: MONEY,
          from: '2026-10-26',
          to: '2026-11-02',
          sessions: [],
          byCashier: [{ cashierName: 'Ali', sessions: 2, variance: -25000 }],
        } satisfies CashVarianceResponse,
      });
    return Promise.resolve({ status: 404, body: null });
  };
  return { api, calls };
}

const wrap = (ui: React.ReactNode) => render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);

afterEach(cleanup);

describe('the day reconciliation', () => {
  it("shows why the day is provisional, the session's variance, and the bills never handed over", async () => {
    const f = fakeApi();
    wrap(<DayReconciliationScreen api={f.api} permissions={['reports.view']} />);
    expect(await screen.findByText('Provisional')).toBeTruthy();
    expect(screen.getByText(/C04 hasn’t been heard from since the day ended/)).toBeTruthy();
    expect(screen.getByText('Wrong change given')).toBeTruthy();
    expect(screen.getByText('Waiting')).toBeTruthy();
    expect(screen.getByText(/C03-S000412/)).toBeTruthy();
    // Only a manager sees the button.
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Download CSV' }).getAttribute('href')).toMatch(/format=csv$/);
  });

  it('lists the cash taken for voided bills, open or given back (W1-23)', async () => {
    const f = fakeApi();
    wrap(<DayReconciliationScreen api={f.api} permissions={['reports.view']} />);
    expect(await screen.findByText('Cash taken for voided bills')).toBeTruthy();
    expect(screen.getByText(/C03-S000051 \(voided on C03-V000004\) · .* · not given back yet/)).toBeTruthy();
    expect(screen.getByText(/C03-S000047 .* given back on 2026-11-03 \(D01-M000012\)/)).toBeTruthy();
  });

  it('lets a manager acknowledge a waiting variance', async () => {
    const f = fakeApi();
    wrap(<DayReconciliationScreen api={f.api} permissions={['reports.view', 'cash.variance.approve']} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText('By Imran')).toBeTruthy();
    await waitFor(() => expect(f.calls).toContain('POST /api/reports/cash-sessions/s1/acknowledge'));
  });
});

describe('the cash variance', () => {
  it("totals each cashier's variance", async () => {
    wrap(<CashVarianceScreen api={fakeApi().api} />);
    expect(await screen.findByText('Ali')).toBeTruthy();
    expect(screen.getByText(/2 sessions/)).toBeTruthy();
  });
});

// W2-05: the dates a cash report starts on come from the shop's business date (the API), not this browser's
// calendar. The browser's clock is set days away from the shop's day (19 November), so the test holds anywhere.
describe("the shop's business date (W2-05)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('the day reconciliation opens on the business day before it', async () => {
    const f = fakeApi();
    wrap(<DayReconciliationScreen api={f.api} permissions={['reports.view']} />);
    expect(await screen.findByText('Provisional')).toBeTruthy();
    expect(f.calls.filter((c) => c.includes('/day-reconciliation'))).toEqual([
      'GET /api/reports/day-reconciliation?branchId=b1&date=2026-11-18',
    ]);
  });

  it('the cash variance opens on the 7 days up to it', async () => {
    const f = fakeApi();
    wrap(<CashVarianceScreen api={f.api} />);
    expect(await screen.findByText('Ali')).toBeTruthy();
    expect(f.calls.filter((c) => c.includes('/cash-variance'))).toEqual([
      'GET /api/reports/cash-variance?from=2026-11-12&to=2026-11-19',
    ]);
  });
});
