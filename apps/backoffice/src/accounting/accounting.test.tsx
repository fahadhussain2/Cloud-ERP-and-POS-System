import type {
  AccountingDocumentRow,
  AccountingDocumentView,
  AccountingLookups,
  LockChecklist,
  PeriodsView,
} from '@erp/contracts';
import { formatMoney } from '@erp/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { href, parseHash } from '../router';
import { DocumentScreen, MoneyScreen } from './MoneyScreen';
import { PeriodsScreen } from './PeriodsScreen';
import { VoucherScreen } from './VoucherScreen';

// The accounting screens (W1-19, D-108) over a fake API: a bank receipt posted from its dialog, the duplicate warning
// and Save anyway; a voucher that can't post until it balances, with the customer asked for on an AR line; a reversal;
// locking the next month after its checklist, and reopening for the owner only.

const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
const CAN = {
  receipt: true,
  expense: true,
  transfer: true,
  journal: true,
  close: true,
  reopen: false,
  chart: true,
  financial: true,
};
const lookups = (over: Partial<AccountingLookups> = {}): AccountingLookups => ({
  live: true,
  today: '2026-11-08',
  lockDate: '2026-09-30',
  fiscalYearStartMonth: 1,
  money: MONEY,
  banks: [
    { id: 'hbl', code: 'hbl', name: 'Bank: HBL', kind: 'bank', accountId: 'a1160' },
    { id: 'soneri', code: 'soneri', name: 'Bank: Soneri', kind: 'bank', accountId: 'a1150' },
  ],
  categories: [{ id: 'util', code: 'UTILITIES', name: 'Utilities', accountId: 'a6210', active: true }],
  accounts: [
    {
      id: 'a1130',
      code: '1130',
      name: 'Cash in safe',
      type: 'asset',
      parentId: null,
      postable: true,
      active: true,
      role: 'CASH_SAFE',
    },
    {
      id: 'a1200',
      code: '1200',
      name: 'Accounts receivable',
      type: 'asset',
      parentId: null,
      postable: true,
      active: true,
      role: 'AR_CONTROL',
    },
    {
      id: 'a1300',
      code: '1300',
      name: 'Inventory',
      type: 'asset',
      parentId: null,
      postable: true,
      active: true,
      role: 'INVENTORY',
    },
    {
      id: 'a6300',
      code: '6300',
      name: 'General expenses',
      type: 'expense',
      parentId: null,
      postable: true,
      active: true,
      role: null,
    },
  ],
  can: CAN,
  ...over,
});

const ROW: AccountingDocumentRow = {
  type: 'expense',
  id: 'e1',
  number: 'EX000001',
  date: '2026-11-08',
  status: 'posted',
  amount: 1850000,
  description: 'Utilities · Bank: Soneri',
  reference: null,
  reversedBy: null,
  reverses: null,
};

function fakeApi(l: AccountingLookups, answers: Record<string, { status: number; body: unknown }[]> = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: Api = (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    const queue = answers[key];
    if (queue?.length) return Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0]!);
    if (key === 'GET /api/accounting/lookups') return Promise.resolve({ status: 200, body: l });
    if (key === 'GET /api/accounting/documents') return Promise.resolve({ status: 200, body: [ROW] });
    return Promise.resolve({ status: 200, body: {} });
  };
  return { api, calls };
}

const show = (ui: ReactElement) => render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
afterEach(cleanup);
const a = en.accounting;

describe('the accounting addresses', () => {
  it('open the accounting screens', () => {
    expect(parseHash(href.money)).toEqual({ screen: 'money' });
    expect(parseHash(href.accountingDocument('expense', 'e1'))).toEqual({
      screen: 'accountingDocument',
      type: 'expense',
      id: 'e1',
    });
    expect(parseHash(href.voucher('new'))).toEqual({ screen: 'voucher', id: 'new' });
    expect(parseHash(href.periods)).toEqual({ screen: 'periods' });
    expect(parseHash(href.accounts)).toEqual({ screen: 'accounts' });
    expect(parseHash(href.ledger('a1'))).toEqual({ screen: 'ledger', id: 'a1' });
    expect(parseHash(href.expenseCategories)).toEqual({ screen: 'expenseCategories' });
  });
});

