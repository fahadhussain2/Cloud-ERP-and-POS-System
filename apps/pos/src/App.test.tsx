import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isBillOpen } from './bill/bill-open';
import type { OpenBill } from './bill/open-bill';
import type { BillItem, SearchResult } from './search/search-index';

import { App } from './App';
import type { Counter } from './counter';
import type { DeviceInfo } from './db/repo';
import { i18n } from './i18n';
import en from './locales/en.json';
import { ROLE_TEMPLATES, type Money, type RoleGrant } from '@erp/domain';
import type { StaffUser } from './unlock/unlock';

// The counter's screens over a fake counter (POS spec §3-§7). The PIN check is a plain comparison here; the real
// one is PBKDF2 in the database worker.

const DEVICE: DeviceInfo = { deviceId: 'd', tenantId: 't', branchId: 'b', code: 'C01', kind: 'counter' };
const staff = (over: Partial<StaffUser> = {}): StaffUser => ({
  id: 'u1',
  fullName: 'Asif Khan',
  shortCode: '12',
  pinVerifier: '4831',
  pinMustChange: false,
  status: 'active',
  deletedAt: null,
  ...over,
});

const fakeCounter = (over: Partial<Counter> = {}) => {
  let device: DeviceInfo | null = DEVICE;
  const pins = new Map<string, { failures: number; locked: boolean }>();
  const calls: string[] = [];
  const counter: Counter = {
    checkStorage: () =>
      Promise.resolve({ ok: true, health: { schemaVersion: 1, quickCheck: 'ok', outboxCount: 0 } }),
    device: () => Promise.resolve(device),
    enroll: (input) => {
      calls.push(`enroll ${input.tenantCode} ${input.code}`);
      device = DEVICE;
      return Promise.resolve({ ok: true });
    },
    pull: () => {
      calls.push('pull');
      return Promise.resolve({ ok: true, rows: 0 });
    },
    staff: () => Promise.resolve([staff()]),
    settings: () =>
      Promise.resolve({
        name: 'Delux Autos',
        closingTime: '22:00',
        timeZone: 'Asia/Karachi',
        locale: 'en-PK',
        currency: 'PKR',
        minorUnits: 2,
      }),
    getPinState: (id) => Promise.resolve(pins.get(id) ?? { failures: 0, locked: false }),
    setPinState: (id, s) => {
      pins.set(id, s);
      return Promise.resolve();
    },
    verifyPin: (verifier, pin) => Promise.resolve(verifier === pin),
    changePin: (b) => {
      calls.push(`changePin ${b.userId} ${b.currentPin} ${b.newPin}`);
      return Promise.resolve('ok');
    },
    status: () => Promise.resolve({ outboxCount: 0, lastSyncAt: '2026-10-25T05:30:00.000Z' }),
    log: () => Promise.resolve(),
    search: () => Promise.resolve([]),
    catalog: () => Promise.resolve({ items: 0, ready: true }),
    grants: () => Promise.resolve([]),
    tiers: () => Promise.resolve([{ id: 't-retail', code: 'RETAIL', name: 'Retail', isDefault: true }]),
    billItem: () => Promise.resolve(null),
    tierPrices: () => Promise.resolve({}),
    openBill: () => Promise.resolve(null),
    saveOpenBill: () => Promise.resolve(),
    clearOpenBill: () => Promise.resolve(),
    recordPinEvent: (e) => {
      calls.push(`pinEvent ${e.kind} ${e.userId} ${e.byUserId ?? '-'}`);
      return Promise.resolve();
    },
    ...over,
  };
  return { counter, calls, setDevice: (d: DeviceInfo | null) => (device = d) };
};

const show = (counter: Counter) =>
  render(
    <I18nextProvider i18n={i18n}>
      <App counter={counter} />
    </I18nextProvider>,
  );

const enterPin = (pin: string) => {
  fireEvent.change(screen.getByLabelText(en.unlock.pin), { target: { value: pin } });
  fireEvent.click(screen.getByRole('button', { name: en.unlock.submit }));
};

afterEach(cleanup);

