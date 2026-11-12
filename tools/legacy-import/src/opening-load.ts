import { withTenant } from '@erp/db';
import { money, mulQty, qty } from '@erp/domain';
import { postDocument } from '@erp/posting';
import pg from 'pg';

import { DumpError } from './errors';
import type { Mapping } from './transform/mapping';
import {
  closingStock,
  compareClosing,
  compareCost,
  lastPurchases,
  latestStockRecords,
  legacyQty,
  openingCost,
  openingMovements,
  partyBalances,
  type ClosingStockInput,
  type CompareClosingRow,
  type CompareCostInput,
  type CompareCostRow,
  type LastPurchasesInput,
  type PartyBalancesInput,
  type StockRecordsInput,
} from './transform/opening';
import { legacyMoney, mapLegacyAccount } from './transform/rules';

// The opening balances from a staged dump (W1-14, MIG-02, migration doc §4): computed by the pure rules in
// transform/opening.ts, written as a draft opening document, posted once with `post`, and reconciled against the
// tenant's own ledgers (MIG-04). As the app role inside withTenant (RLS on), in one transaction. Prints and returns
// counts and totals; the party lists go only into the report files (D-085).

export interface OpeningInputs {
  /** The counted drawer and the bank statements at the cutoff, by account code, in rupees ("5000", "1250.50"). */
  accounts?: Record<string, string>;
}

/** Totals read off the legacy app's own reports on the dump day (owner answer 4), in rupees and units. */
export interface LegacyTotals {
  closingStockQty?: string;
  closingStockValue?: string;
  customerOutstanding?: string;
  supplierOutstanding?: string;
}

export interface OpeningOptions {
  stagingUrl: string;
  label: string;
  appUrl: string;
  tenantCode: string;
  mapping: Mapping;
  /** The legacy cutoff (inclusive) and the date the opening posts on. */
  asOf: string;
  businessDate: string;
  /** Write (or replace) the draft; false = compute and report only. */
  write: boolean;
  /** Post the draft after writing it. */
  post: boolean;
  inputs: OpeningInputs;
  legacyTotals: LegacyTotals | null;
  /** The legacy Item Wise Closing Stock report for the dump day, per item (legacy-closing.csv), or null. */
  legacyClosing: { itemId: string; qty: string; rate?: string }[] | null;
  now: Date;
}

export interface DocTypeCount {
  source: 'purchase' | 'sale' | 'physical' | 'stock_record';
  docType: string;
  name: string | null;
  rows: number;
  sign: number | null;
}

export interface PeriodRange {
  /** 'period' = a row of Admin_Period; otherwise the staged table. */
  source: string;
  name: string | null;
  from: string | null;
  to: string | null;
  rows: number;
}

export interface ReconciliationCheck {
  check: string;
  ours: string;
  legacy: string;
  status: 'pass' | 'differs' | 'waiting';
}

export interface OpeningResult {
  tenantId: string;
  label: string;
  status: 'computed' | 'draft' | 'posted' | 'unchanged';
  /** Lines of the posted opening that differ from this run's figures (a re-run after posting changes nothing). */
  differences: number;
  totals: {
    items: number;
    stockLines: number;
    stockQty: number;
    stockValue: number;
    noCost: number;
    customers: number;
    customerTotal: number;
    suppliers: number;
    supplierTotal: number;
  };
  docTypes: DocTypeCount[];
  /** The legacy periods in the dump and each stock table's date range (dates only, no values). */
  periods: PeriodRange[];
  /** Per item against the legacy Closing Stock report, when legacy-closing.csv is given. */
  closingCompare: {
    counts: Record<string, number>;
    totals: { legacy: number; computed: number; records: number };
    rows: CompareClosingRow[];
  } | null;
  /** Per item against the report's Average Rate, when legacy-closing.csv has a rate column. */
  costCompare: {
    counts: Record<string, number>;
    values: { ours: number; report: number };
    byKind: Record<string, number>;
    rows: CompareCostRow[];
  } | null;
  checks: ReconciliationCheck[];
  /** For the report files only (party names and amounts stay on this PC, D-085). */
  detail: {
    negative: { code: string; qty: number }[];
    zeroWithSales: { code: string; sold: number }[];
    noCost: { code: string; qty: number }[];
    qtyMismatch: {
      code: string;
      computed: number;
      running: number;
      periodOpening: number;
      fromRecords: number;
    }[];
    costAboveRetail: { code: string; cost: number; retail: number }[];
    unknownItems: string[];
    unknownParties: { role: string; code: string; amount: number }[];
    excluded: { role: string; code: string | null; amount: number }[];
    topCustomers: { code: string; name: string; amount: number }[];
    topSuppliers: { code: string; name: string; amount: number }[];
    legacyTrialBalance: { legacyCode: string; mapsTo: string; amount: number }[];
    openingTrialBalance: { account: string; debit: number; credit: number }[];
  };
}

