import type { CustomerDetail, CustomerLookups, CustomerRow } from '@erp/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { CustomerScreen, CustomersScreen } from './CustomersScreen';
import { phoneToCheck } from './data';

// The customers screens (W1-22, D-109) over a fake API: the list with balances and credit, search and the status
// filter, Add with a suggested code and the default terms, the terms locked without cust.terms.edit (owner answer 2),
// credit needing a limit or No limit (owner answer 3), the duplicate-phone hint, Deactivate refused with the balance
// (owner answer 5), the legacy notice before go-live (owner answer 6) and the ledger (owner answer 7).

const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
const lookups = (over: Partial<CustomerLookups> = {}): CustomerLookups => ({
  tiers: [
    { id: 'retail', code: 'RETAIL', name: 'Retail', isDefault: true },
    { id: 'mech', code: 'MECHANIC', name: 'Mechanic', isDefault: false },
  ],
  defaultOfflineDailyCap: 2_500_000,
  suppliers: [],
  live: true,
  money: MONEY,
  can: { edit: true, terms: true },
  ...over,
});
const row = (over: Partial<CustomerRow>): CustomerRow => ({
  id: 'c1',
  code: 'C0041',
  name: 'Khan Motors',
  phones: ['03001234567'],
  city: 'Karachi',
  tierId: 'mech',
  tierName: 'Mechanic',
  creditAllowed: true,
  creditLimit: 10_000_000,
  offlineDailyCap: 2_500_000,
  termsDays: null,
  status: 'active',
  balance: 350_000,
  deletable: false,
  imported: false,
  supplier: false,
  ...over,
});
const DETAIL: CustomerDetail = {
  customer: {
    ...row({}),
    contactPerson: null,
    address: null,
    notes: null,
    rowVersion: '5',
    accountVersion: '2',
  },
  balance: 350_000,
  ledger: [
    {
      entryDate: '2026-11-09',
      dueDate: '2026-11-09',
      kind: 'sale',
      sourceId: 's1',
      number: 'A1-000123',
      amount: 450_000,
      balance: 450_000,
    },
    {
      entryDate: '2026-11-09',
      dueDate: '2026-11-09',
      kind: 'customer_receipt',
      sourceId: 'r1',
      number: 'CR000001',
      amount: -100_000,
      balance: 350_000,
    },
  ],
};

type Answer = { status: number; body: unknown };
function fakeApi(l: CustomerLookups, answers: Record<string, Answer> = {}, detail = DETAIL) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: Api = (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    if (answers[key]) return Promise.resolve(answers[key]);
    if (key === 'GET /api/customers/lookups') return Promise.resolve({ status: 200, body: l });
    if (key === 'GET /api/customers/next-code')
      return Promise.resolve({ status: 200, body: { code: 'C0042' } });
    if (key === 'GET /api/customers/c1') return Promise.resolve({ status: 200, body: detail });
    if (key === 'GET /api/customers')
      return Promise.resolve({
        status: 200,
        body: {
          customers: [
            row({}),
            row({
              id: 'c2',
              code: 'C0060',
              name: 'Typo Customer',
              deletable: true,
              creditAllowed: false,
              balance: 0,
            }),
          ],
        },
      });
    if (key === 'POST /api/customers') return Promise.resolve({ status: 201, body: { id: 'c9' } });
    return Promise.resolve({ status: 200, body: { rowVersion: '6', accountVersion: '3' } });
  };
  return { api, calls };
}

const show = (ui: ReactElement) => render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
afterEach(cleanup);

describe('the customers list', () => {
  it('shows each customer with tier, credit and balance, and Delete only for one never used', async () => {
    show(<CustomersScreen api={fakeApi(lookups()).api} />);
    const table = await screen.findByRole('table', { name: en.customers.title });
    expect(within(table).getByText('Khan Motors')).toBeDefined();
    expect(within(table).getByText(/Limit Rs\s?100,000/)).toBeDefined();
    expect(within(table).getByText(en.customers.noCredit)).toBeDefined();
    expect(within(table).getByText(/Rs\s?3,500/)).toBeDefined();
    expect(screen.queryByRole('button', { name: `${en.customers.delete} Khan Motors` })).toBeNull();
    expect(screen.getByRole('button', { name: `${en.customers.delete} Typo Customer` })).toBeDefined();
  });

  it('searches with the text and the status filter', async () => {
    const f = fakeApi(lookups());
    show(<CustomersScreen api={f.api} />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText(en.customers.search), { target: { value: '0300 123' } });
    fireEvent.change(screen.getByLabelText(en.customers.show), { target: { value: 'inactive' } });
    await waitFor(() =>
      expect(f.calls.map((c) => c.path)).toContain('/api/customers?q=0300%20123&status=inactive'),
    );
  });

  it('hides Add for someone without cust.edit', async () => {
    show(<CustomersScreen api={fakeApi(lookups({ can: { edit: false, terms: false } })).api} />);
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: en.customers.add })).toBeNull();
  });

  it('says what the customer owes when Deactivate is refused', async () => {
    const f = fakeApi(lookups(), {
      'PATCH /api/customers/c1': { status: 409, body: { error: 'balance_open', balance: 350_000 } },
    });
    show(<CustomersScreen api={f.api} />);
    fireEvent.click(await screen.findByRole('button', { name: `${en.customers.deactivate} Khan Motors` }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.customers.deactivate }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/balance is Rs\s?3,500/);
    expect(f.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ rowVersion: '5', status: 'inactive' });
  });
});

