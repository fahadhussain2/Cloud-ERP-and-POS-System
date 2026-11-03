import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isBillOpen } from './bill/bill-open';
import type { OpenBill } from './bill/open-bill';
import type { BillItem, SearchResult } from './search/search-index';

import { App } from './App';
import type { Counter, CounterHealth } from './counter';
import type { CheckoutSettings, PaymentMethodRow } from './db/checkout';
import type { CounterCustomer } from './db/customers';
import type { HeldBill } from './db/held';
import type { DeskCheck } from './sync/bills';
import type { DeviceInfo } from './db/repo';
import { i18n } from './i18n';
import type { PrintJob } from './print/print-job';
import en from './locales/en.json';
import {
  buildSaleDocument,
  DomainError,
  ROLE_TEMPLATES,
  type CreditView,
  type Money,
  type RoleGrant,
  type SaleDocument,
  type SaleVoidDocument,
  type Tender,
} from '@erp/domain';
import type { PushOutcome } from './sync/push';
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

const PUSHED: PushOutcome = {
  ok: true,
  accepted: 0,
  duplicate: 0,
  rejected: 0,
  requeued: 0,
  serverTime: '2026-10-25T05:30:00.000Z',
};
const OFFLINE_PUSH: PushOutcome = { ok: false, reason: 'offline' };
const HEALTH: CounterHealth = {
  outboxCount: 2,
  oldestUnsyncedAt: '2026-10-25T05:00:00.000Z',
  quarantinedCount: 1,
  lastPullAt: '2026-10-25T05:30:00.000Z',
  lastPushAt: '2026-10-25T05:31:00.000Z',
  lastContactAt: '2026-10-25T05:31:00.000Z',
  eventsWaiting: 3,
  appVersion: '0.7.0',
  schemaVersion: 6,
  storagePersisted: true,
  storageUsage: 41_000_000,
  storageQuota: 2_000_000_000,
  serverOffsetMs: 1500,
};

