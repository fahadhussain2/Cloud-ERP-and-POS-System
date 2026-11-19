import type { ReportMoney } from './reports';

// The stock reports the back office reads (W2-02 plan; RPT-08, RPT-12, RPT-13, RPT-14, PUR-07 list; D-116). Quantities
// are integer thousandths, money integer minor units (CLAUDE.md rule 1). Values, costs and profit are null for someone
// without cost.view (owner answer 8). "since" is the first day the system knows sales: the opening (owner answer 1).

/** How stock at a date and stock movement are grouped (owner answer 3): category means category, then vehicle make. */
export const STOCK_GROUPS = ['category', 'brand', 'location', 'supplier', 'none'] as const;
export type StockGroup = (typeof STOCK_GROUPS)[number];

/** "No sale in N days" (owner answer 5). */
export const DEAD_DAYS = [30, 60, 90, 180, 365] as const;

export interface StockQtyValue {
  qty: number;
  value: number | null;
}

/** The filters' choices: categories, makes, brands, locations and suppliers, by name. */
export interface StockChoicesView {
  categories: { id: string; name: string }[];
  makes: { id: string; name: string }[];
  brands: { id: string; name: string }[];
  locations: { id: string; code: string; name: string }[];
  suppliers: { id: string; code: string; name: string }[];
}

/** An item as the stock lists show it. */
export interface StockItemCells {
  itemId: string;
  code: string;
  name: string;
  /** The location's code, when the list is per location. */
  location: string | null;
}

/** A group's line (with its subtotals and how many rows it holds) or an item's, in the list's order. */
export type StockLine<C> =
  | { kind: 'group'; depth: number; path: string[]; name: string; count: number; cells: C }
  | ({ kind: 'row'; depth: number; cells: C } & StockItemCells);

export interface StockAtCells {
  qty: number;
  value: number | null;
}

export interface StockAtView {
  money: ReportMoney;
  values: boolean;
  at: string;
  group: StockGroup;
  locationId: string | null;
  negativeOnly: boolean;
  lines: StockLine<StockAtCells>[];
  /** More rows than the screen shows; the total and the CSV count them all. */
  truncated: boolean;
  total: { count: number } & StockAtCells;
}

/** Signed: in is positive, out negative, so opening + every bucket = closing. */
export interface StockMovementCells {
  opening: StockQtyValue;
  openings: StockQtyValue;
  purchases: StockQtyValue;
  purchaseReturns: StockQtyValue;
  sales: StockQtyValue;
  salesReturns: StockQtyValue;
  adjustments: StockQtyValue;
  transfersIn: StockQtyValue;
  transfersOut: StockQtyValue;
  closing: StockQtyValue;
}

export interface StockMovementView {
  money: ReportMoney;
  values: boolean;
  from: string;
  to: string;
  group: StockGroup;
  locationId: string | null;
  lines: StockLine<StockMovementCells>[];
  truncated: boolean;
  total: { count: number } & StockMovementCells;
}

export interface StockLedgerLine {
  seq: number;
  date: string;
  /** The movement's source: sale, goods_receipt, stock_transfer… */
  kind: string;
  documentId: string;
  number: string | null;
  locationCode: string;
  qty: number;
  value: number | null;
  /** On hand after this line, and its value (in the location asked for, else in all). */
  balance: number;
  balanceValue: number | null;
}

export interface StockLedgerView {
  money: ReportMoney;
  values: boolean;
  item: { id: string; code: string; name: string };
  from: string;
  to: string;
  locationId: string | null;
  opening: StockQtyValue;
  lines: StockLedgerLine[];
  truncated: boolean;
  in: StockQtyValue;
  out: StockQtyValue;
  closing: StockQtyValue;
}

export interface ReorderRow {
  itemId: string;
  code: string;
  name: string;
  category: string | null;
  supplierId: string | null;
  supplier: string | null;
  /** In the Shop and the Godown together. */
  onHand: number;
  min: number;
  max: number;
  order: number;
  levelsNeedFixing: boolean;
  lastCost: number | null;
  /** order × last cost. */
  orderValue: number | null;
  lastReceipt: string | null;
  sold30: number;
  sold90: number;
  daysOfCover: number | null;
}

export interface ReorderView {
  money: ReportMoney;
  values: boolean;
  today: string;
  since: string;
  /** By supplier (owner answer 4), then by code. */
  rows: ReorderRow[];
  suppliers: { supplierId: string | null; supplier: string | null; count: number; value: number | null }[];
  truncated: boolean;
  total: { count: number; value: number | null };
}

export type StockAgeKindView = 'dead' | 'notSoldSinceGoLive' | 'slow';

export interface DeadStockRow {
  itemId: string;
  code: string;
  name: string;
  category: string | null;
  make: string | null;
  kind: StockAgeKindView;
  onHand: number;
  value: number | null;
  lastSale: string | null;
  lastReceipt: string | null;
  sold90: number;
  daysSinceSale: number | null;
  daysOfCover: number | null;
}

export interface DeadStockView {
  money: ReportMoney;
  values: boolean;
  today: string;
  since: string;
  days: number;
  rows: DeadStockRow[];
  truncated: boolean;
  totals: Record<StockAgeKindView, { count: number; value: number | null }>;
}

export type AbcClassView = 'A' | 'B' | 'C';

export interface AnalysisRow {
  itemId: string;
  code: string;
  name: string;
  category: string | null;
  qtySold: number;
  sales: number;
  profit: number | null;
  salesClass: AbcClassView | null;
  profitClass: AbcClassView | null;
  onHand: number;
  stockValue: number | null;
  daysOfCover: number | null;
}

export interface AnalysisView {
  money: ReportMoney;
  values: boolean;
  from: string;
  to: string;
  since: string;
  /** Items sold in the period, by sales, largest first. */
  rows: AnalysisRow[];
  truncated: boolean;
  classes: Record<AbcClassView, { count: number; sales: number; profit: number | null }>;
  /** In stock but not sold in the period. */
  unsold: { count: number; value: number | null };
  costOfSales: number | null;
  openingValue: number | null;
  closingValue: number | null;
  /** In hundredths. */
  turnover: number | null;
}
