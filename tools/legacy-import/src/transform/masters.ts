import { parseQty, QTY_SCALE } from '@erp/domain';

import { key, type Mapping } from './mapping';
import {
  classifyBrand,
  classifyManufacture,
  cleanText,
  isPartNumber,
  legacyMoney,
  mapLegacyAccount,
  meaningfulText,
  normalizeIdentifier,
  oemNumbersInName,
  originName,
  parseModel,
  partyPhones,
  tierPrice,
} from './rules';

// Staged legacy rows → the candidate masters and the cleanup findings (migration doc §3, §7; D-085). Pure: the
// load step (load.ts) compares the candidates with the tenant and writes the differences.

export type Row = Record<string, string | null>;
type Text = string | null | undefined;

export interface Staged {
  label: string;
  units: Row[];
  categories: Row[];
  brands: Row[];
  makes: Row[];
  manufactures: Row[];
  sizes: Row[];
  items: Row[];
  partners: Row[];
  selections: Row[];
  partnerTypes: Row[];
  cities: Row[];
  countries: Row[];
  accounts: Row[];
  /** The shop's own details (bill header): Admin_Company and Admin_Parameter. */
  company: Row[];
  parameters: Row[];
  /** Σ(debit − credit) per party code on the legacy AR control account, as decimal text. */
  arBalances: Map<string, string>;
}

type Legacy = Record<string, unknown>;

export interface ItemCandidate {
  code: string;
  name: string;
  category: string;
  unit: string;
  brand: string | null;
  origin: string | null;
  variant: string | null;
  spec: string | null;
  binLocation: string | null;
  defaultSupplier: string | null;
  minQty: string | null;
  maxQty: string | null;
  excludeFromReorder: boolean;
  identifiers: { kind: 'barcode' | 'oem' | 'alternate'; value: string; normalized: string }[];
  tag: { make: string | null; model: string | null; yearFrom: number | null; yearTo: number | null } | null;
  /** Minor units per tier code. */
  prices: Record<'RETAIL' | 'MECHANIC' | 'WHOLESALE', number>;
  legacy: Legacy;
}

export interface PartyCandidate {
  code: string;
  name: string;
  contactPerson: string | null;
  phones: string[];
  email: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  taxId: string | null;
  labelAbbr: string | null;
  customer: { tier: 'RETAIL' | 'MECHANIC' | 'WHOLESALE' } | null;
  supplier: boolean;
  legacy: Legacy;
}

export interface AccountCandidate {
  legacyCode: string;
  name: string;
  /** Set legacy_code on this template account, or create an expense account under `parent`. */
  target: { kind: 'template'; code: string } | { kind: 'expense'; parent: string };
}

export interface Findings {
  brandCountries: { brand: string; origin: string; items: number }[];
  brandMaybeCountry: { brand: string; items: number }[];
  partNoNotOem: { item: string; partNo: string }[];
  manufactureSpec: { value: string; items: number }[];
  modelText: { value: string; items: number }[];
  priceZero: { item: string; name: string }[];
  costAbovePrice: { item: string; name: string; cost: number; price: number }[];
  noCost: { item: string; name: string }[];
  roundedAmounts: { item: string; field: string }[];
  duplicateNames: { name: string; items: string[] }[];
  duplicateOem: { oem: string; items: string[] }[];
  unknownReferences: { item: string; field: string; value: string }[];
  accounts: {
    mapped: { legacyCode: string; name: string; to: string }[];
    unmapped: { legacyCode: string; name: string }[];
    drawings: { legacyCode: string; name: string; code: string }[];
  };
  parties: {
    noPhone: { code: string; name: string }[];
    bothRoles: { code: string; name: string }[];
    abbreviationClashes: { abbr: string; parties: string[] }[];
    creditCustomers: { code: string; name: string; tier: string; legacyBalance: number }[];
  };
  /** Imported before but not in this dump (filled by the load step); reported, never deleted. */
  missing: { what: 'item' | 'party'; code: string }[];
}

