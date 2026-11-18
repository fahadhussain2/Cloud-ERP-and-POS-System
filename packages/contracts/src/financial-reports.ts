import type { ReportMoney } from './reports';

// The financial statements and the day book (W2-01 plan; ACC-07, RPT-11; D-116). Read only, computed on request from
// the journal by @erp/domain's statements.ts. Money in whole minor units (rule 1); a percentage is basis points.
// Every one needs reports.financial (owner, accountant).

/** Every source a journal entry can have (postings_source_type_check, migration 0019): the day book's filter. */
export const JOURNAL_SOURCES = [
  'opening',
  'sale',
  'sales_void',
  'cash_handover',
  'payment',
  'cash_movement',
  'cash_session',
  'goods_receipt',
  'purchase_return',
  'supplier_payment',
  'stock_transfer',
  'stock_transfer_receipt',
  'stock_adjustment',
  'customer_receipt',
  'expense',
  'fund_transfer',
  'journal_voucher',
] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

export interface Sides {
  debit: number;
  credit: number;
}

export interface Period {
  from: string;
  to: string;
}

// ---- Trial balance ----

export interface TrialBalanceRow {
  id: string;
  code: string;
  name: string;
  depth: number;
  group: boolean;
  opening: Sides;
  movement: Sides;
  closing: Sides;
}

export interface TrialBalanceView extends Period {
  money: ReportMoney;
  level: 'accounts' | 'groups';
  showEmpty: boolean;
  rows: TrialBalanceRow[];
  totals: { opening: Sides; movement: Sides; closing: Sides };
  balanced: boolean;
}

// ---- Sections of the profit and loss, the balance sheet and the expenses ----

export interface StatementRow {
  id: string;
  code: string;
  name: string;
  depth: number;
  group: boolean;
  role: string | null;
  /** One amount per column. */
  amounts: number[];
}

export interface StatementSection {
  rows: StatementRow[];
  total: number[];
}

// ---- Profit and loss ----

export type ProfitLossCompare = 'previous' | 'last-year' | 'none' | 'months';

export interface StockPanel {
  opening: number;
  purchases: number;
  purchaseReturns: number;
  adjustments: number;
  other: number;
  closing: number;
  stockUsed: number;
  costOfGoodsSold: number;
  difference: number;
}

export interface ProfitLossView extends Period {
  money: ReportMoney;
  compare: ProfitLossCompare;
  /** The columns: the report's period first, then its comparison; or one per month. */
  periods: Period[];
  revenue: StatementSection;
  costOfSales: StatementSection;
  grossProfit: number[];
  grossMargin: (number | null)[];
  expenses: StatementSection;
  netProfit: number[];
  netMargin: (number | null)[];
  /** The stock and purchases panel for the whole of from–to (owner answer 2). */
  stock: StockPanel;
}

// ---- Balance sheet ----

export interface BalanceSheetView {
  money: ReportMoney;
  at: string;
  /** null when not compared. */
  compareAt: string | null;
  columns: { at: string }[];
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  profitForYear: number[];
  earlierProfit: number[];
  earlierInRetained: boolean;
  liabilitiesAndEquity: number[];
  difference: number[];
}

// ---- Cash book ----

export interface CashBookLine {
  date: string;
  journalNumber: string;
  sourceType: string;
  sourceId: string;
  number: string | null;
  memo: string | null;
  partyName: string | null;
  debit: number;
  credit: number;
  balance: number;
  /** Money moved between two of the shop's own cash and bank accounts: it shows in both. */
  transfer: boolean;
}

export interface CashBookAccount {
  id: string;
  code: string;
  name: string;
  opening: number;
  in: number;
  out: number;
  closing: number;
  days: { date: string; opening: number; in: number; out: number; closing: number }[];
  lines: CashBookLine[];
  /** More lines than one page holds (the days and totals still count them all). */
  truncated: boolean;
}

export interface CashBookView extends Period {
  money: ReportMoney;
  accountId: string | null;
  /** Every cash and bank account, for the filter. */
  choices: { id: string; code: string; name: string }[];
  accounts: CashBookAccount[];
}

// ---- Day book ----

export interface DayBookEntry {
  id: string;
  date: string;
  journalNumber: string;
  sourceType: string;
  sourceId: string;
  number: string | null;
  memo: string | null;
  /** A reversal, or the reversed entry of a document. */
  reversal: boolean;
  debit: number;
  credit: number;
  lines: {
    accountId: string;
    accountCode: string;
    accountName: string;
    partyName: string | null;
    debit: number;
    credit: number;
    memo: string | null;
  }[];
}

export interface DayBookView extends Period {
  money: ReportMoney;
  type: string | null;
  entries: DayBookEntry[];
  totals: { entries: number; debit: number; credit: number };
  truncated: boolean;
}

// ---- Expenses by month ----

export interface ExpensesView extends Period {
  money: ReportMoney;
  /** The months; each row's amounts are one per month, then the total of the range. */
  months: Period[];
  rows: StatementRow[];
  total: number[];
}
