import type { AdjustmentView, InventoryLookups, StockCardView, TransferView } from '@erp/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { href, parseHash } from '../router';
import { AdjustmentScreen } from './AdjustmentScreen';
import { StockCardScreen, TransferNeededScreen } from './StockScreens';
import { TransferScreen } from './TransferScreen';

// The stock screens (W1-18) over a fake API: a transfer the purchaser types but can't post, a route that sends and
// receives, an adjustment that waits for the owner above the limit, the owner's approval, the stock card's running
// balances, and Transfer needed.

const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
/** The shop's business date, from the API (W2-05). */
const TODAY = '2026-11-19';
const CAN = {
  transfer: true,
  postTransfer: true,
  adjust: true,
  approve: false,
  viewCost: true,
  settings: false,
};
const lookups = (over: Partial<InventoryLookups> = {}): InventoryLookups => ({
  locations: [
    { id: 'damaged', code: 'DAMAGED', name: 'Damaged', kind: 'damaged' },
    { id: 'godown', code: 'GODOWN', name: 'Godown', kind: 'storage' },
    { id: 'shop', code: 'SHOP', name: 'Shop', kind: 'shop' },
  ],
  routes: [],
  adjustmentApprovalLimit: 1000000,
  reasons: ['found', 'lost', 'damaged', 'theft', 'count_correction', 'write_off', 'other'],
  live: false,
  money: MONEY,
  can: CAN,
  lockDate: null,
  today: TODAY,
  ...over,
});

const TRANSFER: TransferView = {
  transfer: {
    id: 't1',
    number: null,
    status: 'draft',
    fromLocationId: 'godown',
    toLocationId: 'shop',
    movedOn: '2026-11-08',
    note: null,
    needsReceiving: false,
    receivedOn: null,
    postedBy: null,
    receivedBy: null,
    rowVersion: '2',
  },
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      itemId: 'i1',
      code: 'ABEA001',
      name: 'ADJUSTER BEARING SALOON',
      qty: 5000,
      receivedQty: null,
      allowsFraction: false,
      available: 3000,
    },
  ],
  check: { problems: [], warnings: [{ warning: 'below_zero', row: 0 }] },
  shortfallAdjustment: null,
};

const ADJUSTMENT: AdjustmentView = {
  adjustment: {
    id: 'a1',
    number: null,
    status: 'draft',
    locationId: 'shop',
    adjustedOn: '2026-11-08',
    reason: 'lost',
    note: null,
    transfer: null,
    submittedBy: null,
    approvedBy: null,
    rejection: null,
    rowVersion: '3',
  },
  lines: [
    {
      id: 'al1',
      lineNo: 1,
      itemId: 'i1',
      code: 'ABEA001',
      name: 'ADJUSTER BEARING SALOON',
      qty: -3000,
      allowsFraction: false,
      onHand: 6000,
      avgCost: 400000,
    },
  ],
  check: { problems: [], warnings: [] },
  value: { gain: 0, loss: 1200000 },
  needsApproval: true,
};

const CARD: StockCardView = {
  item: { id: 'i1', code: 'ABEA001', name: 'ADJUSTER BEARING SALOON' },
  balances: { godown: 2000 },
  movements: [
    {
      seq: 3,
      date: '2026-11-08',
      kind: 'stock_transfer',
      documentId: 't9',
      number: 'TR000001',
      locationId: 'shop',
      qty: 5000,
      unitCost: 400000,
      value: 2000000,
      balance: 5000,
      total: 10000,
    },
    {
      seq: 3,
      date: '2026-11-08',
      kind: 'stock_transfer',
      documentId: 't9',
      number: 'TR000001',
      locationId: 'godown',
      qty: -5000,
      unitCost: 400000,
      value: -2000000,
      balance: 5000,
      total: 10000,
    },
  ],
  next: null,
};

function fakeApi(l: InventoryLookups, answers: Record<string, { status: number; body: unknown }> = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: Api = (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    if (answers[key]) return Promise.resolve(answers[key]);
    if (key === 'GET /api/inventory/lookups') return Promise.resolve({ status: 200, body: l });
    if (key === 'GET /api/inventory/transfers/t1') return Promise.resolve({ status: 200, body: TRANSFER });
    if (key === 'GET /api/inventory/adjustments/a1')
      return Promise.resolve({ status: 200, body: ADJUSTMENT });
    if (key === 'GET /api/inventory/items/i1/card') return Promise.resolve({ status: 200, body: CARD });
    return Promise.resolve({ status: 200, body: { rowVersion: '9' } });
  };
  return { api, calls };
}