describe('the money list', () => {
  it('lists what is recorded and posts a bank receipt; a duplicate is saved only on Save anyway', async () => {
    const { api, calls } = fakeApi(lookups(), {
      'GET /api/accounting/parties': [
        {
          status: 200,
          body: [
            {
              id: 'c1',
              code: 'KHAN',
              name: 'Khan Motors',
              customer: true,
              supplier: false,
              customerBalance: 0,
              supplierBalance: 0,
            },
          ],
        },
      ],
      'POST /api/accounting/receipts': [
        { status: 409, body: { error: 'possible_duplicate', warnings: ['possible_duplicate'] } },
        { status: 201, body: { id: 'r2', number: 'CR000002' } },
      ],
    });
    show(<MoneyScreen api={api} />);
    expect(await screen.findByText('EX000001')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: a.money.newReceipt }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox', { name: a.fields.customer }), {
      target: { value: 'khan' },
    });
    fireEvent.click(await within(dialog).findByRole('button', { name: /Khan Motors/ }));
    fireEvent.change(within(dialog).getByLabelText(a.fields.amount), { target: { value: '25,000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: a.new.save }));
    expect(await within(dialog).findByText(a.problems.possible_duplicate)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: a.new.saveAnyway }));
    expect(await screen.findByText('CR000002 is posted.')).toBeTruthy();
    const posts = calls.filter((c) => c.path === '/api/accounting/receipts');
    expect(posts.map((p) => (p.body as { allowDuplicate: boolean }).allowDuplicate)).toEqual([false, true]);
    expect(posts[0]!.body).toMatchObject({
      customerId: 'c1',
      bankAccountId: 'hbl',
      amount: 2500000,
      receivedOn: '2026-11-08',
    });
  });

  it('shows only what this person may start', async () => {
    const { api } = fakeApi(lookups({ can: { ...CAN, receipt: false, transfer: false } }));
    show(<MoneyScreen api={api} />);
    await screen.findByText('EX000001');
    expect(screen.queryByRole('button', { name: a.money.newReceipt })).toBeNull();
    expect(screen.queryByRole('button', { name: a.money.newTransfer })).toBeNull();
    expect(screen.getByRole('button', { name: a.money.newExpense })).toBeTruthy();
  });

  it('shows no go-live notice during the pilot (D-113)', async () => {
    show(<MoneyScreen api={fakeApi(lookups({ live: false })).api} />);
    await screen.findByText('EX000001');
    expect(screen.queryByText(/legacy app/i)).toBeNull();
  });
});

