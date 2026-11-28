import type { PurchasingLookups, ReceiptView, ReturnView, SupplierDetail, SupplierRow } from '@erp/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { href, navigate } from '../router';
import { notify, Toaster } from '../ui';
import { ReceiptScreen } from './ReceiptScreen';
import { ReturnScreen } from './ReturnScreen';
import { SupplierScreen, SuppliersScreen } from './SuppliersScreen';

// The purchasing screens (W1-16) over a fake API: a receipt checked against the bill as you type (the difference,
// line warnings, Post waiting until it matches), the supplier's ledger with its running balance, and Pay by bank only
// for those who may (owner answer 2).

const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
/** The shop's business date, from the API (W2-05). */
const TODAY = '2026-11-19';
const lookups = (over: Partial<PurchasingLookups> = {}): PurchasingLookups => ({
  locations: [
    { id: 'shop', code: 'SHOP', name: 'Shop' },
    { id: 'godown', code: 'GODOWN', name: 'Godown' },
  ],
  bankAccounts: [{ id: 'hbl', code: 'hbl', name: 'Bank: HBL' }],
  suppliers: [{ id: 's1', code: '0210', name: 'Naveed Glass' }],
  live: false,
  money: MONEY,
  can: { receive: true, payByBank: false },
  lockDate: null,
  today: TODAY,
  ...over,
});
const DRAFT: ReceiptView = {
  receipt: {
    id: 'r1',
    number: null,
    status: 'draft',
    supplierId: 's1',
    supplierName: 'Naveed Glass',
    billNo: 'INV-4471',
    billDate: '2026-11-05',
    receivedOn: '2026-11-06',
    locationId: 'shop',
    paidFrom: null,
    billDiscount: 0,
    billTotal: 1340000,
    total: null,
    dueDate: null,
    notes: null,
    rowVersion: '3',
    postedAt: null,
  },
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      itemId: 'i1',
      code: 'ABEA001',
      name: 'ADJUSTER BEARING SALOON',
      qty: 10000,
      unitCost: 125000,
      lineDiscount: 0,
      value: null,
      netUnitCost: null,
      allowsFraction: false,
      lastCost: 100000,
      retail: 160000,
      returnable: null,
    },
    {
      id: 'l2',
      lineNo: 2,
      itemId: 'i2',
      code: 'ABEA002',
      name: 'ADJUSTER BEARING EVERY',
      qty: 2000,
      unitCost: 45050,
      lineDiscount: 0,
      value: null,
      netUnitCost: null,
      allowsFraction: false,
      lastCost: null,
      retail: null,
      returnable: null,
    },
  ],
  check: { problems: [], warnings: [], total: null, difference: null },
};
const LEDGER: SupplierDetail = {
  supplier: {
    id: 's1',
    code: '0210',
    name: 'Naveed Glass',
    phones: [],
    termsDays: 30,
    labelAbbr: 'NG',
    status: 'active',
    balance: 1090100,
    contactPerson: null,
    address: null,
    city: null,
    notes: null,
    rowVersion: '5',
    deletable: false,
  },
  balance: 1090100,
  ledger: [
    {
      entryDate: '2026-11-06',
      dueDate: '2026-12-05',
      kind: 'goods_receipt',
      sourceId: 'r1',
      number: 'GR000001',
      amount: 1340100,
      balance: 1340100,
    },
    {
      entryDate: '2026-11-06',
      dueDate: '2026-11-06',
      kind: 'purchase_return',
      sourceId: 'p1',
      number: 'PR000001',
      amount: -250000,
      balance: 1090100,
    },
  ],
};