type Row = Record<string, string | null>;

const STAGED = {
  items: 'inv_item',
  purchaseLines: 'inv_purchasedetail',
  purchases: 'inv_purchaseheader',
  saleLines: 'inv_saledetail',
  sales: 'inv_saleheader',
  countLines: 'inv_physicalstockdetail',
  counts: 'inv_physicalstockheader',
  stockRecords: 'inv_stockrecordtab',
  glLines: 'gl_transactiondetail',
  gl: 'gl_transactionheader',
  docTypes: 'gen_doctype',
} as const;
/** The legacy tables the opening step reads, so the masters' "unused tables" report leaves them out. */
export const OPENING_TABLES = Object.values(STAGED);

interface Staged {
  items: Row[];
  movements: {
    source: 'purchase' | 'sale' | 'physical';
    itemId: string;
    docType: string;
    date: string | null;
    qty: string | null;
    transactionId: string | null;
    rate: string | null;
    partner: string | null;
  }[];
  stockRecords: (StockRecordsInput['records'][number] & { docType: string; quantity: string | null })[];
  /** The stock-record rows as movements (their own Quantity and type), for the third cross-check. */
  recordMoves: ClosingStockInput['movements'];
  glLines: PartyBalancesInput['lines'];
  docTypeNames: Map<string, string>;
  stockRecordTypes: Map<string, number>;
  periods: PeriodRange[];
}

async function readStaging(url: string, label: string): Promise<Staged> {
  const schema = `"legacy_${label}"`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const present = new Set(
      (
        await c.query<{ table_name: string }>(
          'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
          [`legacy_${label}`],
        )
      ).rows.map((r) => r.table_name),
    );
    for (const t of Object.values(STAGED))
      if (t !== STAGED.docTypes && !present.has(t))
        throw new Error(`legacy_${label}.${t} is missing from the staged dump`);
    const q = async <T extends Row>(sql: string) => (await c.query<T>(sql)).rows;
    const items = await q(
      `SELECT itemid, openingquantity, costprice, openingrate, saleprice FROM ${schema}.inv_item`,
    );
    const lines = (detail: string, header: string, partner: boolean) =>
      q(`SELECT d.itemid, h.documenttypeid AS doctype, h.documentdate AS date, d.quantity AS qty,
                h.transactionid, d.rate, ${partner ? 'h.bpsubaccountcode' : 'NULL'} AS partner
         FROM ${schema}.${detail} d
         JOIN ${schema}.${header} h ON h.periodid = d.periodid AND h.transactionid = d.transactionid
           AND h.companyid = d.companyid
         ORDER BY d._file, d._line`);
    const movements: Staged['movements'] = [];
    for (const [source, detail, header, partner] of [
      ['purchase', STAGED.purchaseLines, STAGED.purchases, true],
      ['sale', STAGED.saleLines, STAGED.sales, true],
      ['physical', STAGED.countLines, STAGED.counts, false],
    ] as const)
      for (const r of await lines(detail, header, partner))
        movements.push({
          source,
          itemId: (r['itemid'] ?? '').trim(),
          docType: (r['doctype'] ?? '').trim(),
          date: r['date'] ?? null,
          qty: r['qty'] ?? null,
          transactionId: r['transactionid'] ?? null,
          rate: r['rate'] ?? null,
          partner: r['partner'] ?? null,
        });
    const stockRecords = (
      await q(`SELECT itemid, documentdate, transactionid, stockquantity, valuationrate, quantity, documenttypeid
               FROM ${schema}.inv_stockrecordtab ORDER BY _file, _line`)
    ).map((r) => ({
      docType: (r['documenttypeid'] ?? '').trim(),
      quantity: r['quantity'] ?? null,
      itemId: r['itemid'] ?? '',
      date: r['documentdate'],
      transactionId: r['transactionid'],
      stockQuantity: r['stockquantity'],
      valuationRate: r['valuationrate'],
    }));
    const stockRecordTypes = new Map(
      (
        await q<{ doctype: string; n: string }>(
          `SELECT trim(documenttypeid) AS doctype, count(*)::text AS n FROM ${schema}.inv_stockrecordtab GROUP BY 1`,
        )
      ).map((r) => [r.doctype, Number(r.n)]),
    );
    const glLines = (
      await q(`SELECT d.accountcode, d.subaccountcode, h.documentdate AS date, d.amountdr, d.amountcr
               FROM ${schema}.gl_transactiondetail d
               JOIN ${schema}.gl_transactionheader h ON h.periodid = d.periodid AND h.transactionid = d.transactionid
                 AND h.companyid = d.companyid`)
    ).map((r) => ({
      accountCode: r['accountcode'],
      subAccountCode: r['subaccountcode'],
      date: r['date'],
      dr: r['amountdr'] ?? '0',
      cr: r['amountcr'] ?? '0',
    }));
    const docTypeNames = new Map<string, string>();
    if (present.has(STAGED.docTypes))
      for (const r of await q(`SELECT documenttypeid, documenttype FROM ${schema}.gen_doctype`))
        docTypeNames.set((r['documenttypeid'] ?? '').trim(), (r['documenttype'] ?? '').trim());
    const recordMoves = stockRecords.map((r) => ({
      itemId: r.itemId,
      docType: r.docType,
      date: r.date,
      qty: r.quantity,
    }));
    const periods: PeriodRange[] = [];
    if (present.has('admin_period'))
      for (const r of await q(
        `SELECT period, startdate, enddate FROM ${schema}.admin_period ORDER BY startdate, periodid`,
      ))
        periods.push({
          source: 'period',
          name: r['period'] ?? null,
          from: r['startdate'] ?? null,
          to: r['enddate'] ?? null,
          rows: 0,
        });
    // Staged datetimes are ISO-like text, so min and max sort as dates.
    for (const t of [STAGED.purchases, STAGED.sales, STAGED.counts, STAGED.stockRecords, STAGED.gl]) {
      const r = (
        await q(
          `SELECT min(documentdate) AS f, max(documentdate) AS t, count(*)::text AS n FROM ${schema}.${t}`,
        )
      )[0];
      periods.push({
        source: t,
        name: null,
        from: r?.['f'] ?? null,
        to: r?.['t'] ?? null,
        rows: Number(r?.['n'] ?? 0),
      });
    }
    return { items, movements, stockRecords, recordMoves, glLines, docTypeNames, stockRecordTypes, periods };
  } finally {
    await c.end();
  }
}

