import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import type { Api, ApiResponse } from './api';
import { App } from './App';
import { i18n } from './i18n';
import en from './locales/en.json';

// The back-office minimum of W1-02 (plan scope 4): sign in, the forced password change, Staff PINs and Counters,
// over a fake API.

const ME = {
  tenantId: '0190a0b0-0000-7000-8000-000000000001',
  user: { id: 'm1', username: 'fahad', fullName: 'Fahad Hussain' },
  permissions: ['admin.devices'],
  limits: { maxDiscountBp: 0, voidWindow: 'none' },
  mustChangePassword: false,
};

type Handler = (body: unknown) => ApiResponse;

const fakeApi = (routes: Record<string, Handler>) => {
  const calls: { route: string; body: unknown }[] = [];
  const api: Api = (method, path, body) => {
    const route = `${method} ${path}`;
    calls.push({ route, body });
    const h = routes[route];
    return Promise.resolve(h ? h(body) : { status: 404, body: { error: 'not_found' } });
  };
  return { api, calls };
};

const signedIn = (over: Record<string, Handler> = {}) => ({
  'GET /api/auth/me': () => ({ status: 200, body: ME }),
  'GET /api/branches': () => ({ status: 200, body: [{ id: 'b1', code: 'MAIN', name: 'Delux Autos' }] }),
  'GET /api/staff': () => ({
    status: 200,
    body: [
      {
        id: 'u1',
        username: 'asif',
        fullName: 'Asif Khan',
        shortCode: '12',
        status: 'active',
        hasPin: false,
        pinMustChange: false,
      },
    ],
  }),
  'GET /api/devices': () => ({
    status: 200,
    body: [
      {
        id: 'd1',
        code: 'C01',
        name: null,
        kind: 'counter',
        branchId: 'b1',
        status: 'active',
        enrolledAt: '2026-10-25T05:00:00.000Z',
        revokedAt: null,
      },
    ],
  }),
  ...over,
});

const show = (api: Api) =>
  render(
    <I18nextProvider i18n={i18n}>
      <App api={api} />
    </I18nextProvider>,
  );

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(cleanup);

describe('back office', () => {
  it('signs in, then makes a new owner change the password before anything else', async () => {
    let me: unknown = null;
    const { api, calls } = fakeApi({
      'GET /api/auth/me': () => (me ? { status: 200, body: me } : { status: 401, body: {} }),
      'POST /api/auth/login': () => {
        me = { ...ME, mustChangePassword: true };
        return { status: 200, body: me };
      },
      'PUT /api/users/me/password': (b) =>
        (b as { newPassword: string }).newPassword.length < 10
          ? { status: 400, body: { error: 'weak_password', problem: 'too_short' } }
          : ((me = ME), { status: 204, body: null }),
      'GET /api/staff': () => ({ status: 200, body: [] }),
    });
    show(api);
    await screen.findByRole('heading', { name: en.login.title });
    type(en.login.shopCode, 'delux');
    type(en.login.username, 'fahad');
    type(en.login.password, 'first password');
    fireEvent.click(screen.getByRole('button', { name: en.login.submit }));
    await screen.findByRole('heading', { name: en.password.title });
    type(en.password.current, 'first password');
    type(en.password.new, 'short');
    type(en.password.repeat, 'short');
    fireEvent.click(screen.getByRole('button', { name: en.password.submit }));
    expect(await screen.findByText(en.passwordProblem.too_short)).toBeDefined();
    type(en.password.new, 'a much longer one');
    type(en.password.repeat, 'a much longer one');
    fireEvent.click(screen.getByRole('button', { name: en.password.submit }));
    expect(await screen.findByRole('heading', { name: en.staff.title })).toBeDefined();
    expect(calls.find((c) => c.route === 'POST /api/auth/login')?.body).toEqual({
      tenantCode: 'delux',
      username: 'fahad',
      password: 'first password',
    });
  });

  it('shows a failed sign-in without saying which part was wrong', async () => {
    const { api } = fakeApi({
      'GET /api/auth/me': () => ({ status: 401, body: {} }),
      'POST /api/auth/login': () => ({ status: 401, body: { error: 'login_failed' } }),
    });
    show(api);
    await screen.findByRole('heading', { name: en.login.title });
    type(en.login.shopCode, 'delux');
    type(en.login.username, 'fahad');
    type(en.login.password, 'wrong');
    fireEvent.click(screen.getByRole('button', { name: en.login.submit }));
    expect(await screen.findByText(en.login.failed)).toBeDefined();
  });

  it('Staff PINs: gives a person a temporary PIN', async () => {
    const { api, calls } = fakeApi(
      signedIn({ 'PUT /api/users/u1/temporary-pin': () => ({ status: 204, body: null }) }),
    );
    show(api);
    const row = (await screen.findByText('Asif Khan')).closest('tr')!;
    expect(within(row).getByText(en.staff.pin.none)).toBeDefined();
    fireEvent.click(within(row).getByRole('button', { name: en.staff.give }));
    type(en.staff.temporaryPin, '4831');
    fireEvent.click(screen.getByRole('button', { name: en.staff.save }));
    expect(await screen.findByText(i18n.t('staff.saved', { name: 'Asif Khan' }))).toBeDefined();
    expect(calls.find((c) => c.route === 'PUT /api/users/u1/temporary-pin')?.body).toEqual({ pin: '4831' });
  });

  it('Counters: creates a one-time code and revokes a counter', async () => {
    const { api, calls } = fakeApi(
      signedIn({
        'POST /api/devices/enrollment-codes': () => ({
          status: 201,
          body: { code: 'K7Q2-M9XD', expiresAt: '2026-10-25T06:00:00.000Z' },
        }),
        'POST /api/devices/d1/revoke': () => ({ status: 204, body: null }),
      }),
    );
    show(api);
    fireEvent.click(await screen.findByRole('button', { name: en.nav.counters }));
    fireEvent.click(await screen.findByRole('button', { name: en.counters.create }));
    expect(await screen.findByText('K7Q2-M9XD')).toBeDefined();
    expect(calls.find((c) => c.route === 'POST /api/devices/enrollment-codes')?.body).toEqual({
      branchId: 'b1',
      kind: 'counter',
    });
    const row = screen.getByText('C01').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: en.counters.revoke }));
    fireEvent.click(await screen.findByRole('button', { name: en.counters.confirmRevoke }));
    await screen.findByText(i18n.t('counters.revoked', { code: 'C01' }));
    expect(calls.map((c) => c.route)).toContain('POST /api/devices/d1/revoke');
  });

  it('hides Staff PINs and Counters from someone without the permission', async () => {
    const { api } = fakeApi(
      signedIn({ 'GET /api/auth/me': () => ({ status: 200, body: { ...ME, permissions: [] } }) }),
    );
    show(api);
    expect(await screen.findByText(en.home.nothing)).toBeDefined();
    expect(screen.queryByRole('button', { name: en.nav.counters })).toBeNull();
  });
});