const fakeCounter = (over: Partial<Counter> = {}) => {
  let device: DeviceInfo | null = DEVICE;
  const pins = new Map<string, { failures: number; locked: boolean }>();
  const calls: string[] = [];
  // Pushes are counted apart: the scheduler pushes at start-up and after sales, which would crowd the call lists.
  const pushes = { n: 0 };
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
        offlineWarningHours: 8,
        offlineStrongWarningHours: 48,
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
    status: () =>
      Promise.resolve({
        outboxCount: 0,
        lastSyncAt: '2026-10-25T05:30:00.000Z',
        lastContactAt: new Date().toISOString(),
        attention: 0,
      }),
    push: () => {
      pushes.n++;
      return Promise.resolve(PUSHED);
    },
    listen: () => () => undefined,
    health: () => Promise.resolve(HEALTH),
    needsAttention: () => Promise.resolve([]),
    retryBill: (id) => {
      calls.push(`retry ${id}`);
      return Promise.resolve(true);
    },
    prune: () => Promise.resolve(0),
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
    holdBill: () => Promise.reject(new Error('no bill')),
    heldBills: () => Promise.resolve([]),
    recallBill: () => Promise.reject(new Error('no held bill')),
    clearHeld: () => Promise.resolve(false),
    voidableBills: () => Promise.resolve([]),
    deskCheck: () => Promise.resolve({ status: 'unknown', at: null, cashierName: null }),
    voidBill: () => Promise.reject(new Error('no bill')),
    voidOf: () => Promise.resolve(null),
    recordPinEvent: (e) => {
      calls.push(`pinEvent ${e.kind} ${e.userId} ${e.byUserId ?? '-'}`);
      return Promise.resolve();
    },
    checkout: () => Promise.resolve(null),
    finalize: () => Promise.reject(new Error('no bill')),
    recentBills: () => Promise.resolve([]),
    bill: () => Promise.resolve(null),
    findBills: () => Promise.resolve([]),
    returnableBill: () => Promise.resolve(null),
    noReceiptPrice: () => Promise.resolve(null),
    returnPolicy: (ids) => Promise.resolve({ windowDays: 30, items: ids.map(() => ({})) }),
    recordReprint: () => Promise.reject(new Error('no bill')),
    print: () => {},
    customers: () => Promise.resolve([]),
    creditFigures: () => Promise.reject(new Error('no customer')),
    deskState: () => Promise.resolve({ session: null, queue: [], local: [] }),
    openSession: () => Promise.reject(new Error('not a cash desk')),
    closeSession: () => Promise.reject(new Error('not a cash desk')),
    confirmHandover: () => Promise.reject(new Error('not a cash desk')),
    deskLookups: () => Promise.reject(new Error('not a cash desk')),
    deskCustomer: () => Promise.resolve(null),
    receiveCollection: () => Promise.reject(new Error('not a cash desk')),
    recordCashMovement: () => Promise.reject(new Error('not a cash desk')),
    printDesk: () => {},
    ...over,
  };
  return { counter, calls, pushes, setDevice: (d: DeviceInfo | null) => (device = d) };
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
      push: () => Promise.resolve(OFFLINE_PUSH),
      status: () => Promise.resolve({ outboxCount: 3, lastSyncAt: null, lastContactAt: null, attention: 0 }),
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
      push: () => Promise.resolve(online ? PUSHED : OFFLINE_PUSH),
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
    const held: HeldBill[] = [];
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
      // Held bills as the worker keeps them (db/held.ts): each person's own, newest first.
      holdBill: ({ userId, label }) => {
        const bill = bills.get(userId);
        if (!bill || bill.bill.lines.length === 0)
          return Promise.reject(new DomainError('empty_bill', 'nothing to hold'));
        if (held.length >= 20) return Promise.reject(new DomainError('too_many', 'too many'));
        const h: HeldBill = {
          id: `held-${held.length + 1}-${Date.now()}`,
          userId,
          heldAt: new Date().toISOString(),
          businessDate: '2026-11-03',
          label: label?.trim() || null,
          bill,
        };
        held.unshift(h);
        bills.delete(userId);
        return Promise.resolve(h);
      },
      heldBills: (userId) => Promise.resolve(held.filter((h) => h.userId === userId)),
      recallBill: ({ id, userId, swap }) => {
        const i = held.findIndex((h) => h.id === id && h.userId === userId);
        if (i < 0) return Promise.reject(new DomainError('not_found', 'gone'));
        const [h] = held.splice(i, 1);
        const open = bills.get(userId);
        if (open && open.bill.lines.length > 0) {
          if (!swap) return Promise.reject(new DomainError('bill_open', 'open bill'));
          held.unshift({ ...h!, id: `held-swap-${Date.now()}`, label: swap.label, bill: open });
        }
        bills.set(userId, h!.bill);
        return Promise.resolve(h!.bill);
      },
      clearHeld: (id, userId) => {
        const i = held.findIndex((h) => h.id === id && h.userId === userId);
        if (i >= 0) held.splice(i, 1);
        return Promise.resolve(i >= 0);
      },
      ...over,
    });
    return { ...f, bills, held };
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

  describe('hold and recall (POS-08, POS spec §17, W1-12)', () => {
    const plainText = (el: Element | null) => plain(el?.textContent);
    const recallList = () => screen.getByRole('listbox', { name: en.recall.title });

    it('F8 holds the bill with a label and leaves an empty one; Shift+F8 and Enter bring it back as it was', async () => {
      const f = billCounter();
      show(f.counter);
      const box = await unlockAs(/Asif Khan/, '4831');
      await add(box, '2*brpd');
      key('F8');
      fireEvent.change(await screen.findByLabelText(en.hold.label), { target: { value: '  Blue Suzuki ' } });
      fireEvent.click(action(en.hold.action));
      expect(await screen.findByText(en.bill.empty)).toBeDefined();
      expect(screen.getByText(/Bill held: Blue Suzuki/)).toBeDefined();
      expect(f.held.map((h) => h.label)).toEqual(['Blue Suzuki']);
      expect(screen.getByRole('button', { name: /Recall \(1\)/ })).toBeDefined();
      key('F8', { shiftKey: true });
      await waitFor(() => expect(plainText(recallList())).toContain('Blue Suzuki'));
      expect(plainText(recallList())).toContain('Rs 9,000');
      key('Enter');
      await waitFor(() => expect(total()).toBe('Rs 9,000'));
      expect(f.held).toEqual([]);
      expect(f.bills.get('u1')?.bill.lines).toHaveLength(1);
    });

    it('an empty bill is not held, and says why', async () => {
      const f = billCounter();
      show(f.counter);
      await unlockAs(/Asif Khan/, '4831');
      await screen.findByText(en.bill.empty);
      key('F8');
      expect(await screen.findByText(en.hold.empty)).toBeDefined();
      expect(screen.queryByLabelText(en.hold.label)).toBeNull();
    });

    it('recalling over a bill with lines asks, then swaps the two', async () => {
      const f = billCounter();
      show(f.counter);
      const box = await unlockAs(/Asif Khan/, '4831');
      await add(box, 'brpd');
      key('F8');
      await screen.findByLabelText(en.hold.label);
      fireEvent.click(action(en.hold.action));
      await screen.findByText(en.bill.empty);
      await add(box, 'hose');
      key('F8', { shiftKey: true });
      await waitFor(() => expect(plainText(recallList())).toContain('Rs 4,500'));
      key('Enter');
      expect(await screen.findByText(/Enter again holds it/)).toBeDefined();
      expect(total()).toBe('Rs 200');
      key('Enter');
      await waitFor(() => expect(total()).toBe('Rs 4,500'));
      expect(f.held.map((h) => h.bill.bill.lines[0]?.unitPrice)).toEqual([20000]);
    });

    it('Del clears a held bill after a second Del', async () => {
      const f = billCounter();
      show(f.counter);
      const box = await unlockAs(/Asif Khan/, '4831');
      await add(box, 'brpd');
      key('F8');
      await screen.findByLabelText(en.hold.label);
      fireEvent.click(action(en.hold.action));
      await screen.findByText(en.bill.empty);
      key('F8', { shiftKey: true });
      await waitFor(() => expect(plainText(recallList())).toContain('Rs 4,500'));
      key('Delete');
      expect(await screen.findByText(/Its lines are removed for good/)).toBeDefined();
      key('Delete');
      expect(await screen.findByText(en.recall.empty)).toBeDefined();
      expect(f.held).toEqual([]);
    });
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
  describe('paying and printing (W1-06, POS spec §12–§13)', () => {
    const METHODS: PaymentMethodRow[] = [
      { id: 'pm1', code: 'cash', name: 'Cash', isCash: true, requiresReference: false, sort: 1 },
      { id: 'pm3', code: 'raast', name: 'Raast', isCash: false, requiresReference: true, sort: 3 },
      { id: 'pm4', code: 'jazzcash', name: 'JazzCash', isCash: false, requiresReference: true, sort: 4 },
      { id: 'pm7', code: 'on_account', name: 'On account', isCash: false, requiresReference: false, sort: 7 },
    ];
    const SETTINGS: CheckoutSettings = {
      increment: 100 as Money,
      timeZone: 'Asia/Karachi',
      cutoffHour: 4,
      methods: METHODS,
      printProfile: null,
      receiptHeader: [],
    };

    /** A credit customer on the Mechanic tier (POS spec §15): Rs 100,000 limit, Rs 4,500 owed. */
    const KHAN: CounterCustomer = {
      id: 'p1',
      code: 'C0042',
      name: 'Khan Motors',
      phones: ['0300-1234567'],
      city: 'Karachi',
      account: {
        tierId: 't-mech',
        creditAllowed: true,
        creditLimit: 10000000 as Money,
        offlineDailyCap: 2500000 as Money,
      },
      balance: 450000 as Money,
    };

    /** The bill counter, with a finalize that builds the real document from the saved open bill. */
    const payCounter = (over: Partial<Counter> = {}) => {
      let credit: CreditView = {
        account: KHAN.account,
        balance: KHAN.balance,
        balanceAsOf: '2026-11-02T09:00:00.000Z',
        unsynced: 0 as Money,
        offline: false,
        offlineToday: 0 as Money,
      };
      const f = billCounter({
        checkout: () => Promise.resolve(SETTINGS),
        customers: () => Promise.resolve([KHAN]),
        creditFigures: (_id, offline) => Promise.resolve({ ...credit, offline }),
        ...over,
      });
      const docs: SaleDocument[] = [];
      const printed: PrintJob[] = [];
      const reprints: string[] = [];
      const finalized: Tender[] = [];
      f.counter.finalize = (req) => {
        finalized.push(req.tender);
        const ob = f.bills.get(req.userId);
        if (!ob) return Promise.resolve({ document: docs.at(-1)!, repeated: true, handover: null });
        try {
          const document = buildSaleDocument({
            bill: ob.bill,
            tender: req.tender,
            methods: METHODS,
            sellerMaxDiscountBp: 10000,
            customer: { id: ob.customer?.id ?? null, walkinPhone: ob.walkinPhone ?? null },
            credit: ob.customer ? { ...credit, offline: req.offline } : null,
            creditApproval: req.creditApproval,
            reissueOf: ob.reissueOf ?? null,
            context: {
              id: req.id,
              seq: docs.length + 1,
              deviceId: 'd',
              deviceCode: 'C01',
              branchId: 'b',
              createdAtMs: req.createdAtMs,
              timeZone: 'Asia/Karachi',
              cutoffHour: 4,
              increment: 100 as Money,
              clientVersion: req.clientVersion,
            },
          });
          f.bills.delete(req.userId);
          docs.push(document);
          return Promise.resolve({ document, repeated: false, handover: null });
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      f.counter.print = (job) => void printed.push(job);
      f.counter.recentBills = () =>
        Promise.resolve(
          [...docs].reverse().map((d) => ({
            id: d.id,
            number: d.number,
            createdAt: d.createdAt,
            total: d.amounts.total,
            cashDue: d.cashDue,
            voidNumber: null,
          })),
        );
      f.counter.bill = (id) => Promise.resolve(docs.find((d) => d.id === id) ?? null);
      f.counter.recordReprint = (r) => {
        reprints.push(`${r.number} ${r.userId}`);
        return Promise.resolve({ ...r, id: 'r1', pushedAt: null });
      };
      const setCredit = (c: Partial<CreditView>) => {
        credit = { ...credit, ...c };
      };
      // Voids as the worker writes them (db/void.ts), with what the cash desk says set by the test.
      const voids: { req: Parameters<Counter['voidBill']>[0]; void: SaleVoidDocument }[] = [];
      let desk: DeskCheck = { status: 'pending', at: null, cashierName: null };
      const voidOfSale = (id: string) => voids.find((v) => v.void.saleId === id)?.void ?? null;
      f.counter.voidableBills = () =>
        Promise.resolve(
          [...docs]
            .reverse()
            .filter((d) => voidOfSale(d.id) === null)
            .map((d) => ({
              id: d.id,
              number: d.number,
              createdAt: d.createdAt,
              sellerId: d.sellerId,
              customerId: d.customerId,
              total: d.amounts.total,
              cashDue: d.cashDue,
            })),
        );
      f.counter.deskCheck = () => Promise.resolve(desk);
      f.counter.voidBill = (req) => {
        const sale = docs.find((d) => d.id === req.saleId)!;
        const v = {
          number: `C01-V${String(voids.length + 1).padStart(6, '0')}`,
          saleId: sale.id,
          saleNumber: sale.number,
          userId: req.userId,
          approvedBy: req.approverId,
          reason: req.reason,
          note: req.note,
          createdAt: '2026-11-03T09:20:00.000Z',
        } as SaleVoidDocument;
        voids.push({ req, void: v });
        return Promise.resolve({ void: v, sale });
      };
      f.counter.voidOf = (id) => Promise.resolve(voidOfSale(id));
      const setDesk = (d: DeskCheck) => {
        desk = d;
      };
      return { ...f, docs, printed, reprints, finalized, setCredit, voids, setDesk };
    };

    const dialog = () => screen.getByRole('dialog');
    const notice = () => plain(screen.queryByRole('status')?.textContent);
    const finalizeButton = () =>
      within(dialog()).getByRole('button', { name: new RegExp(`^${en.pay.finalize}`) });
    /** What Enter does in a popup: submits its form. */
    const enter = (field: HTMLElement) => fireEvent.submit(field.closest('form')!);
    const sold = async (counter: Counter) => {
      show(counter);
      const box = await unlockAs(/Asif Khan/, '4831');
      await add(box, 'brpd');
      return box;
    };

    it('F9 then Enter with the field empty pays the exact amount, prints after saving and starts a new bill', async () => {
      const f = payCounter();
      const box = await sold(f.counter);
      fireEvent.keyDown(window, { key: 'F9' });
      const received = await within(await screen.findByRole('dialog')).findByLabelText(en.pay.cashReceived);
      expect(plain(screen.getByTestId('pay-total').textContent)).toBe('Rs 4,500');
      enter(received);
      await waitFor(() => expect(f.docs).toHaveLength(1));
      expect(f.docs[0]!.payments).toEqual([
        { method: 'cash', amount: 450000, cashReceived: null, changeDue: 0, reference: null },
      ]);
      expect(f.printed.map((j) => [j.document.number, j.reprint, j.sellerName])).toEqual([
        ['C01-S000001', null, 'Asif Khan'],
      ]);
      expect(f.printed[0]!.items['BRPD001']).toEqual({
        code: 'BRPD001',
        name: 'BRAKE PADS FRONT COROLLA FRONT',
      });
      await waitFor(() =>
        expect(notice()).toBe('Bill C01-S000001 printed · bring Rs 4,500 to the cash desk'),
      );
      expect(await screen.findByText(en.bill.empty)).toBeDefined();
      expect(screen.queryByRole('dialog')).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(box));
    });

    it('the main button does what Enter does', async () => {
      const f = payCounter();
      await sold(f.counter);
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${en.pay.cash}`) }));
      await screen.findByRole('dialog');
      fireEvent.click(finalizeButton());
      await waitFor(() => expect(f.docs).toHaveLength(1));
      expect(f.docs[0]!.cashDue).toBe(450000);
    });

    it('quick cash shows each change and finalizes in one click', async () => {
      const f = payCounter();
      await sold(f.counter);
      fireEvent.keyDown(window, { key: 'F9' });
      const quick = within(await screen.findByRole('group', { name: en.pay.quickCash }));
      expect(quick.getAllByRole('button').map((b) => plain(b.textContent))).toEqual([
        en.pay.exact,
        'Rs 5,000change Rs 500',
        'Rs 10,000change Rs 5,500',
        'Rs 15,000change Rs 10,500',
      ]);
      // Formatted money has a no-break space after Rs: pick the button by its place.
      fireEvent.click(quick.getAllByRole('button')[1]!);
      await waitFor(() => expect(f.docs).toHaveLength(1));
      expect(f.docs[0]!.payments[0]).toMatchObject({ cashReceived: 500000, changeDue: 50000 });
      await waitFor(() =>
        expect(notice()).toBe('Bill C01-S000001 printed · bring Rs 4,500 to the cash desk, change Rs 500'),
      );
    });

    it('typed cash shows the change; less than the total is refused; Esc leaves the bill as it was', async () => {
      const f = payCounter();
      await sold(f.counter);
      fireEvent.keyDown(window, { key: 'F9' });
      const received = await within(await screen.findByRole('dialog')).findByLabelText(en.pay.cashReceived);
      fireEvent.change(received, { target: { value: '5000' } });
      expect(plain(screen.getByTestId('pay-change').textContent)).toBe('Rs 500');
      fireEvent.change(received, { target: { value: '4000' } });
      enter(received);
      expect(await within(dialog()).findByText(en.pay.lessThanTotal)).toBeDefined();
      expect(f.finalized).toHaveLength(0);
      fireEvent.keyDown(received, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(total()).toBe('Rs 4,500');
      expect(lines()).toHaveLength(1);
      expect(f.docs).toHaveLength(0);
    });

    it('Raast needs its reference, labelled for Raast; the bill is then paid without cash', async () => {
      const f = payCounter();
      await sold(f.counter);
      const pad = within(screen.getByRole('group', { name: en.pay.pad }));
      // On account waits for a credit customer (POS spec §15).
      const onAccount = pad.getByRole<HTMLButtonElement>('button', { name: 'On account' });
      expect(onAccount.disabled).toBe(true);
      expect(onAccount.title).toBe(en.credit.needsCustomer);
      fireEvent.click(pad.getByRole('button', { name: 'Raast' }));
      const reference = await within(await screen.findByRole('dialog')).findByLabelText(
        en.pay.reference.raast,
      );
      enter(reference);
      expect(await within(dialog()).findByText(en.tender.reference_required)).toBeDefined();
      fireEvent.change(reference, { target: { value: ' RST-5512 ' } });
      enter(reference);
      await waitFor(() => expect(f.docs).toHaveLength(1));
      expect(f.docs[0]).toMatchObject({
        payments: [{ method: 'raast', amount: 450000, reference: 'RST-5512' }],
        cashDue: 0,
        handoverStatus: 'not_applicable',
      });
      await waitFor(() => expect(notice()).toBe('Bill C01-S000001 printed · paid by Raast'));
    });

    it('Shift+F9 splits: what is still to cover, then cash and JazzCash with cash received', async () => {
      const f = payCounter();
      await sold(f.counter);
      fireEvent.keyDown(window, { key: 'F9', shiftKey: true });
      const d = within(await screen.findByRole('dialog'));
      const left = () => plain(screen.getByTestId('split-left').textContent);
      const cash = d.getByLabelText('Cash amount');
      expect((cash as HTMLInputElement).value).toBe('4500');
      expect(left()).toBe(en.pay.covered);
      expect(d.queryByLabelText('On account amount')).toBeNull();
      fireEvent.change(cash, { target: { value: '2000' } });
      expect(left()).toBe('Rs 2,500 still to cover');
      fireEvent.change(d.getByLabelText('JazzCash amount'), { target: { value: '3000' } });
      expect(left()).toBe('Rs 500 too much');
      fireEvent.change(d.getByLabelText('JazzCash amount'), { target: { value: '2500' } });
      enter(cash);
      expect(await d.findByText(en.tender.reference_required)).toBeDefined();
      fireEvent.change(d.getByLabelText(`JazzCash: ${en.pay.reference.jazzcash}`), {
        target: { value: 'JC-88123' },
      });
      fireEvent.change(d.getByLabelText(en.pay.cashReceived), { target: { value: '5000' } });
      expect(plain(screen.getByTestId('pay-change').textContent)).toBe('Rs 3,000');
      enter(cash);
      await waitFor(() => expect(f.docs).toHaveLength(1));
      expect(f.docs[0]!.payments).toEqual([
        { method: 'cash', amount: 200000, cashReceived: 500000, changeDue: 300000, reference: null },
        { method: 'jazzcash', amount: 250000, cashReceived: null, changeDue: null, reference: 'JC-88123' },
      ]);
      expect(f.docs[0]!.cashDue).toBe(200000);
    });

    it('pay is refused while a price waits for an approval', async () => {
      const f = payCounter();
      const box = await sold(f.counter);
      fireEvent.keyDown(box, { key: 'Tab' });
      await waitFor(() => expect(document.activeElement).toBe(billPanel()));
      key('p');
      fireEvent.change(await screen.findByLabelText(en.price.label), { target: { value: '3500' } });
      fireEvent.click(action(en.price.action));
      // The approval opens by itself; the salesman closes it without one.
      fireEvent.keyDown(await screen.findByText(en.approval.title), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      fireEvent.keyDown(window, { key: 'F9' });
      expect(await screen.findByText(en.pay.approveFirst)).toBeDefined();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(f.finalized).toHaveLength(0);
    });

    it('the pay buttons are off while the bill is empty, and F9 does nothing', async () => {
      const f = payCounter();
      show(f.counter);
      await unlockAs(/Asif Khan/, '4831');
      const pad = within(await screen.findByRole('group', { name: en.pay.pad }));
      expect(
        pad.getByRole<HTMLButtonElement>('button', { name: new RegExp(`^${en.pay.cash}`) }).disabled,
      ).toBe(true);
      fireEvent.keyDown(window, { key: 'F9' });
      await act(() => Promise.resolve());
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    describe('customers and credit (W1-09, POS spec §15)', () => {
      const strip = () =>
        plain(screen.getByRole('region', { name: en.bill.title }).querySelector('span')?.textContent);
      const pickKhan = async (by = '4567') => {
        fireEvent.keyDown(window, { key: 'F4' });
        const d = within(await screen.findByRole('dialog'));
        fireEvent.change(d.getByLabelText(en.customer.search), { target: { value: by } });
        const option = await d.findByRole('option', { name: /Khan Motors/ });
        expect(plain(option.textContent)).toContain('•••• 4567');
        expect(plain(option.textContent)).not.toContain('1234567');
        fireEvent.keyDown(d.getByLabelText(en.customer.search), { key: 'ArrowDown' });
        enter(d.getByLabelText(en.customer.search));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      };

      it('F4 finds a customer by phone and their tier sets the prices; back to walk-in returns to Retail', async () => {
        const f = payCounter();
        await sold(f.counter);
        await pickKhan();
        await waitFor(() => expect(total()).toBe('Rs 4,275'));
        expect(strip()).toContain('Khan Motors (C0042)');
        expect(strip()).toContain('Available Rs 95,500');
        expect(f.bills.get('u1')!.customer).toEqual({ id: 'p1', code: 'C0042', name: 'Khan Motors' });

        // With a customer on the bill, F4 opens on them: ↓ and Enter go back to walk-in.
        fireEvent.keyDown(window, { key: 'F4' });
        const d = within(await screen.findByRole('dialog'));
        expect(d.getAllByRole('option')[0]!.textContent).toContain('Khan Motors');
        fireEvent.keyDown(d.getByLabelText(en.customer.search), { key: 'ArrowDown' });
        enter(d.getByLabelText(en.customer.search));
        await waitFor(() => expect(total()).toBe('Rs 4,500'));
        expect(f.bills.get('u1')!.customer).toBeNull();
      });

      it('On account within the limit: the popup shows the figures, Enter finalizes with no cash', async () => {
        const f = payCounter();
        await sold(f.counter);
        await pickKhan('C0042');
        const pad = within(screen.getByRole('group', { name: en.pay.pad }));
        await waitFor(() =>
          expect(pad.getByRole<HTMLButtonElement>('button', { name: 'On account' }).disabled).toBe(false),
        );
        fireEvent.click(pad.getByRole('button', { name: 'On account' }));
        const d = within(await screen.findByRole('dialog'));
        expect(plain(d.getByTestId('credit-facts').textContent)).toContain('Rs 8,775');
        fireEvent.click(d.getByRole('button', { name: new RegExp(`^${en.pay.finalize}`) }));
        await waitFor(() => expect(f.docs).toHaveLength(1));
        expect(f.docs[0]).toMatchObject({
          customerId: 'p1',
          payments: [{ method: 'on_account', amount: 427500 }],
          cashDue: 0,
          overrides: [],
          credit: { offline: false, balance: 450000 },
        });
        await waitFor(() => expect(notice()).toBe('Bill C01-S000001 printed · paid by On account'));
        expect(f.printed[0]!.customer).toEqual({ code: 'C0042', name: 'Khan Motors' });
      });

      it('over the limit, a manager approves with their own PIN and a credit reason', async () => {
        const f = payCounter();
        f.setCredit({ balance: 9800000 as Money });
        await sold(f.counter);
        await pickKhan('khan');
        fireEvent.click(
          within(screen.getByRole('group', { name: en.pay.pad })).getByRole('button', { name: 'On account' }),
        );
        const d = within(await screen.findByRole('dialog'));
        expect(d.getByText(i18n.t('credit.overLimit', { amount: 'Rs 2,275' }))).toBeDefined();
        fireEvent.click(d.getByRole('button', { name: new RegExp(`^${en.pay.finalize}`) }));
        expect(await screen.findByText(en.approval.credit_limit)).toBeDefined();
        expect(f.docs).toHaveLength(0);
        // The manager (short code 41) approves with their own PIN; the credit reasons are offered.
        fireEvent.change(screen.getByLabelText(en.unlock.shortCode), { target: { value: '41' } });
        expect(screen.getByLabelText(en.override.reason.pay_soon)).toBeDefined();
        fireEvent.change(screen.getByLabelText(en.approval.pin), { target: { value: '4321' } });
        fireEvent.submit(screen.getByLabelText(en.approval.pin).closest('form')!);
        await waitFor(() => expect(f.docs).toHaveLength(1));
        expect(f.docs[0]!.overrides).toMatchObject([
          { kind: 'credit_limit', requestedBy: 'u1', approvedBy: 'm1', reason: 'pay_soon' },
        ]);
      });

      it('On account stays off for a customer without credit, and for a seller without pos.credit.sell', async () => {
        const button = () =>
          within(screen.getByRole('group', { name: en.pay.pad })).getByRole<HTMLButtonElement>('button', {
            name: 'On account',
          });
        const noCredit = payCounter({
          customers: () => Promise.resolve([{ ...KHAN, account: { ...KHAN.account, creditAllowed: false } }]),
        });
        await sold(noCredit.counter);
        await pickKhan();
        await waitFor(() => expect(strip()).toContain('Khan Motors'));
        expect([button().disabled, button().title]).toEqual([true, en.credit.needsCustomer]);
        cleanup();

        const seller = payCounter({
          grants: (id) =>
            Promise.resolve(
              id === 'm1'
                ? [role('manager')]
                : [{ ...role('salesman'), permissions: ['pos.sale.create', 'pos.sale.hold'] }],
            ),
        });
        await sold(seller.counter);
        await pickKhan();
        await waitFor(() => expect(button().title).toBe(en.credit.notPermitted));
        expect(button().disabled).toBe(true);
      });

      it('a walk-in may leave a phone: shown by its last four digits, stored normalized', async () => {
        const f = payCounter();
        await sold(f.counter);
        fireEvent.keyDown(window, { key: 'F4' });
        const d = within(await screen.findByRole('dialog'));
        const phone = d.getByLabelText(en.customer.walkinPhone);
        fireEvent.change(phone, { target: { value: '12' } });
        enter(phone);
        expect(await d.findByText(en.customer.badPhone)).toBeDefined();
        fireEvent.change(phone, { target: { value: '+92 300 1234567' } });
        enter(phone);
        await waitFor(() => expect(strip()).toContain('Walk-in · •••• 4567'));
        fireEvent.keyDown(window, { key: 'F9' });
        enter(await within(await screen.findByRole('dialog')).findByLabelText(en.pay.cashReceived));
        await waitFor(() => expect(f.docs).toHaveLength(1));
        expect(f.docs[0]).toMatchObject({ customerId: null, walkinPhone: '03001234567' });
      });
    });

    it('Alt+P reprints a bill of this counter, marked REPRINT and kept for the audit log', async () => {
      const f = payCounter();
      const box = await sold(f.counter);
      fireEvent.keyDown(window, { key: 'F9' });
      enter(await within(await screen.findByRole('dialog')).findByLabelText(en.pay.cashReceived));
      await waitFor(() => expect(f.printed).toHaveLength(1));
      await waitFor(() => expect(document.activeElement).toBe(box));
      fireEvent.keyDown(window, { key: 'p', altKey: true });
      const d = within(await screen.findByRole('dialog'));
      const option = await d.findByRole('option', { name: /C01-S000001/ });
      expect(option.getAttribute('aria-selected')).toBe('true');
      enter(d.getByLabelText(en.reprint.search));
      await waitFor(() => expect(f.printed).toHaveLength(2));
      expect(f.printed[1]!.reprint?.by).toBe('Asif Khan');
      expect(f.printed[1]!.document).toEqual(f.docs[0]);
      expect(f.printed[1]!.items['BRPD001']?.code).toBe('BRPD001');
      expect(f.reprints).toEqual(['C01-S000001 u1']);
      await waitFor(() => expect(notice()).toBe('Bill C01-S000001 reprinted'));
    });

    describe('void and reissue (POS-11, POS spec §18, W1-12)', () => {
      const payCash = async (f: ReturnType<typeof payCounter>, n: number) => {
        fireEvent.keyDown(window, { key: 'F9' });
        enter(await within(await screen.findByRole('dialog')).findByLabelText(en.pay.cashReceived));
        await waitFor(() => expect(f.docs).toHaveLength(n));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      };

      it("Alt+V voids a bill with the manager's PIN and a reason, prints it as VOID, and reissues it linked", async () => {
        const f = payCounter();
        const box = await sold(f.counter);
        await payCash(f, 1);
        await waitFor(() => expect(document.activeElement).toBe(box));
        fireEvent.keyDown(window, { key: 'v', altKey: true });
        const list = within(await screen.findByRole('dialog'));
        await list.findByRole('option', { name: /C01-S000001/ });
        enter(list.getByLabelText(en.void.search));
        expect(await screen.findByText(en.void.deskStatus.pending)).toBeDefined();
        fireEvent.change(screen.getByLabelText(en.unlock.shortCode), { target: { value: '41' } });
        fireEvent.click(screen.getByLabelText(en.override.reason.wrong_price));
        fireEvent.change(screen.getByLabelText(en.approval.pin), { target: { value: '4321' } });
        fireEvent.submit(screen.getByLabelText(en.approval.pin).closest('form')!);

        expect(await screen.findByText('Reissue C01-S000001?')).toBeDefined();
        expect(f.voids.map((v) => [v.req.userId, v.req.approverId, v.req.reason, v.req.deskStatus])).toEqual([
          ['u1', 'm1', 'wrong_price', 'pending'],
        ]);
        expect(f.printed[1]!.document).toEqual(f.docs[0]);
        expect(f.printed[1]!.voided).toMatchObject({
          number: 'C01-V000001',
          by: 'Asif Khan',
          approvedBy: 'Tariq Manager',
          reason: en.override.reason.wrong_price,
        });

        fireEvent.click(action(en.void.reissueAction));
        await waitFor(() => expect(total()).toBe('Rs 4,500'));
        expect(screen.getByText('Reissue of C01-S000001')).toBeDefined();
        await payCash(f, 2);
        expect(f.docs[1]!.reissueOf).toEqual({ id: f.docs[0]!.id, number: 'C01-S000001' });
        expect(f.docs[1]!.number).toBe('C01-S000002');
      });

      it('refuses a bill the cash desk has taken, saying when and by whom', async () => {
        const f = payCounter();
        const box = await sold(f.counter);
        await payCash(f, 1);
        f.setDesk({ status: 'received', at: '2026-11-03T09:05:00.000Z', cashierName: 'Ali' });
        await waitFor(() => expect(document.activeElement).toBe(box));
        fireEvent.keyDown(window, { key: 'v', altKey: true });
        const list = within(await screen.findByRole('dialog'));
        await list.findByRole('option', { name: /C01-S000001/ });
        enter(list.getByLabelText(en.void.search));
        expect(
          await screen.findByText(/C01-S000001 was handed over at 2:05.(PM|pm) by Ali: it can't be voided/),
        ).toBeDefined();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(f.voids).toEqual([]);
      });

      it('offline warns that the desk could not be asked; a salesman cannot approve', async () => {
        const f = payCounter();
        const box = await sold(f.counter);
        await payCash(f, 1);
        f.setDesk({ status: 'unknown', at: null, cashierName: null });
        await waitFor(() => expect(document.activeElement).toBe(box));
        fireEvent.keyDown(window, { key: 'v', altKey: true });
        const list = within(await screen.findByRole('dialog'));
        await list.findByRole('option', { name: /C01-S000001/ });
        enter(list.getByLabelText(en.void.search));
        expect(await screen.findByText(en.void.approveUnknown)).toBeDefined();
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Asif Khan/ }));
        fireEvent.change(screen.getByLabelText(en.approval.pin), { target: { value: '4831' } });
        fireEvent.submit(screen.getByLabelText(en.approval.pin).closest('form')!);
        expect(await screen.findByText(en.approval.notAllowed)).toBeDefined();
        expect(f.voids).toEqual([]);
      });
    });
  });
});

// W1-07: push at start-up, the offline warnings (SYN-06, owner answer 1), the counter's health page (PLT-09, POS spec
// §14, owner answer 4) and a revoked counter (owner answer 3).
describe('push, offline warnings and counter health (W1-07)', () => {
  const HOUR = 3_600_000;
  const MANAGER: RoleGrant = {
    permissions: ['admin.devices'],
    limits: { maxDiscountBp: 10000, voidWindow: 'same_day' },
    branchId: null,
  };
  const boss = staff({ id: 'm1', fullName: 'Boss Man', shortCode: '99', pinVerifier: '2468' });
  const REFUSED = {
    id: 'doc-7',
    family: 'S' as const,
    seq: 7,
    number: 'C01-S000007',
    error: 'bad_schema',
    attempts: 1,
    createdAt: '2026-10-25T05:00:00.000Z',
  };
  const offlineFor = (hours: number) => ({
    pull: () => Promise.resolve({ ok: false as const, reason: 'offline' as const }),
    push: () => Promise.resolve(OFFLINE_PUSH),
    status: () =>
      Promise.resolve({
        outboxCount: 4,
        lastSyncAt: null,
        lastContactAt: new Date(Date.now() - hours * HOUR).toISOString(),
        attention: 0,
      }),
  });

  it('pushes at start-up: the handshake, even with nothing to send', async () => {
    const f = fakeCounter();
    show(f.counter);
    await screen.findByRole('button', { name: /Asif Khan/ });
    await waitFor(() => expect(f.pushes.n).toBeGreaterThan(0));
  });

  it('says nothing for 7 hours offline, warns at 8 hours, and selling goes on', async () => {
    show(fakeCounter(offlineFor(7)).counter);
    await screen.findByRole('button', { name: /Asif Khan/ });
    expect(screen.queryByText(/not reached the server/)).toBeNull();
    cleanup();
    show(fakeCounter(offlineFor(9.5)).counter);
    expect(await screen.findByText(i18n.t('status.offlineWarning', { hours: 9 }))).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Asif Khan/ }));
    enterPin('4831');
    expect(await screen.findByRole('combobox')).toBeDefined();
  });

  it('warns strongly after 48 hours', async () => {
    show(fakeCounter(offlineFor(49)).counter);
    expect(await screen.findByText(i18n.t('status.offlineStrong', { days: 2 }))).toBeDefined();
  });

  it('opens the health page from the status bar: versions, storage, sync times, waiting and refused bills', async () => {
    const f = fakeCounter({ needsAttention: () => Promise.resolve([REFUSED]) });
    show(f.counter);
    await screen.findByRole('button', { name: /Asif Khan/ });
    fireEvent.click(screen.getByRole('button', { name: en.status.openHealth }));
    expect(await screen.findByText(en.health.title)).toBeDefined();
    for (const text of ['0.7.0', en.health.persisted, 'C01-S000007', en.health.error.bad_schema])
      expect(screen.getByText(text, { exact: false })).toBeDefined();
    expect(screen.getByText(en.health.sseOff)).toBeDefined();
  });

  it('Alt+S opens it too, even on the staff list', async () => {
    show(fakeCounter().counter);
    await screen.findByRole('button', { name: /Asif Khan/ });
    fireEvent.keyDown(window, { key: 's', altKey: true });
    expect(await screen.findByText(en.health.noAttention)).toBeDefined();
  });

  it('Try again needs a manager’s own PIN with admin.devices; a wrong one counts against them', async () => {
    const f = fakeCounter({
      staff: () => Promise.resolve([staff(), boss]),
      grants: (id) => Promise.resolve(id === 'm1' ? [MANAGER] : []),
      needsAttention: () => Promise.resolve([REFUSED]),
    });
    show(f.counter);
    await screen.findByRole('button', { name: /Asif Khan/ });
    fireEvent.click(screen.getByRole('button', { name: en.status.openHealth }));
    fireEvent.click(await screen.findByRole('button', { name: en.health.tryAgain }));
    fireEvent.click(await screen.findByRole('button', { name: /Asif Khan/ }));
    fireEvent.change(screen.getByLabelText(en.health.pin), { target: { value: '4831' } });
    fireEvent.click(screen.getByRole('button', { name: en.health.tryAgain }));
    expect(await screen.findByText(en.health.notAllowed)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: en.health.back }));
    fireEvent.click(await screen.findByRole('button', { name: /Boss Man/ }));
    fireEvent.change(screen.getByLabelText(en.health.pin), { target: { value: '0000' } });
    fireEvent.click(screen.getByRole('button', { name: en.health.tryAgain }));
    expect(await screen.findByText(i18n.t('health.wrong', { count: 4 }))).toBeDefined();
    expect(await f.counter.getPinState('m1')).toEqual({ failures: 1, locked: false });
    fireEvent.change(screen.getByLabelText(en.health.pin), { target: { value: '2468' } });
    fireEvent.click(screen.getByRole('button', { name: en.health.tryAgain }));
    expect(await screen.findByText(i18n.t('health.retried', { number: 'C01-S000007' }))).toBeDefined();
    expect(f.calls).toContain('retry doc-7');
  });

  it('a revoked counter stops selling and says how many bills it still holds', async () => {
    const f = fakeCounter({
      push: () => Promise.resolve({ ok: false, reason: 'revoked' }),
      status: () => Promise.resolve({ outboxCount: 3, lastSyncAt: null, lastContactAt: null, attention: 0 }),
    });
    show(f.counter);
    expect(await screen.findByText(i18n.t('revoked.body', { count: 3 }))).toBeDefined();
    expect(screen.queryByRole('button', { name: /Asif Khan/ })).toBeNull();
  });
});
