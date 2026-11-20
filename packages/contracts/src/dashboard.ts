import type { ReportMoney } from './reports';

// The owner's dashboard (W2-06 plan; RPT-18; D-118): one view for the whole screen, read at one moment. Every figure is
// its report's, from the same query. Money is integer minor units, quantities integer thousandths, shares basis points
// (CLAUDE.md rule 1). Cost, profit, margin and stock value are null for someone without cost.view.

export const DASHBOARD_PERIOD_VIEWS = ['today', '7d', '30d'] as const;
export type DashboardPeriodView = (typeof DASHBOARD_PERIOD_VIEWS)[number];

export interface DashboardChipView {
  amount: number;
  /** Of the earlier figure's size; null when it was 0. */
  bp: number | null;
  direction: 'up' | 'down' | 'flat';
  /** Green when true, red when false; null when unchanged. */
  good: boolean | null;
}

export interface DashboardCountView {
  count: number;
  amount: number;
  /** The same in the comparison. */
  usualCount: number;
  usualAmount: number;
  /** How many times the comparison, in tenths, when unusual (owner answer 3); else null. */
  times: number | null;
}

export interface DashboardAttentionView {
  kind: 'exceptions' | 'negativeStock' | 'counterUnseen' | 'atMinimum' | 'overLimit' | 'openSessions';
  tone: 'bad' | 'warn' | 'info';
  count: number;
  name: string | null;
  minutes: number | null;
}

export interface DashboardView {
  money: ReportMoney;
  values: boolean;
  period: DashboardPeriodView;
  /** The business date, and when the figures were read (ISO). */
  today: string;
  readAt: string;
  /** When the first cash session of the business day was opened (ISO), if one was. */
  dayOpenedAt: string | null;
  current: { from: string; to: string };
  comparison: { from: string; to: string };
  /** Today only: the comparison day counts up to this minute of its business day. */
  upToMinute: number | null;
  /** The comparison reaches before the first business day: "before go-live". */
  beforeGoLive: boolean;

  netSales: {
    now: number;
    before: number;
    chip: DashboardChipView;
    bills: number;
    /** Net sales ÷ bills; null with no bills. */
    average: number | null;
  };
  grossProfit: {
    now: number | null;
    before: number | null;
    chip: DashboardChipView | null;
    marginBp: number | null;
    beforeMarginBp: number | null;
  };
  /** The drawers, the safe and cash in transit, in the books (owner answer 1). */
  cash: {
    now: number;
    atDayStart: number;
    chip: DashboardChipView;
    drawers: number;
    safe: number;
    inTransit: number;
    openSessions: number;
  };
  /** Bank and wallet accounts in the books; card money not yet in the bank apart (owner answer 1). */
  bank: {
    now: number;
    atDayStart: number;
    chip: DashboardChipView;
    accounts: { id: string; name: string; kind: 'bank' | 'wallet'; balance: number }[];
    cardClearing: number;
  };
  customersOwe: {
    now: number;
    /** 30 days ago. */
    before: number;
    chip: DashboardChipView;
    customers: number;
    receivedToday: number;
  };

  /** By hour (Today) or by day; `now` is null where the period hasn't reached yet. */
  trend: { step: 'hour' | 'day'; points: { label: string; now: number | null; before: number }[] };
  attention: DashboardAttentionView[];
  /** Bills by weekday (Monday first) and hour over the last 4 weeks: divide by 4 for an average. */
  busyHours: { weeks: number; bills: number[][]; hours: { first: number; last: number } | null };
  topCategories: { rows: { id: string | null; name: string; sales: number }[]; rest: number; total: number };
  leak: {
    discounts: DashboardCountView;
    belowList: DashboardCountView & { byOwner: number };
    returns: DashboardCountView & { topReason: string | null };
    voids: DashboardCountView & { reissued: number };
  };
  /** This month to date (owner answer 4); null without cost.view. */
  donut: {
    from: string;
    to: string;
    grossProfit: number;
    loss: boolean;
    net: number;
    base: number;
    keptBp: number | null;
    slices: { kind: 'net' | 'expense' | 'other'; name: string | null; amount: number; bp: number }[];
  } | null;
  owe: {
    total: number;
    count: number;
    top: { id: string; name: string; amount: number }[];
    rest: { count: number; amount: number };
  };
  suppliers: { total: number; overdue: number; dueIn7Days: number };
  stock: {
    value: number | null;
    atMinimum: number;
    negative: number;
    dead: { count: number; value: number | null };
  };
  bestItems: { id: string; code: string; name: string; qty: number; sales: number }[];
  salesmen: { id: string; name: string; bills: number; sales: number }[];
}
