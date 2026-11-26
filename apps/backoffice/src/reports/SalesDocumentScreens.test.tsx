import type { BillListView, ReturnListView } from '@erp/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { href, parseHash, queryOf } from '../router';
import { PrintProvider } from './frame/ReportFrame';
import { BillsScreen, ReturnsScreen } from './SalesDocumentScreens';

// Bills and Returns (W2-11, D-126): the sales documents as lists on the report frame, with the owner's columns; each
// row opens the bill's details; the search, the salesman and the other filters go in the address.

const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
const plain = (s: string | null | undefined) => (s ?? '').replace(/\s/g, ' ');
const d = en.salesDocuments;

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
  document.body.textContent?.match(/\b(salesDocuments|billDetails|reports|nav)\.[a-zA-Z][\w.-]*/g) ?? [];
const CHOICES = {
  'GET /api/reports/sales-choices': { salesmen: [{ id: 'u1', name: 'Sara' }], customers: [] },
};

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
});
afterEach(cleanup);

const BILLS: BillListView = {
  money: MONEY,
  from: '2026-11-26',
  to: '2026-11-26',
  methods: [
    { code: 'cash', name: 'Cash' },
    { code: 'jazzcash', name: 'JazzCash' },
  ],
  rows: [
    {
      id: 'd2',
      number: 'C03-S000416',
      at: '2026-11-26T10:12:00.000Z',
      customer: null,
      walkinPhone: '03001234567',
      items: 1,
      total: 360000,
      paidBy: ['Cash'],
      status: 'finalized',
      voidNumber: null,
    },
    {
      id: 'd1',
      number: 'C03-S000415',
      at: '2026-11-26T09:32:00.000Z',
      customer: { id: 'p1', code: 'KHAN', name: 'Khan Motors' },
      walkinPhone: null,
      items: 4,
      total: 2400000,
      paidBy: ['Cash', 'JazzCash'],
      status: 'voided',
      voidNumber: 'C03-V000004',
    },
  ],
  truncated: false,
  total: { count: 1, amount: 360000 },
};

const RETURNS: ReturnListView = {
  money: MONEY,
  from: '2026-11-26',
  to: '2026-11-26',
  rows: [
    {
      id: 'r2',
      number: 'C03-S000431',
      at: '2026-11-26T11:05:00.000Z',
      kind: 'exchange',
      originalBill: 'C03-S000415',
      customer: { id: 'p1', code: 'KHAN', name: 'Khan Motors' },
      walkinPhone: null,
      itemsBack: 2000,
      reason: 'several',
      total: -200000,
      refund: 'paid',
      refundDesk: 'D01',
      status: 'finalized',
    },
    {
      id: 'r1',
      number: 'C03-S000430',
      at: '2026-11-26T10:40:00.000Z',
      kind: 'return',
      originalBill: null,
      customer: null,
      walkinPhone: null,
      itemsBack: 1500,
      reason: 'wrong_part',
      total: -67500,
      refund: 'pending',
      refundDesk: null,
      status: 'finalized',
    },
  ],
  truncated: false,
  total: { count: 2, amount: -267500 },
};

const headers = (table: HTMLElement) =>
  within(table)
    .getAllByRole('columnheader')
    .map((h) => h.textContent);

describe('the sales documents addresses', () => {
  it('Bills, Returns and a bill each have their own', () => {
    expect(parseHash(href.bills)).toEqual({ screen: 'bills' });
    expect(parseHash(href.returns)).toEqual({ screen: 'returns' });
    expect(parseHash(href.bill('C03-S000415'))).toEqual({ screen: 'bill', number: 'C03-S000415' });
  });
});

