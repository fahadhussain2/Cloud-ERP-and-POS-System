import { DumpError } from '../errors';
import { legacyMoney } from './rules';

// The legacy side of the opening balances (migration doc §4, §5, W1-14), one pure function each, on staged text.
// Golden cases: tools/legacy-import/golden/transform/. Errors name what is wrong, never a value (rule 11).

type Text = string | null | undefined;
/** A legacy document type's id → +1 (adds stock) or −1 (takes it away), from the mapping file. */
type DocTypes = Readonly<Record<string, number>>;

const QUANTITY = /^(-)?(\d+)(?:\.(\d+))?$/;

/** A legacy quantity → thousandths, exactly; extra non-zero decimals are rounded half away from zero and flagged. */
export function legacyQty(text: string): { thousandths: number; rounded: boolean } {
  const a = QUANTITY.exec(text.trim());
  if (!a) throw new DumpError('bad_quantity', 'not a plain decimal quantity');
  const fraction = a[3] ?? '';
  const exact = BigInt(a[2]! + fraction.slice(0, 3).padEnd(3, '0'));
  const rest = fraction.slice(3);
  const rounded = /[1-9]/.test(rest);
  const n = rounded && rest >= '5' ? exact + 1n : exact;
  return { thousandths: Number(a[1] ? -n : n) || 0, rounded };
}

const qtyOf = (t: Text) => legacyQty(t ?? '').thousandths;
const moneyOf = (t: Text) => legacyMoney(t ?? '').minor;

/** The calendar day of a staged legacy datetime (`2026-12-31 23:59:59.997`). */
function dayOf(date: Text): string {
  const d = /^(\d{4}-\d{2}-\d{2})/.exec(date ?? '');
  if (!d) throw new DumpError('bad_date', 'a row without a valid date');
  return d[1]!;
}

function signOf(docTypes: DocTypes, docType: string): number {
  const s = docTypes[docType.trim()];
  if (s !== 1 && s !== -1)
    throw new DumpError(
      'unknown_doc_type',
      `document type ${docType.trim()} has no sign in the mapping file`,
    );
  return s;
}

/** Latest first: the later day and time, then the higher transaction number. */
const later = (a: { date: string; tx: number }, b: { date: string; tx: number }) =>
  a.date !== b.date ? a.date > b.date : a.tx > b.tx;

const byItem = <T extends { itemId: string }>(rows: T[]) =>
  rows.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

export interface ClosingStockInput {
  asOf: string;
  docTypes: DocTypes;
  openings: { itemId: string; qty: Text }[];
  movements: { itemId: string; docType: string; date: Text; qty: Text }[];
}

/** Opening quantity ± every stock line up to and including `asOf` (legacy fn_INV_ClosingStock, §4.1). */
export function closingStock(input: ClosingStockInput): { itemId: string; qty: number }[] {
  const totals = new Map<string, number>();
  const addTo = (item: string, q: number) => totals.set(item, (totals.get(item) ?? 0) + q);
  for (const o of input.openings) addTo(o.itemId.trim(), qtyOf(o.qty));
  for (const m of input.movements) {
    if (dayOf(m.date) > input.asOf) continue;
    addTo(m.itemId.trim(), signOf(input.docTypes, m.docType) * qtyOf(m.qty));
  }
  return byItem([...totals].map(([itemId, q]) => ({ itemId, qty: q || 0 })));
}

export interface StockRecordsInput {
  asOf: string;
  records: {
    itemId: string;
    date: Text;
    transactionId: Text;
    stockQuantity: Text;
    valuationRate: Text;
  }[];
}

/** Each item's latest INV_StockRecordTAB row up to `asOf`: its running quantity and valuation rate (§4.1). */
export function latestStockRecords(
  input: StockRecordsInput,
): { itemId: string; runningQty: number; valuationRate: number | null }[] {
  const latest = new Map<string, { date: string; tx: number; row: StockRecordsInput['records'][number] }>();
  for (const r of input.records) {
    const date = r.date ?? '';
    if (dayOf(date) > input.asOf) continue;
    const at = { date, tx: Number(r.transactionId ?? 0), row: r };
    const item = r.itemId.trim();
    const seen = latest.get(item);
    if (seen === undefined || later(at, seen)) latest.set(item, at);
  }
  return byItem(
    [...latest].map(([itemId, { row }]) => ({
      itemId,
      runningQty: qtyOf(row.stockQuantity),
      valuationRate:
        row.valuationRate === null || row.valuationRate === undefined ? null : moneyOf(row.valuationRate),
    })),
  );
}