function fakeApi(l: PurchasingLookups, answers: Record<string, { status: number; body: unknown }> = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: Api = (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    if (answers[key]) return Promise.resolve(answers[key]);
    if (key === 'GET /api/purchasing/lookups') return Promise.resolve({ status: 200, body: l });
    if (key === 'GET /api/purchasing/receipts/r1') return Promise.resolve({ status: 200, body: DRAFT });
    if (key === 'GET /api/purchasing/suppliers/s1') return Promise.resolve({ status: 200, body: LEDGER });
    return Promise.resolve({ status: 200, body: { rowVersion: '4' } });
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

describe('a goods receipt', () => {
  // W2-16: the difference sits in the bar at the bottom of the window; Post stays clickable, and with problems it
  // sends nothing, marks them at their field and puts the cursor on the first (owner, 2026-11-28).
  it('shows the difference from the printed total in the bar, and Post sends nothing until it matches', async () => {
    const f = fakeApi(lookups());
    show(<ReceiptScreen api={f.api} id="r1" />);
    const bar = await screen.findByRole('region', { name: en.purchasing.bar });
    // 10 × 1,250 + 2 × 450.50 = 13,401; the bill says 13,400.
    expect(within(bar).getByRole('status').textContent).toMatch(/-Rs\s?1/);
    const post = screen.getByRole<HTMLButtonElement>('button', { name: en.purchasing.post });
    expect(post.disabled).toBe(false);
    fireEvent.click(post);
    const total = screen.getByLabelText(en.purchasing.fields.billTotal);
    expect(total.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(total.getAttribute('aria-describedby')!)!.textContent).toBe(
      en.purchasing.problems.total_mismatch,
    );
    expect(document.activeElement).toBe(total);
    expect(within(bar).getByText('1 to fix before posting')).toBeDefined();
    expect(f.calls.some((c) => c.method !== 'GET')).toBe(false);
    fireEvent.change(total, { target: { value: '13401' } });
    expect(within(bar).getByRole('status').textContent).toContain(en.purchasing.totals.matches);
    expect(total.getAttribute('aria-invalid')).toBeNull();
  });

  it('shows the last cost under the unit cost, and how far it moved when more than 10 %', async () => {
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="r1" />);
    // Line 1: 1,250 against a last cost of 1,000.
    const cost = await screen.findByLabelText('Unit cost of line 1');
    const note = document.getElementById(cost.getAttribute('aria-describedby')!.split(' ')[0]!)!;
    expect(note.textContent).toMatch(/^Last Rs\s?1,000 · 25 % up$/);
  });

  it('saves the draft with the row version, then posts it', async () => {
    const f = fakeApi(lookups(), {
      'POST /api/purchasing/receipts/r1/post': { status: 200, body: { number: 'GR000001' } },
    });
    show(<ReceiptScreen api={f.api} id="r1" />);
    fireEvent.change(await screen.findByLabelText(en.purchasing.fields.billTotal), {
      target: { value: '13401' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.post }));
    await waitFor(() =>
      expect(f.calls.some((c) => c.path === '/api/purchasing/receipts/r1/post')).toBe(true),
    );
    expect(f.calls.find((c) => c.method === 'PUT')).toMatchObject({
      body: {
        rowVersion: '3',
        billTotal: 1340100,
        lines: [
          { itemId: 'i1', qty: 10000, unitCost: 125000 },
          { itemId: 'i2', qty: 2000, unitCost: 45050 },
        ],
      },
    });
    expect(f.calls.find((c) => c.path.endsWith('/post'))!.body).toEqual({ rowVersion: '4' });
  });

  // W2-16: the note is in the Paid dropdown, where someone looking for Cash finds it, not a line on every receipt.
  it('says a cash bill is paid at the desk, in the Paid dropdown, with no go-live notice (D-113)', async () => {
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="r1" />);
    const paid = await screen.findByRole('combobox', { name: en.purchasing.fields.paid });
    expect(screen.queryByText(en.purchasing.receipts.cashNote)).toBeNull();
    fireEvent.keyDown(paid, { key: 'ArrowDown' });
    const list = await screen.findByRole('listbox');
    expect(within(list).getByText(en.purchasing.receipts.cashNote)).toBeDefined();
    expect(screen.queryByText(/legacy app/i)).toBeNull();
  });

  // Owner's review of W1-19: a receipt with nothing on its lines isn't saved.
  it('refuses to save a new receipt with no item on any line', async () => {
    const f = fakeApi(lookups());
    show(<ReceiptScreen api={f.api} id="new" />);
    fireEvent.click(await screen.findByRole('button', { name: en.purchasing.saveDraft }));
    expect(await screen.findByText(en.purchasing.errors.empty_draft)).toBeDefined();
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  // Owner's review of W1-19: a receipt received in a locked month is greyed out before Post, so Post can't leave a
  // surprise draft. Save draft still keeps what was typed.
  // W2-16: Post stays clickable; it sends nothing while the date can't post, and puts the cursor on the date.
  it('says why and posts nothing when Received on is on or before the lock date', async () => {
    const f = fakeApi(lookups({ lockDate: '2026-11-06' }));
    show(<ReceiptScreen api={f.api} id="r1" />);
    fireEvent.change(await screen.findByLabelText(en.purchasing.fields.billTotal), {
      target: { value: '13401' },
    });
    expect(screen.getByText('The books are locked up to 2026-11-06. Pick a later date.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.post }));
    expect(document.activeElement).toBe(screen.getByLabelText(en.purchasing.fields.receivedOn));
    expect(f.calls.some((c) => c.method !== 'GET')).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.purchasing.saveDraft }).disabled).toBe(
      false,
    );
    fireEvent.change(screen.getByLabelText(en.purchasing.fields.receivedOn), {
      target: { value: '2026-11-07' },
    });
    expect(screen.queryByText('The books are locked up to 2026-11-06. Pick a later date.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.post }));
    await waitFor(() => expect(f.calls.some((c) => c.path.endsWith('/post'))).toBe(true));
  });

  // Owner's staging test of W1-19: a receipt received in a locked month said "Something went wrong".
  it('says the books are locked when Post is refused for the date', async () => {
    const f = fakeApi(lookups(), {
      'POST /api/purchasing/receipts/r1/post': {
        status: 409,
        body: { error: 'date_locked', lockDate: '2026-10-31' },
      },
    });
    show(<ReceiptScreen api={f.api} id="r1" />);
    fireEvent.change(await screen.findByLabelText(en.purchasing.fields.billTotal), {
      target: { value: '13401' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.post }));
    expect(
      await screen.findByText('The books are locked up to 2026-10-31. Pick a later date.'),
    ).toBeDefined();
  });

  // A new receipt is saved, refused, then opened at its own address: the refusal must still show there.
  it('keeps the refusal when a new receipt opens at its own address', async () => {
    navigate(href.receipt('r1'), 'The books are locked up to 2026-10-31. Pick a later date.');
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="r1" />);
    expect(
      await screen.findByText('The books are locked up to 2026-10-31. Pick a later date.'),
    ).toBeDefined();
  });
});

describe('a supplier', () => {
  it('shows the ledger with its running balance, and Pay by bank only with acc.payment.create', async () => {
    const f = fakeApi(lookups());
    show(<SupplierScreen api={f.api} id="s1" />);
    const ledger = await screen.findByRole('table', { name: en.purchasing.ledger.title });
    expect(within(ledger).getByText('GR000001')).toBeDefined();
    expect(within(ledger).getAllByText(/Rs\s?10,901/).length).toBe(1);
    expect(screen.queryByRole('button', { name: en.purchasing.pay.action })).toBeNull();
    cleanup();
    show(<SupplierScreen api={fakeApi(lookups({ can: { receive: false, payByBank: true } })).api} id="s1" />);
    expect(await screen.findByRole('button', { name: en.purchasing.pay.action })).toBeDefined();
  });

  it('pays by bank with the amount in paisa', async () => {
    const f = fakeApi(lookups({ can: { receive: false, payByBank: true } }), {
      'POST /api/purchasing/payments': { status: 201, body: { id: 'p9', number: 'SP000001' } },
    });
    show(<SupplierScreen api={f.api} id="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: en.purchasing.pay.action }));
    fireEvent.change(screen.getByLabelText(en.purchasing.pay.amount), { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.pay.confirm }));
    expect(await screen.findByText('SP000001 recorded.')).toBeDefined();
    expect(f.calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      supplierId: 's1',
      bankAccountId: 'hbl',
      amount: 500000,
    });
  });
});

// Owner review of W1-16 on staging (2026-11-07): a line not filled in yet, the last cost on picking an item, the
// supplier dialogs and the suppliers table's actions.

describe('a receipt line (owner review)', () => {
  it('a new empty line is not flagged, keeps its fields in line, and the totals still show', async () => {
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: en.purchasing.line.add }));
    expect(screen.queryByText(en.purchasing.problems.item_required)).toBeNull();
    expect(screen.queryByText(en.purchasing.problems.qty_positive)).toBeNull();
    const rows = within(screen.getByRole('table', { name: en.purchasing.receipts.lines })).getAllByRole(
      'row',
    );
    // Every cell at the top, on the cell itself: the shared cell's own centring beat the row's (W2-16 point 4).
    for (const row of rows.slice(1))
      for (const cell of within(row).getAllByRole('cell')) expect(cell.className).toContain('align-top');
    // 10 × Rs 1,250 = Rs 12,500 on the first line, with the empty third line there.
    expect(within(rows[1]!).getAllByText(/Rs\s?12,500/).length).toBe(1);
  });

  it('picking an item fills in its last purchase cost, which stays editable', async () => {
    const f = fakeApi(lookups(), {
      'GET /api/purchasing/items': {
        status: 200,
        body: {
          items: [
            {
              id: 'i3',
              code: 'OIL050',
              name: 'ENGINE OIL',
              allowsFraction: true,
              lastCost: 245000,
              retail: 300000,
            },
          ],
        },
      },
    });
    show(<ReceiptScreen api={f.api} id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: en.purchasing.line.add }));
    fireEvent.click(screen.getByRole('button', { name: 'Item of line 3' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Item of line 3' }), { target: { value: 'oil' } });
    fireEvent.click(await screen.findByRole('option', { name: /OIL050/ }));
    const cost = screen.getByLabelText<HTMLInputElement>('Unit cost of line 3');
    expect(cost.value).toBe('2450');
    fireEvent.change(cost, { target: { value: '2500' } });
    expect(cost.value).toBe('2500');
  });
});