/** Every document type the stock tables use, with its name and the sign the mapping gives it. */
function docTypesOf(staged: Staged, m: Mapping): DocTypeCount[] {
  const counts = new Map<string, DocTypeCount>();
  for (const mv of staged.movements) {
    const k = `${mv.source}|${mv.docType}`;
    const c = counts.get(k) ?? {
      source: mv.source,
      docType: mv.docType,
      name: staged.docTypeNames.get(mv.docType) ?? null,
      rows: 0,
      sign: m.opening.docTypes[mv.docType] ?? null,
    };
    c.rows += 1;
    counts.set(k, c);
  }
  for (const [docType, rows] of staged.stockRecordTypes)
    counts.set(`stock_record|${docType}`, {
      source: 'stock_record',
      docType,
      name: staged.docTypeNames.get(docType) ?? null,
      rows,
      sign: m.opening.docTypes[docType] ?? null,
    });
  return [...counts.values()].sort((a, b) =>
    a.source !== b.source ? (a.source < b.source ? -1 : 1) : Number(a.docType) - Number(b.docType),
  );
}

const minorOf = (rupees: string | undefined) => (rupees === undefined ? null : legacyMoney(rupees).minor);
const thousandthsOf = (units: string | undefined) => {
  if (units === undefined) return null;
  const m = /^(-)?(\d+)(?:\.(\d{1,3}))?$/.exec(units.trim());
  if (!m) throw new DumpError('bad_quantity', 'legacy-totals.json: closingStockQty is not a plain number');
  const n = Number(m[2]) * 1000 + Number((m[3] ?? '').padEnd(3, '0'));
  return m[1] ? -n : n;
};
const daysBefore = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};
/** A staged legacy datetime (Karachi wall time) as an instant. */
const instantOf = (date: string) => new Date(`${date.replace(' ', 'T')}+05:00`).toISOString();