describe('counter screens', () => {
  it('stop the counter, with what to do, when a storage check fails', async () => {
    const { counter } = fakeCounter({
      checkStorage: () => Promise.resolve({ ok: false, problem: 'not_persistent' }),
    });
    show(counter);
    expect(await screen.findByText(en.stop.not_persistent)).toBeDefined();
    expect(screen.queryByText(en.unlock.title)).toBeNull();
  });

  it('enroll a new counter with the shop code and a one-time code, then pull and show the staff', async () => {
    const f = fakeCounter();
    f.setDevice(null);
    show(f.counter);
    fireEvent.change(await screen.findByLabelText(en.setup.shopCode), { target: { value: 'delux' } });
    fireEvent.change(screen.getByLabelText(en.setup.code), { target: { value: 'K7Q2-M9XD' } });
    fireEvent.click(screen.getByRole('button', { name: en.setup.submit }));
    expect(await screen.findByRole('button', { name: /Asif Khan/ })).toBeDefined();
    expect(f.calls).toEqual(['enroll delux K7Q2-M9XD', 'pull']);
  });

  it('after setup, show the staff while the first catalog load is still running', async () => {
    let finish = () => {};
    const f = fakeCounter({
      pull: (onPage) => {
        onPage?.();
        return new Promise((resolve) => (finish = () => resolve({ ok: true, rows: 1 })));
      },
    });
    f.setDevice(null);
    show(f.counter);
    fireEvent.change(await screen.findByLabelText(en.setup.shopCode), { target: { value: 'delux' } });
    fireEvent.change(screen.getByLabelText(en.setup.code), { target: { value: 'K7Q2-M9XD' } });
    fireEvent.click(screen.getByRole('button', { name: en.setup.submit }));
    expect(await screen.findByRole('button', { name: /Asif Khan/ })).toBeDefined();
    finish();
  });

  it('unlock with the right PIN; count down wrong ones and lock after the last', async () => {
    const { counter } = fakeCounter();
    show(counter);
    fireEvent.click(await screen.findByRole('button', { name: /Asif Khan/ }));
    enterPin('0000');
    expect(await screen.findByText(i18n.t('unlock.wrong', { count: 4 }))).toBeDefined();
    enterPin('4831');
    expect(await screen.findByRole('combobox')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${en.keys.lock}$`) }));
    fireEvent.click(await screen.findByRole('button', { name: /Asif Khan/ }));
    for (let i = 0; i < 4; i++) {
      enterPin('0000');
      await screen.findByText(i18n.t('unlock.wrong', { count: 4 - i }));
    }
    enterPin('0000');
    expect(await screen.findByText(en.unlock.locked)).toBeDefined();
  });

  // W1-04 plan, POS spec §5: a manager unlocks a locked colleague with their own PIN, offline.
  describe('manager unlock', () => {
    const MANAGER: RoleGrant = {
      permissions: ['admin.devices', 'pos.void'],
      limits: { maxDiscountBp: 10000, voidWindow: 'same_day' },
      branchId: null,
    };
    const SELLER: RoleGrant = {
      permissions: ['pos.sale.create'],
      limits: { maxDiscountBp: 10000, voidWindow: 'none' },
      branchId: null,
    };
    const boss = staff({ id: 'm1', fullName: 'Boss Man', shortCode: '99', pinVerifier: '2468' });
    const zara = staff({ id: 's2', fullName: 'Zara Seller', shortCode: '33', pinVerifier: '1357' });
    const lockAsif = async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Asif Khan/ }));
      for (let i = 0; i < 4; i++) {
        enterPin('0000');
        await screen.findByText(i18n.t('unlock.wrong', { count: 4 - i }));
      }
      enterPin('0000');
      await screen.findByText(en.unlock.locked);
    };

    it('a manager’s PIN unlocks the person, who then unlocks with their own; both events are kept', async () => {
      const f = fakeCounter({
        staff: () => Promise.resolve([staff(), boss, zara]),
        grants: (id) => Promise.resolve(id === 'm1' ? [MANAGER] : [SELLER]),
      });
      show(f.counter);
      await lockAsif();
      expect(f.calls).toContain('pinEvent locked u1 -');
      fireEvent.click(screen.getByRole('button', { name: en.unlock.managerUnlock }));
      expect(await screen.findByText(i18n.t('unlock.managerFor', { name: 'Asif Khan' }))).toBeDefined();
      expect(screen.queryByRole('button', { name: /Asif Khan/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Boss Man/ }));
      fireEvent.change(screen.getByLabelText(en.unlock.managerPin), { target: { value: '2468' } });
      fireEvent.click(screen.getByRole('button', { name: en.unlock.managerSubmit }));
      expect(await screen.findByText(i18n.t('unlock.managerDone', { name: 'Asif Khan' }))).toBeDefined();
      expect(f.calls).toContain('pinEvent unlocked u1 m1');
      enterPin('4831');
      expect(await screen.findByRole('combobox')).toBeDefined();
    });

    it('a salesman’s right PIN is refused and the person stays locked', async () => {
      const f = fakeCounter({
        staff: () => Promise.resolve([staff(), boss, zara]),
        grants: () => Promise.resolve([SELLER]),
      });
      show(f.counter);
      await lockAsif();
      fireEvent.click(screen.getByRole('button', { name: en.unlock.managerUnlock }));
      fireEvent.click(await screen.findByRole('button', { name: /Zara Seller/ }));
      fireEvent.change(screen.getByLabelText(en.unlock.managerPin), { target: { value: '1357' } });
      fireEvent.click(screen.getByRole('button', { name: en.unlock.managerSubmit }));
      expect(await screen.findByText(en.unlock.notAllowed)).toBeDefined();
      expect(f.calls.some((c) => c.startsWith('pinEvent unlocked'))).toBe(false);
    });

    it('a wrong manager PIN says so and counts against the manager', async () => {
      const f = fakeCounter({
        staff: () => Promise.resolve([staff(), boss]),
        grants: () => Promise.resolve([MANAGER]),
      });
      show(f.counter);
      await lockAsif();
      fireEvent.click(screen.getByRole('button', { name: en.unlock.managerUnlock }));
      fireEvent.click(await screen.findByRole('button', { name: /Boss Man/ }));
      fireEvent.change(screen.getByLabelText(en.unlock.managerPin), { target: { value: '0000' } });
      fireEvent.click(screen.getByRole('button', { name: en.unlock.managerSubmit }));
      expect(await screen.findByText(i18n.t('unlock.wrong', { count: 4 }))).toBeDefined();
      expect(await f.counter.getPinState('m1')).toEqual({ failures: 1, locked: false });
    });
  });

  it('locks the counter when a sync deactivates the person who is selling (W1-04)', async () => {
    let disabled = false;
    const f = fakeCounter({
      staff: () => Promise.resolve([staff({ status: disabled ? 'disabled' : 'active' })]),
    });
    show(f.counter);
    fireEvent.click(await screen.findByRole('button', { name: /Asif Khan/ }));
    enterPin('4831');
    expect(await screen.findByRole('combobox')).toBeDefined();
    disabled = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();
    });
    expect(await screen.findByText(en.unlock.title)).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Asif Khan/ })).toBeNull();
  });

  it('typing the short code picks the person', async () => {
    const { counter } = fakeCounter();
    show(counter);
    fireEvent.change(await screen.findByLabelText(en.unlock.shortCode), { target: { value: '12' } });
    expect(await screen.findByLabelText(en.unlock.pin)).toBeDefined();
  });

  it('after a temporary PIN, make the person choose their own before selling', async () => {
    const f = fakeCounter({
      staff: () => Promise.resolve([staff({ pinVerifier: '4831', pinMustChange: true })]),
    });
    show(f.counter);
    fireEvent.click(await screen.findByRole('button', { name: /Asif Khan/ }));
    enterPin('4831');
    fireEvent.change(await screen.findByLabelText(en.choosePin.newPin), { target: { value: '1234' } });
    fireEvent.change(screen.getByLabelText(en.choosePin.repeat), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: en.choosePin.submit }));
    expect(await screen.findByText(en.pinProblem.sequence)).toBeDefined();
    fireEvent.change(screen.getByLabelText(en.choosePin.newPin), { target: { value: '7395' } });
    fireEvent.change(screen.getByLabelText(en.choosePin.repeat), { target: { value: '7395' } });
    fireEvent.click(screen.getByRole('button', { name: en.choosePin.submit }));
    expect(await screen.findByRole('combobox')).toBeDefined();
    expect(f.calls).toContain('changePin u1 4831 7395');
  });

  it('a temporary PIN cannot be changed, so cannot sell, while offline', async () => {
    const f = fakeCounter({
      staff: () => Promise.resolve([staff({ pinMustChange: true })]),
      changePin: () => Promise.resolve('offline'),
    });
    show(f.counter);
    fireEvent.click(await screen.findByRole('button', { name: /Asif Khan/ }));
    enterPin('4831');
    fireEvent.change(await screen.findByLabelText(en.choosePin.newPin), { target: { value: '7395' } });
    fireEvent.change(screen.getByLabelText(en.choosePin.repeat), { target: { value: '7395' } });
    fireEvent.click(screen.getByRole('button', { name: en.choosePin.submit }));
    expect(await screen.findByText(en.choosePin.offline)).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('the status bar shows the counter, the bills waiting and when the counter went offline', async () => {
    const { counter } = fakeCounter({
      pull: () => Promise.resolve({ ok: false, reason: 'offline' }),
      status: () => Promise.resolve({ outboxCount: 3, lastSyncAt: null }),
    });
    show(counter);
    expect(await screen.findByText('C01')).toBeDefined();
    expect(await screen.findByText(i18n.t('status.waiting', { count: 3 }))).toBeDefined();
    await waitFor(() => expect(screen.getByText(/^Offline since/)).toBeDefined());
  });

  // Bug (owner, 2026-10-26): switching Wi-Fi off or on showed only after the next pull (up to 60 s) or an unlock.
  it('shows offline as soon as the browser loses the network, without waiting for a pull', async () => {
    const f = fakeCounter();
    show(f.counter);
    expect(await screen.findByText(en.status.online)).toBeDefined();
    const pulls = f.calls.filter((c) => c === 'pull').length;
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(await screen.findByText(/^Offline since/)).toBeDefined();
    expect(f.calls.filter((c) => c === 'pull').length).toBe(pulls);
  });

  it('when the network comes back, retries the pull until one succeeds and shows online', async () => {
    let online = false;
    const f = fakeCounter({
      pull: () => Promise.resolve(online ? { ok: true, rows: 0 } : { ok: false, reason: 'offline' }),
    });
    show(f.counter);
    expect(await screen.findByText(/^Offline since/)).toBeDefined();
    // From here the clock moves only when the test says, so a busy machine can't change the retry schedule.
    vi.useFakeTimers();
    try {
      // The browser says online before the connection really works: the first pull still fails.
      await act(async () => {
        window.dispatchEvent(new Event('online'));
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(screen.queryByText(en.status.online)).toBeNull();
      online = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.getByText(en.status.online)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the counter screen (W1-03)', () => {
  const result = (code: string, over: Partial<SearchResult> = {}): SearchResult => ({
    id: code,
    code,
    name: `PART ${code}`,
    variant: null,
    spec: null,
    oem: null,
    vehicle: null,
    bin: null,
    status: 'active',
    price: 450000,
    rank: 4,
    ...over,
  });
  const unlocked = async (counter: Counter) => {
    show(counter);
    fireEvent.click(await screen.findByRole('button', { name: /Asif Khan/ }));
    enterPin('4831');
    return screen.findByRole('combobox');
  };
  const plain = (s: string | null) => (s ?? '').replace(/\u00a0/g, ' ');

  it('searches as you type and shows code, name, OEM, vehicle, bin and the price in rupees', async () => {
    const searched: string[] = [];
    const { counter } = fakeCounter({
      search: (text) => {
        searched.push(text);
        return Promise.resolve([
          result('BRPD001', {
            name: 'BRAKE PADS FRONT COROLLA',
            variant: 'FRONT',
            oem: '04465-02220',
            vehicle: { make: 'TOYOTA', model: 'COROLLA', yearFrom: 2009, yearTo: 2014 },
            bin: 'R3-B2',
          }),
          result('BRPD003', { status: 'dormant', price: null }),
        ]);
      },
    });
    const box = await unlocked(counter);
    fireEvent.change(box, { target: { value: 'pads corolla' } });
    const options = await screen.findAllByRole('option');
    expect(searched).toEqual(['pads corolla']);
    expect(options[0]!.textContent).toContain('BRAKE PADS FRONT COROLLA');
    expect(options[0]!.textContent).toContain('OEM 04465-02220');
    expect(options[0]!.textContent).toContain('TOYOTA COROLLA 2009–2014');
    expect(options[0]!.textContent).toContain('Bin R3-B2');
    expect(plain(options[0]!.textContent)).toContain('Rs 4,500');
    expect(options[1]!.textContent).toContain(en.item.status.dormant);
    expect(options[1]!.textContent).toContain(en.search.noPrice);
  });

  it('moves the selection with the arrow keys, F2 goes back to the search, Esc clears it', async () => {
    const { counter } = fakeCounter({ search: () => Promise.resolve([result('A1'), result('B2')]) });
    const box = await unlocked(counter);
    fireEvent.change(box, { target: { value: 'part' } });
    await screen.findAllByRole('option');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    expect(box.getAttribute('aria-activedescendant')).toBe('results-1');
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: 'F2' });
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect((box as HTMLInputElement).value).toBe('');
    expect(screen.queryAllByRole('option')).toEqual([]);
  });

  it('never shows an older answer over a newer one', async () => {
    const answers = new Map<string, (r: SearchResult[]) => void>();
    const { counter } = fakeCounter({
      search: (text) => new Promise((resolve) => answers.set(text, resolve)),
    });
    const box = await unlocked(counter);
    fireEvent.change(box, { target: { value: 'b' } });
    fireEvent.change(box, { target: { value: 'br' } });
    answers.get('br')!([result('NEW1')]);
    expect((await screen.findAllByRole('option'))[0]!.textContent).toContain('NEW1');
    answers.get('b')!([result('OLD1')]);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('NEW1'),
    ]);
  });

  it('shows the first catalog load until it is complete, then the search', async () => {
    let status = { items: 1200, ready: false };
    const { counter } = fakeCounter({ catalog: () => Promise.resolve(status) });
    show(counter);
    fireEvent.click(await screen.findByRole('button', { name: /Asif Khan/ }));
    enterPin('4831');
    expect(await screen.findByText(i18n.t('catalog.loading', { count: 1200 }))).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
    status = { items: 19552, ready: true };
    expect(await screen.findByRole('combobox', {}, { timeout: 3000 })).toBeDefined();
  });

  it('Alt+L locks the counter', async () => {
    const { counter } = fakeCounter();
    await unlocked(counter);
    fireEvent.keyDown(window, { key: 'l', altKey: true });
    expect(await screen.findByText(en.unlock.title)).toBeDefined();
  });
});

describe('the bill (W1-05, POS spec §10–§11)', () => {
  const ITEMS: Record<string, BillItem> = {
    BRPD001: {
      itemId: 'BRPD001',
      code: 'BRPD001',
      name: 'BRAKE PADS FRONT COROLLA',
      variant: 'FRONT',
      spec: null,
      list: 450000 as Money,
      floor: 400000 as Money,
      allowsFraction: false,
    },
    HOSE001: {
      itemId: 'HOSE001',
      code: 'HOSE001',
      name: 'FUEL HOSE',
      variant: null,
      spec: null,
      list: 20000 as Money,
      floor: 18000 as Money,
      allowsFraction: true,
    },
    BULB009: {
      itemId: 'BULB009',
      code: 'BULB009',
      name: 'BULB H4',
      variant: null,
      spec: null,
      list: null,
      floor: null,
      allowsFraction: false,
    },
  };
  const MECHANIC: Record<string, Money> = { BRPD001: 427500 as Money };
  const priceIn = (id: string, tier: string | null): Money | null =>
    tier === 't-mech' ? (MECHANIC[id] ?? ITEMS[id]!.list) : ITEMS[id]!.list;
  const manager = staff({ id: 'm1', fullName: 'Tariq Manager', shortCode: '41', pinVerifier: '4321' });
  const role = (template: 'manager' | 'salesman'): RoleGrant => ({
    ...ROLE_TEMPLATES[template],
    branchId: null,
  });

  const billCounter = (over: Partial<Counter> = {}) => {
    const bills = new Map<string, OpenBill>();
    const f = fakeCounter({
      staff: () => Promise.resolve([staff(), manager]),
      grants: (id) => Promise.resolve([role(id === 'm1' ? 'manager' : 'salesman')]),
      tiers: () =>
        Promise.resolve([
          { id: 't-retail', code: 'RETAIL', name: 'Retail', isDefault: true },
          { id: 't-mech', code: 'MECHANIC', name: 'Mechanic', isDefault: false },
        ]),
      search: (text, opts) =>
        Promise.resolve(
          Object.values(ITEMS)
            .filter((i) => `${i.code} ${i.name}`.toLowerCase().includes(text.trim().toLowerCase()))
            .map((i) => ({
              id: i.itemId,
              code: i.code,
              name: i.name,
              variant: i.variant,
              spec: i.spec,
              oem: null,
              vehicle: null,
              bin: null,
              status: 'active',
              price: priceIn(i.itemId, opts?.tierId ?? null),
              rank: 1 as const,
            })),
        ),
      billItem: (id, tier) => Promise.resolve(ITEMS[id] ? { ...ITEMS[id], list: priceIn(id, tier) } : null),
      tierPrices: (ids, tier) =>
        Promise.resolve(Object.fromEntries(ids.map((id) => [id, priceIn(id, tier)]))),
      openBill: (u) => Promise.resolve(bills.get(u) ?? null),
      saveOpenBill: (u, b) => {
        bills.set(u, b);
        return Promise.resolve();
      },
      clearOpenBill: (u) => {
        bills.delete(u);
        return Promise.resolve();
      },
      ...over,
    });
    return { ...f, bills };
  };

  const unlockAs = async (name: RegExp, pin: string) => {
    fireEvent.click(await screen.findByRole('button', { name }));
    enterPin(pin);
    return screen.findByRole('combobox');
  };
  const plain = (s: string | null | undefined) => (s ?? '').replaceAll(String.fromCharCode(160), ' ');
  const total = () => plain(screen.queryByTestId('bill-total')?.textContent);
  // `hidden`: an open dialog hides the page from the accessibility tree, and the lines are still checked behind it.
  const lines = () =>
    within(screen.getByRole('listbox', { name: en.keys.lines, hidden: true })).getAllByRole('option', {
      hidden: true,
    });
  const add = async (box: HTMLElement, text: string) => {
    fireEvent.change(box, { target: { value: text } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect((box as HTMLInputElement).value).toBe(''));
  };
  const billPanel = () => screen.getByRole('region', { name: en.bill.title });
  const key = (k: string, extra: Record<string, unknown> = {}) =>
    fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...extra });
  const action = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}`) });

  it('Enter adds the selected result at the tier price; 3* adds three; the same item again joins its line', async () => {
    const { counter } = billCounter();
    show(counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    expect(await screen.findByText(en.bill.empty)).toBeDefined();
    await add(box, 'brpd');
    expect(total()).toBe('Rs 4,500');
    await add(box, '3*brpd');
    expect(lines()).toHaveLength(1);
    expect(lines()[0]!.textContent).toContain('×4');
    expect(total()).toBe('Rs 18,000');
    expect(isBillOpen()).toBe(true);
  });

  it('a scan (the code then Enter at once) adds the exact match before the results are shown', async () => {
    const { counter } = billCounter();
    show(counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    fireEvent.change(box, { target: { value: 'HOSE001' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(total()).toBe('Rs 200'));
  });

  it('Tab moves to the lines: + − change the quantity, Q sets it, Del removes, a letter goes back to search', async () => {
    const { counter } = billCounter();
    show(counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    await add(box, 'brpd');
    await add(box, '1.5*hose');
    expect(lines()[1]!.textContent).toContain('×1.5');
    fireEvent.keyDown(box, { key: 'Tab' });
    await waitFor(() => expect(document.activeElement).toBe(billPanel()));
    // The line just added is the selected one.
    expect(lines()[1]!.getAttribute('aria-selected')).toBe('true');
    key('ArrowUp');
    key('+');
    expect(lines()[0]!.textContent).toContain('×2');
    key('-');
    expect(lines()[0]!.textContent).toContain('×1');
    key('ArrowDown');
    key('q');
    fireEvent.change(await screen.findByLabelText(en.qty.label), { target: { value: '2.25' } });
    fireEvent.click(action(en.qty.action));
    await waitFor(() => expect(lines()[1]!.textContent).toContain('×2.25'));
    expect(total()).toBe('Rs 4,950');
    await waitFor(() => expect(document.activeElement).toBe(billPanel()));
    key('Delete');
    expect(lines()).toHaveLength(1);
    key('b');
    expect(document.activeElement).toBe(box);
    expect((box as HTMLInputElement).value).toBe('b');
  });

  it('a whole-unit item refuses a fraction and says why', async () => {
    const { counter } = billCounter();
    show(counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    await add(box, 'brpd');
    fireEvent.keyDown(box, { key: 'Tab' });
    await waitFor(() => expect(document.activeElement).toBe(billPanel()));
    key('q');
    fireEvent.change(await screen.findByLabelText(en.qty.label), { target: { value: '1.5' } });
    fireEvent.click(action(en.qty.action));
    expect(await screen.findByText(en.error.invalid_quantity)).toBeDefined();
  });

  it('a price within the rules needs nobody; below the floor asks an approver, whose wrong PIN counts', async () => {
    const f = billCounter();
    show(f.counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    await add(box, 'brpd');
    fireEvent.keyDown(box, { key: 'Tab' });
    await waitFor(() => expect(document.activeElement).toBe(billPanel()));
    key('p');
    fireEvent.change(await screen.findByLabelText(en.price.label), { target: { value: '4,200' } });
    fireEvent.click(action(en.price.action));
    await waitFor(() => expect(plain(lines()[0]!.textContent)).toContain('Bargained −Rs 300'));
    expect(screen.queryByText(en.approval.title)).toBeNull();

    await waitFor(() => expect(document.activeElement).toBe(billPanel()));
    key('p');
    fireEvent.change(await screen.findByLabelText(en.price.label), { target: { value: '3800' } });
    fireEvent.click(action(en.price.action));
    expect(await screen.findByText(en.approval.title)).toBeDefined();
    expect(screen.getByText(en.approval.below_floor)).toBeDefined();
    expect(plain(lines()[0]!.textContent)).toContain(en.bill.needsApproval);

    // A salesman's right PIN can't approve; a wrong manager PIN counts towards the manager's lock.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Asif Khan/ }));
    fireEvent.change(screen.getByLabelText(en.approval.pin), { target: { value: '4831' } });
    fireEvent.click(action(en.approval.action));
    expect(await screen.findByText(en.approval.notAllowed)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: en.approval.back }));
    fireEvent.change(screen.getByLabelText(en.unlock.shortCode), { target: { value: '41' } });
    fireEvent.change(screen.getByLabelText(en.approval.pin), { target: { value: '0000' } });
    fireEvent.click(action(en.approval.action));
    expect(await screen.findByText(i18n.t('approval.wrong', { count: 4 }))).toBeDefined();
    expect(await f.counter.getPinState('m1')).toEqual({ failures: 1, locked: false });

    // "Other" needs a note; then the right PIN approves (Enter), and the line says who and why.
    fireEvent.click(screen.getByLabelText(en.override.reason.other));
    fireEvent.change(screen.getByLabelText(en.approval.pin), { target: { value: '4321' } });
    fireEvent.submit(screen.getByLabelText(en.approval.pin).closest('form')!);
    expect(await screen.findByText(en.approval.noteRequired)).toBeDefined();
    fireEvent.click(screen.getByLabelText(en.override.reason.customer_bargain));
    fireEvent.submit(screen.getByLabelText(en.approval.pin).closest('form')!);
    await waitFor(() => expect(screen.queryByText(en.approval.title)).toBeNull());
    expect(plain(lines()[0]!.textContent)).toContain('Approved by Tariq Manager · Customer bargain');
    expect(await f.counter.getPinState('m1')).toEqual({ failures: 0, locked: false });
    expect(f.bills.get('u1')!.bill.lines[0]!.approval).toMatchObject({
      kind: 'below_floor',
      requestedBy: 'u1',
      approvedBy: 'm1',
      reason: 'customer_bargain',
    });
  });

  it('an item without a price is added with a typed one and an approval', async () => {
    const { counter } = billCounter();
    show(counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    fireEvent.change(box, { target: { value: 'bulb' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(await screen.findByLabelText(en.price.label), { target: { value: '650' } });
    fireEvent.click(action(en.price.action));
    expect(await screen.findByText(en.approval.title)).toBeDefined();
    expect(total()).toBe('Rs 650');
  });

  it('F7 moves the bill to another tier: lines at list take its price', async () => {
    const { counter } = billCounter();
    show(counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    await add(box, 'brpd');
    key('F7');
    fireEvent.click(await screen.findByLabelText('Mechanic'));
    fireEvent.click(action(en.tier.action));
    await waitFor(() => expect(total()).toBe('Rs 4,275'));
    expect(screen.getByText(i18n.t('bill.tierPrices', { tier: 'Mechanic' }))).toBeDefined();
  });

  it('D gives a bill discount, as an amount or a percent', async () => {
    const { counter } = billCounter();
    show(counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    await add(box, '2*brpd');
    fireEvent.keyDown(box, { key: 'Tab' });
    await waitFor(() => expect(document.activeElement).toBe(billPanel()));
    key('d');
    fireEvent.change(await screen.findByLabelText(en.discount.label), { target: { value: '5%' } });
    fireEvent.click(action(en.discount.action));
    await waitFor(() => expect(total()).toBe('Rs 8,550'));
    expect(screen.queryByText(en.approval.title)).toBeNull();
  });

  it('the bill waits for the same person after a lock; another person starts with their own', async () => {
    const { counter } = billCounter();
    show(counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    await add(box, 'brpd');
    key('l', { altKey: true });
    await screen.findByText(en.unlock.title);
    expect(isBillOpen()).toBe(false);
    await unlockAs(/Tariq Manager/, '4321');
    expect(await screen.findByText(en.bill.empty)).toBeDefined();
    key('l', { altKey: true });
    await unlockAs(/Asif Khan/, '4831');
    await waitFor(() => expect(total()).toBe('Rs 4,500'));
  });

  it('Alt+C asks, then clears the bill', async () => {
    const f = billCounter();
    show(f.counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    await add(box, 'brpd');
    key('c', { altKey: true });
    await screen.findByText(en.clear.title);
    fireEvent.click(action(en.clear.action));
    expect(await screen.findByText(en.bill.empty)).toBeDefined();
    expect(f.bills.has('u1')).toBe(false);
    expect(isBillOpen()).toBe(false);
  });

  it('the key bar follows the zone, and each hint does what its key does', async () => {
    const { counter } = billCounter();
    show(counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    fireEvent.change(box, { target: { value: 'brpd' } });
    await screen.findAllByRole('option');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.keys.add) }));
    await waitFor(() => expect(total()).toBe('Rs 4,500'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.keys.toLines) }));
    const bar = await screen.findByRole('contentinfo', { name: en.keys.lines });
    fireEvent.click(within(bar).getByRole('button', { name: new RegExp(en.keys.qty) }));
    await waitFor(() => expect(lines()[0]!.textContent).toContain('×2'));
    fireEvent.click(within(bar).getByRole('button', { name: new RegExp(en.keys.remove) }));
    expect(await screen.findByText(en.bill.empty)).toBeDefined();
  });

  // Review of PR #74.
  it('a price above list shows as added money, with one sign', async () => {
    const { counter } = billCounter();
    show(counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    await add(box, 'brpd');
    fireEvent.keyDown(box, { key: 'Tab' });
    await waitFor(() => expect(document.activeElement).toBe(billPanel()));
    key('p');
    fireEvent.change(await screen.findByLabelText(en.price.label), { target: { value: '4600' } });
    fireEvent.click(action(en.price.action));
    await waitFor(() => expect(total()).toBe('Rs 4,600'));
    const totals = plain(billPanel().textContent);
    expect(totals).toContain(`${en.bill.aboveListTotal}Rs 100`);
    expect(totals).not.toContain('−-');
  });

  it('the price dialog starts from the line’s price as plain text', async () => {
    const { counter } = billCounter();
    show(counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    await add(box, 'brpd');
    fireEvent.keyDown(box, { key: 'Tab' });
    await waitFor(() => expect(document.activeElement).toBe(billPanel()));
    key('p');
    expect((await screen.findByLabelText<HTMLInputElement>(en.price.label)).value).toBe('4500');
  });

  it('says so when the bill can’t be saved on the counter, instead of losing it quietly', async () => {
    const logged: string[] = [];
    const { counter } = billCounter({
      saveOpenBill: () => Promise.reject(new Error('OPFS full')),
      log: (kind) => {
        logged.push(kind);
        return Promise.resolve();
      },
    });
    show(counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    await add(box, 'brpd');
    expect(await screen.findByText(en.bill.saveFailed)).toBeDefined();
    expect(logged).toContain('bill.save_failed');
  });

  it('judges no approval until the seller’s limit is known', async () => {
    const { counter } = billCounter({
      grants: (id) => (id === 'u1' ? new Promise<RoleGrant[]>(() => {}) : Promise.resolve([role('manager')])),
    });
    show(counter);
    const box = await unlockAs(/Asif Khan/, '4831');
    await add(box, 'brpd');
    fireEvent.keyDown(box, { key: 'Tab' });
    await waitFor(() => expect(document.activeElement).toBe(billPanel()));
    key('p');
    fireEvent.change(await screen.findByLabelText(en.price.label), { target: { value: '4200' } });
    fireEvent.click(action(en.price.action));
    await waitFor(() => expect(total()).toBe('Rs 4,200'));
    expect(screen.queryByText(en.approval.title)).toBeNull();
    expect(plain(lines()[0]!.textContent)).not.toContain(en.bill.needsApproval);
  });
});
