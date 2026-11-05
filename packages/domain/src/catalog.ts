import { normalizeIdentifier } from './identifier';
import { money, mulBp, type Money } from './money';
import { roundCash } from './rounding';

// Catalog maintenance in the back office (W1-15, CAT-01…CAT-05, CAT-07): the checks the API makes before it saves,
// and the back office before it sends. Pure; money in paisa, quantities in thousandths (CLAUDE.md rule 1).

const CODE = /^[A-Z0-9-]{1,20}$/;
const NAME_MAX = 120;

export interface ItemInput {
  code: string;
  name: string;
  categoryId: string | null;
  unitId: string | null;
  /** The unit allows fractions (LITRE, METER, FOOT). */
  allowsFraction: boolean;
  minQty: number | null;
  maxQty: number | null;
}

export type ItemProblem =
  | 'code_required'
  | 'code_format'
  | 'name_required'
  | 'name_too_long'
  | 'category_required'
  | 'unit_required'
  | 'qty_negative'
  | 'qty_fraction'
  | 'min_above_max';

/**
 * An item's details: the code trimmed and upper case, printable as Code 39 on a label (D-019, D-055); the name
 * trimmed; the problems in a fixed order.
 */
export function itemProblems(input: ItemInput): { code: string; name: string; problems: ItemProblem[] } {
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  const problems: ItemProblem[] = [];
  if (code === '') problems.push('code_required');
  else if (!CODE.test(code)) problems.push('code_format');
  if (name === '') problems.push('name_required');
  else if (name.length > NAME_MAX) problems.push('name_too_long');
  if (!input.categoryId) problems.push('category_required');
  if (!input.unitId) problems.push('unit_required');
  const qtys = [input.minQty, input.maxQty].filter((q): q is number => q !== null);
  if (qtys.some((q) => q < 0)) problems.push('qty_negative');
  if (!input.allowsFraction && qtys.some((q) => q % 1000 !== 0)) problems.push('qty_fraction');
  if (input.minQty !== null && input.maxQty !== null && input.minQty > input.maxQty)
    problems.push('min_above_max');
  return { code, name, problems };
}

export type IdentifierKind = 'barcode' | 'oem' | 'alternate' | 'supplier_ref';

export interface CatalogCodesInput {
  code: string;
  /** The calendar year today, for the year range. */
  thisYear: number;
  identifiers: { kind: IdentifierKind; value: string }[];
  vehicles: {
    makeId: string | null;
    model: string | null;
    yearFrom: number | null;
    yearTo: number | null;
    note: string | null;
  }[];
}

export type CatalogCodeProblem =
  'code_barcode_missing' | 'value_required' | 'duplicate' | 'tag_empty' | 'year_out_of_range' | 'year_range';

const FIRST_YEAR = 1950;

/** An item's identifiers and vehicle tags (CAT-02, CAT-03); each problem names its row (null = the item). */
export function catalogCodeProblems(
  input: CatalogCodesInput,
): { problem: CatalogCodeProblem; row: number | null }[] {
  const out: { problem: CatalogCodeProblem; row: number | null }[] = [];
  const code = normalizeIdentifier(input.code.trim());
  if (!input.identifiers.some((i) => i.kind === 'barcode' && normalizeIdentifier(i.value.trim()) === code))
    out.push({ problem: 'code_barcode_missing', row: null });
  const seen = new Set<string>();
  input.identifiers.forEach((i, row) => {
    const n = normalizeIdentifier(i.value.trim());
    if (n === '') return out.push({ problem: 'value_required', row });
    const key = `${i.kind}|${n}`;
    if (seen.has(key)) out.push({ problem: 'duplicate', row });
    seen.add(key);
  });
  const last = input.thisYear + 1;
  input.vehicles.forEach((v, row) => {
    const years = [v.yearFrom, v.yearTo].filter((y): y is number => y !== null);
    if (!v.makeId && (v.model ?? '').trim() === '' && years.length === 0)
      return out.push({ problem: 'tag_empty', row });
    if (years.some((y) => !Number.isInteger(y) || y < FIRST_YEAR || y > last))
      return out.push({ problem: 'year_out_of_range', row });
    if (v.yearFrom !== null && v.yearTo !== null && v.yearFrom > v.yearTo)
      out.push({ problem: 'year_range', row });
  });
  return out;
}

/** Why a price went down (owner answer 2 to W1-15). */
export const PRICE_REASONS = ['supplier_price', 'market_price', 'slow_stock', 'correction', 'other'] as const;
export type PriceReason = (typeof PRICE_REASONS)[number];

export interface PriceSet {
  /** Paisa per tier code; null = no price for that tier. */
  tiers: Record<string, number | null>;
  /** The item's own floor; null = none (the cost floor or the list price applies). */
  floor: number | null;
}

export interface PriceChangeInput {
  before: PriceSet;
  after: PriceSet;
  reason: string | null;
  note: string | null;
}

export type PriceProblem =
  'retail_required' | 'price_invalid' | 'reason_unknown' | 'reason_required' | 'note_required';

/** A change of an item's prices (CAT-04, CAT-05, CAT-07): problems, warnings and the changes for the history. */
export function priceChange(input: PriceChangeInput): {
  problems: PriceProblem[];
  warnings: 'floor_above_retail'[];
  changes: { target: string; old: number | null; new: number | null }[];
} {
  const { before, after } = input;
  const changes: { target: string; old: number | null; new: number | null }[] = [];
  const targets = [...new Set([...Object.keys(after.tiers), ...Object.keys(before.tiers)])];
  for (const t of targets) {
    const old = before.tiers[t] ?? null;
    const now = after.tiers[t] ?? null;
    if (old !== now) changes.push({ target: t, old, new: now });
  }
  if (before.floor !== after.floor) changes.push({ target: 'floor', old: before.floor, new: after.floor });

  const problems: PriceProblem[] = [];
  const retail = after.tiers['RETAIL'] ?? null;
  if (retail === null) problems.push('retail_required');
  const values = [...Object.values(after.tiers), after.floor].filter((v): v is number => v !== null);
  if (values.some((v) => !Number.isSafeInteger(v) || v < 0)) problems.push('price_invalid');
  const reason = input.reason;
  if (reason !== null && !(PRICE_REASONS as readonly string[]).includes(reason))
    problems.push('reason_unknown');
  else if (reason === null && changes.some((c) => c.old !== null && c.new !== null && c.new < c.old))
    problems.push('reason_required');
  if (reason === 'other' && (input.note ?? '').trim() === '') problems.push('note_required');

  const warnings: 'floor_above_retail'[] =
    after.floor !== null && retail !== null && after.floor > retail ? ['floor_above_retail'] : [];
  return { problems, warnings, changes };
}

/** A new item's tier prices from its Retail price: Mechanic −5 %, Wholesale −10 %, rounded to Rs 1 (PRD Q1). */
export function proposeTierPrices(retail: Money): { RETAIL: Money; MECHANIC: Money; WHOLESALE: Money } {
  const tier = (bp: number) => roundCash(mulBp(retail, bp), money(100)).rounded;
  return { RETAIL: retail, MECHANIC: tier(9500), WHOLESALE: tier(9000) };
}
