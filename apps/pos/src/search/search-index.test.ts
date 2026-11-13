// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';

import cases from './cases.json';
import { SearchIndex, type CatalogChanges } from './search-index';

// Counter search (POS-02, CAT-02, POS spec §9, W1-03): the golden cases, what a result shows, patches from a pull,
// and the speed on a catalog the size of Delux's.

const withSync = (rows: Record<string, unknown>[]) =>
  rows.map((r) => ({ row_version: '1', deleted_at: null, ...r }));
const catalog = (): CatalogChanges =>
  Object.fromEntries(
    Object.entries(cases.catalog).map(([dataset, rows]) => [
      dataset,
      withSync(rows as Record<string, unknown>[]),
    ]),
  );
const loaded = () => {
  const index = new SearchIndex();
  index.apply(catalog());
  return index;
};
const codes = (index: SearchIndex, text: string) => index.search(text).map((r) => r.code);

describe(cases.description, () => {
  const index = loaded();
  for (const c of cases.cases) {
    it(c.name, () => {
      expect(codes(index, c.text)).toEqual(c.expected);
    });
  }
});

describe('a search result', () => {
  it('shows what the salesman needs: code, name, variant, first OEM number, vehicle, bin and the default tier price', () => {
    const [r] = loaded().search('BRPD001');
    expect(r).toEqual({
      id: 'i1',
      code: 'BRPD001',
      name: 'BRAKE PADS FRONT COROLLA',
      variant: 'FRONT',
      spec: null,
      oem: '04465-02220',
      vehicle: { make: 'TOYOTA', model: 'COROLLA', yearFrom: 2009, yearTo: 2014 },
      bin: 'R3-B2',
      status: 'active',
      price: 450000,
      rank: 1,
      // The database worker fills in the stock (W1-27); the index knows whether the unit allows fractions.
      fraction: false,
      stock: [],
    });
  });

  it("shows another tier's price when asked, the default tier's when the item has none there, or none", () => {
    const index = loaded();
    expect(index.search('BRPD001', { tierId: 't-mech' })[0]!.price).toBe(427500);
    // The price a bill line would get (POS spec §10).
    expect(index.search('FNBL001', { tierId: 't-mech' })[0]!.price).toBe(130000);
    expect(index.search('FNBL002')[0]!.price).toBeNull();
  });

  it('returns at most 50 results, or the limit asked for', () => {
    const index = new SearchIndex();
    const items = Array.from({ length: 80 }, (_, i) => ({
      id: `g${i}`,
      code: `GSKT${String(i).padStart(3, '0')}`,
      name: `GASKET SET ${i}`,
      status: 'active',
    }));
    index.apply({ items: withSync(items) });
    expect(index.search('gasket')).toHaveLength(50);
    expect(index.search('gasket', { limit: 10 })).toHaveLength(10);
    expect(index.size).toBe(80);
  });
});

describe('an item for a bill line (POS spec §10)', () => {
  const withUnits = () => {
    const index = loaded();
    index.apply({
      units: withSync([
        { id: 'u-pcs', code: 'PCS', name: 'Piece', allows_fraction: false },
        { id: 'u-m', code: 'METER', name: 'Meter', allows_fraction: true },
      ]),
      items: withSync([
        {
          id: 'i4',
          code: 'FNBL001',
          name: 'FAN BELT CULTUS 4PK-855',
          category_id: 'c-fnbl',
          spec: '4PK-855',
          unit_id: 'u-pcs',
          floor_price: '120000',
          status: 'active',
        },
        { id: 'i9', code: 'HOSE001', name: 'FUEL HOSE', unit_id: 'u-m', status: 'active' },
      ]),
    });
    return index;
  };

  it('takes the price in the bill’s tier, the floor and whether the unit allows fractions', () => {
    expect(withUnits().billItem('i1', 't-mech')).toEqual({
      itemId: 'i1',
      code: 'BRPD001',
      name: 'BRAKE PADS FRONT COROLLA',
      variant: 'FRONT',
      spec: null,
      list: 427500,
      floor: null,
      allowsFraction: false,
    });
    expect(withUnits().billItem('i4', 't-retail')).toMatchObject({
      list: 130000,
      floor: 120000,
      allowsFraction: false,
    });
    expect(withUnits().billItem('i9', null)).toMatchObject({ list: null, floor: null, allowsFraction: true });
  });

  it("takes the floor from cost when the item has none of its own; the item's own floor wins (W1-14, D-092)", () => {
    const index = withUnits();
    index.apply({
      item_floors: withSync([
        { item_id: 'i1', floor: '325500' },
        { item_id: 'i4', floor: '99000' },
      ]),
    });
    expect(index.billItem('i1', 't-retail')?.floor).toBe(325500);
    expect(index.billItem('i4', 't-retail')?.floor).toBe(120000);
    expect(index.billItem('i9', null)?.floor).toBeNull();
    // A floor that goes (the item has no cost any more) leaves the list price as the floor again.
    index.apply({
      item_floors: [{ item_id: 'i1', floor: '325500', row_version: '9', deleted_at: '2026-12-31' }],
    });
    expect(index.billItem('i1', 't-retail')?.floor).toBeNull();
  });

  it("falls back to the default tier's price, and is null for an unknown item", () => {
    const index = withUnits();
    expect(index.billItem('i4', 't-mech')?.list).toBe(130000);
    expect(index.billItem('i4', null)?.list).toBe(130000);
    expect(index.billItem('nope', 't-retail')).toBeNull();
  });

  it('gives the prices in another tier for a tier change', () => {
    expect(withUnits().tierPrices(['i1', 'i4', 'i9'], 't-mech')).toEqual({
      i1: 427500,
      i4: 130000,
      i9: null,
    });
  });

  it('lists the tiers in their order', () => {
    expect(withUnits().tiers()).toEqual([
      { id: 't-retail', code: 'RETAIL', name: 'Retail', isDefault: true },
      { id: 't-mech', code: 'MECHANIC', name: 'Mechanic', isDefault: false },
    ]);
  });
});