export interface OpeningCostInput {
  /** Minor units, from `latestStockRecords`. */
  valuationRate: number | null;
  costPrice: Text;
  openingRate: Text;
}

/** The valuation rate, else the cost price, else the opening rate; 0 or less counts as none (§4.1). */
export function openingCost(input: OpeningCostInput): {
  unitCost: number | null;
  source: 'valuation_rate' | 'cost_price' | 'opening_rate' | null;
} {
  if (input.valuationRate !== null && input.valuationRate > 0)
    return { unitCost: input.valuationRate, source: 'valuation_rate' };
  const fallbacks = [
    ['cost_price', input.costPrice],
    ['opening_rate', input.openingRate],
  ] as const;
  for (const [source, text] of fallbacks) {
    if (text === null || text === undefined || text.trim() === '') continue;
    const c = moneyOf(text);
    if (c > 0) return { unitCost: c, source };
  }
  return { unitCost: null, source: null };
}

export interface PartyBalancesInput {
  asOf: string;
  customerAccount: string;
  supplierAccount: string;
  cashPartners: string[];
  lines: { accountCode: Text; subAccountCode: Text; date: Text; dr: Text; cr: Text }[];
}

type Balance = { code: string; amount: number };

/** Σ (DR − CR) per customer and Σ (CR − DR) per supplier on the control accounts, up to `asOf` (§4.2). */
export function partyBalances(input: PartyBalancesInput): {
  customers: Balance[];
  suppliers: Balance[];
  excluded: { role: 'customer' | 'supplier'; code: string | null; amount: number }[];
} {
  const cash = new Set(input.cashPartners.map((c) => c.trim()));
  const sums = { customer: new Map<string, number>(), supplier: new Map<string, number>() };
  for (const l of input.lines) {
    const account = (l.accountCode ?? '').trim();
    const role =
      account === input.customerAccount ? 'customer' : account === input.supplierAccount ? 'supplier' : null;
    if (role === null) continue;
    if (dayOf(l.date) > input.asOf) continue;
    const net = moneyOf(l.dr) - moneyOf(l.cr);
    const code = (l.subAccountCode ?? '').trim();
    const m = sums[role];
    m.set(code, (m.get(code) ?? 0) + (role === 'customer' ? net : -net));
  }
  const sorted = (m: Map<string, number>, keep: (code: string) => boolean): Balance[] =>
    [...m]
      .filter(([code, amount]) => amount !== 0 && keep(code))
      .map(([code, amount]) => ({ code, amount }))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const isParty = (code: string) => code !== '' && !cash.has(code);
  const excluded = (['customer', 'supplier'] as const).flatMap((role) =>
    sorted(sums[role], (c) => !isParty(c)).map((b) => ({
      role,
      code: b.code === '' ? null : b.code,
      amount: b.amount,
    })),
  );
  return {
    customers: sorted(sums.customer, isParty),
    suppliers: sorted(sums.supplier, isParty),
    excluded,
  };
}

export interface LastPurchasesInput {
  asOf: string;
  docTypes: DocTypes;
  cashPartners?: string[];
  lines: {
    itemId: string;
    docType: string;
    date: Text;
    transactionId: Text;
    rate: Text;
    supplierCode: Text;
  }[];
}

/** Each item's latest purchase (a type that adds stock, a rate above 0) up to `asOf` (§5). */
export function lastPurchases(
  input: LastPurchasesInput,
): { itemId: string; cost: number; supplierCode: string | null; date: string }[] {
  const cash = new Set((input.cashPartners ?? []).map((c) => c.trim()));
  const latest = new Map<string, { date: string; tx: number; cost: number; supplier: string | null }>();
  for (const l of input.lines) {
    const date = l.date ?? '';
    if (dayOf(date) > input.asOf) continue;
    if (signOf(input.docTypes, l.docType) !== 1) continue;
    const cost = moneyOf(l.rate);
    if (cost <= 0) continue;
    const code = (l.supplierCode ?? '').trim();
    const at = {
      date,
      tx: Number(l.transactionId ?? 0),
      cost,
      supplier: code === '' || cash.has(code) ? null : code,
    };
    const item = l.itemId.trim();
    const seen = latest.get(item);
    if (seen === undefined || later(at, seen)) latest.set(item, at);
  }
  return byItem(
    [...latest].map(([itemId, p]) => ({ itemId, cost: p.cost, supplierCode: p.supplier, date: p.date })),
  );
}
