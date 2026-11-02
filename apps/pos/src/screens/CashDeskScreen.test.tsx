import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DomainError,
  money,
  type CashHandoverDocument,
  type CashSessionDocument,
  type QueueEntry,
  type RoleGrant,
} from '@erp/domain';

import type { DeskState, HandoverRequest } from '../db/desk';
import { i18n } from '../i18n';
import type { StaffUser } from '../unlock/unlock';
import { CashDeskScreen, type CashDeskCounter } from './CashDeskScreen';

// The Cash desk screen (W1-10, cash desk spec, CSH-01…CSH-04) over a fake desk: the queue by salesman, Enter, E, a
// scan of a queued bill, a scan of one not in the queue, the session, and offline.

const person = (id: string, fullName: string): StaffUser => ({
  id,
  fullName,
  shortCode: null,
  pinVerifier: 'v',
  pinMustChange: false,
  status: 'active',
  deletedAt: null,
});
const ALI = person('ali', 'Ali');
const IMRAN = person('imran', 'Imran');
const BILAL = person('bilal', 'Bilal');
const CASHIER: RoleGrant[] = [
  {
    permissions: ['cash.handover.receive', 'cash.refund.pay', 'cash.session.close'],
    limits: { maxDiscountBp: 0, voidWindow: 'none' },
    branchId: null,
  },
];

const bill = (number: string, sellerId: string, cashDue: number, over: Partial<QueueEntry> = {}) => ({
  id: `id-${number}`,
  number,
  deviceId: 'c3',
  sellerId,
  createdAt: '2026-11-02T10:15:30.000Z',
  cashDue: money(cashDue),
  cashReceived: money(500000),
  changeDue: money(500000 - cashDue),
  handoverStatus: 'pending' as const,
  status: 'finalized' as const,
  ...over,
});

const SESSION = {
  id: 's1',
  number: 'D01-Z000001',
  cashierId: 'ali',
  openedAt: '2026-11-02T05:02:00.000Z',
  openingFloat: money(500000),
  status: 'open' as const,
  handedIn: money(0),
  paidOut: money(0),
  expected: money(500000),
};

function fakeDesk(state: Partial<DeskState> = {}) {
  const calls: Omit<HandoverRequest, 'id' | 'createdAtMs' | 'clientVersion'>[] = [];
  const sessions: string[] = [];
  let desk: DeskState = {
    session: SESSION,
    queue: [
      bill('C03-S000412', 'imran', 432000),
      bill('C03-S000415', 'imran', -45000, { cashReceived: null }),
    ],
    local: [],
    ...state,
  };
  const counter: CashDeskCounter = {
    deskState: () => Promise.resolve(desk),
    grants: () => Promise.resolve(CASHIER),
    log: () => Promise.resolve(),
    openSession: (req) => {
      sessions.push(`open ${req.openingFloat}`);
      desk = { ...desk, session: SESSION };
      return Promise.resolve({ number: 'D01-Z000002' } as CashSessionDocument);
    },
    closeSession: () => {
      sessions.push('close');
      desk = { ...desk, session: { ...SESSION, status: 'closed' } };
      return Promise.resolve({ number: 'D01-Z000003' } as CashSessionDocument);
    },
    confirmHandover: (req) => {
      calls.push(req);
      if (desk.local.some((h) => h.billNumber === req.billNumber))
        return Promise.reject(new DomainError('already_handed_over', 'again'));
      const queued = desk.queue.find((b) => b.number === req.billNumber);
      const cashDue = queued?.cashDue ?? req.code!.cashDue;
      const amount = Math.abs(cashDue);
      const received = req.cashReceived ?? queued?.cashReceived ?? null;
      desk = {
        ...desk,
        local: [
          ...desk.local,
          {
            billNumber: req.billNumber,
            kind: cashDue < 0 ? 'payout' : 'in',
            number: 'D01-H000001',
            cashierId: 'ali',
            at: '2026-11-02T10:16:00.000Z',
          },
        ],
      };
      return Promise.resolve({
        kind: cashDue < 0 ? 'payout' : 'in',
        amount: money(amount),
        changeGiven: cashDue < 0 || received === null ? null : money(received - amount),
      } as CashHandoverDocument);
    },
  };
  return { counter, calls, sessions };
}