const show = (ui: ReactElement) => render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
afterEach(cleanup);

describe('the stock addresses', () => {
  it('open the stock screens', () => {
    expect(parseHash(href.transfer('t1'))).toEqual({ screen: 'transfer', id: 't1' });
    expect(parseHash(href.transfers)).toEqual({ screen: 'transfers' });
    expect(parseHash(href.adjustment('new'))).toEqual({ screen: 'adjustment', id: 'new' });
    expect(parseHash(href.adjustments)).toEqual({ screen: 'adjustments' });
    expect(parseHash(href.stockCard('i1'))).toEqual({ screen: 'stockCard', itemId: 'i1' });
    expect(parseHash(href.stockCards)).toEqual({ screen: 'stockCard', itemId: null });
    expect(parseHash(href.transferNeeded)).toEqual({ screen: 'transferNeeded' });
    expect(parseHash(href.stockSettings)).toEqual({ screen: 'stockSettings' });
  });
});

describe('a transfer', () => {
  it('warns when it takes the Godown below 0, and the purchaser can save it but not post it', async () => {
    show(
      <TransferScreen
        api={fakeApi(lookups({ can: { ...CAN, postTransfer: false, adjust: false } })).api}
        id="t1"
      />,
    );
    expect(await screen.findByText(en.inventory.warnings.below_zero)).toBeDefined();
    expect(screen.getByRole('button', { name: en.inventory.saveDraft })).toBeDefined();
    expect(screen.queryByRole('button', { name: en.inventory.post })).toBeNull();
    // Before go-live too, no notice (D-113).
    expect(screen.queryByText(/legacy app/i)).toBeNull();
  });

  it('greys out Post and says why when its date is on or before the lock date (D-108)', async () => {
    show(<TransferScreen api={fakeApi(lookups({ lockDate: '2026-11-08' })).api} id="t1" />);
    expect(
      await screen.findByText('The books are locked up to 2026-11-08. Pick a later date.'),
    ).toBeDefined();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.inventory.post }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.inventory.saveDraft }).disabled).toBe(
      false,
    );
  });

  // Owner's review of W1-19: a transfer or an adjustment with no item isn't saved.
  it('refuses to save a new transfer or adjustment with no item', async () => {
    for (const screenOf of [
      (api: Api) => <TransferScreen api={api} id="new" />,
      (api: Api) => <AdjustmentScreen api={api} id="new" />,
    ]) {
      const f = fakeApi(lookups());
      show(screenOf(f.api));
      fireEvent.click(await screen.findByRole('button', { name: en.inventory.saveDraft }));
      expect(await screen.findByText(en.inventory.errors.empty_draft)).toBeDefined();
      expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
      cleanup();
    }
  });

  it('says Send on a route that needs receiving, and saves before it sends', async () => {
    const f = fakeApi(
      lookups({ routes: [{ fromLocationId: 'godown', toLocationId: 'shop', needsReceiving: true }] }),
      {
        'POST /api/inventory/transfers/t1/post': {
          status: 200,
          body: { number: 'TR000001', status: 'in_transit' },
        },
      },
    );
    show(<TransferScreen api={f.api} id="t1" />);
    expect(await screen.findByText(en.inventory.transfers.needsReceiving)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: en.inventory.transfers.send }));
    await waitFor(() => expect(f.calls.some((c) => c.path.endsWith('/t1/post'))).toBe(true));
    expect(f.calls.find((c) => c.method === 'PUT')).toMatchObject({
      body: {
        rowVersion: '2',
        fromLocationId: 'godown',
        toLocationId: 'shop',
        lines: [{ itemId: 'i1', qty: 5000 }],
      },
    });
    expect(f.calls.find((c) => c.path.endsWith('/post'))!.body).toEqual({ rowVersion: '9' });
  });

  it('receives what arrived on each line', async () => {
    const sent = {
      ...TRANSFER,
      transfer: { ...TRANSFER.transfer, status: 'in_transit' as const, number: 'TR000002' },
    };
    const f = fakeApi(lookups(), { 'GET /api/inventory/transfers/t1': { status: 200, body: sent } });
    show(<TransferScreen api={f.api} id="t1" />);
    fireEvent.change(await screen.findByLabelText('Received of line 1'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: en.inventory.transfers.receive }));
    await waitFor(() => expect(f.calls.some((c) => c.path.endsWith('/t1/receive'))).toBe(true));
    expect(f.calls.find((c) => c.path.endsWith('/receive'))!.body).toMatchObject({
      rowVersion: '2',
      lines: [{ lineId: 'l1', receivedQty: 4000 }],
    });
  });
});

