import type { CatalogLookups, ItemDetail, ItemList } from '@erp/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { CategoriesScreen, percentText, percentValue } from './CategoriesScreen';
import { qtyText, qtyValue } from './data';
import { ItemScreen } from './ItemScreen';
import { ItemsScreen } from './ItemsScreen';
import { NewItemScreen } from './NewItemScreen';
import { notify, Toaster } from '../ui';
import { chooseOption } from '../ui/testing/choose';

// The catalog screens (W1-15) over a fake API: the list and its search, an item's parts, the price form only for the
// owner (owner answer 3) with a reason when a price goes down (owner answer 2), a stale save, the notice until the
// shop is live (owner answer 1), a new item's proposed tier prices, and a category's margin.

const MONEY = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };
const lookups = (over: Partial<CatalogLookups> = {}): CatalogLookups => ({
  categories: [
    {
      id: 'c1',
      code: 'ABEA',
      name: 'Adjuster bearings',
      parentId: null,
      floorMarginBp: 500,
      rowVersion: '7',
    },
  ],
  units: [{ id: 'u1', code: 'PCS', name: 'Pieces', allowsFraction: false }],
  brands: [{ id: 'b1', name: 'CHINA' }],
  origins: [],
  makes: [{ id: 'm1', name: 'TOYOTA' }],
  tiers: [
    { id: 't1', code: 'RETAIL', name: 'Retail' },
    { id: 't2', code: 'MECHANIC', name: 'Mechanic' },
    { id: 't3', code: 'WHOLESALE', name: 'Wholesale' },
  ],
  suppliers: [],
  live: false,
  money: MONEY,
  can: { editItems: true, editPrices: true, viewCost: true, printLabels: true, stockCard: true },
  ...over,
});
const DETAIL: ItemDetail = {
  item: {
    id: 'i1',
    code: 'ABEA001',
    name: 'ADJUSTER BEARING SALOON',
    categoryId: 'c1',
    unitId: 'u1',
    brandId: 'b1',
    originId: null,
    variant: null,
    spec: null,
    binLocation: null,
    defaultSupplierId: null,
    minQty: null,
    maxQty: null,
    excludeFromReorder: false,
    status: 'active',
    rowVersion: '41',
    updatedAt: '2026-11-05T10:00:00.000Z',
    updatedBy: 'Owner',
  },
  identifiers: [
    { kind: 'barcode', value: 'ABEA001', isPrimary: true },
    { kind: 'oem', value: '16620-22010', isPrimary: false },
  ],
  vehicles: [{ makeId: 'm1', model: 'COROLLA', yearFrom: 2008, yearTo: 2014, note: null }],
  prices: { RETAIL: 400000, MECHANIC: 380000, WHOLESALE: 360000 },
  floor: { own: null, fromCost: 315000, effective: 315000, source: 'cost' },
  cost: {
    avgCost: 300000,
    lastCost: 310000,
    lastSupplier: 'Naveed Glass',
    lastReceiptAt: '2026-11-03T05:00:00.000Z',
  },
  history: [
    {
      target: 'RETAIL',
      old: 380000,
      new: 400000,
      source: 'manual',
      reason: null,
      note: null,
      by: 'Owner',
      at: '2026-11-04T10:00:00.000Z',
    },
  ],
};

// Shop 8 and Godown 4 of the bearing at Rs 3,000; a dormant lamp with none; 4.5 m of hose, 2 m below zero in the
// godown (W1-26).
const LIST: ItemList = {
  total: 3,
  locations: [
    { id: 'l-shop', name: 'Shop' },
    { id: 'l-godown', name: 'Godown' },
  ],
  totalValue: 3_684_500,
  items: [
    {
      id: 'i1',
      code: 'ABEA001',
      name: 'ADJUSTER BEARING SALOON',
      brand: 'CHINA',
      category: 'Adjuster bearings',
      status: 'active',
      retail: 400000,
      unit: 'PCS',
      fraction: false,
      stock: { 'l-shop': 8000, 'l-godown': 4000 },
      level: 'ok',
      avgCost: 300000,
      value: 3_600_000,
    },
    {
      id: 'i2',
      code: 'HLMP007',
      name: 'HEAD LAMP CULTUS',
      brand: null,
      category: 'Lamps',
      status: 'dormant',
      retail: 950000,
      unit: 'PCS',
      fraction: false,
      stock: {},
      level: 'out',
      avgCost: null,
      value: 0,
    },
    {
      id: 'i3',
      code: 'HOSE001',
      name: 'BRAKE HOSE',
      brand: 'GENUINE',
      category: 'Hoses',
      status: 'active',
      retail: 52000,
      unit: 'METER',
      fraction: true,
      stock: { 'l-shop': 4500, 'l-godown': -2000 },
      level: 'low',
      avgCost: 33800,
      value: 84500,
    },
  ],
};