export async function importOpening(opts: OpeningOptions): Promise<OpeningResult> {
  const m = opts.mapping;
  const staged = await readStaging(opts.stagingUrl, opts.label);
  const docTypes = docTypesOf(staged, m);

  // The legacy figures (migration doc §4.1, §4.2, §5). An unmapped document type stops here, after the report.
  // Closing stock as the legacy report computes it (D-102): the stock records, physical counts from the count lines.
  const lineMoves = staged.movements.map((mv) => ({
    itemId: mv.itemId,
    docType: mv.docType,
    date: mv.date,
    qty: mv.qty,
  }));
  const stockMoves = openingMovements({
    records: staged.recordMoves,
    physical: lineMoves.filter((_, i) => staged.movements[i]!.source === 'physical'),
  });
  const closingInput: ClosingStockInput = {
    asOf: opts.asOf,
    docTypes: m.opening.docTypes,
    openings: m.opening.itemOpeningQuantity
      ? staged.items.map((r) => ({ itemId: r['itemid'] ?? '', qty: r['openingquantity'] ?? '0' }))
      : [],
    movements: stockMoves,
  };
  const unmapped = docTypes.filter((d) => d.source !== 'stock_record' && d.sign === null);
  const result: OpeningResult = {
    tenantId: '',
    label: opts.label,
    status: 'computed',
    differences: 0,
    totals: {
      items: staged.items.length,
      stockLines: 0,
      stockQty: 0,
      stockValue: 0,
      noCost: 0,
      customers: 0,
      customerTotal: 0,
      suppliers: 0,
      supplierTotal: 0,
    },
    docTypes,
    periods: staged.periods,
    closingCompare: null,
    costCompare: null,
    checks: [],
    detail: {
      negative: [],
      zeroWithSales: [],
      noCost: [],
      qtyMismatch: [],
      costAboveRetail: [],
      unknownItems: [],
      unknownParties: [],
      excluded: [],
      topCustomers: [],
      topSuppliers: [],
      legacyTrialBalance: [],
      openingTrialBalance: [],
    },
  };
  if (unmapped.length > 0) {
    const e = new DumpError(
      'unknown_doc_type',
      `document types without a sign in the mapping file: ${unmapped.map((d) => `${d.source} ${d.docType}`).join(', ')}` +
        ' (see reports/opening/doc-types.csv, then add them to opening.docTypes)',
    );
    (e as DumpError & { partial?: OpeningResult }).partial = result;
    throw e;
  }
  const closing = closingStock(closingInput);
  const fromRecords = new Map(
    closingStock({ ...closingInput, movements: staged.recordMoves }).map((r) => [r.itemId, r.qty]),
  );
  // The report's Average Rate per item (the first listing of a code), for the cost comparison.
  const reportRates = new Map<string, string>();
  for (const l of opts.legacyClosing ?? [])
    if (l.rate !== undefined && l.rate !== '' && !reportRates.has(l.itemId.trim()))
      reportRates.set(l.itemId.trim(), l.rate);
  const costItems: CompareCostInput['items'] = [];
  const records = new Map(
    latestStockRecords({ asOf: opts.asOf, records: staged.stockRecords }).map((r) => [r.itemId, r]),
  );
  const purchases: LastPurchasesInput = {
    asOf: opts.asOf,
    docTypes: m.opening.docTypes,
    cashPartners: [...m.cashPartners],
    lines: staged.movements
      .filter((mv) => mv.source === 'purchase')
      .map((mv) => ({
        itemId: mv.itemId,
        docType: mv.docType,
        date: mv.date,
        transactionId: mv.transactionId,
        rate: mv.rate,
        supplierCode: mv.partner,
      })),
  };
  const last = new Map(lastPurchases(purchases).map((p) => [p.itemId, p]));
  const balances = partyBalances({
    asOf: opts.asOf,
    customerAccount: m.opening.customerAccount,
    supplierAccount: m.opening.supplierAccount,
    cashPartners: [...m.cashPartners],
    lines: staged.glLines,
  });
  result.detail.excluded = balances.excluded;
  const itemRows = new Map(staged.items.map((r) => [(r['itemid'] ?? '').trim(), r]));
  const recentlySold = new Map<string, number>();
  const from = daysBefore(opts.asOf, 90);
  for (const mv of staged.movements)
    if (
      mv.source === 'sale' &&
      mv.date !== null &&
      mv.date.slice(0, 10) > from &&
      mv.date.slice(0, 10) <= opts.asOf
    )
      recentlySold.set(mv.itemId, (recentlySold.get(mv.itemId) ?? 0) + 1);

  // The legacy trial balance per account up to the cutoff, mapped (MIG-04).
  const legacyTb = new Map<string, number>();
  for (const l of staged.glLines) {
    if ((l.date ?? '').slice(0, 10) > opts.asOf) continue;
    const code = (l.accountCode ?? '').trim();
    legacyTb.set(
      code,
      (legacyTb.get(code) ?? 0) + legacyMoney(l.dr ?? '0').minor - legacyMoney(l.cr ?? '0').minor,
    );
  }
  result.detail.legacyTrialBalance = [...legacyTb]
    .filter(([, a]) => a !== 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([legacyCode, amount]) => {
      const t = mapLegacyAccount(legacyCode, m);
      const mapsTo =
        t.kind === 'template' || t.kind === 'drawings'
          ? t.code
          : t.kind === 'expense'
            ? `under ${t.parent}`
            : t.kind;
      return { legacyCode, mapsTo, amount };
    });

  const pool = new pg.Pool({ connectionString: opts.appUrl, max: 2 });
  try {
    const dir = await pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM erp.tenant_directory WHERE code = $1',
      [opts.tenantCode],
    );
    const tenantId = dir.rows[0]?.tenant_id;
    if (!tenantId) throw new Error(`no shop ${opts.tenantCode}`);
    result.tenantId = tenantId;

    class DryRun extends Error {}
    await withTenant(pool, { tenantId }, async (_db, c) => {
      const ids = async (sql: string) =>
        new Map((await c.query<{ k: string; id: string }>(sql)).rows.map((r) => [r.k, r.id]));
      const itemIds = await ids('SELECT code AS k, id FROM erp.items WHERE deleted_at IS NULL');
      const partyIds = await ids('SELECT code AS k, id FROM erp.parties WHERE deleted_at IS NULL');
      const accountIds = await ids('SELECT code AS k, id FROM erp.accounts');
      const partyNames = new Map(
        (await c.query<{ code: string; name: string }>('SELECT code, name FROM erp.parties')).rows.map(
          (r) => [r.code, r.name],
        ),
      );
      const retail = new Map(
        (
          await c.query<{ item_id: string; price: string }>(
            `SELECT p.item_id, p.price FROM erp.item_prices p JOIN erp.price_tiers t ON t.id = p.tier_id
             WHERE t.code = 'RETAIL' AND p.deleted_at IS NULL`,
          )
        ).rows.map((r) => [r.item_id, Number(r.price)]),
      );
      const shop = (
        await c.query<{ id: string; branch_id: string }>(
          `SELECT l.id, l.branch_id FROM erp.locations l JOIN erp.branches b ON b.id = l.branch_id
           WHERE l.code = 'SHOP' AND l.deleted_at IS NULL ORDER BY b.code LIMIT 1`,
        )
      ).rows[0];
      if (!shop) throw new Error('the shop has no SHOP location');

      // The opening's lines (posting rules §7), in a stable order: stock by item code, customers, suppliers, accounts.
      type Line = Record<string, unknown> & { kind: string };
      const lines: Line[] = [];
      for (const s of closing) {
        const itemId = itemIds.get(s.itemId);
        if (itemId === undefined) {
          if (s.qty !== 0) result.detail.unknownItems.push(s.itemId);
          continue;
        }
        const r = itemRows.get(s.itemId);
        const record = records.get(s.itemId);
        if (record && record.runningQty !== s.qty)
          result.detail.qtyMismatch.push({
            code: s.itemId,
            computed: s.qty,
            running: record.runningQty,
            periodOpening: legacyQty(r?.['openingquantity'] ?? '0').thousandths,
            fromRecords: fromRecords.get(s.itemId) ?? 0,
          });
        if (s.qty === 0) {
          if (recentlySold.has(s.itemId))
            result.detail.zeroWithSales.push({ code: s.itemId, sold: recentlySold.get(s.itemId)! });
          continue;
        }
        if (s.qty < 0) result.detail.negative.push({ code: s.itemId, qty: s.qty });
        const p = last.get(s.itemId);
        const cost = openingCost({
          valuationRate: record?.valuationRate ?? null,
          lastPurchase: p?.cost ?? null,
          costPrice: r?.['costprice'],
          openingRate: r?.['openingrate'],
          retail: retail.get(itemId) ?? null,
        });
        if (cost.unitCost === null) {
          result.detail.noCost.push({ code: s.itemId, qty: s.qty });
          result.totals.noCost += 1;
        } else {
          const price = retail.get(itemId);
          if (price !== undefined && cost.unitCost > price)
            result.detail.costAboveRetail.push({ code: s.itemId, cost: cost.unitCost, retail: price });
        }
        const reportRate = reportRates.get(s.itemId);
        if (reportRate !== undefined && cost.unitCost !== null)
          costItems.push({
            itemId: s.itemId,
            qty: s.qty,
            ours: cost.unitCost,
            source: cost.source ?? '',
            report: reportRate,
            costPrice: r?.['costprice'],
            openingRate: r?.['openingrate'],
            lastPurchase: p?.cost ?? null,
            retail: retail.get(itemId) ?? null,
          });
        lines.push({
          kind: 'stock',
          item_id: itemId,
          location_id: shop.id,
          qty: s.qty,
          unit_cost: cost.unitCost,
          last_cost: p?.cost ?? null,
          last_supplier_id: p?.supplierCode ? (partyIds.get(p.supplierCode) ?? null) : null,
          last_receipt_at: p ? instantOf(p.date) : null,
        });
        result.totals.stockLines += 1;
        result.totals.stockQty += s.qty;
        result.totals.stockValue += mulQty(qty(s.qty), money(cost.unitCost ?? 0));
      }
      for (const [role, list] of [
        ['customer', balances.customers],
        ['supplier', balances.suppliers],
      ] as const)
        for (const b of list) {
          const partyId = partyIds.get(b.code);
          if (partyId === undefined) {
            result.detail.unknownParties.push({ role, code: b.code, amount: b.amount });
            continue;
          }
          lines.push({ kind: role, party_id: partyId, amount: b.amount });
          if (role === 'customer') {
            result.totals.customers += 1;
            result.totals.customerTotal += b.amount;
          } else {
            result.totals.suppliers += 1;
            result.totals.supplierTotal += b.amount;
          }
        }
      const top = (list: { code: string; amount: number }[]) =>
        [...list]
          .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
          .slice(0, 20)
          .map((b) => ({ code: b.code, name: partyNames.get(b.code) ?? '(not loaded)', amount: b.amount }));
      result.detail.topCustomers = top(balances.customers);
      result.detail.topSuppliers = top(balances.suppliers);
      for (const [code, rupees] of Object.entries(opts.inputs.accounts ?? {})) {
        const accountId = accountIds.get(code);
        if (accountId === undefined) throw new Error(`opening-inputs.json: no account ${code} in the chart`);
        const amount = legacyMoney(rupees).minor;
        if (amount !== 0) lines.push({ kind: 'account', account_id: accountId, amount });
      }

      if (!opts.write) throw new DryRun();

      // Write or replace the draft; a posted opening is compared, never changed (rule 3).
      const existing = (
        await c.query<{ id: string; status: 'draft' | 'posted' }>(
          'SELECT id, status FROM erp.opening_balances WHERE label = $1',
          [opts.label],
        )
      ).rows[0];
      const legacy = {
        asOf: opts.asOf,
        totals: { ...result.totals },
        docTypes: docTypes.map((d) => ({ source: d.source, docType: d.docType, rows: d.rows, sign: d.sign })),
      };
      let openingId: string;
      if (existing?.status === 'posted') {
        openingId = existing.id;
        result.differences = await differencesFrom(c, openingId, lines);
        result.status = 'unchanged';
      } else {
        if (existing) {
          openingId = existing.id;
          await c.query('DELETE FROM erp.opening_balance_lines WHERE opening_id = $1', [openingId]);
          await c.query(
            `UPDATE erp.opening_balances SET branch_id = $2, as_of = $3, business_date = $4, legacy = $5 WHERE id = $1`,
            [openingId, shop.branch_id, opts.asOf, opts.businessDate, JSON.stringify(legacy)],
          );
        } else {
          openingId = (
            await c.query<{ id: string }>(
              `INSERT INTO erp.opening_balances (tenant_id, label, branch_id, as_of, business_date, legacy)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
              [tenantId, opts.label, shop.branch_id, opts.asOf, opts.businessDate, JSON.stringify(legacy)],
            )
          ).rows[0]!.id;
        }
        await insertLines(c, tenantId, openingId, lines);
        result.status = 'draft';
        if (opts.post) {
          const outcome = await postDocument(c, { tenantId, type: 'opening', id: openingId, now: opts.now });
          if (outcome.status !== 'posted')
            throw new Error(
              `the opening didn't post: ${outcome.status === 'failed' ? outcome.code : outcome.status}`,
            );
          await c.query("UPDATE erp.opening_balances SET status = 'posted', posted_at = $2 WHERE id = $1", [
            openingId,
            opts.now,
          ]);
          await c.query(
            `INSERT INTO erp.audit_log (tenant_id, action, entity, entity_id, after)
             VALUES ($1, 'opening.posted', 'opening_balances', $2, $3)`,
            [
              tenantId,
              openingId,
              JSON.stringify({
                label: opts.label,
                seq: outcome.seq,
                journal: outcome.journalNumber,
                totals: result.totals,
              }),
            ],
          );
          result.status = 'posted';
        }
      }
      result.checks = await reconcile(
        c,
        openingId,
        result,
        staged.items.length,
        itemIds.size,
        opts.legacyTotals,
      );
      result.detail.openingTrialBalance = (
        await c.query<{ account: string; debit: string; credit: string }>(
          `SELECT a.code AS account, sum(l.debit)::text AS debit, sum(l.credit)::text AS credit
           FROM erp.journal_lines l JOIN erp.journal_entries e ON e.id = l.entry_id JOIN erp.accounts a ON a.id = l.account_id
           WHERE e.source_type = 'opening' AND e.source_id = $1 GROUP BY a.code ORDER BY a.code`,
          [openingId],
        )
      ).rows.map((r) => ({ account: r.account, debit: Number(r.debit), credit: Number(r.credit) }));
    }).catch((err: unknown) => {
      if (!(err instanceof DryRun)) throw err;
    });
    if (opts.legacyClosing) {
      const cmp = compareClosing({
        ...closingInput,
        lines: stockMoves,
        records: staged.recordMoves,
        running: [...records.values()].map((x) => ({ itemId: x.itemId, qty: x.runningQty })),
        legacy: opts.legacyClosing,
      });
      result.closingCompare = cmp;
      if (costItems.length > 0) {
        const cost = compareCost({ items: costItems });
        result.costCompare = cost;
        result.checks.push({
          check: 'Unit cost per item = legacy Closing Stock report (Average Rate)',
          ours: `${cost.counts.same} same, ${cost.rows.length} differ (${cost.counts.unexplained} unexplained)`,
          legacy: `${cost.counts.items} items`,
          status: cost.rows.length === 0 ? 'pass' : 'differs',
        });
      }
      result.checks.push({
        check: 'Stock per item = legacy Closing Stock report',
        ours: `${cmp.counts.same} same, ${cmp.counts.differ} differ, ${cmp.counts.notInReport} not in the report`,
        legacy: `${cmp.counts.legacyItems} items`,
        status: cmp.counts.differ + cmp.counts.notInReport === 0 ? 'pass' : 'differs',
      });
    }
    return result;
  } finally {
    await pool.end();
  }
}

