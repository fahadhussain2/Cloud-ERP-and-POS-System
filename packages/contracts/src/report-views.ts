import { z } from 'zod';

import type { ReportMoney } from './reports';

// The W1-20 reports and support views (RPT-01, RPT-03, RPT-04, RPT-05, RPT-06, RPT-10, PLT-12, D-110). Read only,
// computed on request from the ledgers. Money in whole minor units, quantities in thousandths (rule 1). A value or a
// cost is null for someone without cost.view: the API leaves it out, not only the screen (owner answer 1).

/** The filters every dated report takes: a range of up to 92 days (owner answer 2), one branch or all. */
export interface ReportRange {
  from: string;
  to: string;
}

// ---- Sales register (RPT-01) ----

export interface RegisterRow {
  id: string;
  number: string;
  kind: 'sale' | 'return' | 'exchange';
  status: 'finalized' | 'voided';
  businessDate: string;
  /** The counter's time of the bill. */
  createdAt: string;
  deviceCode: string;
  salespersonName: string;
  customerName: string | null;
  total: number;
  payments: { methodCode: string; methodName: string; amount: number }[];
  /** For a voided bill: its void's number and reason (owner answer 3). */
  voidNumber: string | null;
  voidReason: string | null;
}

export interface SalesRegisterView extends ReportRange {
  money: ReportMoney;
  bills: RegisterRow[];
  totals: {
    bills: number;
    voided: number;
    total: number;
    bySalesperson: { id: string; name: string; bills: number; total: number }[];
    byCounter: { code: string; bills: number; total: number }[];
    byTender: { code: string; name: string; amount: number }[];
  };
}

// ---- Overrides (RPT-03) ----

export interface OverrideRow {
  id: string;
  kind: string;
  billNumber: string;
  businessDate: string;
  at: string;
  itemCode: string | null;
  itemName: string | null;
  requestedByName: string;
  approvedByName: string;
  reasonCode: string;
  note: string | null;
  listPrice: number | null;
  unitPrice: number | null;
  /** The floor comes from cost: null without cost.view. */
  floorPrice: number | null;
}

export interface OverridesView extends ReportRange {
  money: ReportMoney;
  overrides: OverrideRow[];
  byRequester: { name: string; count: number }[];
  byApprover: { name: string; count: number }[];
  byKind: { kind: string; count: number }[];
}

// ---- Voids and returns (RPT-04) ----

export interface VoidRow {
  number: string;
  saleNumber: string;
  businessDate: string;
  at: string;
  reasonCode: string;
  note: string | null;
  voidedByName: string;
  approvedByName: string;
  saleTotal: number | null;
  /** The bill issued in its place, if any. */
  reissueNumber: string | null;
}

export interface ReturnLineRow {
  billNumber: string;
  businessDate: string;
  salespersonName: string;
  itemCode: string;
  itemName: string;
  /** Thousandths, positive: what came back. */
  qty: number;
  /** Positive: what the line gave back. */
  amount: number;
  reasonCode: string;
  condition: 'resellable' | 'defective';
  originalBillNumber: string | null;
}

export interface VoidsReturnsView extends ReportRange {
  money: ReportMoney;
  voids: VoidRow[];
  returns: ReturnLineRow[];
  voidsByReason: { reason: string; count: number }[];
  returnsByReason: { reason: string; count: number; amount: number }[];
  returnsByCondition: { condition: string; count: number; amount: number }[];
}

// ---- Stock and valuation (RPT-05) ----

export interface StockRow {
  itemId: string;
  itemCode: string;
  itemName: string;
  categoryName: string | null;
  locationCode: string;
  /** Thousandths. */
  qty: number;
  /** Null without cost.view, or when the item has no cost yet. */
  avgCost: number | null;
  value: number | null;
}

export interface StockView {
  money: ReportMoney;
  /** Whether values are shown (cost.view). */
  values: boolean;
  rows: StockRow[];
  /** More rows matched than were sent (the screen narrows the filter); the totals still count them all. */
  truncated: boolean;
  byLocation: { code: string; name: string; qty: number; value: number | null }[];
  byCategory: { name: string; qty: number; value: number | null }[];
  total: { qty: number; value: number | null };
  /** Items on hand with no cost yet: counted at 0 in the value, as posting does. */
  noCost: number;
}

// ---- Outstanding and ageing (RPT-06) ----

export interface AgeingPartyRow {
  partyId: string;
  code: string;
  name: string;
  termsDays: number | null;
  balance: number;
  notDue: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
}

export interface AgeingView {
  money: ReportMoney;
  side: 'customers' | 'suppliers';
  asOf: string;
  rows: AgeingPartyRow[];
  totals: Omit<AgeingPartyRow, 'partyId' | 'code' | 'name' | 'termsDays'>;
  /** The control account's balance at the date (Accounts receivable or payable), which the total equals. */
  controlBalance: number;
}

// ---- Exceptions (RPT-10) ----

export type ExceptionStatus = 'open' | 'reviewed' | 'dismissed';