const row = (over: Partial<SupplierRow>): SupplierRow => ({
  id: 's1',
  code: '0210',
  name: 'Naveed Glass',
  phones: [],
  termsDays: 30,
  labelAbbr: 'NG',
  status: 'active',
  balance: 1090100,
  deletable: false,
  ...over,
});

describe('the suppliers table (owner review)', () => {
  const listApi = (answers: Record<string, { status: number; body: unknown }> = {}) =>
    fakeApi(lookups(), {
      'GET /api/purchasing/suppliers': {
        status: 200,
        body: {
          suppliers: [
            row({}),
            row({ id: 's2', code: '0301', name: 'Typo Traders', balance: 0, deletable: true }),
          ],
        },
      },
      ...answers,
    });

  it('opens Add supplier in a dialog', async () => {
    show(<SuppliersScreen api={listApi().api} />);
    fireEvent.click(await screen.findByRole('button', { name: en.purchasing.suppliers.add }));
    expect(within(screen.getByRole('dialog')).getByLabelText(en.purchasing.fields.code)).toBeDefined();
  });

  it('offers Edit and Deactivate on every row, Delete only on a supplier never used', async () => {
    show(<SuppliersScreen api={listApi().api} />);
    expect(
      await screen.findByRole('button', { name: `${en.purchasing.suppliers.edit} Naveed Glass` }),
    ).toBeDefined();
    expect(
      screen.getByRole('button', { name: `${en.purchasing.suppliers.deactivate} Naveed Glass` }),
    ).toBeDefined();
    expect(
      screen.queryByRole('button', { name: `${en.purchasing.suppliers.delete} Naveed Glass` }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: `${en.purchasing.suppliers.delete} Typo Traders` }),
    ).toBeDefined();
  });

  it('says what the shop still owes when Deactivate is refused', async () => {
    const f = listApi({
      'PATCH /api/purchasing/suppliers/s1': {
        status: 409,
        body: { error: 'balance_open', balance: 1090100 },
      },
    });
    show(<SuppliersScreen api={f.api} />);
    fireEvent.click(
      await screen.findByRole('button', { name: `${en.purchasing.suppliers.deactivate} Naveed Glass` }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.purchasing.suppliers.deactivate }));
    // A toast, and the question stays open (owner answer 6).
    expect((await screen.findByRole('alert')).textContent).toMatch(/still owes this supplier Rs\s?10,901/);
    expect(dialog.isConnected).toBe(true);
    expect(f.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ rowVersion: '5', status: 'inactive' });
  });

  it('deletes a supplier never used, after asking', async () => {
    const f = listApi({ 'DELETE /api/purchasing/suppliers/s2': { status: 200, body: { deleted: true } } });
    show(<SuppliersScreen api={f.api} />);
    fireEvent.click(
      await screen.findByRole('button', { name: `${en.purchasing.suppliers.delete} Typo Traders` }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.purchasing.suppliers.delete }));
    expect(await screen.findByText('Typo Traders is deleted.')).toBeDefined();
  });
});