describe('Bills', () => {
  it("opens on today with the owner's columns; a row opens its bill; a voided bill is marked", async () => {
    window.location.hash = href.bills;
    const { api, calls } = fakeApi({ 'GET /api/sales/bills': BILLS, ...CHOICES });
    show(<BillsScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.bills });
    expect(calls).toContain('/api/sales/bills?preset=today');
    expect(headers(table)).toEqual([
      d.col.number,
      d.col.at,
      d.col.customer,
      d.col.items,
      d.col.total,
      d.col.paidBy,
      d.col.status,
    ]);
    expect(within(table).getByRole('link', { name: 'C03-S000415' }).getAttribute('href')).toBe(
      href.bill('C03-S000415'),
    );
    const voided = within(table).getByText('C03-S000415').closest('tr')!;
    expect(plain(voided.textContent)).toContain(i18n.t('salesDocuments.voided', { number: 'C03-V000004' }));
    expect(plain(voided.textContent)).toContain('Khan Motors (KHAN)');
    expect(plain(voided.textContent)).toContain('Cash, JazzCash');
    expect(plain(within(table).getByText('C03-S000416').closest('tr')!.textContent)).toContain(
      i18n.t('salesDocuments.walkInPhone', { phone: '03001234567' }),
    );
    const figures = plain(screen.getByLabelText(en.reports.frame.figures).textContent);
    expect(figures).toContain('3,600');
    expect(untranslated()).toEqual([]);
  });

  it('puts the search, the salesman, the method and the status in the address', async () => {
    window.location.hash = href.bills;
    const { api } = fakeApi({ 'GET /api/sales/bills': BILLS, ...CHOICES });
    show(<BillsScreen api={api} />);
    await screen.findByRole('table', { name: en.nav.bills });
    fireEvent.change(await screen.findByLabelText(d.filter.salesmanId), { target: { value: 'u1' } });
    fireEvent.change(screen.getByLabelText(d.filter.method), { target: { value: 'jazzcash' } });
    fireEvent.change(screen.getByLabelText(d.filter.status), { target: { value: 'voided' } });
    expect(Object.fromEntries(queryOf(window.location.hash))).toEqual({
      preset: 'today',
      salesmanId: 'u1',
      method: 'jazzcash',
      status: 'voided',
    });
    fireEvent.change(screen.getByLabelText(d.search), { target: { value: ' C03-S000415 ' } });
    await screen.findByDisplayValue(' C03-S000415 ');
    await new Promise((r) => setTimeout(r, 350));
    expect(queryOf(window.location.hash).get('q')).toBe('C03-S000415');
  });
});

describe('Returns', () => {
  it("lists returns and exchanges with the owner's columns", async () => {
    window.location.hash = href.returns;
    const { api, calls } = fakeApi({ 'GET /api/sales/returns': RETURNS, ...CHOICES });
    show(<ReturnsScreen api={api} />);
    const table = await screen.findByRole('table', { name: en.nav.returns });
    expect(calls).toContain('/api/sales/returns?preset=today');
    expect(headers(table)).toEqual([
      d.col.returnNumber,
      d.col.at,
      d.col.type,
      d.col.originalBill,
      d.col.customer,
      d.col.itemsBack,
      d.col.reason,
      d.col.refund,
      d.col.refundPaid,
      d.col.status,
    ]);
    const exchange = within(table).getByText('C03-S000431').closest('tr')!;
    expect(plain(exchange.textContent)).toContain(d.kind.exchange);
    expect(plain(exchange.textContent)).toContain(d.several);
    expect(plain(exchange.textContent)).toContain(i18n.t('salesDocuments.paidAt', { desk: 'D01' }));
    expect(within(exchange).getByRole('link', { name: 'C03-S000415' }).getAttribute('href')).toBe(
      href.bill('C03-S000415'),
    );
    const back = within(table).getByText('C03-S000430').closest('tr')!;
    expect(plain(back.textContent)).toContain(d.noReceipt);
    expect(plain(back.textContent)).toContain(en.billDetails.returnReasons.wrong_part);
    expect(plain(back.textContent)).toContain(d.notYet);
    expect(plain(back.textContent)).toContain('1.5');
    expect(within(table).getByRole('link', { name: 'C03-S000430' }).getAttribute('href')).toBe(
      href.bill('C03-S000430'),
    );
    expect(untranslated()).toEqual([]);
  });

  it('filters by type and reason in the address', async () => {
    window.location.hash = href.returns;
    const { api } = fakeApi({ 'GET /api/sales/returns': RETURNS, ...CHOICES });
    show(<ReturnsScreen api={api} />);
    await screen.findByRole('table', { name: en.nav.returns });
    fireEvent.change(screen.getByLabelText(d.filter.kind), { target: { value: 'exchange' } });
    fireEvent.change(screen.getByLabelText(d.filter.reason), { target: { value: 'defective' } });
    expect(Object.fromEntries(queryOf(window.location.hash))).toEqual({
      preset: 'today',
      kind: 'exchange',
      reason: 'defective',
    });
  });
});