describe('an adjustment', () => {
  it("shows the manager's Rs 12,000 loss will wait for the owner, and sends it", async () => {
    const f = fakeApi(lookups(), {
      'POST /api/inventory/adjustments/a1/post': {
        status: 200,
        body: { number: null, status: 'awaiting_approval' },
      },
    });
    show(<AdjustmentScreen api={f.api} id="a1" />);
    expect(await screen.findByText(/will wait for the owner's approval/)).toBeDefined();
    expect(screen.getByRole('status').textContent).toMatch(/Loss Rs\s?12,000/);
    fireEvent.click(screen.getByRole('button', { name: en.inventory.adjustments.sendForApproval }));
    await waitFor(() => expect(f.calls.some((c) => c.path.endsWith('/a1/post'))).toBe(true));
  });

  it('posts at once for the owner, who may approve', async () => {
    show(<AdjustmentScreen api={fakeApi(lookups({ can: { ...CAN, approve: true } })).api} id="a1" />);
    expect(await screen.findByRole('button', { name: en.inventory.post })).toBeDefined();
    expect(screen.queryByText(/will wait/)).toBeNull();
  });

  it('greys out Post and says why when its date is on or before the lock date (D-108)', async () => {
    show(
      <AdjustmentScreen
        api={fakeApi(lookups({ can: { ...CAN, approve: true }, lockDate: '2026-11-08' })).api}
        id="a1"
      />,
    );
    expect(
      await screen.findByText('The books are locked up to 2026-11-08. Pick a later date.'),
    ).toBeDefined();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.inventory.post }).disabled).toBe(true);
  });

  // Owner's staging test of W1-19: a stock document dated in a locked month said "Something went wrong".
  it('says the books are locked when Post is refused for the date', async () => {
    const f = fakeApi(lookups({ can: { ...CAN, approve: true } }), {
      'POST /api/inventory/adjustments/a1/post': {
        status: 409,
        body: { error: 'date_locked', lockDate: '2026-10-31' },
      },
    });
    show(<AdjustmentScreen api={f.api} id="a1" />);
    fireEvent.click(await screen.findByRole('button', { name: en.inventory.post }));
    expect(
      await screen.findByText('The books are locked up to 2026-10-31. Pick a later date.'),
    ).toBeDefined();
  });

  it('the owner approves one awaiting approval, or sends it back with a note', async () => {
    const waiting = {
      ...ADJUSTMENT,
      adjustment: { ...ADJUSTMENT.adjustment, status: 'awaiting_approval' as const, submittedBy: 'Maria' },
      needsApproval: false,
    };
    const f = fakeApi(lookups({ can: { ...CAN, approve: true } }), {
      'GET /api/inventory/adjustments/a1': { status: 200, body: waiting },
    });
    show(<AdjustmentScreen api={f.api} id="a1" />);
    const back = await screen.findByRole<HTMLButtonElement>('button', {
      name: en.inventory.adjustments.reject,
    });
    expect(back.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(en.inventory.adjustments.rejectNote), {
      target: { value: 'Count again first' },
    });
    fireEvent.click(back);
    await waitFor(() => expect(f.calls.some((c) => c.path.endsWith('/a1/reject'))).toBe(true));
    expect(f.calls.find((c) => c.path.endsWith('/reject'))!.body).toEqual({
      rowVersion: '3',
      note: 'Count again first',
    });
    fireEvent.click(screen.getByRole('button', { name: en.inventory.adjustments.approve }));
    await waitFor(() => expect(f.calls.some((c) => c.path.endsWith('/a1/approve'))).toBe(true));
  });
});

