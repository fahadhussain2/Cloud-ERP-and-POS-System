import type { BillView } from '@erp/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { href, parseHash } from '../router';
import { BillScreen } from './BillScreen';
import { PrintProvider } from './frame/ReportFrame';

// Bill details (W2-10, D-125): one bill, read only, as in the mockup. Cost and profit only with cost.view; Trace a bill
// only with support.trace; a voided bill's banner; a returned line's bill; a number typed or scanned opens its bill.

const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
const plain = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');
const b = en.billDetails;

function fakeApi(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const api: Api = (method, path) => {
    calls.push(path);
    const key = `${method} ${path.split('?')[0]}`;
    return Promise.resolve(
      key in answers ? { status: 200, body: answers[key] } : { status: 404, body: { error: 'not_found' } },
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
  document.body.textContent?.match(/\b(billDetails|reports|nav)\.[a-zA-Z][\w.-]*/g) ?? [];

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const BILL: BillView = {
  money: MONEY,
  values: true,
  canTrace: true,
  bill: {
    id: 'd1',
    number: 'C03-S000415',
    kind: 'sale',
    status: 'finalized',
    businessDate: '2026-11-12',
    createdAt: '2026-11-12T09:32:00.000Z',
    device: 'C03',
    priceTier: 'Retail',
    salesman: 'Sara Ahmed',
    customer: { id: 'p1', code: 'KHAN', name: 'Khan Motors' },
    walkinPhone: null,
  },
  handover: {
    status: 'received',
    number: 'D01-H000031',
    desk: 'D01',
    cashier: 'Kashif',
    at: '2026-11-12T09:40:00.000Z',
  },
  void: null,
  lines: [
    {
      lineNo: 1,
      itemId: 'i1',
      code: 'BPAD-CIV16',
      name: 'BRAKE PAD CIVIC 2016',
      location: 'SHOP',
      qty: 2000,
      allowsFraction: false,
      listPrice: 450000,
      unitPrice: 420000,
      lineDiscount: 60000,
      amount: 840000,
      billShare: 23000,
      lineTotal: 817000,
      approvals: [
        {
          kind: 'below_list',
          reason: 'customer_bargain',
          approvedBy: 'Tariq',
          at: '2026-11-12T09:31:00.000Z',
        },
      ],
      returned: null,
      cost: 620000,
      profit: 197000,
      noCost: false,
    },
    {
      lineNo: 2,
      itemId: 'i2',
      code: 'HOSE-FUEL8',
      name: 'FUEL HOSE 8MM',
      location: 'SHOP',
      qty: 1500,
      allowsFraction: true,
      listPrice: 45000,
      unitPrice: 45000,
      lineDiscount: 0,
      amount: 67500,
      billShare: 1800,
      lineTotal: 65700,
      approvals: [],
      returned: null,
      cost: 52500,
      profit: 13200,
      noCost: false,
    },
    {
      lineNo: 3,
      itemId: 'i3',
      code: 'LAMP-H4',
      name: 'HEAD LAMP BULB H4',
      location: 'SHOP',
      qty: 2000,
      allowsFraction: false,
      listPrice: 180000,
      unitPrice: 180000,
      lineDiscount: 0,
      amount: 360000,
      billShare: 9700,
      lineTotal: 350300,
      approvals: [],
      returned: null,
      cost: 0,
      profit: 350300,
      noCost: true,
    },
  ],
  totals: { lines: 1267500, billDiscount: 34500, rounding: 0, tax: 0, total: 1233000 },
  billApprovals: [
    { kind: 'below_list', reason: 'regular_customer', approvedBy: 'Tariq', at: '2026-11-12T09:32:00.000Z' },
  ],
  payments: [
    { method: 'cash', name: 'Cash', amount: 833000, cashReceived: 833000, change: 0, reference: null },
    {
      method: 'jazzcash',
      name: 'JazzCash',
      amount: 400000,
      cashReceived: null,
      change: null,
      reference: '71839204',
    },
  ],
  cost: { cost: 672500, profit: 560500, marginBp: 4546, noCostLines: 1 },
  related: {
    returns: [{ number: 'C03-S000431', date: '2026-11-14', status: 'finalized', total: -420000 }],
    returnOf: null,
    reissueOf: null,
    approvals: [],
    journal: 'J000812',
  },
};

const at = (number: string) => `GET /api/sales/bills/${encodeURIComponent(number)}`;

describe('bill details', () => {
  it('has its own address, and a bill number opens it', () => {
    expect(href.bill('C03-S000415')).toBe('#/sales/bills/C03-S000415');
    expect(parseHash('#/sales/bills/C03-S000415')).toEqual({ screen: 'bill', number: 'C03-S000415' });
    expect(parseHash('#/sales/bills')).toEqual({ screen: 'bill', number: null });
  });

  it('shows the header, the items with their approvals, the totals, the payments and what is related', async () => {
    const { api, calls } = fakeApi({ [at('C03-S000415')]: BILL });
    show(<BillScreen api={api} number="C03-S000415" />);
    const items = await screen.findByRole('table', { name: b.items });
    expect(calls).toContain('/api/sales/bills/C03-S000415');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('C03-S000415');
    expect(screen.getByText(b.status.finalized)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Khan Motors/ }).getAttribute('href')).toBe(href.customer('p1'));
    expect(screen.getByRole('link', { name: b.trace }).getAttribute('href')).toBe(href.trace('C03-S000415'));

    expect(
      within(items)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      b.col.no,
      b.col.item,
      b.col.qty,
      b.col.list,
      b.col.price,
      b.col.discount,
      b.col.amount,
      b.col.cost,
      b.col.profit,
    ]);
    const pads = within(items).getByText('BRAKE PAD CIVIC 2016').closest('tr')!;
    expect(plain(pads.textContent)).toContain('4,200');
    expect(plain(pads.textContent)).toContain(i18n.t('billDetails.approval.below_list', { by: 'Tariq' }));
    expect(within(items).getByRole('link', { name: 'BPAD-CIV16' }).getAttribute('href')).toBe(
      href.item('i1'),
    );
    expect(plain(within(items).getByText('FUEL HOSE 8MM').closest('tr')!.textContent)).toContain('1.5');
    expect(plain(within(items).getByText('HEAD LAMP BULB H4').closest('tr')!.textContent)).toContain(
      b.noCost,
    );

    const totals = screen.getByRole('region', { name: b.totals });
    expect(plain(totals.textContent)).toContain('12,330');
    expect(plain(totals.textContent)).toContain('JazzCash');
    expect(plain(totals.textContent)).toContain('71839204');
    const profit = screen.getByRole('region', { name: b.costProfit });
    expect(plain(profit.textContent)).toContain('5,605');
    expect(plain(profit.textContent)).toContain('45.5%');
    const related = screen.getByRole('region', { name: b.related });
    expect(within(related).getByRole('link', { name: 'C03-S000431' }).getAttribute('href')).toBe(
      href.bill('C03-S000431'),
    );
    expect(plain(related.textContent)).toContain('J000812');
    expect(untranslated()).toEqual([]);
  });

  it('without cost.view: no cost, no profit; without support.trace: no Trace', async () => {
    const lines = BILL.lines.map((l) => ({ ...l, cost: null, profit: null }));
    const { api } = fakeApi({
      [at('C03-S000415')]: { ...BILL, values: false, canTrace: false, cost: null, lines },
    });
    show(<BillScreen api={api} number="C03-S000415" />);
    const items = await screen.findByRole('table', { name: b.items });
    const heads = within(items)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(heads).not.toContain(b.col.cost);
    expect(heads).not.toContain(b.col.profit);
    expect(screen.queryByRole('region', { name: b.costProfit })).toBeNull();
    expect(screen.queryByRole('link', { name: b.trace })).toBeNull();
    expect(screen.queryByText(b.noCost)).toBeNull();
  });

  it('a voided bill shows its void and its reissue; a returned line shows the bill it came from', async () => {
    const voided: BillView = {
      ...BILL,
      bill: { ...BILL.bill, status: 'voided' },
      void: {
        number: 'C03-V000004',
        at: '2026-11-12T10:05:00.000Z',
        reason: 'wrong_price',
        approvedBy: 'Tariq',
        reissue: 'C03-S000416',
      },
      lines: [
        {
          ...BILL.lines[0]!,
          qty: -1000,
          amount: -420000,
          billShare: 0,
          lineTotal: -420000,
          approvals: [],
          returned: { reason: 'wrong_part', condition: 'resellable', note: null, billNumber: 'C03-S000400' },
        },
      ],
    };
    const { api } = fakeApi({ [at('C03-S000415')]: voided });
    show(<BillScreen api={api} number="C03-S000415" />);
    const banner = await screen.findByRole('status');
    expect(plain(banner.textContent)).toContain('C03-V000004');
    expect(plain(banner.textContent)).toContain(en.billDetails.voidReasons.wrong_price);
    expect(within(banner).getByRole('link', { name: 'C03-S000416' }).getAttribute('href')).toBe(
      href.bill('C03-S000416'),
    );
    expect(screen.getByText(b.status.voided)).toBeTruthy();
    const items = screen.getByRole('table', { name: b.items });
    expect(within(items).getByRole('link', { name: 'C03-S000400' }).getAttribute('href')).toBe(
      href.bill('C03-S000400'),
    );
    expect(plain(items.textContent)).toContain(en.billDetails.returnReasons.wrong_part);
  });

  it('opens a typed or scanned number; an unknown number says so', async () => {
    const { api } = fakeApi({});
    show(<BillScreen api={api} number={null} />);
    fireEvent.change(screen.getByLabelText(b.number), { target: { value: ' C03-S000415 ' } });
    fireEvent.submit(screen.getByLabelText(b.number).closest('form')!);
    expect(window.location.hash).toBe(href.bill('C03-S000415'));
    cleanup();
    show(<BillScreen api={api} number="C99-S000001" />);
    expect(await screen.findByText(i18n.t('billDetails.notFound', { number: 'C99-S000001' }))).toBeTruthy();
  });
});