async function insertLines(
  c: pg.ClientBase,
  tenantId: string,
  openingId: string,
  lines: Record<string, unknown>[],
) {
  const col = (k: string) => lines.map((l) => l[k] ?? null);
  await c.query(
    `INSERT INTO erp.opening_balance_lines (tenant_id, opening_id, line_no, kind, item_id, location_id, qty, unit_cost,
       last_cost, last_supplier_id, last_receipt_at, party_id, account_id, amount)
     SELECT $1, $2, l.n, l.kind, l.item_id, l.location_id, l.qty::numeric / 1000, l.unit_cost, l.last_cost,
       l.last_supplier_id, l.last_receipt_at, l.party_id, l.account_id, l.amount
     FROM unnest($3::text[], $4::uuid[], $5::uuid[], $6::bigint[], $7::bigint[], $8::bigint[], $9::uuid[],
       $10::timestamptz[], $11::uuid[], $12::uuid[], $13::bigint[]) WITH ORDINALITY
       AS l (kind, item_id, location_id, qty, unit_cost, last_cost, last_supplier_id, last_receipt_at, party_id,
         account_id, amount, n)`,
    [
      tenantId,
      openingId,
      col('kind'),
      col('item_id'),
      col('location_id'),
      col('qty'),
      col('unit_cost'),
      col('last_cost'),
      col('last_supplier_id'),
      col('last_receipt_at'),
      col('party_id'),
      col('account_id'),
      col('amount'),
    ],
  );
}