describe('reading the stock', () => {
  it('the stock card shows each movement with its document and balances; costs only with cost.view', async () => {
    show(<StockCardScreen api={fakeApi(lookups()).api} itemId="i1" />);
    const table = await screen.findByRole('table', { name: en.inventory.card.movements });
    expect(within(table).getAllByRole('link', { name: 'TR000001' })[0]!.getAttribute('href')).toBe(
      href.transfer('t9'),
    );
    expect(within(table).getAllByText(/Rs\s?4,000/).length).toBe(2);
    expect(screen.getByRole('status').textContent).toBe('Godown: 2');
    cleanup();
    show(<StockCardScreen api={fakeApi(lookups({ can: { ...CAN, viewCost: false } })).api} itemId="i1" />);
    const plain = await screen.findByRole('table', { name: en.inventory.card.movements });
    expect(within(plain).queryByText(/Rs/)).toBeNull();
  });

  it('Transfer needed lists the short items and opens a transfer for them', async () => {
    const f = fakeApi(lookups(), {
      'GET /api/inventory/transfer-needed': {
        status: 200,
        body: {
          rows: [
            { itemId: 'i2', code: 'OIL050', name: 'ENGINE OIL', shop: -2000, godown: 20500, suggested: 2000 },
          ],
        },
      },
    });
    show(<TransferNeededScreen api={f.api} />);
    const table = await screen.findByRole('table', { name: en.inventory.needed.title });
    expect(within(table).getByText('-2')).toBeDefined();
    expect(screen.getByRole('link', { name: en.inventory.needed.transfer }).getAttribute('href')).toBe(
      href.transfer('needed'),
    );
  });
});

// W2-05: every stock form is dated by the shop's business date from the API (04:00 cut-off), never by this browser's
// calendar, and Post waits on a date after it. The browser's clock is set days away from the shop's day, so the test
// holds in any time zone.
describe("the shop's business date (W2-05)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());
  const onToday = (input: HTMLInputElement) => {
    expect(input.value).toBe(TODAY);
    expect(input.max).toBe(TODAY);
  };
  const ahead = "The date can't be after 2026-11-19, the shop's business date.";

  it('a new transfer is moved on it; a later date greys out Post and says why', async () => {
    show(<TransferScreen api={fakeApi(lookups()).api} id="new" />);
    onToday(await screen.findByLabelText<HTMLInputElement>(en.inventory.fields.movedOn));
    cleanup();
    show(<TransferScreen api={fakeApi(lookups()).api} id="t1" />);
    fireEvent.change(await screen.findByLabelText(en.inventory.fields.movedOn), {
      target: { value: '2026-11-20' },
    });
    expect(screen.getByText(ahead)).toBeDefined();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.inventory.post }).disabled).toBe(true);
  });

  it('a transfer on the way is received on it, and not on a later date', async () => {
    const sent = { ...TRANSFER, transfer: { ...TRANSFER.transfer, status: 'in_transit' as const } };
    const f = fakeApi(lookups(), { 'GET /api/inventory/transfers/t1': { status: 200, body: sent } });
    show(<TransferScreen api={f.api} id="t1" />);
    const received = await screen.findByLabelText<HTMLInputElement>(en.inventory.fields.receivedOn);
    onToday(received);
    fireEvent.change(received, { target: { value: '2026-11-20' } });
    expect(screen.getByText(ahead)).toBeDefined();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: en.inventory.transfers.receive }).disabled,
    ).toBe(true);
  });

  it('a new adjustment is dated on it, and says why when Post is refused for a later date', async () => {
    show(<AdjustmentScreen api={fakeApi(lookups()).api} id="new" />);
    onToday(await screen.findByLabelText<HTMLInputElement>(en.inventory.fields.adjustedOn));
    cleanup();
    const f = fakeApi(lookups(), {
      'POST /api/inventory/adjustments/a1/post': {
        status: 400,
        body: { error: 'date_in_future', today: TODAY },
      },
    });
    show(<AdjustmentScreen api={f.api} id="a1" />);
    fireEvent.click(await screen.findByRole('button', { name: en.inventory.adjustments.sendForApproval }));
    expect(await screen.findByText(ahead)).toBeDefined();
  });
});
