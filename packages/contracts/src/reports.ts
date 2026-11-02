// The cash reports the back office reads (CSH-08, RPT-02, W1-11): the day reconciliation of one branch and business
// date, and the cash variance by session over a date range. Amounts are whole minor units (CLAUDE.md rule 1). The
// day reconciliation is what `reconcileDay` in `@erp/domain` returns.

/** How the tenant writes money: the reports' amounts are in its minor units. */
export interface ReportMoney {
  locale: string;
  currency: string;
  minorUnits: number;
}

export type CashMovementKindName = 'expense' | 'supplier_payment' | 'bank_deposit' | 'to_safe' | 'from_safe';

export type DayHoldResponse =
  | { kind: 'day_not_over'; dayEndsAt: string }
  | { kind: 'device_not_heard'; deviceCode: string; lastContactAt: string | null }
  | { kind: 'device_unsynced'; deviceCode: string; oldestUnsyncedAt: string }
  | { kind: 'sequence_gap'; deviceCode: string; family: string; fromSeq: number; toSeq: number }
  | { kind: 'session_open'; number: string; deviceCode: string; cashierName: string };

/** `open` while the session runs; `not_counted` for a close without a count (W1-10); `waiting` for a manager. */
export type AcknowledgementStatus = 'open' | 'not_counted' | 'exact' | 'waiting' | 'acknowledged';

export interface DaySessionResponse {
  id: string;
  number: string;
  deviceCode: string;
  cashierName: string;
  status: 'open' | 'closed';
  openingFloat: number;
  handedIn: number;
  paidOut: number;
  cashCollections: number;
  cashOuts: Record<CashMovementKindName, number>;
  expected: number;
  deskExpected: number | null;
  expectedDiffers: boolean;
  counted: number | null;
  variance: number | null;
  varianceReason: string | null;
  acknowledgement: AcknowledgementStatus;
  acknowledgedByName: string | null;
}

export interface DayReconciliationResponse {
  money: ReportMoney;
  branchId: string;
  businessDate: string;
  status: 'final' | 'provisional';
  holds: DayHoldResponse[];
  sessions: DaySessionResponse[];
  /** null when handover confirmation is Off. */
  missingHandovers:
    | {
        sellerId: string;
        sellerName: string | null;
        bills: { number: string; createdAt: string; kind: 'in' | 'payout'; amount: number }[];
        toCollect: number;
        toPayOut: number;
      }[]
    | null;
  unmatchedScans: {
    number: string;
    billNumber: string;
    kind: 'in' | 'payout';
    amount: number;
    createdAt: string;
  }[];
  exceptions: { kind: string; severity: 'low' | 'medium' | 'high'; count: number }[];
  cashInTransit: number;
  totalVariance: number;
}

export interface CashVarianceRow {
  sessionId: string;
  number: string;
  deviceCode: string;
  cashierName: string;
  businessDate: string;
  expected: number | null;
  counted: number | null;
  variance: number | null;
  varianceReason: string | null;
  varianceNote: string | null;
  acknowledgement: AcknowledgementStatus;
  acknowledgedByName: string | null;
}

export interface CashVarianceResponse {
  money: ReportMoney;
  from: string;
  to: string;
  sessions: CashVarianceRow[];
  /** Per cashier, by name: the sum of their counted sessions' variances. */
  byCashier: { cashierName: string; sessions: number; variance: number }[];
}
