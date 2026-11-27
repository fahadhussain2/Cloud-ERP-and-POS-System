import type { ShopSettingsView } from '@erp/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { ShopSettingsScreen } from './ShopSettingsScreen';
import { notify, Toaster } from '../ui';

// The shop's name and bill header (W1-25, PLT-01, POS-09) over a fake API: the fields as saved, a preview in the
// bill's order, the limits checked before saving, one save, and a refusal shown.

const BRANCH = '0196f000-0000-7000-8000-0000000000e1';
const SHOP: ShopSettingsView = {
  name: 'Delux Autos',
  branchId: BRANCH,
  branchName: 'Main',
  address: '',
  phone: '',
  lines: [],
  policyText: '',
  profileLines: ['Counter copy'],
};

function fakeApi(put: { status: number; body: unknown } = { status: 200, body: SHOP }) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: Api = (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET') return Promise.resolve({ status: 200, body: SHOP });
    return Promise.resolve(put);
  };
  return { api, calls };
}

// With the frame's toasts (W2-12, owner answer 6), which start empty for each test.
const show = (ui: ReactElement) =>
  render(
    <I18nextProvider i18n={i18n}>
      {ui}
      <Toaster />
    </I18nextProvider>,
  );
afterEach(() => {
  cleanup();
  notify.clear();
});

const field = (name: string) => screen.getByRole<HTMLInputElement>('textbox', { name });
const value = (name: string) => field(name).value;
const type = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });
const preview = () => screen.getByRole('region', { name: en.shop.preview });
const save = () => screen.getByRole<HTMLButtonElement>('button', { name: en.shop.save });

describe('the shop and bill screen', () => {
  it('shows the saved values and previews the bill as it prints: name, header lines, policy line', async () => {
    show(<ShopSettingsScreen api={fakeApi().api} />);
    await waitFor(() => expect(value(en.shop.fields.name)).toBe('Delux Autos'));
    expect(within(preview()).getByRole('heading', { name: 'Delux Autos' })).toBeTruthy();
    expect(within(preview()).getByText('Counter copy')).toBeTruthy();
    // No policy line set: the bill prints the default.
    expect(within(preview()).getByText(en.shop.defaultPolicy)).toBeTruthy();

    type(en.shop.fields.name, 'Delux City Auto Corner');
    type(en.shop.fields.address, 'Shop 14, Auto Market, Karachi');
    type(en.shop.fields.phone, '021-1234567');
    type(en.shop.fields.line1, 'Dealers in genuine parts');
    type(en.shop.fields.policy, 'Exchange within 30 days with this bill.');

    expect(within(preview()).getByRole('heading', { name: 'Delux City Auto Corner' })).toBeTruthy();
    expect(
      within(preview())
        .getAllByTestId('header-line')
        .map((l) => l.textContent),
    ).toEqual(['Shop 14, Auto Market, Karachi', '021-1234567', 'Dealers in genuine parts', 'Counter copy']);
    expect(within(preview()).getByText('Exchange within 30 days with this bill.')).toBeTruthy();
  });

  it('saves everything in one request, blank extra lines dropped, and says so', async () => {
    const f = fakeApi();
    show(<ShopSettingsScreen api={f.api} />);
    await waitFor(() => expect(value(en.shop.fields.name)).toBe('Delux Autos'));
    type(en.shop.fields.name, 'Delux City Auto Corner');
    type(en.shop.fields.line2, 'Wholesale and retail');
    fireEvent.click(save());
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(en.shop.saved));
    expect(f.calls.filter((c) => c.method === 'PUT')).toEqual([
      {
        method: 'PUT',
        path: '/api/settings/shop',
        body: {
          name: 'Delux City Auto Corner',
          branchId: BRANCH,
          address: '',
          phone: '',
          lines: ['Wholesale and retail'],
          policyText: '',
        },
      },
    ]);
  });

  it('checks the limits before saving: a name is needed and a line fits on the bill', async () => {
    show(<ShopSettingsScreen api={fakeApi().api} />);
    await waitFor(() => expect(value(en.shop.fields.name)).toBe('Delux Autos'));
    type(en.shop.fields.name, '  ');
    expect(screen.getByText(en.shop.problems.nameRequired)).toBeTruthy();
    expect(save().disabled).toBe(true);
    type(en.shop.fields.name, 'Delux City Auto Corner');
    type(en.shop.fields.address, 'x'.repeat(61));
    expect(screen.getByText(i18n.t('shop.problems.tooLong', { max: 60 }))).toBeTruthy();
    expect(save().disabled).toBe(true);
    type(en.shop.fields.address, 'x'.repeat(60));
    expect(save().disabled).toBe(false);
  });

  it('shows a refusal and keeps what was typed', async () => {
    show(<ShopSettingsScreen api={fakeApi({ status: 403, body: { error: 'forbidden' } }).api} />);
    await waitFor(() => expect(value(en.shop.fields.name)).toBe('Delux Autos'));
    type(en.shop.fields.name, 'Delux City Auto Corner');
    fireEvent.click(save());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(en.shop.refused));
    expect(value(en.shop.fields.name)).toBe('Delux City Auto Corner');
  });
});
