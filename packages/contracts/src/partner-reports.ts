import type { ReportMoney } from './reports';

// The customer, supplier and control reports and the cash flow the back office reads (W2-04 plan; RPT-16, RPT-17,
// ACC-07; D-116). Money is integer minor units (CLAUDE.md rule 1); dates are business dates. A party balance is what is
// owed: > 0 the customer owes the shop, or the shop owes the supplier; < 0 an advance.

export const PARTY_ROLES = ['customer', 'supplier'] as const;
export type PartyRoleView = (typeof PARTY_ROLES)[number];

/** The shop's header on a statement: as on its printed bills (W1-25). */
export interface ShopHeaderView {
  name: string;
  address: string;
  phone: string;
  lines: string[];
}

export interface PartyView {
  id: string;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  phones: string[];
  termsDays: number | null;
  /** Customers only; null = no limit (D-085). */
  limit: number | null;
}

/** One line of a bill or a goods receipt, on a statement "with items". */
export interface StatementItemView {
  code: string;
  name: string;
  /** Thousandths. */
  qty: number;
  price: number;
  total: number;
}

export interface LedgerLineView {
  date: string;
  dueDate: string;
  /** The party ledger's source type: sale, sales_void, payment, customer_receipt, goods_receipt… */
  kind: string;
  sourceId: string;
  number: string;
  memo: string | null;
  debit: number;
  credit: number;
  balance: number;
  /** A voided bill or its void: shown marked on screen, left out of the statement (owner answer 1). */
  voided: boolean;
  /** With items only. */
  items?: StatementItemView[];
}

export interface KindTotalView {
  kind: string;
  count: number;
  debit: number;
  credit: number;
}

export interface AgeingBucketsView {
  balance: number;
  notDue: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
}

export interface PartnerLedgerBody {
  party: PartyView;
  opening: number;
  lines: LedgerLineView[];
  byKind: KindTotalView[];
  debit: number;
  credit: number;
  closing: number;
  /** The closing balance by how overdue it is, as on `to` (W1-20's ageing). */
  ageing: AgeingBucketsView;
}

export interface PartnerLedgerView extends PartnerLedgerBody {
  money: ReportMoney;
  role: PartyRoleView;
  from: string;
  to: string;
  /** The printed statement: voided bills left out. */
  statement: boolean;
  header: ShopHeaderView;
}

/** Statements for every customer with a balance at `to` or a document in the range, one per page (owner answer 2). */
export interface StatementsView {
  money: ReportMoney;
  from: string;
  to: string;
  header: ShopHeaderView;
  statements: PartnerLedgerBody[];
}

export interface BalanceTrendRow {
  partyId: string;
  code: string;
  name: string;
  /** One per date; null before go-live. */
  balances: (number | null)[];
  /** As on the date − a month before; null when that was before go-live. */
  change: number | null;
}

/** Balances as on a date, 15 days, 1, 2, 3 and 6 months before it (owner answer 3). */
export interface BalanceTrendView {
  money: ReportMoney;
  role: PartyRoleView;
  asOf: string;
  dates: string[];
  /** The first day the books have anything; a date before it shows "before go-live". */
  since: string | null;
  rows: BalanceTrendRow[];
  totals: (number | null)[];
  /** Accounts receivable or payable at each date: equal to the totals. */
  control: (number | null)[];
}

export const OVERDUE_DAYS = [0, 15, 30, 60, 90] as const;

export interface OverdueRow {
  partyId: string;
  code: string;
  name: string;
  phones: string[];
  balance: number;
  overdue: number;
  oldestDate: string | null;
  oldestLate: number | null;
  lastPayment: { date: string; amount: number } | null;
  limit: number | null;
  termsDays: number | null;
}

export interface OverdueView {
  money: ReportMoney;
  asOf: string;
  days: number;
  rows: OverdueRow[];
  totals: { balance: number; overdue: number };
}

export interface OverLimitRow {
  partyId: string;
  code: string;
  name: string;
  phones: string[];
  limit: number;
  balance: number;
  /** limit − balance: negative when over. */
  left: number;
  state: 'over' | 'near';
  /** The last time a counter's sale past the limit was approved for this customer. */
  lastApproval: string | null;
}

export interface OverLimitView {
  money: ReportMoney;
  asOf: string;
  rows: OverLimitRow[];
  /** Customers with a limit at all: none means limits haven't been set yet. */
  withLimit: number;
}

export const REGISTER_SIDES = ['received', 'paid'] as const;
export type RegisterSide = (typeof REGISTER_SIDES)[number];

export interface MoneyRegisterRow {
  date: string;
  /** payment, customer_receipt; supplier_payment, cash_movement, goods_receipt. */
  kind: string;
  sourceId: string;
  number: string;
  partyId: string;
  partyCode: string;
  partyName: string;
  /** The method (cash, Raast…) at a counter, or the bank account. */
  how: string;
  /** The counter, or null for the back office. */
  counter: string | null;
  by: string | null;
  reference: string | null;
  amount: number;
}

export interface MoneyRegisterTotal {
  name: string;
  count: number;
  amount: number;
}

/** Money received from customers or paid to suppliers (owner answer 5). */
export interface CollectionsView {
  money: ReportMoney;
  side: RegisterSide;
  from: string;
  to: string;
  rows: MoneyRegisterRow[];
  byMethod: MoneyRegisterTotal[];
  byPerson: MoneyRegisterTotal[];
  total: number;
}

export const ACTIVITY_KIND_VIEWS = [
  'sign_in',
  'sales',
  'approvals',
  'items',
  'parties',
  'money',
  'stock',
  'settings',
  'books',
  'other',
] as const;
export type ActivityKindView = (typeof ACTIVITY_KIND_VIEWS)[number];

export interface ActivityRow {
  at: string;
  userId: string;
  userName: string;
  /** The counter's name, or null for the back office. */
  device: string | null;
  kind: ActivityKindView;
  /** create, update, delete, or a named event (login.failed, sale.voided…). */
  action: string;
  /** The table changed (items, sales_documents…). */
  entity: string;
  entityId: string | null;
  /** The record's number, code or name, when it has one. */
  label: string | null;
  changes: { field: string; before: unknown; after: unknown }[];
}

/** Who did what (owner answer 6): the owner only (admin.users). */
export interface UserActivityView {
  from: string;
  to: string;
  users: { id: string; name: string }[];
  rows: ActivityRow[];
  /** Rows matching the filters; the screen shows the newest 2,000, the CSV has every one. */
  count: number;
}

export const CASH_FLOW_CLASS_VIEWS = [
  'opening',
  'sales',
  'customers',
  'suppliers',
  'expenses',
  'owner',
  'shortOver',
  'other',
] as const;
export type CashFlowClassView = (typeof CASH_FLOW_CLASS_VIEWS)[number];

export interface CashFlowRowView {
  cls: CashFlowClassView;
  /** Expenses only: the expense account. */
  account: { id: string; code: string; name: string } | null;
  amounts: number[];
  total: number;
}

export interface CashFlowColumnView {
  from: string;
  to: string;
  opening: number;
  net: number;
  closing: number;
}

/** Money in and out of cash and bank by what it was for, month by month (owner answer 7). */
export interface CashFlowView {
  money: ReportMoney;
  from: string;
  to: string;
  columns: CashFlowColumnView[];
  rows: CashFlowRowView[];
  total: { opening: number; net: number; closing: number };
}