// Bugs (owner's review of New goods receipt, 2026-11-28; W2-16 points 7 and 8): a purchase return draft couldn't be
// deleted (the API could, the screen had no button); a receipt draft was deleted at once, without asking, by a button
// beside Post; Make labels opened the labels page with the receipt's id in its "Goods receipt number" field.
const RETURN_DRAFT: ReturnView = {
  purchaseReturn: {
    id: 'p1',
    number: null,
    status: 'draft',
    supplierId: 's1',
    supplierName: 'Naveed Glass',
    goodsReceiptId: null,
    goodsReceiptNumber: null,
    locationId: 'shop',
    returnedOn: '2026-11-07',
    reason: 'damaged',
    note: null,
    total: null,
    rowVersion: '2',
  },
  lines: [
    {
      id: 'pl1',
      lineNo: 1,
      itemId: 'i1',
      code: 'ABEA001',
      name: 'ADJUSTER BEARING SALOON',
      receiptLineId: null,
      qty: 1000,
      unitCost: 125000,
      allowsFraction: false,
      returnable: null,
    },
  ],
  check: { problems: [], total: 125000 },
};

describe('deleting a draft, and the labels of a receipt (W2-16)', () => {
  it('asks before deleting a goods receipt draft', async () => {
    const f = fakeApi(lookups(), {
      'DELETE /api/purchasing/receipts/r1': { status: 200, body: { deleted: true } },
    });
    show(<ReceiptScreen api={f.api} id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: en.purchasing.deleteDraft }));
    const dialog = await screen.findByRole('dialog');
    expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: en.purchasing.deleteDraft }));
    await waitFor(() =>
      expect(f.calls.some((c) => c.method === 'DELETE' && c.path === '/api/purchasing/receipts/r1')).toBe(
        true,
      ),
    );
  });

  it('deletes a purchase return draft, after asking', async () => {
    const f = fakeApi(lookups(), {
      'GET /api/purchasing/returns/p1': { status: 200, body: RETURN_DRAFT },
      'DELETE /api/purchasing/returns/p1': { status: 200, body: { deleted: true } },
    });
    show(<ReturnScreen api={f.api} id="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: en.purchasing.deleteDraft }));
    const dialog = await screen.findByRole('dialog');
    expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: en.purchasing.deleteDraft }));
    await waitFor(() =>
      expect(f.calls.some((c) => c.method === 'DELETE' && c.path === '/api/purchasing/returns/p1')).toBe(
        true,
      ),
    );
  });

  it("opens a posted receipt's labels by its number", async () => {
    const posted: ReceiptView = {
      ...DRAFT,
      receipt: { ...DRAFT.receipt, status: 'posted', number: 'GR000001', dueDate: '2026-12-05' },
    };
    const f = fakeApi(lookups(), { 'GET /api/purchasing/receipts/r1': { status: 200, body: posted } });
    show(<ReceiptScreen api={f.api} id="r1" />);
    const link = await screen.findByRole('link', { name: en.labels.makeLabels });
    expect(link.getAttribute('href')).toBe(href.receiptLabels('GR000001'));
  });
});

