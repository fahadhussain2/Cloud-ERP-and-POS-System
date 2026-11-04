import { z } from 'zod';

// The owner's reviewed decisions (D-085): `mapping/delux.json`. Codes and catalog words only, never personal data.

const Words = z.record(z.string(), z.string());

/** Whole rupees in the file; minor units once read. */
const Rupees = z.int().nonnegative();

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
  /**
   * Credit terms by party code, in whole rupees (W1-09, owner answer 5): each optional; a customer without an entry
   * is allowed credit with no limit (D-085) and the Rs 25,000 offline cap (PRD Q6).
   */
  partyCredit: z
    .record(
      z.string(),
      z.strictObject({
        creditAllowed: z.boolean().optional(),
        creditLimit: Rupees.nullable().optional(),
        offlineDailyCap: Rupees.optional(),
      }),
    )
    .optional(),
  /**
   * The opening balances (W1-14, migration doc §4): each legacy document type that moves stock, with the sign it has
   * (+1 adds, −1 takes away), confirmed by the owner from the document-type report; the control accounts whose
   * sub-accounts are the customers and suppliers; whether the period's INV_Item.OpeningQuantity counts.
   */
  opening: z
    .strictObject({
      docTypes: z.record(z.string(), z.strictObject({ name: z.string(), sign: z.union([z.literal(1), z.literal(-1)]) })),
      customerAccount: z.string(),
      supplierAccount: z.string(),
      itemOpeningQuantity: z.boolean(),
    })
    .optional(),
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
  /** In minor units. */
  partyCredit: ReadonlyMap<string, PartyCredit>;
  opening: {
    docTypes: Readonly<Record<string, number>>;
    docTypeNames: ReadonlyMap<string, string>;
    customerAccount: string;
    supplierAccount: string;
    itemOpeningQuantity: boolean;
  };
  accounts: {
    template: ReadonlyMap<string, string>;
    retired: ReadonlySet<string>;
    notMigrated: ReadonlySet<string>;
    expenseParents: ReadonlyMap<string, string>;
    drawings: ReadonlyMap<string, string>;
  };
}

/** A party's credit terms from the mapping, in minor units; a missing field keeps the default. */
export interface PartyCredit {
  creditAllowed?: boolean;
  creditLimit?: number | null;
  offlineDailyCap?: number;
}

/** Rupees to paisa (Delux's PKR has 2 minor units). */
const MINOR_PER_RUPEE = 100;

const creditTerms = (t: {
  creditAllowed?: boolean | undefined;
  creditLimit?: number | null | undefined;
  offlineDailyCap?: number | undefined;
}) => {
  const out: PartyCredit = {};
  if (t.creditAllowed !== undefined) out.creditAllowed = t.creditAllowed;
  if (t.creditLimit !== undefined)
    out.creditLimit = t.creditLimit === null ? null : t.creditLimit * MINOR_PER_RUPEE;
  if (t.offlineDailyCap !== undefined) out.offlineDailyCap = t.offlineDailyCap * MINOR_PER_RUPEE;
  return out;
};

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
    partyCredit: new Map(Object.entries(f.partyCredit ?? {}).map(([k, v]) => [k.trim(), creditTerms(v)])),
    opening: {
      docTypes: Object.fromEntries(Object.entries(f.opening?.docTypes ?? {}).map(([k, v]) => [k.trim(), v.sign])),
      docTypeNames: new Map(Object.entries(f.opening?.docTypes ?? {}).map(([k, v]) => [k.trim(), v.name])),
      customerAccount: f.opening?.customerAccount ?? '10-03-0001',
      supplierAccount: f.opening?.supplierAccount ?? '20-02-0001',
      itemOpeningQuantity: f.opening?.itemOpeningQuantity ?? true,
    },
    accounts: {
      template: new Map(Object.entries(f.accounts.template)),
      retired: new Set(f.accounts.retired),
      notMigrated: new Set(f.accounts.notMigrated),
      expenseParents: new Map(Object.entries(f.accounts.expenseParents)),
      drawings: new Map(Object.entries(f.accounts.drawings)),
    },
  };
}
