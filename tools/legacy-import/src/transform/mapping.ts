import { z } from 'zod';

// The owner's reviewed decisions (D-085): `mapping/delux.json`. Codes and catalog words only, never personal data.

const Words = z.record(z.string(), z.string());

const MappingFile = z.strictObject({
  $comment: z.string().optional(),
  /** Values that mean "nothing" (None, N/A, -…). */
  emptyValues: z.array(z.string()),
  /** Brands that are really countries → the origin they mean. */
  countryBrands: Words,
  /** Brand renames, e.g. GENUINE → Genuine (OEM). */
  brandNames: Words,
  /** Origin spelling fixes; any other origin is title-cased. */
  originNames: Words,
  /** The vehicle-make allow-list, with spelling fixes: legacy Manufacture value → make. */
  vehicleMakes: Words,
  /** Manufacture values that name a model, e.g. HIACE → Toyota Hiace. */
  manufactureModels: z.record(z.string(), z.strictObject({ make: z.string(), model: z.string() })),
  /** Manufacture values that mean "any vehicle": no make, no spec. */
  genericManufactures: z.array(z.string()),
  /** Units sold in fractions (litres, metres). */
  fractionUnits: z.array(z.string()),
  /** Legacy partners that are not parties (cash purchase, cash sale). */
  cashPartners: z.array(z.string()),
  /** Customer tier by party code (Retail when not listed). */
  partyTiers: z.record(z.string(), z.enum(['RETAIL', 'MECHANIC', 'WHOLESALE'])),
  accounts: z.strictObject({
    /** Legacy account → template account code. */
    template: Words,
    retired: z.array(z.string()),
    notMigrated: z.array(z.string()),
    /** Legacy group prefix → template header the accounts go under. */
    expenseParents: Words,
    /** Legacy group prefix → the drawings account its postings map to. */
    drawings: Words,
  }),
});

export interface Mapping {
  emptyValues: ReadonlySet<string>;
  countryBrands: ReadonlyMap<string, string>;
  brandNames: ReadonlyMap<string, string>;
  originNames: ReadonlyMap<string, string>;
  vehicleMakes: ReadonlyMap<string, string>;
  manufactureModels: ReadonlyMap<string, { make: string; model: string }>;
  genericManufactures: ReadonlySet<string>;
  fractionUnits: ReadonlySet<string>;
  cashPartners: ReadonlySet<string>;
  partyTiers: ReadonlyMap<string, 'RETAIL' | 'MECHANIC' | 'WHOLESALE'>;
  accounts: {
    template: ReadonlyMap<string, string>;
    retired: ReadonlySet<string>;
    notMigrated: ReadonlySet<string>;
    expenseParents: ReadonlyMap<string, string>;
    drawings: ReadonlyMap<string, string>;
  };
}

/** How values are compared: trimmed, single spaces, upper case. */
export const key = (value: string): string => value.trim().replace(/\s+/g, ' ').toUpperCase();

const keyed = <V>(record: Record<string, V>) => new Map(Object.entries(record).map(([k, v]) => [key(k), v]));
const keySet = (values: string[]) => new Set(values.map(key));

export function parseMapping(raw: unknown): Mapping {
  const parsed = MappingFile.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `mapping file: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`,
    );
  const f = parsed.data;
  return {
    emptyValues: keySet(f.emptyValues),
    countryBrands: keyed(f.countryBrands),
    brandNames: keyed(f.brandNames),
    originNames: keyed(f.originNames),
    vehicleMakes: keyed(f.vehicleMakes),
    manufactureModels: keyed(f.manufactureModels),
    genericManufactures: keySet(f.genericManufactures),
    fractionUnits: keySet(f.fractionUnits),
    cashPartners: new Set(f.cashPartners.map((c) => c.trim())),
    partyTiers: new Map(Object.entries(f.partyTiers).map(([k, v]) => [k.trim(), v])),
    accounts: {
      template: new Map(Object.entries(f.accounts.template)),
      retired: new Set(f.accounts.retired),
      notMigrated: new Set(f.accounts.notMigrated),
      expenseParents: new Map(Object.entries(f.accounts.expenseParents)),
      drawings: new Map(Object.entries(f.accounts.drawings)),
    },
  };
}
