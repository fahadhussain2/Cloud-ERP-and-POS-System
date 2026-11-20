import type { DashboardView } from '@erp/contracts';
import { TooltipProvider } from '@erp/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { href, parseHash, queryOf } from '../router';
import { DashboardScreen } from './DashboardScreen';

// The owner's dashboard (W2-06 plan; RPT-18; D-118): the key figures with their chips and details, the period switch,
// the cards' links carrying the period, the donut (and a loss month), attention and the unusual chip, and nothing
// about cost without cost.view. No string left untranslated.

const d = en.dashboard;
const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
const plain = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');
const chip = (amount: number, bp: number | null, good: boolean | null) => ({
  amount,
  bp,
  direction: amount > 0 ? ('up' as const) : amount < 0 ? ('down' as const) : ('flat' as const),
  good,
});
const count = (count: number, amount: number, usualCount: number, times: number | null = null) => ({
  count,
  amount,
  usualCount,
  usualAmount: 0,
  times,
});

const VIEW: DashboardView = {
  money: MONEY,
  values: true,
  period: 'today',
  today: '2027-01-15',
  readAt: '2027-01-15T13:05:00.000Z',
  dayOpenedAt: '2027-01-15T04:42:00.000Z',
  current: { from: '2027-01-15', to: '2027-01-15' },
  comparison: { from: '2027-01-08', to: '2027-01-08' },
  upToMinute: 600,
  beforeGoLive: false,
  netSales: { now: 42600000, before: 37900000, chip: chip(4700000, 1240, true), bills: 164, average: 259756 },
  grossProfit: {
    now: 10820400,
    before: 9399200,
    chip: chip(1421200, 1512, true),
    marginBp: 2540,
    beforeMarginBp: 2480,
  },
  cash: {
    now: 59840000,
    atDayStart: 43200000,
    chip: chip(16640000, 3852, true),
    drawers: 18640000,
    safe: 41200000,
    inTransit: 0,
    openSessions: 2,
  },
  bank: {
    now: 242385000,
    atDayStart: 237785000,
    chip: chip(4600000, 193, true),
    accounts: [
      { id: 'b1', name: 'Current account', kind: 'bank', balance: 234560000 },
      { id: 'b2', name: 'Wallet', kind: 'wallet', balance: 7825000 },
    ],
    cardClearing: 0,
  },
  customersOwe: {
    now: 186430000,
    before: 179100000,
    chip: chip(7330000, 409, false),
    customers: 312,
    receivedToday: 9450000,
  },
  trend: {
    step: 'hour',
    points: [
      { label: '09:00', now: 900000, before: 800000 },
      { label: '10:00', now: 1600000, before: 1500000 },
      { label: '11:00', now: null, before: 2200000 },
    ],
  },
  attention: [
    { kind: 'exceptions', tone: 'bad', count: 3, name: null, minutes: null },
    { kind: 'counterUnseen', tone: 'warn', count: 1, name: 'Counter 2', minutes: 18 },
  ],
  busyHours: {
    weeks: 4,
    bills: Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, h) => (h >= 9 && h <= 20 ? 8 : 0))),
    hours: { first: 9, last: 20 },
  },
  topCategories: {
    rows: [{ id: 'c1', name: 'Engine oil', sales: 9800000 }],
    rest: 32800000,
    total: 42600000,
  },
  leak: {
    discounts: count(23, 645000, 18),
    belowList: { ...count(5, 320000, 2, 25), byOwner: 1 },
    returns: { ...count(4, 1230000, 3), topReason: 'wrong_part' },
    voids: { ...count(2, 890000, 2), reissued: 2 },
  },
  donut: {
    from: '2027-01-01',
    to: '2027-01-31',
    grossProfit: 238640000,
    loss: false,
    net: 126780000,
    base: 238640000,
    keptBp: 5313,
    slices: [
      { kind: 'net', name: null, amount: 126780000, bp: 5313 },
      { kind: 'expense', name: 'Salaries', amount: 52000000, bp: 2179 },
      { kind: 'expense', name: 'Rent', amount: 28000000, bp: 1173 },
      { kind: 'other', name: null, amount: 31860000, bp: 1335 },
    ],
  },
  owe: {
    total: 186430000,
    count: 312,
    top: [{ id: 'p1', name: 'Sadar Auto Works', amount: 18600000 }],
    rest: { count: 311, amount: 167830000 },
  },
  suppliers: { total: 124000000, overdue: 9200000, dueIn7Days: 38500000 },
  stock: { value: 1483200000, atMinimum: 7, negative: 2, dead: { count: 212, value: 64200000 } },
  bestItems: [{ id: 'i1', code: 'OIL-1', name: 'Engine oil 4 L', qty: 12000, sales: 4200000 }],
  salesmen: [{ id: 'u1', name: 'Imran', bills: 58, sales: 15230000 }],
};

function fakeApi(views: Partial<Record<string, DashboardView>>) {
  const calls: string[] = [];
  const api: Api = (_method, path) => {
    calls.push(path);
    const period = new URLSearchParams(path.split('?')[1]).get('period') ?? 'today';
    const body = views[period];
    return Promise.resolve(body ? { status: 200, body } : { status: 403, body: { error: 'forbidden' } });
  };
  return { api, calls };
}
const show = (api: Api) =>
  render(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <DashboardScreen api={api} />
      </TooltipProvider>
    </I18nextProvider>,
  );
const untranslated = () => document.body.textContent?.match(/\b(dashboard|nav)\.[a-zA-Z][\w.-]*/g) ?? [];
const linkTo = (name: RegExp | string) => screen.getAllByRole('link', { name })[0]!.getAttribute('href')!;

