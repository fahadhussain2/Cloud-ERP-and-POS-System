import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import type { SearchResult } from './search/search-index';

import { App } from './App';
import type { Counter } from './counter';
import type { DeviceInfo } from './db/repo';
import { i18n } from './i18n';
import en from './locales/en.json';
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