function fakeApi(l: CatalogLookups, answers: Record<string, { status: number; body: unknown }> = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: Api = (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    if (answers[key]) return Promise.resolve(answers[key]);
    if (key === 'GET /api/catalog/lookups') return Promise.resolve({ status: 200, body: l });
    if (key === 'GET /api/catalog/items/i1') return Promise.resolve({ status: 200, body: DETAIL });
    if (key === 'GET /api/catalog/items') return Promise.resolve({ status: 200, body: LIST });
    return Promise.resolve({ status: 200, body: { rowVersion: '42' } });
  };
  return { api, calls };
}

// With the frame's toasts (W2-12, owner answer 6), which start empty for each test.
const show = (ui: React.ReactElement) =>
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

describe('the item list', () => {
  it('lists items with their Retail price and searches as you type, with no go-live notice (D-113)', async () => {
    const f = fakeApi(lookups());
    show(<ItemsScreen api={f.api} />);
    expect(await screen.findByRole('link', { name: 'ABEA001' })).toBeDefined();
    expect(screen.getByText(/4,000/)).toBeDefined();
    expect(screen.queryByText(/legacy app/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(en.catalog.items.search), { target: { value: '16620 22010' } });
    await waitFor(() => expect(f.calls.some((c) => c.path.includes('q=16620+22010'))).toBe(true));
  });

  it('shows no New item without cat.item.edit', async () => {
    const f = fakeApi(
      lookups({
        live: true,
        can: { editItems: false, editPrices: true, viewCost: true, printLabels: false, stockCard: true },
      }),
    );
    show(<ItemsScreen api={f.api} />);
    expect(await screen.findByRole('link', { name: 'ABEA001' })).toBeDefined();
    expect(screen.queryByRole('link', { name: en.catalog.items.add })).toBeNull();
    // Nor a relabel without cat.label.print.
    expect(screen.queryByRole('checkbox', { name: 'Label ABEA001' })).toBeNull();
  });

  it('picks items for a relabel and opens the label screen with them (W1-17)', async () => {
    show(<ItemsScreen api={fakeApi(lookups()).api} />);
    const none = await screen.findByRole('button', { name: `${en.labels.makeLabels} (0)` });
    expect((none as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Label ABEA001' }));
    const ready = screen.getByRole('link', { name: `${en.labels.makeLabels} (1)` });
    expect(ready.getAttribute('href')).toBe('#/catalog/labels/items/i1');
  });
});

describe('the item list with its stock (W1-26)', () => {
  const header = () =>
    screen
      .getAllByRole('columnheader')
      .map((h) => h.textContent ?? '')
      .filter((x) => x !== '');

  it('shows each item on one line: unit, cost, sale price, Shop, Godown, stock value and level, with a total', async () => {
    show(<ItemsScreen api={fakeApi(lookups()).api} />);
    await screen.findByRole('link', { name: 'ABEA001' });
    expect(header()).toEqual([
      en.catalog.fields.code,
      en.catalog.items.item,
      en.catalog.fields.brand,
      en.catalog.items.unit,
      en.catalog.items.cost,
      en.catalog.items.salePrice,
      'Shop',
      'Godown',
      en.catalog.items.value,
      en.catalog.items.level,
    ]);
    const bearing = screen.getByRole('row', { name: /ABEA001/ });
    const cells = within(bearing)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells).toEqual([
      // The pick-for-labels box, named for screen readers only.
      'Label ABEA001',
      'ABEA001',
      'ADJUSTER BEARING SALOON',
      'CHINA',
      'PCS',
      expect.stringMatching(/3,000/),
      expect.stringMatching(/4,000/),
      '8',
      '4',
      expect.stringMatching(/36,000/),
      en.catalog.items.levels.ok,
    ]);
    // A quantity opens the item's stock card.
    expect(within(bearing).getByRole('link', { name: '8' }).getAttribute('href')).toBe('#/stock/card/i1');
    // The total counts every match, not only this page.
    expect(screen.getByText(en.catalog.items.totalValue).closest('tr')?.textContent).toMatch(/36,845/);
  });

  it('shows a chip only for an item that is not active, a quantity below zero in red, and decimals for a fractional unit', async () => {
    show(<ItemsScreen api={fakeApi(lookups()).api} />);
    await screen.findByRole('link', { name: 'ABEA001' });
    const table = screen.getByRole('table', { name: en.catalog.items.title });
    expect(within(table).queryByText(en.catalog.status.active)).toBeNull();
    const lamp = screen.getByRole('row', { name: /HLMP007/ });
    expect(within(lamp).getByText(en.catalog.status.dormant)).toBeDefined();
    expect(within(lamp).getByText(en.catalog.items.levels.out)).toBeDefined();
    expect(within(lamp).getByText(en.catalog.items.noCost)).toBeDefined();
    const hose = screen.getByRole('row', { name: /HOSE001/ });
    expect(within(hose).getByRole('link', { name: '4.5' })).toBeDefined();
    const below = within(hose).getByRole('link', { name: '-2' });
    expect(below.className).toMatch(/text-destructive/);
    expect(within(hose).getByText(en.catalog.items.levels.low)).toBeDefined();
  });

  it('hides the cost and the value without cost.view, and links no quantity without the stock card', async () => {
    const plain: ItemList = {
      total: LIST.total,
      locations: LIST.locations,
      items: LIST.items.map((i) => {
        const r = { ...i };
        delete r.avgCost;
        delete r.value;
        return r;
      }),
    };
    const f = fakeApi(
      lookups({
        can: { editItems: true, editPrices: false, viewCost: false, printLabels: false, stockCard: false },
      }),
      { 'GET /api/catalog/items': { status: 200, body: plain } },
    );
    show(<ItemsScreen api={f.api} />);
    await screen.findByRole('link', { name: 'ABEA001' });
    expect(header()).not.toContain(en.catalog.items.cost);
    expect(header()).not.toContain(en.catalog.items.value);
    expect(screen.queryByText(en.catalog.items.totalValue)).toBeNull();
    const bearing = screen.getByRole('row', { name: /ABEA001/ });
    expect(within(bearing).queryByRole('link', { name: '8' })).toBeNull();
    expect(within(bearing).getByText('8')).toBeDefined();
  });

  it('filters by level and sorts by a column, then the other way', async () => {
    const f = fakeApi(lookups());
    show(<ItemsScreen api={f.api} />);
    await screen.findByRole('link', { name: 'ABEA001' });
    await chooseOption(en.catalog.items.level, en.catalog.items.levelFilters.low);
    await waitFor(() => expect(f.calls.some((c) => c.path.includes('level=low'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: en.catalog.items.value }));
    await waitFor(() => expect(f.calls.some((c) => c.path.includes('sort=value&dir=desc'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: en.catalog.items.value }));
    await waitFor(() => expect(f.calls.some((c) => c.path.includes('sort=value&dir=asc'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Godown' }));
    await waitFor(() => expect(f.calls.some((c) => c.path.includes('sort=l-godown&dir=desc'))).toBe(true));
  });
});

describe('an item', () => {
  it('shows its parts, its floor from cost and its cost, and the history', async () => {
    show(<ItemScreen api={fakeApi(lookups()).api} id="i1" />);
    expect(await screen.findByDisplayValue('ADJUSTER BEARING SALOON')).toBeDefined();
    expect(screen.getByDisplayValue('16620-22010')).toBeDefined();
    expect(screen.getByDisplayValue('COROLLA')).toBeDefined();
    expect(screen.getByText(/The counter's floor: Rs\s?3,150, cost \+ the category margin/)).toBeDefined();
    expect(screen.getByText('Naveed Glass')).toBeDefined();
    const history = screen.getByRole('table', { name: en.catalog.item.history });
    expect(within(history).getAllByText('Retail').length).toBeGreaterThan(0);
  });

  it('asks why when a price goes down, and sends the reason with the row version', async () => {
    const f = fakeApi(lookups());
    show(<ItemScreen api={f.api} id="i1" />);
    const mechanic = await screen.findByLabelText('Mechanic');
    expect(screen.queryByLabelText(en.catalog.item.reason)).toBeNull();
    fireEvent.change(mechanic, { target: { value: '3700' } });
    await chooseOption(en.catalog.item.reason, en.catalog.reasons.market_price);
    fireEvent.click(screen.getByRole('button', { name: en.catalog.item.savePrices }));
    await waitFor(() => expect(f.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(f.calls.find((c) => c.method === 'PUT')).toMatchObject({
      path: '/api/catalog/items/i1/prices',
      body: {
        rowVersion: '41',
        tiers: { RETAIL: 400000, MECHANIC: 370000, WHOLESALE: 360000 },
        floor: null,
        reason: 'market_price',
      },
    });
  });

  it('keeps the price form read-only for a manager, and hides the cost without cost.view', async () => {
    const noCost: ItemDetail = { ...DETAIL };
    delete noCost.cost;
    const f = fakeApi(
      lookups({
        can: { editItems: true, editPrices: false, viewCost: false, printLabels: false, stockCard: true },
      }),
      {
        'GET /api/catalog/items/i1': { status: 200, body: noCost },
      },
    );
    show(<ItemScreen api={f.api} id="i1" />);
    expect(await screen.findByText(en.catalog.item.pricesOwnerOnly)).toBeDefined();
    expect(screen.getByLabelText('Retail').matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: en.catalog.item.savePrices })).toBeNull();
    expect(screen.queryByText(en.catalog.cost.average)).toBeNull();
  });

  it('says who changed the item in the meantime when a save is stale', async () => {
    const f = fakeApi(lookups(), {
      'PATCH /api/catalog/items/i1': {
        status: 409,
        body: { error: 'stale', by: 'Maria', at: '2026-11-05T10:05:00.000Z' },
      },
    });
    show(<ItemScreen api={f.api} id="i1" />);
    fireEvent.click(await screen.findByRole('button', { name: en.catalog.item.saveDetails }));
    expect(await screen.findByText(/Maria changed this in the meantime/)).toBeDefined();
  });
});

describe('a new item', () => {
  it('proposes Mechanic and Wholesale from Retail, and sends the code upper case', async () => {
    const f = fakeApi(lookups(), { 'POST /api/catalog/items': { status: 201, body: { id: 'i9' } } });
    show(<NewItemScreen api={f.api} />);
    fireEvent.change(await screen.findByLabelText('Retail'), { target: { value: '3950' } });
    expect(screen.getByLabelText<HTMLInputElement>('Mechanic').value).toBe('3753');
    expect(screen.getByLabelText<HTMLInputElement>('Wholesale').value).toBe('3555');
    fireEvent.change(screen.getByLabelText(en.catalog.fields.code), { target: { value: ' abea050 ' } });
    fireEvent.change(screen.getByLabelText(en.catalog.fields.name), {
      target: { value: 'ADJUSTER BEARING VITZ' },
    });
    // The category is searched (owner answer 3), and taken with Enter.
    const category = screen.getByRole('combobox', { name: en.catalog.fields.category });
    fireEvent.change(category, { target: { value: 'abea' } });
    fireEvent.keyDown(category, { key: 'Enter' });
    await chooseOption(en.catalog.fields.unit, 'PCS');
    fireEvent.click(screen.getByRole('button', { name: en.catalog.newItem.create }));
    await waitFor(() => expect(window.location.hash).toBe('#/catalog/items/i9'));
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({
      code: 'ABEA050',
      name: 'ADJUSTER BEARING VITZ',
      categoryId: 'c1',
      unitId: 'u1',
      prices: { RETAIL: 395000, MECHANIC: 375300, WHOLESALE: 355500 },
    });
  });

  it('marks every wrong field at once and puts focus on the first; sends nothing (owner answer 6)', async () => {
    const f = fakeApi(lookups());
    show(<NewItemScreen api={f.api} />);
    fireEvent.change(await screen.findByLabelText('Retail'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: en.catalog.newItem.create }));
    const code = screen.getByLabelText(en.catalog.fields.code);
    await waitFor(() => expect(document.activeElement).toBe(code));
    for (const label of [
      en.catalog.fields.code,
      en.catalog.fields.name,
      en.catalog.fields.category,
      'Retail',
    ])
      expect(screen.getByLabelText(label).getAttribute('aria-invalid')).toBe('true');
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('a manager adds one without prices', async () => {
    show(
      <NewItemScreen
        api={
          fakeApi(
            lookups({
              can: {
                editItems: true,
                editPrices: false,
                viewCost: false,
                printLabels: false,
                stockCard: true,
              },
            }),
          ).api
        }
      />,
    );
    expect(await screen.findByText(en.catalog.newItem.ownerPrices)).toBeDefined();
    expect(screen.queryByLabelText('Retail')).toBeNull();
  });
});

describe('the categories', () => {
  it("saves a category's floor margin as basis points", async () => {
    const f = fakeApi(lookups());
    show(<CategoriesScreen api={f.api} />);
    const field = await screen.findByLabelText('Floor margin of ABEA');
    expect((field as HTMLInputElement).value).toBe('5');
    fireEvent.change(field, { target: { value: '7.5' } });
    fireEvent.click(screen.getByRole('button', { name: en.catalog.categories.save }));
    await waitFor(() =>
      expect(f.calls.find((c) => c.method === 'PATCH')).toMatchObject({
        path: '/api/catalog/categories/c1',
        body: { rowVersion: '7', floorMarginBp: 750 },
      }),
    );
  });
});

describe('field values', () => {
  it('quantities in thousandths and margins in basis points, exactly', () => {
    expect([qtyText(2500), qtyText(2000), qtyText(125), qtyText(null)]).toEqual(['2.5', '2', '0.125', '']);
    expect([qtyValue('2.5'), qtyValue(''), qtyValue('x')]).toEqual([2500, null, undefined]);
    expect([
      percentText(500),
      percentText(250),
      percentValue('7.5'),
      percentValue('101'),
      percentValue(''),
    ]).toEqual(['5', '2.5', 750, undefined, null]);
  });
});