const show = (counter: CashDeskCounter, over: { user?: StaffUser; offline?: boolean } = {}) =>
  render(
    <I18nextProvider i18n={i18n}>
      <CashDeskScreen
        counter={counter}
        money={{ locale: 'en-PK', currency: 'PKR', minorUnits: 2 }}
        user={over.user ?? ALI}
        staff={[ALI, IMRAN, BILAL]}
        branchId="b"
        timeZone="Asia/Karachi"
        offline={over.offline ?? false}
        offlineSince={over.offline ? new Date('2026-11-02T09:05:00.000Z') : null}
        syncTick={0}
        onSaved={() => {}}
        onSell={() => {}}
        onLock={() => {}}
      />
    </I18nextProvider>,
  );

const scanField = () => screen.getByRole('textbox', { name: 'Scan a bill' });
const press = (key: string) => fireEvent.keyDown(scanField(), { key });
const typeScan = (text: string) => {
  fireEvent.change(scanField(), { target: { value: text } });
  press('Enter');
};

afterEach(() => cleanup());

describe('the cash desk screen', () => {
  it('lists the queue under its salesman, with what they bring and are owed', async () => {
    show(fakeDesk().counter);
    const group = await screen.findByRole('rowgroup', { name: 'Imran' });
    expect(within(group).getByText('C03-S000412')).toBeTruthy();
    expect(within(group).getByText(/Bring/)).toBeTruthy();
    expect(within(group).getByText(/Pay out .*450/, { selector: 'td' })).toBeTruthy();
  });

  it('confirms the selected bill with Enter, as the salesman entered it', async () => {
    const f = fakeDesk();
    show(f.counter);
    await screen.findByText('C03-S000412');
    press('Enter');
    await screen.findByText(/Received .*4,320 for C03-S000412 · change .*680/);
    expect(f.calls).toEqual([
      { userId: 'ali', billNumber: 'C03-S000412', cashReceived: null, code: null, method: 'queue' },
    ]);
    await waitFor(() => expect(screen.queryByText('C03-S000412')).toBeNull());
  });

  it('E corrects the cash received before confirming', async () => {
    const f = fakeDesk();
    show(f.counter);
    await screen.findByText('C03-S000412');
    press('e');
    const field = await screen.findByRole('textbox', { name: 'Cash received (whole rupees)' });
    fireEvent.change(field, { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm handover' }));
    await waitFor(() => expect(f.calls[0]).toMatchObject({ cashReceived: 1000000, method: 'queue' }));
  });

  it('refuses a correction below the amount due', async () => {
    const f = fakeDesk();
    show(f.counter);
    await screen.findByText('C03-S000412');
    press('e');
    const field = await screen.findByRole('textbox', { name: 'Cash received (whole rupees)' });
    fireEvent.change(field, { target: { value: '4000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm handover' }));
    expect(await screen.findByText(/less than the amount due/)).toBeTruthy();
    expect(f.calls).toEqual([]);
  });

  it('a scan of a queued bill selects it; Enter then records it as scanned', async () => {
    const f = fakeDesk();
    show(f.counter);
    await screen.findByText('C03-S000412');
    press('ArrowDown');
    typeScan('C03-S000412 4320');
    expect(f.calls).toEqual([]);
    press('Enter');
    await waitFor(() => expect(f.calls[0]).toMatchObject({ billNumber: 'C03-S000412', method: 'scan' }));
  });

  it('a scan of a bill not in the queue asks before recording it from the code (owner answer 2)', async () => {
    const f = fakeDesk();
    show(f.counter);
    await screen.findByText('C03-S000412');
    typeScan('C04-S000077 1250');
    expect(await screen.findByText('C04-S000077 isn’t in the queue yet')).toBeTruthy();
    expect(f.calls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /Record .*1,250/ }));
    await waitFor(() =>
      expect(f.calls[0]).toEqual({
        userId: 'ali',
        billNumber: 'C04-S000077',
        cashReceived: null,
        code: { cashDue: 125000 },
        method: 'scan',
      }),
    );
  });

  it('a second scan of a bill already taken here says who took it, and writes nothing', async () => {
    const f = fakeDesk({
      local: [
        {
          billNumber: 'C04-S000077',
          kind: 'in',
          number: 'D01-H000009',
          cashierId: 'ali',
          at: '2026-11-02T10:16:00.000Z',
        },
      ],
    });
    show(f.counter);
    await screen.findByText('C03-S000412');
    typeScan('C04-S000077 1250');
    expect(await screen.findByText(/Already handed over: D01-H000009 by Ali/)).toBeTruthy();
    expect(f.calls).toEqual([]);
  });

  it('refuses something that is not a bill code', async () => {
    show(fakeDesk().counter);
    await screen.findByText('C03-S000412');
    typeScan('ABEA001');
    expect(await screen.findByText('That isn’t a bill code: ABEA001')).toBeTruthy();
  });

  it("shows another cashier's session, and a confirm is refused", async () => {
    const f = fakeDesk();
    f.counter.confirmHandover = () => Promise.reject(new DomainError('not_session_cashier', 'not theirs'));
    show(f.counter, { user: BILAL });
    expect(await screen.findByText(/Ali’s session is open/)).toBeTruthy();
    press('Enter');
    expect(await screen.findByText(/Only the cashier of the open session takes cash/)).toBeTruthy();
  });

  it('opens a session with its float (Alt+O) and closes it (Alt+X)', async () => {
    const f = fakeDesk({ session: null });
    show(f.counter);
    await screen.findByText('C03-S000412');
    expect(screen.getByText('No session open on this desk')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'o', altKey: true });
    const field = await screen.findByRole('textbox', { name: 'Opening float (whole rupees)' });
    fireEvent.change(field, { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
    await screen.findByText(/Session D01-Z000002 opened/);
    expect(f.sessions).toEqual(['open 500000']);

    fireEvent.keyDown(window, { key: 'x', altKey: true });
    expect(await screen.findByText(/The drawer should hold .*5,000/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    await screen.findByText(/Session D01-Z000003 closed/);
    expect(f.sessions).toEqual(['open 500000', 'close']);
  });

  it("Alt+O opens the dialog at once, before the person's roles have loaded (CI caught it)", async () => {
    const f = fakeDesk({ session: null });
    f.counter.grants = () => new Promise(() => {});
    show(f.counter);
    await screen.findByText('C03-S000412');
    fireEvent.keyDown(window, { key: 'o', altKey: true });
    expect(await screen.findByRole('textbox', { name: 'Opening float (whole rupees)' })).toBeTruthy();
  });

  it('keeps the selected bill in view while ↓ walks down a long queue', async () => {
    const queue = Array.from({ length: 30 }, (_, i) =>
      bill(`C03-S0005${String(i).padStart(2, '0')}`, 'imran', 10000 + i * 100),
    );
    const scrolled: string[] = [];
    // jsdom has no scrollIntoView: record which row asks for it.
    const saved = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: function (this: Element) {
        scrolled.push(this.textContent ?? '');
      },
    });
    try {
      show(fakeDesk({ queue }).counter);
      await screen.findByText('C03-S000529');
      for (let i = 0; i < 29; i++) press('ArrowDown');
      await waitFor(() => expect(scrolled.at(-1)).toContain('C03-S000529'));
    } finally {
      if (saved) Object.defineProperty(Element.prototype, 'scrollIntoView', saved);
      else delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it('scrolls only the rows of a long queue: its heading and column headings stay in place', async () => {
    const queue = Array.from({ length: 30 }, (_, i) =>
      bill(`C03-S0005${String(i).padStart(2, '0')}`, 'imran', 10000 + i * 100),
    );
    show(fakeDesk({ queue }).counter);
    await screen.findByText('C03-S000529');
    const panel = screen.getByRole('region', { name: 'Waiting for the cash desk' });
    // jsdom has no layout: the scrolling box is the one with overflow-y-auto.
    const scroller = panel.querySelector('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(within(panel).getByRole('heading', { level: 2 }))).toBe(false);
    expect(scroller!.contains(within(panel).getByRole('table'))).toBe(true);
    expect(panel.querySelector('thead')!.className).toContain('sticky');
  });

  it('offline, says the queue is not updating and to scan each bill', async () => {
    show(fakeDesk().counter, { offline: true });
    expect(await screen.findByText(/queue is not updating · scan each bill/)).toBeTruthy();
  });
});
