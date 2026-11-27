import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Api, ApiResponse } from './api';
import { App } from './App';
import { i18n } from './i18n';
import en from './locales/en.json';

// The back office over a fake API: sign in, the forced password change (W1-02), the layout and menu, Staff and
// Counters (W1-04 plan).

const OWNER = {
  tenantId: '0190a0b0-0000-7000-8000-000000000001',
  user: { id: 'o1', username: 'fahad', fullName: 'Fahad Hussain' },
  permissions: ['admin.users', 'admin.roles', 'admin.settings', 'admin.devices', 'pos.sale.create'],
  limits: { maxDiscountBp: 10000, voidWindow: 'same_day' },
  mustChangePassword: false,
};
const MANAGER = {
  ...OWNER,
  user: { id: 'm1', username: 'boss', fullName: 'Boss' },
  permissions: ['admin.devices', 'pos.void'],
};
const SALESMAN = {
  ...OWNER,
  user: { id: 's1', username: 'sara', fullName: 'Sara' },
  permissions: ['pos.sale.create'],
};

const ASIF = {
  id: 'u1',
  username: 'asif',
  fullName: 'Asif Khan',
  shortCode: '12',
  email: null,
  status: 'active',
  hasPassword: false,
  hasPin: false,
  pinMustChange: false,
  lastLoginAt: null,
  canGivePin: true,
  roles: [{ roleId: 'r-sales', name: 'Salesman', templateKey: 'salesman', branchId: null }],
};
const LEFT = { ...ASIF, id: 'u2', username: 'old', fullName: 'Old Hand', status: 'disabled' };
/** Someone the person signed in may not give a PIN to (an Owner, for a manager). */
const BOSS = {
  ...ASIF,
  id: 'u3',
  username: 'fahad',
  fullName: 'Fahad Owner',
  canGivePin: false,
  roles: [{ roleId: 'r-owner', name: 'Owner', templateKey: 'owner', branchId: null }],
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

const signedIn = (me: unknown = OWNER, over: Record<string, Handler> = {}) => ({
  'GET /api/auth/me': () => ({ status: 200, body: me }),
  'GET /api/branches': () => ({ status: 200, body: [{ id: 'b1', code: 'MAIN', name: 'Delux Autos' }] }),
  'GET /api/users': () => ({ status: 200, body: [ASIF, LEFT, BOSS] }),
  'GET /api/roles': () => ({
    status: 200,
    body: [
      { id: 'r-owner', name: 'Owner', templateKey: 'owner' },
      { id: 'r-sales', name: 'Salesman', templateKey: 'salesman' },
      { id: 'r-cash', name: 'Cashier', templateKey: 'cashier' },
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

const goTo = (hash: string) =>
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });

// Most tests start on Staff. The fixture's owner holds only admin rights, and user activity (admin.users, W2-04) puts
// the Reports row first in the menu's order for them; a real owner holds every permission and opens on the Dashboard
// (W2-06). A sign-in opens the first screen, whatever the address named.
beforeEach(() => {
  window.location.hash = '#/staff';
});
afterEach(cleanup);

describe('signing in', () => {
  it('signs in, then makes a new owner change the password before anything else', async () => {
    let me: unknown = null;
    const { api, calls } = fakeApi({
      ...signedIn(),
      'GET /api/auth/me': () => (me ? { status: 200, body: me } : { status: 401, body: {} }),
      'POST /api/auth/login': () => {
        me = { ...OWNER, mustChangePassword: true };
        return { status: 200, body: me };
      },
      'PUT /api/users/me/password': (b) =>
        (b as { newPassword: string }).newPassword.length < 10
          ? { status: 400, body: { error: 'weak_password', problem: 'too_short' } }
          : ((me = OWNER), { status: 204, body: null }),
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
    // Then the first screen they may open (the address before sign-in is not kept).
    expect(await screen.findByRole('navigation', { name: en.nav.menu })).toBeDefined();
    expect(screen.queryByRole('heading', { name: en.password.title })).toBeNull();
    expect(window.location.hash).toBe('');
    expect(calls.find((c) => c.route === 'POST /api/auth/login')?.body).toEqual({
      tenantCode: 'delux',
      username: 'fahad',
      password: 'first password',
    });
  });

  it('opens the first screen after signing in, whatever the address still names: the Dashboard for the owner', async () => {
    // Bug: signing out on Customers left #/sales/customers in the address, so the owner's next sign-in opened Customers
    // instead of their Dashboard (W2-06; D-118).
    window.location.hash = '#/sales/customers';
    let me: unknown = null;
    const owner = { ...OWNER, permissions: [...OWNER.permissions, 'cust.edit', 'dashboard.view'] };
    const { api } = fakeApi({
      ...signedIn(),
      'GET /api/auth/me': () => (me ? { status: 200, body: me } : { status: 401, body: {} }),
      'POST /api/auth/login': () => ((me = owner), { status: 200, body: me }),
    });
    show(api);
    await screen.findByRole('heading', { name: en.login.title });
    type(en.login.shopCode, 'delux');
    type(en.login.username, 'fahad');
    type(en.login.password, 'a password');
    fireEvent.click(screen.getByRole('button', { name: en.login.submit }));
    const menu = await screen.findByRole('navigation', { name: en.nav.menu });
    await waitFor(() =>
      expect(within(menu).getByRole('link', { name: en.nav.dashboard }).getAttribute('aria-current')).toBe(
        'page',
      ),
    );
    expect(
      within(menu).getByRole('link', { name: en.nav.customers }).getAttribute('aria-current'),
    ).toBeNull();
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
});

describe('layout and menu', () => {
  it('an owner sees Staff and Counters under Settings, and who is signed in', async () => {
    show(fakeApi(signedIn()).api);
    const menu = await screen.findByRole('navigation', { name: en.nav.menu });
    expect(within(menu).getByRole('button', { name: en.nav.groups.settings })).toBeDefined();
    expect(within(menu).getByRole('link', { name: en.nav.staff }).getAttribute('href')).toBe('#/staff');
    expect(within(menu).getByRole('link', { name: en.nav.counters }).getAttribute('href')).toBe('#/counters');
    expect(screen.getByText('Fahad Hussain')).toBeDefined();
  });

  it('a manager sees Staff and Counters too (temporary PINs, counters)', async () => {
    show(fakeApi(signedIn(MANAGER)).api);
    const menu = await screen.findByRole('navigation', { name: en.nav.menu });
    expect(within(menu).getByRole('link', { name: en.nav.staff })).toBeDefined();
    expect(within(menu).getByRole('link', { name: en.nav.counters })).toBeDefined();
  });

  it('opens the first screen the person may open, in the menu’s order: Customers for a shop’s owner', async () => {
    window.location.hash = '';
    show(fakeApi(signedIn({ ...OWNER, permissions: [...OWNER.permissions, 'cust.edit'] })).api);
    const menu = await screen.findByRole('navigation', { name: en.nav.menu });
    expect(within(menu).getByRole('link', { name: en.nav.customers }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('someone with no admin rights sees no menu entries, only a note', async () => {
    show(fakeApi(signedIn(SALESMAN)).api);
    expect(await screen.findByText(en.home.nothing)).toBeDefined();
    expect(screen.queryByRole('link', { name: en.nav.staff })).toBeNull();
    expect(screen.queryByRole('link', { name: en.nav.counters })).toBeNull();
  });

  it('the address keeps the screen: #/staff/<id> opens that person after a reload, #/staff goes back', async () => {
    window.location.hash = '#/staff/u1';
    show(fakeApi(signedIn()).api);
    expect(await screen.findByRole('heading', { name: 'Asif Khan' })).toBeDefined();
    goTo('#/staff');
    expect(await screen.findByRole('heading', { name: en.staff.title })).toBeDefined();
  });

  it('following a person’s name sets the address', async () => {
    show(fakeApi(signedIn()).api);
    fireEvent.click(await screen.findByRole('link', { name: 'Asif Khan' }));
    // jsdom follows a fragment link a moment later, as a browser does.
    await waitFor(() => expect(window.location.hash).toBe('#/staff/u1'));
    expect(await screen.findByRole('heading', { name: 'Asif Khan' })).toBeDefined();
  });
});

describe('Staff', () => {
  it('lists active people with role, back-office access and PIN state; deactivated ones under their filter', async () => {
    show(fakeApi(signedIn()).api);
    const row = (await screen.findByRole('link', { name: 'Asif Khan' })).closest('tr')!;
    expect(within(row).getByText('Salesman')).toBeDefined();
    expect(within(row).getByText(en.staff.backOfficeNo)).toBeDefined();
    expect(within(row).getByText(en.staff.pin.none)).toBeDefined();
    expect(screen.queryByText('Old Hand')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.staff.filter.disabled }));
    expect(await screen.findByText('Old Hand')).toBeDefined();
  });

  it('a manager gives a temporary PIN but can’t add or change people', async () => {
    const { api, calls } = fakeApi(
      signedIn(MANAGER, { 'PUT /api/users/u1/temporary-pin': () => ({ status: 204, body: null }) }),
    );
    show(api);
    const row = (await screen.findByText('Asif Khan')).closest('tr')!;
    expect(screen.queryByRole('button', { name: en.staff.add })).toBeNull();
    // A row action is an icon named with the person (W2-15).
    fireEvent.click(within(row).getByRole('button', { name: `${en.staff.give} Asif Khan` }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(en.staff.temporaryPin), { target: { value: '4831' } });
    fireEvent.click(within(dialog).getByRole('button', { name: en.staff.save }));
    expect(await screen.findByText(i18n.t('staff.saved', { name: 'Asif Khan' }))).toBeDefined();
    expect(calls.find((c) => c.route === 'PUT /api/users/u1/temporary-pin')?.body).toEqual({ pin: '4831' });
    expect(calls.map((c) => c.route)).not.toContain('GET /api/roles');
  });

  it('a manager has no PIN action for someone they may not give a PIN to (an Owner)', async () => {
    show(fakeApi(signedIn(MANAGER)).api);
    const row = (await screen.findByText('Fahad Owner')).closest('tr')!;
    expect(within(row).queryByRole('button', { name: new RegExp(`^${en.staff.give}`) })).toBeNull();
    fireEvent.click(within(row).getByRole('link', { name: 'Fahad Owner' }));
    expect(await screen.findByRole('heading', { name: 'Fahad Owner' })).toBeDefined();
    expect(screen.queryByRole('button', { name: en.staff.give })).toBeNull();
  });

  it('explains a refused PIN', async () => {
    const { api } = fakeApi(
      signedIn(MANAGER, {
        'PUT /api/users/u1/temporary-pin': () => ({ status: 403, body: { error: 'cannot_grant' } }),
      }),
    );
    show(api);
    const row = (await screen.findByText('Asif Khan')).closest('tr')!;
    // A row action is an icon named with the person (W2-15).
    fireEvent.click(within(row).getByRole('button', { name: `${en.staff.give} Asif Khan` }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(en.staff.temporaryPin), { target: { value: '4831' } });
    fireEvent.click(within(dialog).getByRole('button', { name: en.staff.save }));
    // Not about the PIN itself: a toast, and the dialog stays open (owner answer 6).
    expect(await screen.findByText(en.staff.errors.pin_not_allowed)).toBeDefined();
    expect(dialog.isConnected).toBe(true);
  });

  it('an owner adds a person with a role and no password', async () => {
    const { api, calls } = fakeApi(
      signedIn(OWNER, { 'POST /api/users': () => ({ status: 201, body: { id: 'u9' } }) }),
    );
    show(api);
    fireEvent.click(await screen.findByRole('button', { name: en.staff.add }));
    const dialog = await screen.findByRole('dialog');
    const field = (label: string, value: string) =>
      fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    field(en.staff.fullName, 'Bilal Ahmed');
    field(en.staff.username, 'bilal');
    field(en.staff.shortCodeField, 'BA');
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'Salesman' }));
    fireEvent.click(within(dialog).getByRole('button', { name: en.staff.create }));
    expect(await screen.findByText(i18n.t('staff.created', { name: 'Bilal Ahmed' }))).toBeDefined();
    expect(calls.find((c) => c.route === 'POST /api/users')?.body).toEqual({
      username: 'bilal',
      fullName: 'Bilal Ahmed',
      shortCode: 'BA',
      email: null,
      roles: [{ roleId: 'r-sales', branchId: null }],
    });
  });

  it('shows which field is a duplicate', async () => {
    const { api } = fakeApi(
      signedIn(OWNER, {
        'POST /api/users': () => ({ status: 409, body: { error: 'duplicate', field: 'username' } }),
      }),
    );
    show(api);
    fireEvent.click(await screen.findByRole('button', { name: en.staff.add }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(en.staff.fullName), { target: { value: 'Asif Two' } });
    fireEvent.change(within(dialog).getByLabelText(en.staff.username), { target: { value: 'asif' } });
    fireEvent.click(within(dialog).getByRole('button', { name: en.staff.create }));
    expect(await within(dialog).findByText(en.staff.errors.duplicate_username)).toBeDefined();
  });

  it('Esc closes a dialog and returns focus to the button that opened it (D-053)', async () => {
    show(fakeApi(signedIn()).api);
    const add = await screen.findByRole('button', { name: en.staff.add });
    add.focus();
    fireEvent.click(add);
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Radix gives focus back a moment after closing.
    await waitFor(() => expect(document.activeElement).toBe(add));
  });
});

describe('a person', () => {
  it('gives back-office access with a temporary password', async () => {
    const { api, calls } = fakeApi(
      signedIn(OWNER, { 'PUT /api/users/u1/password': () => ({ status: 204, body: null }) }),
    );
    window.location.hash = '#/staff/u1';
    show(api);
    fireEvent.click(await screen.findByRole('button', { name: en.staff.password.give }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(en.staff.password.temporary), {
      target: { value: 'start here 2026' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: en.staff.password.save }));
    expect(await screen.findByText(i18n.t('staff.password.saved', { name: 'Asif Khan' }))).toBeDefined();
    expect(calls.find((c) => c.route === 'PUT /api/users/u1/password')?.body).toEqual({
      temporaryPassword: 'start here 2026',
    });
  });

  it('changes the roles', async () => {
    const { api, calls } = fakeApi(
      signedIn(OWNER, { 'PUT /api/users/u1/roles': () => ({ status: 204, body: null }) }),
    );
    window.location.hash = '#/staff/u1';
    show(api);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Cashier' }));
    fireEvent.click(screen.getByRole('button', { name: en.staff.saveRoles }));
    expect(await screen.findByText(en.staff.rolesSaved)).toBeDefined();
    expect(calls.find((c) => c.route === 'PUT /api/users/u1/roles')?.body).toEqual({
      roles: [
        { roleId: 'r-sales', branchId: null },
        { roleId: 'r-cash', branchId: null },
      ],
    });
  });

  it('deactivates after a confirmation, and explains a refusal', async () => {
    let refuse = false;
    const { api, calls } = fakeApi(
      signedIn(OWNER, {
        'POST /api/users/u1/deactivate': () =>
          refuse ? { status: 409, body: { error: 'last_owner' } } : { status: 204, body: null },
      }),
    );
    window.location.hash = '#/staff/u1';
    show(api);
    fireEvent.click(await screen.findByRole('button', { name: en.staff.deactivate }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(i18n.t('staff.deactivateConfirm', { name: 'Asif Khan' }))).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: en.staff.deactivate }));
    expect(await screen.findByText(i18n.t('staff.deactivated', { name: 'Asif Khan' }))).toBeDefined();
    expect(calls.map((c) => c.route)).toContain('POST /api/users/u1/deactivate');

    refuse = true;
    fireEvent.click(await screen.findByRole('button', { name: en.staff.deactivate }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.staff.deactivate }));
    expect(await screen.findByText(en.staff.errors.last_owner)).toBeDefined();
  });

  it('a manager on a person’s page sees the PIN action only', async () => {
    window.location.hash = '#/staff/u1';
    show(fakeApi(signedIn(MANAGER)).api);
    expect(await screen.findByRole('heading', { name: 'Asif Khan' })).toBeDefined();
    expect(screen.getByRole('button', { name: en.staff.give })).toBeDefined();
    expect(screen.queryByRole('button', { name: en.staff.deactivate })).toBeNull();
    expect(screen.queryByRole('button', { name: en.staff.password.give })).toBeNull();
    expect(screen.queryByRole('button', { name: en.staff.saveRoles })).toBeNull();
  });
});

describe('Counters', () => {
  it('creates a one-time code and revokes a counter', async () => {
    const { api, calls } = fakeApi(
      signedIn(OWNER, {
        'POST /api/devices/enrollment-codes': () => ({
          status: 201,
          body: { code: 'K7Q2-M9XD', expiresAt: '2026-10-25T06:00:00.000Z' },
        }),
        'POST /api/devices/d1/revoke': () => ({ status: 204, body: null }),
      }),
    );
    window.location.hash = '#/counters';
    show(api);
    fireEvent.click(await screen.findByRole('button', { name: en.counters.create }));
    expect(await screen.findByText('K7Q2-M9XD')).toBeDefined();
    expect(calls.find((c) => c.route === 'POST /api/devices/enrollment-codes')?.body).toEqual({
      branchId: 'b1',
      kind: 'counter',
    });
    const row = screen.getByText('C01').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: `${en.counters.revoke} C01` }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.counters.confirmRevoke }));
    await screen.findByText(i18n.t('counters.revoked', { code: 'C01' }));
    expect(calls.map((c) => c.route)).toContain('POST /api/devices/d1/revoke');
  });
});

// W1-07 (PLT-09, owner answer 3): each counter's health from its last push, and Re-enable for a revoked one.
describe('Counters: health and Re-enable (W1-07)', () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const device = (over: Record<string, unknown>) => ({
    id: 'd1',
    code: 'C01',
    name: null,
    kind: 'counter',
    branchId: 'b1',
    status: 'active',
    enrolledAt: '2026-10-25T05:00:00.000Z',
    revokedAt: null,
    health: null,
    ...over,
  });
  const health = (over: Record<string, unknown> = {}) => ({
    lastSeenAt: ago(1),
    lastPushAt: ago(1),
    lastPullAt: ago(1),
    clientVersion: '0.7.0',
    schemaVersion: 6,
    outboxCount: 0,
    oldestUnsyncedAt: null,
    quarantinedCount: 0,
    storagePersisted: true,
    storageUsage: 41_000_000,
    storageQuota: 2_000_000_000,
    clockSkewMs: 800,
    openGaps: 0,
    ...over,
  });
  /** The tone of the chip with `text` in `row`; a text ending in a space matches the chip that starts with it. */
  const tone = (row: HTMLElement, text: string) =>
    within(row)
      .getByText(text.endsWith(' ') ? (t) => t.startsWith(text) : text)
      .closest('[data-tone]')
      ?.getAttribute('data-tone');

  it('shows each counter’s health, colouring what needs an eye', async () => {
    const { api } = fakeApi(
      signedIn(OWNER, {
        'GET /api/devices': () => ({
          status: 200,
          body: [
            device({ health: health() }),
            device({
              id: 'd2',
              code: 'C02',
              health: health({
                outboxCount: 3,
                oldestUnsyncedAt: ago(300),
                quarantinedCount: 1,
                storagePersisted: false,
                clockSkewMs: -420_000,
                openGaps: 2,
                clientVersion: '0.6.0',
              }),
            }),
            device({ id: 'd3', code: 'C03' }),
          ],
        }),
      }),
    );
    window.location.hash = '#/counters';
    show(api);
    const fine = (await screen.findByText('C01')).closest('tr')!;
    expect(tone(fine, en.counters.waitingNone)).toBe('ok');
    expect(tone(fine, en.counters.clockOk)).toBe('ok');
    expect(within(fine).getByText('0.7.0')).toBeDefined();

    const troubled = screen.getByText('C02').closest('tr')!;
    expect(within(troubled).getByText('0.6.0')).toBeDefined();
    expect(tone(troubled, '3 since ')).toBe('bad');
    expect(tone(troubled, i18n.t('counters.attention', { count: 1 }))).toBe('bad');
    expect(tone(troubled, i18n.t('counters.clockOff', { minutes: 7 }))).toBe('bad');
    expect(tone(troubled, en.counters.storageBad)).toBe('bad');
    expect(tone(troubled, i18n.t('counters.gapsOpen', { count: 2 }))).toBe('bad');

    const unseen = screen.getByText('C03').closest('tr')!;
    expect(within(unseen).getByText(en.counters.notSeen)).toBeDefined();
  });

  it('bills waiting over 10 minutes are amber, under it plain', async () => {
    const { api } = fakeApi(
      signedIn(OWNER, {
        'GET /api/devices': () => ({
          status: 200,
          body: [
            device({ health: health({ outboxCount: 1, oldestUnsyncedAt: ago(15) }) }),
            device({ id: 'd2', code: 'C02', health: health({ outboxCount: 1, oldestUnsyncedAt: ago(2) }) }),
          ],
        }),
      }),
    );
    window.location.hash = '#/counters';
    show(api);
    expect(tone((await screen.findByText('C01')).closest('tr')!, '1 since ')).toBe('warn');
    expect(tone(screen.getByText('C02').closest('tr')!, '1 since ')).toBe('neutral');
  });

  it('re-enables a revoked counter after a confirmation', async () => {
    const { api, calls } = fakeApi(
      signedIn(OWNER, {
        'GET /api/devices': () => ({
          status: 200,
          body: [device({ status: 'revoked', revokedAt: '2026-10-28T09:00:00.000Z' })],
        }),
        'POST /api/devices/d1/reenable': () => ({ status: 204, body: null }),
      }),
    );
    window.location.hash = '#/counters';
    show(api);
    const row = (await screen.findByText('C01')).closest('tr')!;
    expect(within(row).queryByRole('button', { name: `${en.counters.revoke} C01` })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: `${en.counters.reenable} C01` }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.counters.confirmReenable }));
    await screen.findByText(i18n.t('counters.reenabled', { code: 'C01' }));
    expect(calls.map((c) => c.route)).toContain('POST /api/devices/d1/reenable');
  });
});