describe('adding a customer', () => {
  const openAdd = async (l = lookups()) => {
    const f = fakeApi(l);
    show(<CustomersScreen api={f.api} />);
    fireEvent.click(await screen.findByRole('button', { name: en.customers.add }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByLabelText<HTMLInputElement>(en.customers.fields.code).value).toBe('C0042'),
    );
    return { f, dialog };
  };

  it('suggests the next code and sends the default tier, no credit and the Rs 25,000 cap', async () => {
    const { f, dialog } = await openAdd();
    fireEvent.change(within(dialog).getByLabelText(en.customers.fields.name), {
      target: { value: 'Bilal Autos' },
    });
    fireEvent.change(within(dialog).getByLabelText(en.customers.fields.phones), {
      target: { value: '0300-7654321, 021 3456789' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: en.customers.create }));
    await waitFor(() => expect(f.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({
      code: 'C0042',
      name: 'Bilal Autos',
      phones: ['0300-7654321', '021 3456789'],
      city: '',
      contactPerson: '',
      address: '',
      notes: '',
      terms: {
        tierId: 'retail',
        creditAllowed: false,
        creditLimit: null,
        noLimit: false,
        offlineDailyCap: 2_500_000,
        termsDays: null,
      },
    });
  });

  it('needs a limit or No limit once credit is on', async () => {
    const { f, dialog } = await openAdd();
    fireEvent.change(within(dialog).getByLabelText(en.customers.fields.name), {
      target: { value: 'Credit Co' },
    });
    fireEvent.click(within(dialog).getByLabelText(en.customers.fields.creditAllowed));
    fireEvent.click(within(dialog).getByRole('button', { name: en.customers.create }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(en.customers.problems.limit);
    fireEvent.change(within(dialog).getByLabelText(en.customers.fields.limit), {
      target: { value: '50,000' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: en.customers.create }));
    await waitFor(() => expect(f.calls.some((c) => c.method === 'POST')).toBe(true));
    expect((f.calls.find((c) => c.method === 'POST')!.body as { terms: unknown }).terms).toMatchObject({
      creditAllowed: true,
      creditLimit: 5_000_000,
      noLimit: false,
    });
  });

  it('locks the terms and sends none without cust.terms.edit', async () => {
    const { f, dialog } = await openAdd(lookups({ can: { edit: true, terms: false } }));
    expect(within(dialog).getByText(en.customers.termsLocked)).toBeDefined();
    expect(within(dialog).getByLabelText<HTMLSelectElement>(en.customers.fields.tier).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(en.customers.fields.name), { target: { value: 'Bilal' } });
    fireEvent.click(within(dialog).getByRole('button', { name: en.customers.create }));
    await waitFor(() => expect(f.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(f.calls.find((c) => c.method === 'POST')!.body).not.toHaveProperty('terms');
  });

  it('says when a phone is already used by another customer', async () => {
    const { f, dialog } = await openAdd();
    fireEvent.change(within(dialog).getByLabelText(en.customers.fields.phones), {
      target: { value: '+92 300 1234567' },
    });
    expect(await within(dialog).findByText('This phone is already used by C0041 Khan Motors.')).toBeDefined();
    expect(f.calls.map((c) => c.path)).toContain('/api/customers?q=1234567');
  });

  it('makes an existing supplier a customer', async () => {
    const { f, dialog } = await openAdd(
      lookups({ suppliers: [{ id: 's1', code: 'S0001', name: 'Naveed' }] }),
    );
    fireEvent.change(within(dialog).getByLabelText(en.customers.source.label), {
      target: { value: 'supplier' },
    });
    expect(within(dialog).getByLabelText<HTMLSelectElement>(en.customers.source.pick).value).toBe('s1');
    fireEvent.click(within(dialog).getByRole('button', { name: en.customers.create }));
    await waitFor(() => expect(f.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(f.calls.find((c) => c.method === 'POST')!.body).toMatchObject({ partyId: 's1' });
  });
});

describe("a customer's page", () => {
  it('shows the ledger with its running balance', async () => {
    show(<CustomerScreen api={fakeApi(lookups()).api} id="c1" />);
    const table = await screen.findByRole('table', { name: en.customers.ledger.title });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]!.textContent).toMatch(/Bill A1-000123.*Rs\s?4,500.*Rs\s?4,500/);
    expect(rows[2]!.textContent).toMatch(/Bank receipt CR000001.*-Rs\s?1,000.*Rs\s?3,500/);
  });

  it('warns on an imported customer before go-live only', async () => {
    const imported = { ...DETAIL, customer: { ...DETAIL.customer, imported: true } };
    show(<CustomerScreen api={fakeApi(lookups({ live: false }), {}, imported).api} id="c1" />);
    expect(await screen.findByText(en.customers.notLive.title)).toBeDefined();
    cleanup();
    show(<CustomerScreen api={fakeApi(lookups({ live: true }), {}, imported).api} id="c1" />);
    await screen.findByRole('table');
    expect(screen.queryByText(en.customers.notLive.title)).toBeNull();
  });

  it('saves edited terms with both row versions', async () => {
    const f = fakeApi(lookups());
    show(<CustomerScreen api={f.api} id="c1" />);
    fireEvent.click(await screen.findByRole('button', { name: en.customers.edit }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(en.customers.fields.noLimit));
    fireEvent.click(within(dialog).getByRole('button', { name: en.customers.save }));
    await waitFor(() => expect(f.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(f.calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({
      rowVersion: '5',
      accountVersion: '2',
      terms: { creditAllowed: true, creditLimit: null, noLimit: true },
    });
  });
});

describe('the phone to check for a duplicate', () => {
  it('is the last 7 digits of the last phone, once it has 7', () => {
    expect(phoneToCheck('')).toBeNull();
    expect(phoneToCheck('0300 12')).toBeNull();
    expect(phoneToCheck('021-3456789, +92 300 1234567')).toBe('1234567');
  });
});
