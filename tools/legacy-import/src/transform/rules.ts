import { money, mulBp, roundCash } from '@erp/domain';

import { DumpError } from '../errors';
import { key, type Mapping } from './mapping';

// The legacy mapping rules (migration doc §3, D-085), one pure function each. Golden cases:
// tools/legacy-import/golden/transform/.

type Text = string | null | undefined;

/** Trimmed, runs of white space collapsed; empty → null. Case kept. */
export function cleanText(value: Text): string | null {
  const t = (value ?? '').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

/** cleanText, and the mapping's empty-like values (None, N/A, 0…) → null. */
export const meaningfulText = (value: Text, m: Mapping): string | null => {
  const t = cleanText(value);
  return t === null || m.emptyValues.has(key(t)) ? null : t;
};

const titleCase = (t: string) => t.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

/** A legacy brand: a country is the origin, not a brand (§3.2). */
export function classifyBrand(value: Text, m: Mapping): { brand: string | null; origin: string | null } {
  const t = meaningfulText(value, m);
  if (t === null) return { brand: null, origin: null };
  const k = key(t);
  const origin = m.countryBrands.get(k);
  if (origin !== undefined) return { brand: null, origin };
  return { brand: m.brandNames.get(k) ?? t, origin: null };
}

/** A legacy make is a country of origin: spelling fixed, otherwise title case (§3.2). */
export function originName(value: Text, m: Mapping): string | null {
  const t = meaningfulText(value, m);
  return t === null ? null : (m.originNames.get(key(t)) ?? titleCase(t));
}

/** A legacy Manufacture value: a vehicle make (maybe with a model), "any vehicle", or a product spec (§3.2). */
export function classifyManufacture(
  value: Text,
  m: Mapping,
): { make: string | null; model: string | null; spec: string | null } {
  const t = meaningfulText(value, m);
  const none = { make: null, model: null, spec: null };
  if (t === null) return none;
  const k = key(t);
  const withModel = m.manufactureModels.get(k);
  if (withModel) return { make: withModel.make, model: withModel.model, spec: null };
  const make = m.vehicleMakes.get(k);
  if (make !== undefined) return { make, model: null, spec: null };
  return m.genericManufactures.has(k) ? none : { make: null, model: null, spec: t };
}

const YEARS = /^(\d{4})\s*-\s*(\d{4}|ON)$/i;
const plausible = (y: number) => y >= 1950 && y <= 2100;

/** A legacy Model: a year range (ON = open-ended) or a model name (§3.3); null when empty. */
export function parseModel(
  value: Text,
  m: Mapping,
): { yearFrom: number | null; yearTo: number | null; model: string | null } | null {
  const t = meaningfulText(value, m);
  if (t === null) return null;
  const r = YEARS.exec(t);
  if (r) {
    const from = Number(r[1]);
    const to = r[2]!.toUpperCase() === 'ON' ? null : Number(r[2]);
    if (plausible(from) && (to === null || (plausible(to) && from <= to)))
      return { yearFrom: from, yearTo: to, model: null };
  }
  return { yearFrom: null, yearTo: null, model: t };
}

/** At least 5 characters, with digits, and a dash or at least 4 digits (§3.3). */
export function isPartNumber(value: string): boolean {
  const t = value.trim();
  const digits = t.replace(/\D/g, '').length;
  return t.length >= 5 && digits > 0 && (t.includes('-') || digits >= 4);
}

/** Bracketed groups with a digit in an item name, e.g. `(17910-SO4-E84)`: extra OEM numbers (§3.3). */
export function oemNumbersInName(name: string): string[] {
  const found = [...name.matchAll(/\(([^()]*\d[^()]*)\)/g)].map((g) => g[1]!.trim());
  return [...new Set(found)];
}

/** The search key of an identifier (data model §4): the one rule in packages/domain, shared with the counter. */
export { normalizeIdentifier } from '@erp/domain';

const AMOUNT = /^(-)?(\d+)(?:\.(\d+))?$/;

/** A legacy amount → minor units (2 decimals), exactly; extra non-zero decimals are rounded and flagged. */
export function legacyMoney(text: string): { minor: number; rounded: boolean } {
  const a = AMOUNT.exec(text.trim());
  if (!a) throw new DumpError('bad_amount', 'not a plain decimal amount');
  const fraction = a[3] ?? '';
  const exact = BigInt(a[2]! + fraction.slice(0, 2).padEnd(2, '0'));
  const rest = fraction.slice(2);
  const rounded = /[1-9]/.test(rest);
  // Half away from zero on the third decimal onwards: .005 and more rounds up.
  const minor = rounded && rest >= '5' ? exact + 1n : exact;
  return { minor: Number(a[1] ? -minor : minor) || 0, rounded };
}

/** Retail × rate (9500 bp = Retail − 5%), rounded to Rs 1 half away from zero (PRD Q1). */
export const tierPrice = (retail: number, bp: number): number =>
  roundCash(mulBp(money(retail), bp), money(100)).rounded;

/** Phones: trimmed, empty and digit-less values dropped, the same digits kept once, order kept (§3.4). */
export function partyPhones(values: Text[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = cleanText(v);
    const digits = (t ?? '').replace(/\D/g, '');
    if (t === null || digits === '' || seen.has(digits)) continue;
    seen.add(digits);
    out.push(t);
  }
  return out;
}

/** For reports (D-085): the last 4 digits kept, and the first 4 when there are at least 11. */
export function maskPhone(phone: string): string {
  const n = phone.replace(/\D/g, '').length;
  let i = 0;
  return phone.replace(/\d/g, (d) => {
    const at = i++;
    const keep = n > 4 && (at >= n - 4 || (n >= 11 && at < 4));
    return keep ? d : '*';
  });
}

export type LegacyAccount =
  | { kind: 'template'; code: string }
  | { kind: 'expense'; parent: string }
  | { kind: 'drawings'; code: string }
  | { kind: 'retired' }
  | { kind: 'not_migrated' }
  | { kind: 'unmapped' };

/** Where a legacy (postable) account goes in the new chart (§3.5). */
export function mapLegacyAccount(code: string, m: Mapping): LegacyAccount {
  const a = m.accounts;
  const template = a.template.get(code);
  if (template !== undefined) return { kind: 'template', code: template };
  if (a.retired.has(code)) return { kind: 'retired' };
  if (a.notMigrated.has(code)) return { kind: 'not_migrated' };
  const group = code.split('-').slice(0, 2).join('-');
  const parent = a.expenseParents.get(group);
  if (parent !== undefined) return { kind: 'expense', parent };
  const drawings = a.drawings.get(group);
  return drawings !== undefined ? { kind: 'drawings', code: drawings } : { kind: 'unmapped' };
}