export interface ExceptionRow {
  id: string;
  kind: string;
  severity: 'low' | 'medium' | 'high';
  businessDate: string;
  createdAt: string;
  deviceCode: string | null;
  userName: string | null;
  documentType: string | null;
  documentNumber: string | null;
  details: Record<string, unknown>;
  status: ExceptionStatus;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface ExceptionsView extends ReportRange {
  exceptions: ExceptionRow[];
  byKind: { kind: string; open: number; total: number }[];
}

export const ReviewExceptionRequest = z.strictObject({
  status: z.enum(['open', 'reviewed', 'dismissed']),
  note: z.string().trim().max(500).nullable(),
});
export type ReviewExceptionRequest = z.infer<typeof ReviewExceptionRequest>;

// ---- Trace a bill (PLT-12) ----

export type TraceSource = 'counter' | 'sync' | 'server' | 'desk' | 'books' | 'diagnostics';

export interface TraceStep {
  at: string;
  /** What happened, as an i18n key under `support.trace.steps` (e.g. `created`, `pushed`, `handed_over`). */
  step: string;
  source: TraceSource;
  /** The facts for the step's words: a number, a person, a device, an amount. */
  detail: Record<string, string | number | boolean | null>;
}

export interface BillTraceView {
  money: ReportMoney;
  bill: {
    id: string;
    number: string;
    kind: 'sale' | 'return' | 'exchange';
    status: 'finalized' | 'voided';
    businessDate: string;
    total: number;
    deviceCode: string;
    salespersonName: string;
    handoverStatus: string;
  };
  steps: TraceStep[];
}

// ---- Bill details (W2-10, D-125): one bill, read only, for anyone with reports.view ----

/** An approval on a bill or one of its lines (PLT-07). */
export interface BillApprovalView {
  kind: string;
  reason: string;
  approvedBy: string;
  at: string;
}

export interface BillLineView {
  lineNo: number;
  itemId: string;
  code: string;
  name: string;
  /** The location's code, e.g. SHOP. */
  location: string | null;
  /** Thousandths: below 0 for a returned line. */
  qty: number;
  allowsFraction: boolean;
  listPrice: number | null;
  unitPrice: number;
  /** List amount − amount: what the line price took off the list price. */
  lineDiscount: number;
  /** qty × unit price, signed: what the line came to before the bill discount. */
  amount: number;
  /** The line's share of the bill discount. */
  billShare: number;
  /** amount − bill share: the line's sales figure, as Sales and gross profit counts it. */
  lineTotal: number;
  approvals: BillApprovalView[];
  /** A returned line: why, in what condition, and the bill it came from (null: no receipt). */
  returned: { reason: string; condition: string; note: string | null; billNumber: string | null } | null;
  /** Only with cost.view: −its stock movements' value (cost corrections left out, D-124), and lineTotal − cost. */
  cost: number | null;
  profit: number | null;
  /** It left (or came back) with no cost known (no_cost). */
  noCost: boolean;
}

export interface BillPaymentView {
  method: string;
  name: string;
  amount: number;
  cashReceived: number | null;
  change: number | null;
  reference: string | null;
}

export interface BillView {
  money: ReportMoney;
  /** cost.view: cost, profit and margin are in the answer. */
  values: boolean;
  /** support.trace: the page links to Trace a bill. */
  canTrace: boolean;
  bill: {
    id: string;
    number: string;
    kind: 'sale' | 'return' | 'exchange';
    status: 'finalized' | 'voided';
    businessDate: string;
    /** On the counter's clock. */
    createdAt: string;
    device: string;
    priceTier: string;
    salesman: string;
    customer: { id: string; code: string; name: string } | null;
    walkinPhone: string | null;
  };
  /** The cash handover at the desk, or null when none (paid without cash, or not yet). */
  handover: {
    status: 'not_applicable' | 'pending' | 'received' | 'paid_out';
    number: string | null;
    desk: string | null;
    cashier: string | null;
    at: string | null;
  };
  /** Only for a voided bill. */
  void: {
    number: string | null;
    at: string | null;
    reason: string | null;
    approvedBy: string | null;
    reissue: string | null;
  } | null;
  lines: BillLineView[];
  totals: { lines: number; billDiscount: number; rounding: number; tax: number; total: number };
  /** The bill discount's approval, if it needed one. */
  billApprovals: BillApprovalView[];
  payments: BillPaymentView[];
  /** Only with cost.view. */
  cost: { cost: number; profit: number; marginBp: number | null; noCostLines: number } | null;
  related: {
    /** Returns made against this bill, in order. */
    returns: { number: string; date: string; status: 'finalized' | 'voided'; total: number }[];
    returnOf: string | null;
    reissueOf: string | null;
    /** Other approvals on the bill: a credit limit, a no-receipt return, a void, a reprint… */
    approvals: BillApprovalView[];
    journal: string | null;
  };
}

// ---- Send diagnostics (PLT-12) ----

export const DiagnosticEvent = z.strictObject({
  at: z.string().max(40),
  kind: z.string().max(80),
  detail: z.unknown(),
});

/** What a counter sends: who sent it (a manager, after their PIN), its health and its last 5,000 events. */
export const DiagnosticsUpload = z.strictObject({
  sentByUserId: z.uuid(),
  atDevice: z.iso.datetime(),
  health: z.record(z.string(), z.unknown()),
  events: z.array(DiagnosticEvent).max(5000),
});
export type DiagnosticsUpload = z.infer<typeof DiagnosticsUpload>;

export interface DiagnosticsRow {
  id: string;
  receivedAt: string;
  atDevice: string;
  sentByName: string;
  eventCount: number;
}
