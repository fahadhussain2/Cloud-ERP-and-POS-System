import { describe, expect, it } from 'vitest';

import { generateCatalog } from './generate';

// The generated staging catalog (W1-21): deterministic, and shaped like Delux's.

describe('a generated catalog', () => {
  const items = generateCatalog({ items: 2000, seed: 7 });
  const share = (pred: (i: (typeof items)[number]) => boolean) => items.filter(pred).length / items.length;

  it('is the same for the same seed, and different for another', () => {
    expect(generateCatalog({ items: 50, seed: 7 })).toEqual(generateCatalog({ items: 50, seed: 7 }));
    expect(generateCatalog({ items: 50, seed: 8 })).not.toEqual(generateCatalog({ items: 50, seed: 7 }));
  });

  it('has the number of items asked for, each with a unique Delux-style code and an upper-case name', () => {
    expect(items).toHaveLength(2000);
    expect(new Set(items.map((i) => i.code)).size).toBe(2000);
    for (const i of items) {
      expect(i.code).toMatch(/^[A-Z]{4}\d{3,}$/);
      expect(i.category).toBe(i.code.slice(0, 4));
      expect(i.name).toMatch(/^[A-Z0-9 /.-]+$/);
    }
  });

  it('prices every item in whole rupees: Retail, then Mechanic and Wholesale no higher', () => {
    for (const i of items) {
      const { RETAIL, MECHANIC, WHOLESALE } = i.prices!;
      expect(RETAIL! % 100).toBe(0);
      expect(RETAIL!).toBeGreaterThan(0);
      expect(MECHANIC!).toBeLessThanOrEqual(RETAIL!);
      expect(WHOLESALE!).toBeLessThanOrEqual(MECHANIC!);
    }
  });

  it('has some floors (never above Retail), part numbers, vehicle tags, dormant items and fractional units', () => {
    expect(share((i) => i.floor !== undefined)).toBeGreaterThan(0.02);
    expect(share((i) => i.floor !== undefined)).toBeLessThan(0.1);
    for (const i of items)
      if (i.floor !== undefined) expect(i.floor).toBeLessThanOrEqual(i.prices!['RETAIL']!);
    expect(share((i) => (i.oem ?? []).length > 0)).toBeGreaterThan(0.5);
    expect(share((i) => (i.vehicles ?? []).length > 0)).toBeGreaterThan(0.5);
    for (const i of items)
      for (const v of i.vehicles ?? []) if (v.from && v.to) expect(v.from).toBeLessThanOrEqual(v.to);
    expect(share((i) => i.status === 'dormant')).toBeGreaterThan(0.01);
    const fractional = items.filter((i) => i.fractional);
    expect(fractional.length).toBeGreaterThan(0);
    for (const i of fractional) expect(['METER', 'LITRE']).toContain(i.unit);
  });
});