// W2-16 (owner's review, 2026-11-28): each problem under its own field, once the field is left or on Save draft /
// Post; Enter on the last line adds one; a return from a receipt knows how much can go back before it is saved.
const noteOf = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');

describe('a goods receipt line, field by field (W2-16)', () => {
  it('shows a quantity problem under Quantity once you leave it, not while you type and not under Item', async () => {
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="r1" />);
    const qty = await screen.findByLabelText('Quantity of line 2');
    fireEvent.focus(qty);
    fireEvent.change(qty, { target: { value: '0' } });
    expect(screen.queryByText(en.purchasing.short.qty_positive)).toBeNull();
    fireEvent.blur(qty);
    expect(qty.getAttribute('aria-invalid')).toBe('true');
    // In short words under a line's box: the column already names the field (W2-17).
    expect(noteOf(qty)).toBe(en.purchasing.short.qty_positive);
    expect(noteOf(screen.getByRole('button', { name: 'Item of line 2' }))).not.toContain(
      en.purchasing.short.qty_positive,
    );
    // The other boxes of the line keep their places: nothing is added to their cells.
    expect(screen.getByLabelText('Discount of line 2').getAttribute('aria-invalid')).toBeNull();
  });

  // W2-17 (owner answer 2): Save draft marks nothing red; it keeps the draft and says what is left before posting.
  it('Save draft keeps a draft with problems, marks nothing, and says what is left', async () => {
    const f = fakeApi(lookups());
    show(<ReceiptScreen api={f.api} id="r1" />);
    const billNo = await screen.findByLabelText(en.purchasing.fields.billNo);
    fireEvent.change(billNo, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.saveDraft }));
    await waitFor(() => expect(f.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(billNo.getAttribute('aria-invalid')).toBeNull();
    // The bill number, and the lines that don't add up to the bill.
    expect(await screen.findByText('Draft saved. 2 to fix before posting.')).toBeDefined();
  });

  it('a saved draft says quietly in the bar what is left, and in red once Post is pressed', async () => {
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="r1" />);
    const bar = await screen.findByRole('region', { name: en.purchasing.bar });
    const left = within(bar).getByText('1 to fix before posting');
    expect(left.className).toContain('text-muted-foreground');
    fireEvent.click(within(bar).getByRole('button', { name: en.purchasing.post }));
    expect(within(bar).getByText('1 to fix before posting').className).toContain('text-bad');
  });

  it('says a cost over Rs 1 crore under Unit cost, and Save draft keeps nothing until it is fixed', async () => {
    const f = fakeApi(lookups());
    show(<ReceiptScreen api={f.api} id="r1" />);
    const cost = await screen.findByLabelText('Unit cost of line 2');
    fireEvent.change(cost, { target: { value: '10000001' } });
    fireEvent.blur(cost);
    expect(noteOf(cost)).toMatch(/^Over Rs\s?10,000,000/);
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.saveDraft }));
    expect(await screen.findByText(en.purchasing.cantSave)).toBeDefined();
    expect(f.calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('says "Not an amount" under a discount that isn\'t one, and "More than the line" when it is too big', async () => {
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="r1" />);
    const discount = await screen.findByLabelText('Discount of line 2');
    fireEvent.change(discount, { target: { value: 's' } });
    fireEvent.blur(discount);
    expect(noteOf(discount)).toBe(en.purchasing.short.not_amount);
    fireEvent.change(discount, { target: { value: '5000' } });
    expect(noteOf(discount)).toBe(en.purchasing.short.discount_invalid);
  });

  it('names the payment: not paid yet, or paid from a bank, with the cash note in the list', async () => {
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="r1" />);
    const payment = await screen.findByRole('combobox', { name: en.purchasing.fields.paid });
    expect(payment.textContent).toContain("Not paid yet (on the supplier's account)");
    fireEvent.keyDown(payment, { key: 'ArrowDown' });
    const list = await screen.findByRole('listbox');
    expect(within(list).getByRole('option', { name: 'Paid from Bank: HBL' })).toBeDefined();
    expect(within(list).getByText(en.purchasing.receipts.cashNote)).toBeDefined();
  });

  it('adds a line on Enter in the last Discount, with the cursor in its Item', async () => {
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="r1" />);
    fireEvent.keyDown(await screen.findByLabelText('Discount of line 2'), { key: 'Enter' });
    const item = await screen.findByRole('button', { name: 'Item of line 3' });
    expect(document.activeElement).toBe(item);
    // Enter in an earlier line's Discount adds nothing.
    fireEvent.keyDown(screen.getByLabelText('Discount of line 1'), { key: 'Enter' });
    expect(screen.queryByRole('button', { name: 'Item of line 4' })).toBeNull();
  });

  it('has a red bin on each line, and its numbers in a # column', async () => {
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="r1" />);
    const bin = await screen.findByRole('button', { name: 'Remove line 1' });
    expect(bin.className).toContain('text-bad');
    const table = screen.getByRole('table', { name: en.purchasing.receipts.lines });
    expect(within(table).getByRole('columnheader', { name: en.purchasing.line.number })).toBeDefined();
  });
});