describe('patches from a pull', () => {
  it('a deleted item is gone, and a changed price shows at once', () => {
    const index = loaded();
    index.apply({
      items: withSync([{ ...cases.catalog.items[3], deleted_at: '2026-10-26T10:00:00Z' }]),
      item_prices: withSync([
        { id: 'p1', item_id: 'i1', tier_id: 't-retail', price: '470000', row_version: '2' },
      ]),
    });
    expect(codes(index, 'FNBL001')).toEqual([]);
    expect(codes(index, '17521')).toEqual(['FNBL002']);
    expect(index.search('BRPD001')[0]!.price).toBe(470000);
  });

  it('a removed identifier no longer finds its item; a new one does', () => {
    const index = loaded();
    index.apply({
      item_identifiers: withSync([
        { id: 'x17', item_id: 'i6', kind: 'oem', value: '17801-0D060', normalized_value: '178010D060' },
      ]).map((r) => ({ ...r, deleted_at: '2026-10-26T10:00:00Z' })),
    });
    expect(codes(index, '17801')).toEqual([]);
    index.apply({
      item_identifiers: withSync([
        { id: 'x30', item_id: 'i6', kind: 'oem', value: '17801-0Y040', normalized_value: '178010Y040' },
      ]),
    });
    expect(codes(index, '17801 0y040')).toEqual(['AFLT001']);
  });

  it('identifiers and vehicle tags that arrive before their item are used once it arrives', () => {
    const index = new SearchIndex();
    index.apply({
      item_identifiers: withSync([
        { id: 'x1', item_id: 'n1', kind: 'oem', value: '12345-67890', normalized_value: '1234567890' },
      ]),
      item_compatibility: withSync([
        { id: 'v1', item_id: 'n1', make_id: null, model: 'HIACE', year_from: 2005 },
      ]),
    });
    expect(index.search('12345')).toEqual([]);
    index.apply({ items: withSync([{ id: 'n1', code: 'NEW001', name: 'NEW PART', status: 'active' }]) });
    expect(codes(index, '12345')).toEqual(['NEW001']);
    expect(codes(index, 'hiace 2010')).toEqual(['NEW001']);
  });

  it('a renamed vehicle make is found by its new name', () => {
    const index = loaded();
    index.apply({ vehicle_makes: withSync([{ id: 'm-suzuki', name: 'PAK SUZUKI', row_version: '2' }]) });
    expect(codes(index, 'pak cultus')).toEqual(['FNBL001']);
  });
});

describe('speed (POS-02: results within 100 ms of a key press)', () => {
  const WORDS = ['BRAKE', 'PADS', 'FAN', 'BELT', 'AIR', 'FILTER', 'OIL', 'CLUTCH', 'PLATE', 'WATER', 'PUMP'];
  const MODELS = ['COROLLA', 'CIVIC', 'MEHRAN', 'CULTUS', 'ALTO', 'CITY', 'VITZ', 'HIACE', 'BOLAN', 'SWIFT'];
  const big = () => {
    let seed = 20261026;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
    const items = [];
    const identifiers = [];
    const vehicles = [];
    for (let i = 0; i < 20_000; i++) {
      const code = `${pick(['ABEA', 'BRPD', 'FNBL', 'AFLT'])}${String(i).padStart(5, '0')}`;
      items.push({
        id: `i${i}`,
        code,
        name: `${pick(WORDS)} ${pick(WORDS)} ${pick(MODELS)} ${i}`,
        status: 'active',
      });
      identifiers.push({
        id: `b${i}`,
        item_id: `i${i}`,
        kind: 'barcode',
        value: code,
        normalized_value: code,
      });
      const oem = `${10000 + Math.floor(rnd() * 89999)}${pick(['A', 'B', 'C'])}${Math.floor(rnd() * 9999)}`;
      identifiers.push({ id: `o${i}`, item_id: `i${i}`, kind: 'oem', value: oem, normalized_value: oem });
      vehicles.push({
        id: `v${i}`,
        item_id: `i${i}`,
        model: pick(MODELS),
        year_from: 2000 + (i % 20),
        year_to: null,
      });
    }
    const index = new SearchIndex();
    index.apply({
      items: withSync(items),
      item_identifiers: withSync(identifiers),
      item_compatibility: withSync(vehicles),
    });
    return index;
  };

  // Built once: under the full parallel run, building 20,000 items twice took longer than a test's 5 seconds.
  let index: SearchIndex;
  beforeAll(() => {
    index = big();
    index.warm();
  }, 60_000);

  it('the first search after start-up is within the budget too, once the index is warmed', () => {
    const start = performance.now();
    index.search('brake pads corolla');
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('answers typical searches on 20,000 items in well under 50 ms', () => {
    const queries = [
      'brake pads corolla',
      'fan belt',
      '17',
      '1752',
      'BRPD00012',
      'clutch plate civic 2015',
      'f',
      'oil',
    ];
    index.search('warm up');
    const times: number[] = [];
    for (let i = 0; i < 80; i++) {
      const q = queries[i % queries.length]!;
      const start = performance.now();
      index.search(q);
      times.push(performance.now() - start);
    }
    // The median, not the slowest: in the full parallel run (48 test files sharing the CPU) single queries stall for
    // reasons outside the search. Alone, even with coverage, the slowest query is about 18 ms; the real catalog
    // measured 3–19 ms in the browser (plan, Verify 2).
    times.sort((a, b) => a - b);
    expect(times[times.length / 2]).toBeLessThan(50);
  }, 30_000);
});