describe('a journal voucher', () => {
  it("can't post until it balances; an AR line asks for the customer; Inventory isn't offered", async () => {
    const { api } = fakeApi(lookups());
    show(<VoucherScreen api={api} id="new" />);
    const post = await screen.findByRole('button', { name: a.voucher.post });
    expect((post as HTMLButtonElement).disabled).toBe(true);
    const first = screen.getByRole('combobox', { name: 'Account, line 1' });
    expect(within(first).queryByText(/Inventory/)).toBeNull();
    fireEvent.change(first, { target: { value: 'a6300' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Account, line 2' }), {
      target: { value: 'a1200' },
    });
    expect(screen.getByRole('combobox', { name: 'Customer or supplier, line 2' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Debit, line 1'), { target: { value: '1,500' } });
    fireEvent.change(screen.getByLabelText('Credit, line 2'), { target: { value: '1,000' } });
    expect(screen.getByText(/Off by/)).toBeTruthy();
    expect((post as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Credit, line 2'), { target: { value: '1,500' } });
    await waitFor(() => expect((post as HTMLButtonElement).disabled).toBe(false));
  });

  // Owner's review of W1-19: nothing typed is nothing to save, and a new voucher has no draft to delete.
  it('refuses to save an empty voucher, and offers Delete draft only on a saved one', async () => {
    const { api, calls } = fakeApi(lookups());
    show(<VoucherScreen api={api} id="new" />);
    fireEvent.click(await screen.findByRole('button', { name: a.voucher.save }));
    expect(await screen.findByText(a.errors.empty_draft)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(screen.queryByRole('button', { name: a.voucher.delete })).toBeNull();
  });

  // Owner's review of W1-19: each line says what it does to its account, so a wrong-way line shows before posting.
  it('says under each account what the line does to it', async () => {
    const { api } = fakeApi(lookups());
    show(<VoucherScreen api={api} id="new" />);
    await screen.findByRole('button', { name: a.voucher.post });
    fireEvent.change(screen.getByRole('combobox', { name: 'Account, line 1' }), {
      target: { value: 'a6300' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Account, line 2' }), {
      target: { value: 'a1130' },
    });
    fireEvent.change(screen.getByLabelText('Debit, line 1'), { target: { value: '1,500' } });
    fireEvent.change(screen.getByLabelText('Credit, line 2'), { target: { value: '1,500' } });
    // The page's text is matched with its spaces made plain; money has a non-breaking one.
    const amount = formatMoney(150000, MONEY).replace(/\s/g, ' ');
    expect(screen.getByText(`↑ General expenses goes up ${amount}`)).toBeTruthy();
    expect(screen.getByText(`↓ Cash in safe goes down ${amount}`)).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Account, line 2' }), {
      target: { value: 'a1200' },
    });
    expect(screen.getByText(`↓ The customer owes you less: ${amount}`)).toBeTruthy();
  });

  it('a new voucher posts in one go: saved as a draft, then posted, then shown as posted', async () => {
    const { api, calls } = fakeApi(lookups(), {
      'POST /api/accounting/vouchers': [{ status: 201, body: { id: 'jv1' } }],
      'GET /api/accounting/vouchers/jv1': [
        {
          status: 200,
          body: {
            id: 'jv1',
            number: null,
            status: 'draft',
            date: '2026-11-08',
            narration: 'Drawings',
            rowVersion: '1',
            lines: [],
            check: { problems: [], debit: 500000, credit: 500000 },
            updatedBy: null,
            updatedAt: '2026-11-08T06:00:00.000Z',
          },
        },
      ],
      'POST /api/accounting/vouchers/jv1/post': [{ status: 200, body: { number: 'JV000001' } }],
    });
    show(<VoucherScreen api={api} id="new" />);
    await screen.findByRole('button', { name: a.voucher.post });
    fireEvent.change(screen.getByRole('combobox', { name: 'Account, line 1' }), {
      target: { value: 'a6300' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Account, line 2' }), {
      target: { value: 'a1130' },
    });
    fireEvent.change(screen.getByLabelText('Debit, line 1'), { target: { value: '5,000' } });
    fireEvent.change(screen.getByLabelText('Credit, line 2'), { target: { value: '5,000' } });
    fireEvent.click(screen.getByRole('button', { name: a.voucher.post }));
    await waitFor(() => expect(window.location.hash).toBe(href.accountingDocument('journal_voucher', 'jv1')));
    expect(
      calls
        .filter((c) => c.method !== 'GET' || c.path.includes('vouchers'))
        .map((c) => `${c.method} ${c.path}`),
    ).toEqual([
      'POST /api/accounting/vouchers',
      'GET /api/accounting/vouchers/jv1',
      'POST /api/accounting/vouchers/jv1/post',
    ]);
  });
});

describe('a posted document', () => {
  it('is reversed from its own screen, on a chosen date', async () => {
    const view: AccountingDocumentView = {
      ...ROW,
      note: null,
      createdBy: 'Alia',
      createdAt: '2026-11-08T06:00:00.000Z',
      journal: {
        number: 'J000004',
        entryDate: '2026-11-08',
        lines: [
          {
            accountId: 'a6210',
            accountCode: '6210',
            accountName: 'Utilities',
            partyName: null,
            debit: 1850000,
            credit: 0,
          },
          {
            accountId: 'a1150',
            accountCode: '1150',
            accountName: 'Bank: Soneri',
            partyName: null,
            debit: 0,
            credit: 1850000,
          },
        ],
      },
      canReverse: true,
    };
    const { api, calls } = fakeApi(lookups(), {
      'GET /api/accounting/documents/expense/e1': [{ status: 200, body: view }],
      'POST /api/accounting/reverse': [{ status: 201, body: { id: 'jv2', number: 'JV000002' } }],
    });
    show(<DocumentScreen api={api} type="expense" id="e1" />);
    expect(await screen.findByText('Journal J000004')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: a.document.reverse }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: a.document.reverse }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/accounting/reverse')?.body).toEqual({
        type: 'expense',
        id: 'e1',
        date: '2026-11-08',
      }),
    );
  });
});

describe('periods', () => {
  const PERIODS: PeriodsView = {
    startMonth: 1,
    startMonthFixed: true,
    lockDate: '2026-09-30',
    today: '2026-11-08',
    years: [
      {
        label: '2026',
        start: '2026-01-01',
        end: '2026-12-31',
        months: Array.from({ length: 12 }, (_, i) => {
          const m = String(i + 1).padStart(2, '0');
          const end = new Date(Date.UTC(2026, i + 1, 0)).toISOString().slice(0, 10);
          return { start: `2026-${m}-01`, end, locked: end <= '2026-09-30' };
        }),
      },
    ],
    next: '2026-10-31',
    history: [],
  };
  const CHECK: LockChecklist = {
    lockDate: '2026-10-31',
    items: [
      { kind: 'draft_vouchers', count: 2, amount: null },
      { kind: 'suspense', count: 0, amount: 300 },
    ],
  };

  it('locks the next month after showing what still looks open; the accountant gets no Reopen', async () => {
    const { api, calls } = fakeApi(lookups(), {
      'GET /api/accounting/periods': [{ status: 200, body: PERIODS }],
      'GET /api/accounting/periods/checklist': [{ status: 200, body: CHECK }],
      'POST /api/accounting/lock': [{ status: 200, body: { lockDate: '2026-10-31' } }],
    });
    show(<PeriodsScreen api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Lock up to 2026-10-31' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Journal vouchers still drafts: 2')).toBeTruthy();
    expect(within(dialog).getByText(/Posting suspense holds/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: a.periods.reopen })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: a.periods.lock }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/accounting/lock')?.body).toEqual({
        lockDate: '2026-10-31',
        reason: null,
      }),
    );
  });

  it('the owner reopens the last locked month, saying why', async () => {
    const { api, calls } = fakeApi(lookups({ can: { ...CAN, reopen: true } }), {
      'GET /api/accounting/periods': [{ status: 200, body: PERIODS }],
    });
    show(<PeriodsScreen api={api} />);
    const reopen = await screen.findAllByRole('button', { name: a.periods.reopen });
    expect(reopen).toHaveLength(1);
    fireEvent.click(reopen[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(a.periods.reason), {
      target: { value: 'A missed receipt' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: a.periods.reopen }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/accounting/lock')?.body).toEqual({
        lockDate: '2026-08-31',
        reason: 'A missed receipt',
      }),
    );
  });
});

// W2-05: the accounting forms were already dated by the shop's business date from the API; they stay so, whatever
// this browser's calendar says (its clock is set days away from the shop's day).
describe("the shop's business date (W2-05)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());
  const onToday = (input: HTMLInputElement) => {
    expect(input.value).toBe('2026-11-08');
    expect(input.max).toBe('2026-11-08');
  };

  it('a receipt, an expense and a transfer are dated on it, and no later', async () => {
    show(<MoneyScreen api={fakeApi(lookups()).api} />);
    await screen.findByText('EX000001');
    for (const start of [a.money.newReceipt, a.money.newExpense, a.money.newTransfer]) {
      fireEvent.click(screen.getByRole('button', { name: start }));
      const dialog = await screen.findByRole('dialog');
      onToday(within(dialog).getByLabelText<HTMLInputElement>(a.fields.date));
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });

  it('a new journal voucher is dated on it, and no later', async () => {
    show(<VoucherScreen api={fakeApi(lookups()).api} id="new" />);
    onToday(await screen.findByLabelText<HTMLInputElement>(a.fields.date));
  });
});
