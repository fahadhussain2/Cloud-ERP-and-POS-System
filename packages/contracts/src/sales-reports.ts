import type { ReportMoney } from './reports';

// The sales and purchase reports the back office reads (W2-03 plan; RPT-07, RPT-09, RPT-15; D-116). Money is integer
// minor units, quantities integer thousandths, shares basis points (CLAUDE.md rule 1). Cost, profit, margin, purchase
// amounts and purchase rates are null for someone without cost.view. "since" is the first business date the system has
// sales for: a comparison before it is "before go-live".

/** How sales and gross profit are grouped (owner answer 3); a category's row opens its items, an item's its bills. */
export const SALES_GROUPS = [
  'category',
  'item',
  'brand',
  'make',
  'salesman',
  'customer',
  'bill',
  'day',
  'month',
] as const;
export type SalesGroup = (typeof SALES_GROUPS)[number];

/** The comparison period: the one before, the same one a year before, or none (as the profit and loss). */
export const SALES_COMPARES = ['previous', 'last-year', 'none'] as const;
export type SalesCompare = (typeof SALES_COMPARES)[number];

/** The customer filter's value for walk-in bills. */
export const WALK_IN = 'walk-in';

export interface SalesChoicesView {
  /** Everyone who has made a bill, by name. */
  salesmen: { id: string; name: string }[];
  customers: { id: string; code: string; name: string }[];
}

export interface ChangeView {
  amount: number;
  bp: number | null;
}

export interface SalesCells {
  /** Bills (a return or exchange is a bill too). */
  bills: number;
  qty: number;
  sales: number;
  /** List − paid (owner answer 6). */
  discount: number;
  discountBp: number | null;
  cost: number | null;
  profit: number | null;
  marginBp: number | null;
}

export interface SalesBefore {
  sales: number;
  profit: number | null;
  salesChange: ChangeView;
  profitChange: ChangeView | null;
}

export interface SalesRow {
  /** The group's id: a category, item, brand, make, user, party or bill id, a date or a month (YYYY-MM); '' for none. */
  key: string;
  name: string;
  /** The item's or customer's code, the bill's number; null otherwise. */
  code: string | null;
  /** A bill's business date. */
  date: string | null;
  cells: SalesCells;
  before: SalesBefore | null;
}

export interface SalesProfitView {
  money: ReportMoney;
  values: boolean;
  from: string;
  to: string;
  group: SalesGroup;
  compare: SalesCompare;
  /** The comparison period, or null. */
  before: { from: string; to: string } | null;
  since: string;
  rows: SalesRow[];
  /** More rows than the screen shows; the total and the CSV count them all. */
  truncated: boolean;
  total: { count: number; cells: SalesCells; before: SalesBefore | null };
  /**
   * Stock sold before it arrived, settled when it came in (D-124): cost of goods sold on no bill, by item, in the
   * period the stock came in, under the same item filters. None with a salesman or customer filter (it belongs to
   * neither); null without cost.view.
   */
  corrections: SalesCorrections | null;
}

export interface SalesCorrections {
  /** Σ of the items' corrections: above 0 is more cost. */
  cost: number;
  /** The bills' profit less the corrections: gross profit in the books. */
  profit: number;
  /** The largest first. */
  items: { itemId: string; code: string; name: string; cost: number }[];
}

// ---- The purchase register (RPT-09) ----

export interface PurchaseLineView {
  itemId: string | null;
  code: string | null;
  name: string | null;
  qty: number;
  /** The cost on the supplier's bill, per unit. */
  rate: number | null;
  /** After the line and bill discounts. */
  value: number | null;
}

export interface PurchaseDocumentRow {
  kind: 'receipt' | 'return';
  id: string;
  number: string | null;
  date: string;
  supplierId: string | null;
  supplier: string | null;
  supplierBillNo: string | null;
  supplierBillDate: string | null;
  location: string;
  /** A receipt paid by bank when it was made, or put on the supplier's account; a return goes on the account. */
  paidBy: 'bank' | 'account';
  dueDate: string | null;
  lineCount: number;
  qty: number;
  /** Signed: a return is negative. Null without cost.view. */
  total: number | null;
  lines: PurchaseLineView[] | null;
}

export interface PurchaseRegisterView {
  money: ReportMoney;
  values: boolean;
  from: string;
  to: string;
  supplierId: string | null;
  withLines: boolean;
  rows: PurchaseDocumentRow[];
  /** One per supplier, by name, those without one last. */
  suppliers: { supplierId: string | null; name: string | null; count: number; total: number | null }[];
  total: { count: number; receipts: number | null; returns: number | null; net: number | null };
}

// ---- Purchase and sale rates (RPT-09, owner answer 4) ----

export interface RateStatsView {
  count: number;
  qty: number;
  value: number;
  average: number | null;
  lowest: number | null;
  highest: number | null;
  last: number | null;
}

export interface RateLineView {
  kind: 'receipt' | 'sale';
  documentId: string;
  number: string | null;
  date: string;
  /** The supplier or the customer; null for a walk-in. */
  party: string | null;
  /** The bill's salesman (sales only). */
  salesman: string | null;
  itemId: string;
  code: string;
  name: string;
  qty: number;
  /** A sale's list price; null on a receipt or with no price on the tier. */
  listPrice: number | null;
  /** The rate on the document: the supplier's cost or the price charged. */
  rate: number;
  /** After the line and bill discounts. */
  netRate: number;
  value: number;
}

export interface RatesView {
  money: ReportMoney;
  values: boolean;
  from: string;
  to: string;
  item: { id: string; code: string; name: string } | null;
  party: { id: string; code: string; name: string } | null;
  /** Null without cost.view. */
  purchases: RateLineView[] | null;
  sales: RateLineView[];
  /** Per item, when the report is for a party and several items: the statistics are for one item only. */
  purchaseStats: RateStatsView | null;
  saleStats: RateStatsView | null;
  spread: { amount: number; marginBp: number | null } | null;
}

// ---- Sales over time (RPT-15, owner answers 5 and 6) ----

export const SALES_RANKINGS = ['sales', 'profit', 'qty'] as const;
export type SalesRanking = (typeof SALES_RANKINGS)[number];

export const GRID_MEASURES = ['bills', 'sales'] as const;
export type GridMeasure = (typeof GRID_MEASURES)[number];

export interface TrendPointView {
  from: string;
  to: string;
  bills: number;
  sales: number;
  profit: number | null;
}

export interface TopItemView {
  itemId: string;
  code: string;
  name: string;
  qty: number;
  sales: number;
  profit: number | null;
}

export interface DiscountRowView {
  /** A user id or a date. */
  key: string;
  name: string;
  listSales: number;
  sales: number;
  discount: number;
  discountBp: number | null;
  /** Price approvals (below list, below floor) on these bills. */
  approvals: number;
}

export interface SalesOverTimeView {
  money: ReportMoney;
  values: boolean;
  from: string;
  to: string;
  compare: SalesCompare;
  before: { from: string; to: string } | null;
  since: string;
  step: 'day' | 'week' | 'month';
  trend: TrendPointView[];
  /** The comparison period's, bucket by bucket in the same order; null without a comparison. */
  beforeTrend: TrendPointView[] | null;
  /** [weekday][hour], Monday first. */
  grid: { bills: number[][]; sales: number[][]; hours: { first: number; last: number } | null };
  by: SalesRanking;
  top: TopItemView[];
  bottom: TopItemView[];
  discounts: { bySalesman: DiscountRowView[]; byDay: DiscountRowView[]; total: DiscountRowView };
}
