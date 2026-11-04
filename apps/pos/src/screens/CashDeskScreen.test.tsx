import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DomainError,
  money,
  type CashHandoverDocument,
  type CashMovementDocument,
  type CashSessionDocument,
  type CustomerCollectionDocument,
  type QueueEntry,
  type RoleGrant,
} from '@erp/domain';

import type { CounterCustomer } from '../db/customers';
import type { DeskLookups, DeskState, HandoverRequest } from '../db/desk';
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
  collected: money(0),
  cashOut: money(0),
  fromSafe: money(0),
  expected: money(500000),
  countedCash: null,
  variance: null,
  leftInDrawer: null,
};

const CUSTOMER: CounterCustomer = {
  id: 'c1',
  code: 'C0042',
  name: 'Ali Autos',
  phones: [],
  city: null,
  account: { tierId: 't1', creditAllowed: true, creditLimit: null, offlineDailyCap: money(0) },
  balance: money(1250000),
};
const LOOKUPS: DeskLookups = {
  methods: [{ id: 'm1', code: 'cash', name: 'Cash', isCash: true, requiresReference: false, isActive: true }],
  categories: [{ id: 'e7', name: 'General expenses', isActive: true }],
  suppliers: [],
  banks: [],
  currency: 'PKR',
};

function fakeDesk(state: Partial<DeskState> = {}) {
  const calls: Omit<HandoverRequest, 'id' | 'createdAtMs' | 'clientVersion'>[] = [];
  const sessions: string[] = [];
  const deskCalls: string[] = [];
  const prints: string[] = [];
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
    closeSession: (req) => {
      sessions.push(
        `close ${JSON.stringify(req.counts)} ${req.reason ?? '-'} ${req.acknowledgerId ?? '-'} ${req.leftInDrawer}`,
      );
      desk = { ...desk, session: { ...SESSION, status: 'closed' } };
      const counted = Object.entries(req.counts).reduce((s, [d, c]) => s + Number(d) * c, 0);
      return Promise.resolve({
        number: 'D01-Z000003',
        variance: money(counted - 500000),
        countedCash: money(counted),
        leftInDrawer: req.leftInDrawer,
        acknowledgedByUserId: req.acknowledgerId,
      } as CashSessionDocument);
    },
    customers: () => Promise.resolve([CUSTOMER]),
    deskLookups: () => Promise.resolve(LOOKUPS),
    deskCustomer: () =>
      Promise.resolve({
        partyId: 'c1',
        code: 'C0042',
        name: 'Ali Autos',
        phones: [],
        balance: money(1250000),
        lastCollection: null,
      }),
    receiveCollection: (req) => {
      deskCalls.push(`collect C0042 ${req.amount} ${req.methodId === 'm1' ? 'cash' : req.methodId}`);
      return Promise.resolve({
        number: 'D01-R000001',
        amount: req.amount,
        customerName: 'Ali Autos',
        customerCode: 'C0042',
        methodId: req.methodId,
        methodCode: 'cash',
        balanceBefore: money(1250000),
      } as CustomerCollectionDocument);
    },
    recordCashMovement: (req) => {
      deskCalls.push(
        `out ${req.kind} ${req.amount} ${req.overDrawerConfirmed ? 'confirmed' : 'unconfirmed'}`,
      );
      if (!req.overDrawerConfirmed && req.amount > 500000)
        return Promise.reject(new DomainError('over_drawer', 'over'));
      return Promise.resolve({
        number: 'D01-M000001',
        kind: req.kind,
        amount: req.amount,
      } as CashMovementDocument);
    },
    printDesk: (job) => prints.push(`${job.slip.kind} ${job.slip.doc.number}`),
    checkout: () => Promise.resolve(null),
    getPinState: () => Promise.resolve({ failures: 0, locked: false }),
    setPinState: () => Promise.resolve(),
    verifyPin: () => Promise.resolve(false),
    recordPinEvent: () => Promise.resolve(),
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
  return { counter, calls, sessions, desk: () => deskCalls, printed: () => prints };
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

  it('opens a session with its float (Alt+O) and counts it to close (Alt+X)', async () => {
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
    fireEvent.change(await screen.findByRole('textbox', { name: /5,000.*×/ }), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Count done' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close & print' }));
    await screen.findByText(/Session D01-Z000003 closed/);
    expect(f.sessions).toEqual(['open 500000', 'close {"500000":1} - - 500000']);
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

// W1-11 (cash desk spec): a customer's payment (Alt+R), a cash-out (Alt+M), and the blind count (Alt+X).
// Each test waits up to 5 s for a dialog that opens after two reads from the desk, so the test itself needs more than
// 5 s on a loaded runner (it timed out in CI on W1-11 and W1-14).
describe('collections, cash-out and the count (W1-11)', { timeout: 15_000 }, () => {
  it('receives a payment from a customer found by name, and prints the receipt', async () => {
    const f = fakeDesk();
    show(f.counter);
    await screen.findByText('C03-S000412');
    fireEvent.keyDown(window, { key: 'r', altKey: true });
    // The dialog opens after two reads from the desk: give a loaded run time.
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Name, phone or code' }, { timeout: 5000 }),
      {
        target: { value: 'ali autos' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose customer' }));
    expect(await screen.findByText('Ali Autos (C0042)')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Amount received' }), { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Receive & print' }));
    await screen.findByText(/Received Rs\.?\s?5,000(\.00)? from Ali Autos · D01-R000001/);
    expect(f.desk()).toEqual(['collect C0042 500000 cash']);
    expect(f.printed()).toEqual(['collection D01-R000001']);
  });

  it('asks before paying out more than the drawer should hold, then pays on the second Enter', async () => {
    const f = fakeDesk();
    show(f.counter);
    await screen.findByText('C03-S000412');
    fireEvent.keyDown(window, { key: 'm', altKey: true });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Expense category' }, { timeout: 5000 }), {
      target: { value: 'e7' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Amount (whole rupees)' }), {
      target: { value: '9000' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Note: what it was for/ }), {
      target: { value: 'diesel' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pay out & print' }));
    expect(await screen.findByText(/should be in the drawer. Pay out anyway/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pay out anyway' }));
    await screen.findByText(/Paid out .*9,000.* · D01-M000001/);
    expect(f.desk()).toEqual(['out expense 900000 unconfirmed', 'out expense 900000 confirmed']);
    expect(f.printed()).toEqual(['cash_out D01-M000001']);
  });

  it('counts blind: the expected cash shows only after the count; a variance needs a reason and a manager, or later', async () => {
    const f = fakeDesk();
    show(f.counter);
    await screen.findByText('C03-S000412');
    fireEvent.keyDown(window, { key: 'x', altKey: true });
    const fiveThousands = await screen.findByRole('textbox', { name: /5,000.*×/ }, { timeout: 5000 });
    expect(screen.queryByText(/Expected in the drawer/)).toBeNull();
    fireEvent.change(fiveThousands, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Count done' }));
    // Float Rs 5,000 expected, Rs 5,000 counted.
    expect(await screen.findByText('Exact')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close & print' }));
    await screen.findByText(/Session D01-Z000003 closed/);
    expect(f.sessions).toEqual(['close {"500000":1} - - 500000']);
  });

  it('a short count needs its reason, then Acknowledge later closes it', async () => {
    const f = fakeDesk();
    show(f.counter);
    await screen.findByText('C03-S000412');
    fireEvent.keyDown(window, { key: 'x', altKey: true });
    fireEvent.change(await screen.findByRole('textbox', { name: /1,000.*×/ }, { timeout: 5000 }), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Count done' }));
    expect(await screen.findByText(/Short .*1,000/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close & print' }));
    expect(await screen.findByText('Choose why the drawer is short or over.')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Not known' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close & print' }));
    expect(await screen.findByText(/A manager enters their PIN, or tick Acknowledge later/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /Acknowledge later/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close & print' }));
    await screen.findByText(/closed, variance/);
    expect(f.sessions).toEqual(['close {"100000":4} unknown - 400000']);
    expect(f.printed()).toEqual(['close D01-Z000003']);
  });
});