describe('a purchase return from a receipt (W2-16)', () => {
  const RECEIPT: ReceiptView = {
    ...DRAFT,
    receipt: { ...DRAFT.receipt, id: 'r9', status: 'posted', number: 'GR000009' },
    lines: DRAFT.lines.map((l, n) => ({
      ...l,
      netUnitCost: l.unitCost,
      returnable: n === 0 ? 6000 : 2000,
    })),
  };

  it('says how many can go back, and marks more than that before saving', async () => {
    const f = fakeApi(lookups(), { 'GET /api/purchasing/receipts/r9': { status: 200, body: RECEIPT } });
    show(<ReturnScreen api={f.api} id="new-r9" />);
    const qty = await screen.findByLabelText('Quantity of line 1');
    expect(noteOf(qty)).toBe('Up to 6');
    fireEvent.change(qty, { target: { value: '8' } });
    fireEvent.blur(qty);
    expect(qty.getAttribute('aria-invalid')).toBe('true');
    expect(noteOf(qty)).toContain(en.purchasing.short.more_than_received);
    expect(f.calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('keeps Save and Post in the bar at the bottom, with what the supplier owes back', async () => {
    const f = fakeApi(lookups(), { 'GET /api/purchasing/receipts/r9': { status: 200, body: RECEIPT } });
    show(<ReturnScreen api={f.api} id="new-r9" />);
    const bar = await screen.findByRole('region', { name: en.purchasing.bar });
    fireEvent.change(screen.getByLabelText('Quantity of line 1'), { target: { value: '2' } });
    expect(within(bar).getByRole('status').textContent).toMatch(/Rs\s?2,500/);
    expect(within(bar).getByRole('button', { name: en.purchasing.post })).toBeDefined();
  });
});

// W2-05: every purchasing form is dated by the shop's business date from the API (04:00 cut-off), never by this
// browser's calendar, and Post waits on a date after it. The browser's clock is set days away from the shop's day,
// so the test holds in any time zone.
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

  it('a new goods receipt is received and billed on it, and received no later', async () => {
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="new" />);
    onToday(await screen.findByLabelText<HTMLInputElement>(en.purchasing.fields.receivedOn));
    // The bill date is the supplier's paper: the same default, no limit (owner answer 3).
    const bill = screen.getByLabelText<HTMLInputElement>(en.purchasing.fields.billDate);
    expect(bill.value).toBe(TODAY);
    expect(bill.max).toBe('');
  });

  it('says why and posts nothing when Received on is after it', async () => {
    const f = fakeApi(lookups());
    show(<ReceiptScreen api={f.api} id="r1" />);
    fireEvent.change(await screen.findByLabelText(en.purchasing.fields.billTotal), {
      target: { value: '13401' },
    });
    fireEvent.change(screen.getByLabelText(en.purchasing.fields.receivedOn), {
      target: { value: '2026-11-20' },
    });
    expect(screen.getByText(ahead)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.post }));
    expect(f.calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('says why when Post is refused for a date after it', async () => {
    const f = fakeApi(lookups(), {
      'POST /api/purchasing/receipts/r1/post': {
        status: 400,
        body: { error: 'date_in_future', today: TODAY },
      },
    });
    show(<ReceiptScreen api={f.api} id="r1" />);
    fireEvent.change(await screen.findByLabelText(en.purchasing.fields.billTotal), {
      target: { value: '13401' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.post }));
    expect(await screen.findByText(ahead)).toBeDefined();
  });

  it('a new purchase return is returned on it', async () => {
    show(<ReturnScreen api={fakeApi(lookups()).api} id="new" />);
    onToday(await screen.findByLabelText<HTMLInputElement>(en.purchasing.fields.returnedOn));
  });

  it('a supplier payment is paid on it, and not sent when dated later', async () => {
    const f = fakeApi(lookups({ can: { receive: false, payByBank: true } }));
    show(<SupplierScreen api={f.api} id="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: en.purchasing.pay.action }));
    const date = await screen.findByLabelText<HTMLInputElement>(en.purchasing.pay.date);
    onToday(date);
    fireEvent.change(screen.getByLabelText(en.purchasing.pay.amount), { target: { value: '5000' } });
    fireEvent.change(date, { target: { value: '2026-11-20' } });
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.pay.confirm }));
    expect((await screen.findAllByText(ahead)).length).toBeGreaterThan(0);
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

// W2-17 (owner's staging test of W2-16, 2026-11-28): bugs, each test written before its fix.
describe('the fixes from the staging test (W2-17)', () => {
  it('a unit cost too big to work out is a problem under Unit cost, and the page stays', async () => {
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="r1" />);
    const qty = await screen.findByLabelText('Quantity of line 2');
    fireEvent.change(qty, { target: { value: '100' } });
    const cost = screen.getByLabelText('Unit cost of line 2');
    fireEvent.change(cost, { target: { value: '2000000000000' } });
    fireEvent.blur(cost);
    expect(cost.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('button', { name: en.purchasing.post })).toBeDefined();
  });

  it('a line discount that is not a number is a problem under Discount, not 0', async () => {
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="r1" />);
    const discount = await screen.findByLabelText('Discount of line 2');
    fireEvent.change(discount, { target: { value: 's' } });
    fireEvent.blur(discount);
    expect(discount.getAttribute('aria-invalid')).toBe('true');
  });

  it('a bill discount too big to read never makes the bill match', async () => {
    show(<ReceiptScreen api={fakeApi(lookups()).api} id="r1" />);
    const bar = await screen.findByRole('region', { name: en.purchasing.bar });
    fireEvent.change(screen.getByLabelText(en.purchasing.fields.billTotal), { target: { value: '13401' } });
    expect(within(bar).getByRole('status').textContent).toContain(en.purchasing.totals.matches);
    const discount = screen.getByLabelText(en.purchasing.fields.billDiscount);
    fireEvent.change(discount, { target: { value: '100000000000000' } });
    fireEvent.blur(discount);
    expect(within(bar).getByRole('status').textContent).not.toContain(en.purchasing.totals.matches);
    expect(discount.getAttribute('aria-invalid')).toBe('true');
  });

  it('Save draft sends nothing while a quantity is not a number, and marks it', async () => {
    const f = fakeApi(lookups());
    show(<ReceiptScreen api={f.api} id="r1" />);
    const qty = await screen.findByLabelText('Quantity of line 2');
    fireEvent.change(qty, { target: { value: 'dsasd' } });
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.saveDraft }));
    expect(qty.getAttribute('aria-invalid')).toBe('true');
    await Promise.resolve();
    expect(f.calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('two quick clicks on Save draft save a receipt once', async () => {
    const f = fakeApi(lookups());
    show(<ReceiptScreen api={f.api} id="r1" />);
    const save = await screen.findByRole('button', { name: en.purchasing.saveDraft });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(f.calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 20));
    expect(f.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('two quick clicks on Save draft make one new receipt, not two', async () => {
    const f = fakeApi(lookups(), {
      'POST /api/purchasing/receipts': { status: 201, body: { id: 'r1', rowVersion: '1' } },
      'GET /api/purchasing/items': {
        status: 200,
        body: {
          items: [
            {
              id: 'i3',
              code: 'OIL050',
              name: 'ENGINE OIL',
              allowsFraction: true,
              lastCost: null,
              retail: null,
            },
          ],
        },
      },
    });
    show(<ReceiptScreen api={f.api} id="new" />);
    // A line with an item: a line with none is nothing to keep, and nothing would be sent at all.
    fireEvent.click(await screen.findByRole('button', { name: 'Item of line 1' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Item of line 1' }), { target: { value: 'oil' } });
    fireEvent.click(await screen.findByRole('option', { name: /OIL050/ }));
    fireEvent.change(screen.getByLabelText('Quantity of line 1'), { target: { value: '1' } });
    const save = screen.getByRole('button', { name: en.purchasing.saveDraft });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 20));
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('two quick clicks on Save draft save a purchase return once', async () => {
    const f = fakeApi(lookups(), { 'GET /api/purchasing/returns/p1': { status: 200, body: RETURN_DRAFT } });
    show(<ReturnScreen api={f.api} id="p1" />);
    const save = await screen.findByRole('button', { name: en.purchasing.saveDraft });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(f.calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 20));
    expect(f.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
});

// W2-18 (owner, 2026-11-28): one supplier's bill is posted once. The screen asks who else has it when the bill number
// is left (and when a draft opens), and says it under Supplier's bill no.
describe("a supplier's bill, posted once (W2-18)", () => {
  const POSTED = { status: 200, body: { posted: { id: 'r14', number: 'GR000014' }, drafts: 0 } };
  const NEW = (answer: { status: number; body: unknown }) =>
    fakeApi(lookups(), { 'GET /api/purchasing/receipts/bill-no': answer });
  const pickSupplier = async () => {
    fireEvent.change(await screen.findByRole('combobox', { name: en.purchasing.fields.supplier }), {
      target: { value: 'naveed' },
    });
    fireEvent.click(await screen.findByRole('option', { name: /Naveed Glass/ }));
  };

  it('says under the bill number which posted receipt has it, as a link to that receipt', async () => {
    const answers: Record<string, { status: number; body: unknown }> = {
      'GET /api/purchasing/receipts/bill-no': { status: 200, body: { posted: null, drafts: 0 } },
    };
    const f = fakeApi(lookups(), answers);
    show(<ReceiptScreen api={f.api} id="new" />);
    await pickSupplier();
    const billNo = screen.getByLabelText(en.purchasing.fields.billNo);
    fireEvent.change(billNo, { target: { value: 'INV-4471' } });
    expect(f.calls.some((c) => c.path.startsWith('/api/purchasing/receipts/bill-no'))).toBe(false);
    answers['GET /api/purchasing/receipts/bill-no'] = POSTED;
    fireEvent.blur(billNo);
    const link = await screen.findByRole('link', { name: 'GR000014' });
    expect(link.getAttribute('href')).toBe(href.receipt('r14'));
    expect(billNo.getAttribute('aria-invalid')).toBe('true');
    expect(noteOf(billNo)).toBe('Already on GR000014.');
    const asked = f.calls.find((c) => c.path.startsWith('/api/purchasing/receipts/bill-no'))!;
    expect(asked.path).toContain('supplier=s1');
    expect(asked.path).toContain('billNo=INV-4471');
  });

  it('a draft opened with a posted bill says so at once, and Post sends nothing and goes to the bill number', async () => {
    const f = NEW(POSTED);
    show(<ReceiptScreen api={f.api} id="r1" />);
    const billNo = await screen.findByLabelText(en.purchasing.fields.billNo);
    await waitFor(() => expect(noteOf(billNo)).toBe('Already on GR000014.'));
    const asked = f.calls.find((c) => c.path.startsWith('/api/purchasing/receipts/bill-no'))!;
    expect(asked.path).toContain('except=r1');
    fireEvent.change(screen.getByLabelText(en.purchasing.fields.billTotal), { target: { value: '13401' } });
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.post }));
    expect(document.activeElement).toBe(billNo);
    expect(f.calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('another draft with the bill is an amber note only, and Post goes ahead', async () => {
    const f = NEW({ status: 200, body: { posted: null, drafts: 1 } });
    show(<ReceiptScreen api={f.api} id="r1" />);
    const note = await screen.findByText(en.purchasing.warnings.bill_no_on_draft);
    expect(note.className).toContain('text-warn');
    fireEvent.change(screen.getByLabelText(en.purchasing.fields.billTotal), { target: { value: '13401' } });
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.post }));
    await waitFor(() => expect(f.calls.some((c) => c.method === 'PUT')).toBe(true));
  });

  it('says which receipt has the bill when the server refuses Post a moment later', async () => {
    const f = fakeApi(lookups(), {
      'GET /api/purchasing/receipts/bill-no': { status: 200, body: { posted: null, drafts: 0 } },
      'POST /api/purchasing/receipts/r1/post': {
        status: 409,
        body: { error: 'bill_no_taken', number: 'GR000015' },
      },
    });
    show(<ReceiptScreen api={f.api} id="r1" />);
    fireEvent.change(await screen.findByLabelText(en.purchasing.fields.billTotal), {
      target: { value: '13401' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.purchasing.post }));
    expect(await screen.findByText('This bill is already on GR000015.')).toBeDefined();
  });
});

// Owner's staging test (2026-11-28): the unit cost an item filled in went with it. Changing the line's item replaced
// nothing, so the old item's last cost stayed against the new item. A cost the purchaser typed stays.
describe("changing a line's item", () => {
  const ITEMS = {
    status: 200,
    body: {
      items: [
        {
          id: 'i3',
          code: 'OIL050',
          name: 'ENGINE OIL',
          allowsFraction: true,
          lastCost: 245000,
          retail: 300000,
        },
        {
          id: 'i4',
          code: 'FNBL005',
          name: 'FAN BELT SWIFT',
          allowsFraction: false,
          lastCost: null,
          retail: null,
        },
        {
          id: 'i5',
          code: 'FNBL002',
          name: 'FAN BELT CIVIC',
          allowsFraction: false,
          lastCost: 68600,
          retail: null,
        },
      ],
    },
  };
  const choose = async (code: RegExp) => {
    fireEvent.click(screen.getByRole('button', { name: 'Item of line 3' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Item of line 3' }), { target: { value: 'a' } });
    fireEvent.click(await screen.findByRole('option', { name: code }));
  };
  const start = async () => {
    show(<ReceiptScreen api={fakeApi(lookups(), { 'GET /api/purchasing/items': ITEMS }).api} id="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: en.purchasing.line.add }));
    await choose(/OIL050/);
    const cost = screen.getByLabelText<HTMLInputElement>('Unit cost of line 3');
    expect(cost.value).toBe('2450');
    return cost;
  };

  it('empties the cost the old item filled in when the new item has no last cost', async () => {
    const cost = await start();
    await choose(/FNBL005/);
    expect(cost.value).toBe('');
  });

  it("puts the new item's last cost in place of the one the old item filled in", async () => {
    const cost = await start();
    await choose(/FNBL002/);
    expect(cost.value).toBe('686');
  });

  it('keeps a cost the purchaser typed', async () => {
    const cost = await start();
    fireEvent.change(cost, { target: { value: '2500' } });
    await choose(/FNBL002/);
    expect(cost.value).toBe('2500');
  });
});