afterEach(cleanup);

describe("the owner's dashboard", () => {
  it('shows the five key figures with their chips and details, today against last week', async () => {
    show(fakeApi({ today: VIEW }).api);
    const figures = await screen.findByRole('region', { name: d.keyFigures });
    const cards = within(figures).getAllByRole('link');
    expect(cards).toHaveLength(5);
    expect(plain(cards[0]!.textContent)).toContain(d.kpi.salesSoFar);
    expect(plain(cards[0]!.textContent)).toContain('+12.4%');
    expect(cards[0]!.querySelector('.text-ok')).not.toBeNull();
    // What customers owe rising is bad: red.
    expect(plain(cards[4]!.textContent)).toContain('+4.1% in 30 days');
    expect(cards[4]!.querySelector('.text-bad')).not.toBeNull();
    // The margin beside the chip, and the details for screen readers and on hover.
    expect(plain(cards[1]!.textContent)).toContain('margin 25.4%');
    expect(plain(cards[0]!.textContent)).toContain('164 bills · average');
    expect(plain(cards[2]!.textContent)).toContain('Drawers');
    expect(screen.getByText(d.compared.today)).toBeTruthy();
    expect(untranslated()).toEqual([]);
  });

  it('opens each card’s report with the same period', async () => {
    show(fakeApi({ today: VIEW }).api);
    await screen.findByRole('region', { name: d.keyFigures });
    const sales = linkTo(new RegExp(d.kpi.salesSoFar));
    expect(sales.startsWith(href.salesProfit)).toBe(true);
    expect(Object.fromEntries(queryOf(sales))).toMatchObject({ from: '2027-01-15', to: '2027-01-15' });
    expect(parseHash(linkTo(d.categories.link)).screen).toBe('salesProfit');
    expect(queryOf(linkTo(d.categories.link)).get('group')).toBe('category');
    expect(linkTo(d.donut.link)).toBe(`${href.profitLoss}?from=2027-01-01&to=2027-01-31`);
    expect(linkTo(/Sadar Auto Works/)).toBe(`${href.partnerLedger}?role=customer&partyId=p1`);
    expect(linkTo(/3 high-severity exceptions are open/)).toBe(
      `${href.exceptions}?status=open&severity=high`,
    );
    expect(linkTo(/Counter 2 not seen for 18 minutes/)).toBe(href.counters);
  });

  it('reads the period again when it changes, with its own comparison', async () => {
    const { api, calls } = fakeApi({
      today: VIEW,
      '7d': {
        ...VIEW,
        period: '7d',
        current: { from: '2027-01-09', to: '2027-01-15' },
        trend: { step: 'day', points: [{ label: '2027-01-15', now: 100, before: 90 }] },
      },
    });
    show(api);
    await screen.findByRole('region', { name: d.keyFigures });
    fireEvent.click(screen.getByRole('button', { name: d.periods['7d'] }));
    await waitFor(() => expect(calls).toContain('/api/dashboard?period=7d'));
    expect(await screen.findByText(d.compared['7d'])).toBeTruthy();
    expect(screen.getByRole('button', { name: d.periods['7d'] }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(d.kpi.sales)).toBeTruthy();
  });

  it('the donut: net profit kept in the centre, a slice’s share on hover, and a loss month in red', async () => {
    show(fakeApi({ today: VIEW }).api);
    const donut = await screen.findByRole('region', { name: d.donut.title });
    expect(plain(donut.textContent)).toContain('53.1%');
    expect(plain(donut.textContent)).toContain(d.donut.kept);
    fireEvent.mouseEnter(within(donut).getByText('Salaries').closest('li')!);
    expect(plain(donut.textContent)).toContain('21.8%');
    expect(within(donut).getByText(d.donut.other)).toBeTruthy();
    cleanup();

    const loss = {
      ...VIEW.donut!,
      grossProfit: 50000000,
      loss: true,
      net: -39640000,
      base: 89640000,
      keptBp: null,
      slices: [
        { kind: 'expense' as const, name: 'Salaries', amount: 52000000, bp: 5801 },
        { kind: 'other' as const, name: null, amount: 37640000, bp: 4199 },
      ],
    };
    show(fakeApi({ today: { ...VIEW, donut: loss } }).api);
    const red = await screen.findByRole('region', { name: d.donut.title });
    expect(within(red).getByText(d.donut.loss)).toBeTruthy();
    expect(within(red).getByText(d.donut.netLoss)).toBeTruthy();
    expect(red.querySelector('.text-bad')).not.toBeNull();
  });

  it('flags an unusual figure with how many times usual', async () => {
    show(fakeApi({ today: VIEW }).api);
    const leak = await screen.findByRole('region', { name: d.leak.title });
    expect(plain(leak.textContent)).toContain('2.5× usual');
    expect(within(leak).getAllByText(/× usual/)).toHaveLength(1);
  });

  it('shows no cost, profit or stock value without cost.view', async () => {
    const noCost: DashboardView = {
      ...VIEW,
      values: false,
      grossProfit: { now: null, before: null, chip: null, marginBp: null, beforeMarginBp: null },
      donut: null,
      stock: { ...VIEW.stock, value: null, dead: { count: 212, value: null } },
    };
    show(fakeApi({ today: noCost }).api);
    const figures = await screen.findByRole('region', { name: d.keyFigures });
    expect(within(figures).getAllByRole('link')).toHaveLength(4);
    expect(screen.queryByText(d.kpi.profit)).toBeNull();
    expect(screen.queryByRole('region', { name: d.donut.title })).toBeNull();
    expect(screen.queryByText(d.stock.value)).toBeNull();
  });
});