/** How many lines of a posted opening differ from this run's (as sets of line text). */
async function differencesFrom(c: pg.ClientBase, openingId: string, lines: Record<string, unknown>[]) {
  const text = (l: Record<string, unknown>) =>
    [l['kind'], l['item_id'], l['qty'], l['unit_cost'], l['party_id'], l['account_id'], l['amount']]
      .map((v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '-'))
      .join(' ');
  const stored = (
    await c.query<Record<string, unknown>>(
      `SELECT kind, item_id, (qty * 1000)::bigint::text AS qty, unit_cost::text AS unit_cost, party_id, account_id,
         amount::text AS amount
       FROM erp.opening_balance_lines WHERE opening_id = $1`,
      [openingId],
    )
  ).rows.map(text);
  const wanted = lines.map(text);
  const have = new Set(stored);
  const want = new Set(wanted);
  return wanted.filter((l) => !have.has(l)).length + stored.filter((l) => !want.has(l)).length;
}

/** The reconciliation checks (MIG-04, migration doc §8), from the tenant's own ledgers once posted. */
async function reconcile(
  c: pg.ClientBase,
  openingId: string,
  r: OpeningResult,
  stagedItems: number,
  loadedItems: number,
  legacy: LegacyTotals | null,
): Promise<ReconciliationCheck[]> {
  const rs = (minor: number) => (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const units = (t: number) => (t / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });
  const checks: ReconciliationCheck[] = [];
  const add = (check: string, ours: string, theirs: string | null, same: boolean | null) =>
    checks.push({
      check,
      ours,
      legacy: theirs ?? '-',
      status: same === null ? 'waiting' : same ? 'pass' : 'differs',
    });

  add('Items loaded = legacy items', String(loadedItems), String(stagedItems), loadedItems === stagedItems);
  const posted = r.status === 'posted' || r.status === 'unchanged';
  const ledger = posted
    ? (
        await c.query<{ qty: string; value: string; ar: string; ap: string; dr: string; cr: string }>(
          `SELECT
             (SELECT coalesce(sum(qty_delta * 1000), 0)::bigint::text FROM erp.stock_movements
               WHERE source_type = 'opening' AND source_id = $1) AS qty,
             (SELECT coalesce(sum(value_delta), 0)::text FROM erp.stock_movements
               WHERE source_type = 'opening' AND source_id = $1) AS value,
             (SELECT coalesce(sum(amount), 0)::text FROM erp.party_ledger_entries
               WHERE source_type = 'opening' AND source_id = $1 AND role = 'customer') AS ar,
             (SELECT coalesce(sum(amount), 0)::text FROM erp.party_ledger_entries
               WHERE source_type = 'opening' AND source_id = $1 AND role = 'supplier') AS ap,
             (SELECT coalesce(sum(l.debit), 0)::text FROM erp.journal_lines l JOIN erp.journal_entries e ON e.id = l.entry_id
               WHERE e.source_type = 'opening' AND e.source_id = $1) AS dr,
             (SELECT coalesce(sum(l.credit), 0)::text FROM erp.journal_lines l JOIN erp.journal_entries e ON e.id = l.entry_id
               WHERE e.source_type = 'opening' AND e.source_id = $1) AS cr`,
          [openingId],
        )
      ).rows[0]!
    : null;
  if (ledger === null) {
    add('Stock quantity (ledger) = legacy computation', 'not posted yet', units(r.totals.stockQty), null);
  } else {
    const qty = Number(ledger.qty);
    const value = Number(ledger.value);
    add(
      'Stock quantity (ledger) = legacy computation',
      units(qty),
      units(r.totals.stockQty),
      qty === r.totals.stockQty,
    );
    add(
      'Stock value (ledger) = legacy computation (Rs 1 per item)',
      rs(value),
      rs(r.totals.stockValue),
      Math.abs(value - r.totals.stockValue) <= 100 * r.totals.stockLines,
    );
    add(
      'Customers (ledger) = legacy GL',
      rs(Number(ledger.ar)),
      rs(r.totals.customerTotal),
      Number(ledger.ar) === r.totals.customerTotal,
    );
    add(
      'Suppliers (ledger) = legacy GL',
      rs(Number(ledger.ap)),
      rs(r.totals.supplierTotal),
      Number(ledger.ap) === r.totals.supplierTotal,
    );
    add(
      'Opening entry balances (Dr = Cr)',
      `${rs(Number(ledger.dr))} = ${rs(Number(ledger.cr))}`,
      '-',
      ledger.dr === ledger.cr,
    );
  }
  add(
    'Stock quantities agree with legacy running balances',
    `${r.detail.qtyMismatch.length} items differ`,
    '0',
    r.detail.qtyMismatch.length === 0,
  );
  const lq = thousandthsOf(legacy?.closingStockQty);
  const lv = minorOf(legacy?.closingStockValue);
  const lc = minorOf(legacy?.customerOutstanding);
  const ls = minorOf(legacy?.supplierOutstanding);
  add(
    'Stock quantity = legacy Closing Stock report',
    units(r.totals.stockQty),
    lq === null ? null : units(lq),
    lq === null ? null : lq === r.totals.stockQty,
  );
  add(
    'Stock value = legacy Closing Stock report (Rs 1 per item)',
    rs(r.totals.stockValue),
    lv === null ? null : rs(lv),
    lv === null ? null : Math.abs(lv - r.totals.stockValue) <= 100 * r.totals.stockLines,
  );
  add(
    'Customers = legacy Customer Outstanding',
    rs(r.totals.customerTotal),
    lc === null ? null : rs(lc),
    lc === null ? null : lc === r.totals.customerTotal,
  );
  add(
    'Suppliers = legacy Supplier Outstanding',
    rs(r.totals.supplierTotal),
    ls === null ? null : rs(ls),
    ls === null ? null : ls === r.totals.supplierTotal,
  );
  add(
    'Every legacy item and party found in the shop',
    `${r.detail.unknownItems.length + r.detail.unknownParties.length} missing`,
    '0',
    r.detail.unknownItems.length + r.detail.unknownParties.length === 0,
  );
  return checks;
}