export interface Masters {
  units: { code: string; allowsFraction: boolean; legacy: Legacy }[];
  categories: { code: string; name: string; legacy: Legacy }[];
  brands: { name: string; legacy: Legacy }[];
  origins: { name: string; legacy: Legacy }[];
  makes: string[];
  parties: PartyCandidate[];
  items: ItemCandidate[];
  accounts: AccountCandidate[];
  findings: Findings;
}

/** Items whose category or unit is missing get these (and a finding). */
export const FALLBACK_CATEGORY = { code: 'NONE', name: 'No category' };
export const FALLBACK_UNIT = 'PCS';

const legacyOf = (label: string, row: Row): Legacy => {
  const out: Legacy = { label };
  for (const [k, v] of Object.entries(row)) if (!k.startsWith('_')) out[k] = v;
  return out;
};
/** Staged columns are lower case; legacy keeps the source names, so map them back for readability. */
const withSourceNames = (legacy: Legacy, names: readonly string[]): Legacy => {
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  return Object.fromEntries(Object.entries(legacy).map(([k, v]) => [byLower.get(k) ?? k, v]));
};

const ITEM_COLUMNS = [
  'CompanyID',
  'ChartOfAccountID',
  'ItemID',
  'Item',
  'CategoryID',
  'UnitID',
  'ManufactureID',
  'ManufactureCTID',
  'BrandID',
  'MakeID',
  'SizeID',
  'BPAccountCode',
  'DefaultSupplierCode',
  'Model',
  'PartNo',
  'PlaceofItem',
  'MinQuantity',
  'MaxQuantity',
  'CostPrice',
  'SalePrice',
  'OpeningQuantity',
  'OpeningRate',
  'IsExcludeOrderList',
  'ItemReferenceNo',
] as const;
const PARTNER_COLUMNS = [
  'CompanyID',
  'ChartOfAccountID',
  'BusinessPartnerID',
  'BusinessPartner',
  'ContactPerson',
  'CountryID',
  'CityID',
  'BPAddress1',
  'BPAddress2',
  'BPPhone1',
  'BPPhone2',
  'BPFax1',
  'BPFax2',
  'BPMobile1',
  'BPMobile2',
  'BPEmail1',
  'BPEmail2',
  'BPNTN',
  'BPNameAbbr',
] as const;

const byId = (rows: Row[], id: string, value: string) =>
  new Map(rows.map((r) => [(r[id] ?? '').trim(), r[value] ?? null]));
const isTrue = (v: Text) => v != null && /^(1|true)$/i.test(v.trim());

/** Legacy quantity text → numeric(14,3) text, exactly. */
function qtyText(value: Text): string | null {
  const t = cleanText(value);
  if (t === null) return null;
  const q = parseQty(t.replace(/(\.\d{3})0+$/, '$1'));
  const sign = q < 0 ? '-' : '';
  const abs = Math.abs(q);
  return `${sign}${Math.floor(abs / QTY_SCALE)}.${String(abs % QTY_SCALE).padStart(3, '0')}`;
}

