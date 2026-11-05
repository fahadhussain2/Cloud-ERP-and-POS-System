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

export interface CompareClosingInput {
  asOf: string;
  docTypes: DocTypes;
  openings: ClosingStockInput['openings'];
  /** The purchase, sale, return and physical-stock document lines. */
  lines: ClosingStockInput['movements'];
  /** The INV_StockRecordTAB rows as movements (their own Quantity and type). */
  records: ClosingStockInput['movements'];
  /** Each item's latest running balance (latestStockRecords). */
  running: { itemId: string; qty: number }[];
  /** The legacy Item Wise Closing Stock report, as the owner ran it for the dump day. */
  legacy: { itemId: string; qty: string }[];
}

export interface CompareClosingRow {
  itemId: string;
  legacy: number | null;
  computed: number | null;
  records: number | null;
  running: number | null;
  opening: number | null;
  matches: ('records' | 'running')[];
  byType: { docType: string; lines: number; records: number }[];
}

/**
 * Our closing stock against the legacy Closing Stock report (W1-14 rehearsal 2): which figure the report shows and,
 * per document type, where the document lines and the stock-record lines disagree. Quantities in thousandths.
 */
export function compareClosing(input: CompareClosingInput): {
  counts: {
    legacyItems: number;
    same: number;
    differ: number;
    matchRecords: number;
    matchRunning: number;
    none: number;
    notInReport: number;
    notOurs: number;
  };
  totals: { legacy: number; computed: number; records: number };
  rows: CompareClosingRow[];
} {
  const legacy = new Map<string, number>();
  for (const l of input.legacy) {
    const id = l.itemId.trim();
    legacy.set(id, (legacy.get(id) ?? 0) + qtyOf(l.qty));
  }
  const toMap = (rows: { itemId: string; qty: number }[]) => new Map(rows.map((r) => [r.itemId, r.qty]));
  const computed = toMap(closingStock({ ...input, movements: input.lines }));
  const records = toMap(closingStock({ ...input, movements: input.records }));
  const running = toMap(input.running.map((r) => ({ itemId: r.itemId.trim(), qty: r.qty })));
  const openings = new Map<string, number>();
  for (const o of input.openings) {
    const id = o.itemId.trim();
    openings.set(id, (openings.get(id) ?? 0) + qtyOf(o.qty));
  }
  // Per item and document type: the signed sum from the document lines and from the stock records.
  const types = new Map<string, Map<string, { lines: number; records: number }>>();
  const addType = (rows: CompareClosingInput['lines'], key: 'lines' | 'records') => {
    for (const m of rows) {
      if (dayOf(m.date) > input.asOf) continue;
      const id = m.itemId.trim();
      const t = m.docType.trim();
      const byType = types.get(id) ?? new Map<string, { lines: number; records: number }>();
      const v = byType.get(t) ?? { lines: 0, records: 0 };
      v[key] += signOf(input.docTypes, t) * qtyOf(m.qty);
      byType.set(t, v);
      types.set(id, byType);
    }
  };
  addType(input.lines, 'lines');
  addType(input.records, 'records');

  const ours = new Set([...computed.keys(), ...records.keys(), ...running.keys()]);
  const counts = {
    legacyItems: legacy.size,
    same: 0,
    differ: 0,
    matchRecords: 0,
    matchRunning: 0,
    none: 0,
    notInReport: 0,
    notOurs: 0,
  };
  const totals = { legacy: 0, computed: 0, records: 0 };
  for (const q of legacy.values()) totals.legacy += q;
  for (const q of computed.values()) totals.computed += q;
  for (const q of records.values()) totals.records += q;
  const rows: CompareClosingRow[] = [];
  for (const id of [...new Set([...ours, ...legacy.keys()])].sort()) {
    const l = legacy.get(id) ?? null;
    if (!ours.has(id)) {
      counts.differ += 1;
      counts.notOurs += 1;
      rows.push({
        itemId: id,
        legacy: l,
        computed: null,
        records: null,
        running: null,
        opening: null,
        matches: [],
        byType: [],
      });
      continue;
    }
    const c = computed.get(id) ?? 0;
    if (l === null) {
      if (c === 0) continue;
      counts.notInReport += 1;
    } else if (l === c) {
      counts.same += 1;
      continue;
    } else counts.differ += 1;
    const rec = records.get(id) ?? 0;
    const run = running.get(id) ?? null;
    const matches: CompareClosingRow['matches'] = [];
    if (l !== null) {
      if (l === rec) matches.push('records');
      if (l === run) matches.push('running');
      if (matches.includes('records')) counts.matchRecords += 1;
      else if (matches.includes('running')) counts.matchRunning += 1;
      else counts.none += 1;
    }
    rows.push({
      itemId: id,
      legacy: l,
      computed: c,
      records: rec,
      running: run,
      opening: openings.get(id) ?? 0,
      matches,
      byType: [...(types.get(id) ?? new Map<string, { lines: number; records: number }>())]
        .filter(([, v]) => v.lines !== v.records)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([docType, v]) => ({ docType, ...v })),
    });
  }
  return { counts, totals, rows };
}

export interface OpeningMovementsInput {
  /** The INV_StockRecordTAB rows as movements (their own Quantity and document type). */
  records: ClosingStockInput['movements'];
  /** The physical-stock count lines, with their signed quantities (a shortage is negative). */
  physical: ClosingStockInput['movements'];
}

/**
 * The movements the opening's closing stock counts (D-102, §4.1), as the legacy Closing Stock report does: the stock
 * records, except physical-stock counts, whose records lose a shortage's sign, so those come from the count lines.
 * Sale lines are never used: legacy stores their quantities negative.
 */
export function openingMovements(input: OpeningMovementsInput): ClosingStockInput['movements'] {
  const counted = new Set(input.physical.map((m) => m.docType.trim()));
  return [...input.records.filter((m) => !counted.has(m.docType.trim())), ...input.physical];
}