const counted = (m: Map<string, number>) =>
  [...m].map(([value, items]) => ({ value, items })).sort((a, b) => a.value.localeCompare(b.value));
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export function buildMasters(s: Staged, m: Mapping): Masters {
  const findings: Findings = {
    brandCountries: [],
    brandMaybeCountry: [],
    partNoNotOem: [],
    manufactureSpec: [],
    modelText: [],
    priceZero: [],
    costAbovePrice: [],
    noCost: [],
    roundedAmounts: [],
    duplicateNames: [],
    duplicateOem: [],
    unknownReferences: [],
    accounts: { mapped: [], unmapped: [], drawings: [] },
    parties: { noPhone: [], bothRoles: [], abbreviationClashes: [], creditCustomers: [] },
    missing: [],
  };

  // Units and categories.
  const unitNames = byId(s.units, 'unitid', 'unit');
  const units = new Map<string, { code: string; allowsFraction: boolean; legacy: Legacy }>();
  for (const r of s.units) {
    const code = cleanText(r['unit'])?.toUpperCase();
    if (code && !units.has(code))
      units.set(code, { code, allowsFraction: m.fractionUnits.has(code), legacy: legacyOf(s.label, r) });
  }
  const categories = new Map<string, { code: string; name: string; legacy: Legacy }>();
  for (const r of s.categories) {
    const code = cleanText(r['categoryid']);
    if (code && !categories.has(code))
      categories.set(code, { code, name: cleanText(r['category']) ?? code, legacy: legacyOf(s.label, r) });
  }

  // Brands, origins and makes, from what the items use.
  const brandRows = new Map(s.brands.map((r) => [(r['brandid'] ?? '').trim(), r]));
  const makeRows = new Map(s.makes.map((r) => [(r['makeid'] ?? '').trim(), r]));
  const manufactureNames = byId(s.manufactures, 'manufactureid', 'manufacture');
  const sizeNames = byId(s.sizes, 'sizeid', 'size');
  const legacyOrigins = new Set(s.makes.map((r) => originName(r['make'], m)).filter((o) => o !== null));

  const brands = new Map<string, { name: string; legacy: Legacy }>();
  const origins = new Map<string, { name: string; legacy: Legacy }>();
  const makes = new Set<string>();
  const brandCountries = new Map<string, { origin: string; items: number }>();
  const maybeCountry = new Map<string, number>();
  const manufactureSpec = new Map<string, number>();
  const modelText = new Map<string, number>();

  // Parties first: items refer to their default supplier.
  const cityNames = byId(s.cities, 'cityid', 'city');
  const countryNames = byId(s.countries, 'countryid', 'country');
  const types = new Map(s.partnerTypes.map((r) => [(r['businesspartnertypeid'] ?? '').trim(), r]));
  const roles = new Map<string, { customer: boolean; supplier: boolean }>();
  for (const r of s.selections) {
    const code = (r['businesspartnerid'] ?? '').trim();
    const t = types.get((r['businesspartnertypeid'] ?? '').trim());
    const role = roles.get(code) ?? { customer: false, supplier: false };
    if (t && isTrue(t['purchase'])) role.supplier = true;
    if (t && isTrue(t['sale'])) role.customer = true;
    roles.set(code, role);
  }
  const parties: PartyCandidate[] = [];
  for (const r of s.partners) {
    const code = (r['businesspartnerid'] ?? '').trim();
    if (code === '' || m.cashPartners.has(code)) continue;
    const role = roles.get(code) ?? { customer: false, supplier: false };
    const name = cleanText(r['businesspartner']) ?? code;
    const address = [cleanText(r['bpaddress1']), cleanText(r['bpaddress2'])]
      .filter((a) => a !== null)
      .join(', ');
    const p: PartyCandidate = {
      code,
      name,
      contactPerson: cleanText(r['contactperson']),
      phones: partyPhones([r['bpphone1'], r['bpphone2'], r['bpmobile1'], r['bpmobile2']]),
      email: cleanText(r['bpemail1']) ?? cleanText(r['bpemail2']),
      address: address === '' ? null : address,
      city: cleanText(cityNames.get((r['cityid'] ?? '').trim())),
      country: cleanText(countryNames.get((r['countryid'] ?? '').trim())),
      taxId: cleanText(r['bpntn']),
      labelAbbr: cleanText(r['bpnameabbr']),
      customer: role.customer ? { tier: m.partyTiers.get(code) ?? 'RETAIL' } : null,
      supplier: role.supplier,
      legacy: withSourceNames(legacyOf(s.label, r), PARTNER_COLUMNS),
    };
    parties.push(p);
    if (p.phones.length === 0) findings.parties.noPhone.push({ code, name });
    if (role.customer && role.supplier) findings.parties.bothRoles.push({ code, name });
    if (p.customer) {
      const balance = s.arBalances.get(code);
      findings.parties.creditCustomers.push({
        code,
        name,
        tier: p.customer.tier,
        legacyBalance: balance === undefined ? 0 : legacyMoney(balance).minor,
      });
    }
  }
  const abbreviations = new Map<string, string[]>();
  for (const p of parties)
    if (p.labelAbbr)
      abbreviations.set(key(p.labelAbbr), [...(abbreviations.get(key(p.labelAbbr)) ?? []), p.code]);
  findings.parties.abbreviationClashes = [...abbreviations]
    .filter(([, codes]) => codes.length > 1)
    .map(([abbr, codes]) => ({ abbr, parties: codes.sort() }));
  const partyCodes = new Set(parties.map((p) => p.code));

  // Items.
  const items: ItemCandidate[] = [];
  const names = new Map<string, { name: string; items: string[] }>();
  const oems = new Map<string, Set<string>>();
  for (const r of s.items) {
    const code = (r['itemid'] ?? '').trim();
    const name = cleanText(r['item']) ?? code;
    const ref = (field: string, value: Text) => {
      if (cleanText(value) !== null)
        findings.unknownReferences.push({ item: code, field, value: (value ?? '').trim() });
    };

    let category = cleanText(r['categoryid']);
    if (category === null || !categories.has(category)) {
      ref('CategoryID', r['categoryid']);
      category = FALLBACK_CATEGORY.code;
      if (!categories.has(category))
        categories.set(category, { ...FALLBACK_CATEGORY, legacy: { label: s.label } });
    }
    let unit = cleanText(unitNames.get((r['unitid'] ?? '').trim()))?.toUpperCase() ?? null;
    if (unit === null) {
      ref('UnitID', r['unitid']);
      unit = FALLBACK_UNIT;
      if (!units.has(unit))
        units.set(unit, { code: unit, allowsFraction: false, legacy: { label: s.label } });
    }

    const brandRow = brandRows.get((r['brandid'] ?? '').trim());
    if (!brandRow) ref('BrandID', r['brandid']);
    const b = classifyBrand(brandRow?.['brand'], m);
    if (b.origin !== null) {
      const k = cleanText(brandRow?.['brand'])!;
      brandCountries.set(k, { origin: b.origin, items: (brandCountries.get(k)?.items ?? 0) + 1 });
    }
    if (b.brand !== null) {
      if (legacyOrigins.has(originName(b.brand, m)!)) bump(maybeCountry, b.brand);
      if (!brands.has(key(b.brand)))
        brands.set(key(b.brand), { name: b.brand, legacy: legacyOf(s.label, brandRow!) });
    }
    const makeRow = makeRows.get((r['makeid'] ?? '').trim());
    if (!makeRow) ref('MakeID', r['makeid']);
    const origin = originName(makeRow?.['make'], m) ?? b.origin;
    if (origin !== null && !origins.has(key(origin)))
      origins.set(key(origin), {
        name: origin,
        legacy: makeRow ? legacyOf(s.label, makeRow) : { label: s.label },
      });

    const manufactureId = (r['manufactureid'] ?? '').trim();
    const manufacture = manufactureNames.get(manufactureId);
    if (manufacture === undefined) ref('ManufactureID', r['manufactureid']);
    const mf = classifyManufacture(manufacture, m);
    if (mf.spec !== null) bump(manufactureSpec, mf.spec);
    const model = parseModel(r['model'], m);
    if (model?.model) bump(modelText, model.model);
    const tagModel = model?.model ?? mf.model;
    const tag =
      mf.make !== null || tagModel !== null || model?.yearFrom != null
        ? { make: mf.make, model: tagModel, yearFrom: model?.yearFrom ?? null, yearTo: model?.yearTo ?? null }
        : null;
    if (mf.make !== null) makes.add(mf.make);

    const specs = [mf.spec];
    const identifiers: ItemCandidate['identifiers'] = [
      { kind: 'barcode', value: code, normalized: normalizeIdentifier(code) },
    ];
    const addId = (kind: 'oem' | 'alternate', value: string) => {
      const normalized = normalizeIdentifier(value);
      if (normalized === '' || identifiers.some((i) => i.kind === kind && i.normalized === normalized))
        return;
      identifiers.push({ kind, value, normalized });
      if (kind === 'oem') oems.set(normalized, (oems.get(normalized) ?? new Set()).add(code));
    };
    const partNo = cleanText(r['partno']);
    if (partNo !== null) {
      if (isPartNumber(partNo)) addId('oem', partNo);
      else {
        specs.push(partNo);
        findings.partNoNotOem.push({ item: code, partNo });
      }
    }
    for (const oem of oemNumbersInName(name)) addId('oem', oem);
    const reference = cleanText(r['itemreferenceno']);
    if (reference !== null) addId('alternate', reference);

    const amount = (field: string, value: Text) => {
      if (cleanText(value) === null) return null;
      const a = legacyMoney(value!);
      if (a.rounded) findings.roundedAmounts.push({ item: code, field });
      return a.minor;
    };
    const retail = amount('SalePrice', r['saleprice']) ?? 0;
    const cost = amount('CostPrice', r['costprice']);
    if (retail === 0) findings.priceZero.push({ item: code, name });
    if (cost === null || cost === 0) findings.noCost.push({ item: code, name });
    else if (cost > retail) findings.costAbovePrice.push({ item: code, name, cost, price: retail });

    const supplier = cleanText(r['defaultsuppliercode']);
    let defaultSupplier: string | null = null;
    if (supplier !== null && !m.cashPartners.has(supplier)) {
      if (partyCodes.has(supplier)) defaultSupplier = supplier;
      else ref('DefaultSupplierCode', supplier);
    }

    const sameName = names.get(key(name)) ?? { name, items: [] };
    sameName.items.push(code);
    names.set(key(name), sameName);

    const spec = specs.filter((x) => x !== null).join(', ');
    items.push({
      code,
      name,
      category,
      unit,
      brand: b.brand,
      origin,
      variant: meaningfulText(sizeNames.get((r['sizeid'] ?? '').trim()), m),
      spec: spec === '' ? null : spec,
      binLocation: meaningfulText(r['placeofitem'], m),
      defaultSupplier,
      minQty: qtyText(r['minquantity']),
      maxQty: qtyText(r['maxquantity']),
      excludeFromReorder: isTrue(r['isexcludeorderlist']),
      identifiers,
      tag,
      prices: { RETAIL: retail, MECHANIC: tierPrice(retail, 9500), WHOLESALE: tierPrice(retail, 9000) },
      legacy: withSourceNames(legacyOf(s.label, r), ITEM_COLUMNS),
    });
  }

  findings.brandCountries = [...brandCountries]
    .map(([brand, v]) => ({ brand, origin: v.origin, items: v.items }))
    .sort((a, b) => a.brand.localeCompare(b.brand));
  findings.brandMaybeCountry = counted(maybeCountry).map(({ value, items: n }) => ({
    brand: value,
    items: n,
  }));
  findings.manufactureSpec = counted(manufactureSpec);
  findings.modelText = counted(modelText);
  findings.duplicateNames = [...names.values()]
    .filter((d) => d.items.length > 1)
    .map((d) => ({ name: d.name, items: d.items.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  findings.duplicateOem = [...oems]
    .filter(([, codes]) => codes.size > 1)
    .map(([oem, codes]) => ({ oem, items: [...codes].sort() }))
    .sort((a, b) => a.oem.localeCompare(b.oem));
  for (const list of [findings.partNoNotOem, findings.priceZero, findings.costAbovePrice, findings.noCost])
    (list as { item: string }[]).sort((a, b) => a.item.localeCompare(b.item));

  // The chart of accounts: postable legacy accounts only (headers are structure, not accounts).
  const accounts: AccountCandidate[] = [];
  for (const r of [...s.accounts].sort((a, b) =>
    (a['accountcode'] ?? '').localeCompare(b['accountcode'] ?? ''),
  )) {
    if (isTrue(r['summaryflag'])) continue;
    const legacyCode = (r['accountcode'] ?? '').trim();
    const name = cleanText(r['description']) ?? legacyCode;
    const to = mapLegacyAccount(legacyCode, m);
    if (to.kind === 'template' || to.kind === 'expense') accounts.push({ legacyCode, name, target: to });
    if (to.kind === 'unmapped') findings.accounts.unmapped.push({ legacyCode, name });
    if (to.kind === 'drawings') findings.accounts.drawings.push({ legacyCode, name, code: to.code });
    findings.accounts.mapped.push({
      legacyCode,
      name,
      to:
        to.kind === 'template' || to.kind === 'drawings'
          ? to.code
          : to.kind === 'expense'
            ? `under ${to.parent}`
            : to.kind,
    });
  }

  return {
    units: [...units.values()],
    categories: [...categories.values()],
    brands: [...brands.values()],
    origins: [...origins.values()],
    makes: [...makes].sort(),
    parties,
    items,
    accounts,
    findings,
  };
}
