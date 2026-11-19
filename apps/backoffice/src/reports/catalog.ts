import { href, type Route } from '../router';

// The Reports home's list (W2-01 plan, owner answer 1; D-116): every report in sections, each with who may open it
// and the screens it owns. The menu's Reports row opens the home; the screen search (Ctrl K) still finds each report by
// name; and a report's own permission decides whether its screen opens. Later tasks (W2-02 to W2-04) add their reports
// here.

export type ReportSection = 'accounts' | 'sales' | 'stock' | 'parties' | 'cash' | 'support';

export const REPORT_SECTIONS: readonly ReportSection[] = [
  'accounts',
  'sales',
  'stock',
  'parties',
  'cash',
  'support',
];

export interface ReportEntry {
  /** Its name is `nav.<key>`, its line on the home `reports.home.about.<key>`. */
  key:
    | 'trialBalance'
    | 'profitLoss'
    | 'balanceSheet'
    | 'accountLedger'
    | 'cashBook'
    | 'dayBook'
    | 'expensesReport'
    | 'salesRegister'
    | 'salesProfit'
    | 'purchaseRegister'
    | 'rates'
    | 'salesOverTime'
    | 'overridesReport'
    | 'voidsReturns'
    | 'stockReport'
    | 'stockAt'
    | 'stockMovement'
    | 'stockLedger'
    | 'reorder'
    | 'deadStock'
    | 'inventoryAnalysis'
    | 'ageing'
    | 'dayReconciliation'
    | 'cashVariance'
    | 'exceptions'
    | 'trace';
  section: ReportSection;
  href: string;
  /** Any of these permissions opens it. */
  needs: readonly string[];
  /** The screens it owns: none for a report that opens another module's screen (the account ledger). */
  screens: readonly Route['screen'][];
}

const FINANCIAL = ['reports.financial'];
const VIEW = ['reports.view'];

export const REPORTS: readonly ReportEntry[] = [
  {
    key: 'trialBalance',
    section: 'accounts',
    href: href.trialBalance,
    needs: FINANCIAL,
    screens: ['trialBalance'],
  },
  {
    key: 'profitLoss',
    section: 'accounts',
    href: href.profitLoss,
    needs: FINANCIAL,
    screens: ['profitLoss'],
  },
  {
    key: 'balanceSheet',
    section: 'accounts',
    href: href.balanceSheet,
    needs: FINANCIAL,
    screens: ['balanceSheet'],
  },
  // The ledger opens from an account on Accounts (W1-19), where it stays in the menu.
  { key: 'accountLedger', section: 'accounts', href: href.accounts, needs: FINANCIAL, screens: [] },
  { key: 'cashBook', section: 'accounts', href: href.cashBook, needs: FINANCIAL, screens: ['cashBook'] },
  { key: 'dayBook', section: 'accounts', href: href.dayBook, needs: FINANCIAL, screens: ['dayBook'] },
  {
    key: 'expensesReport',
    section: 'accounts',
    href: href.expensesReport,
    needs: FINANCIAL,
    screens: ['expensesReport'],
  },
  {
    key: 'salesRegister',
    section: 'sales',
    href: href.salesRegister,
    needs: VIEW,
    screens: ['salesRegister'],
  },
  // The sales and purchase analysis (W2-03): what the shop uses today first, sales over time last.
  { key: 'salesProfit', section: 'sales', href: href.salesProfit, needs: VIEW, screens: ['salesProfit'] },
  {
    key: 'purchaseRegister',
    section: 'sales',
    href: href.purchaseRegister,
    needs: VIEW,
    screens: ['purchaseRegister'],
  },
  { key: 'rates', section: 'sales', href: href.rates, needs: VIEW, screens: ['rates'] },
  {
    key: 'salesOverTime',
    section: 'sales',
    href: href.salesOverTime,
    needs: VIEW,
    screens: ['salesOverTime'],
  },
  {
    key: 'overridesReport',
    section: 'sales',
    href: href.overridesReport,
    needs: VIEW,
    screens: ['overridesReport'],
  },
  { key: 'voidsReturns', section: 'sales', href: href.voidsReturns, needs: VIEW, screens: ['voidsReturns'] },
  { key: 'stockReport', section: 'stock', href: href.stockReport, needs: VIEW, screens: ['stockReport'] },
  // The stock reports (W2-02): the ones the shop uses today first, the analysis last.
  { key: 'stockLedger', section: 'stock', href: href.stockLedger, needs: VIEW, screens: ['stockLedger'] },
  { key: 'stockAt', section: 'stock', href: href.stockAt, needs: VIEW, screens: ['stockAt'] },
  {
    key: 'stockMovement',
    section: 'stock',
    href: href.stockMovement,
    needs: VIEW,
    screens: ['stockMovement'],
  },
  { key: 'reorder', section: 'stock', href: href.reorder, needs: VIEW, screens: ['reorder'] },
  { key: 'deadStock', section: 'stock', href: href.deadStock, needs: VIEW, screens: ['deadStock'] },
  {
    key: 'inventoryAnalysis',
    section: 'stock',
    href: href.inventoryAnalysis,
    needs: VIEW,
    screens: ['inventoryAnalysis'],
  },
  { key: 'ageing', section: 'parties', href: href.ageing, needs: VIEW, screens: ['ageing'] },
  {
    key: 'dayReconciliation',
    section: 'cash',
    href: href.dayReconciliation,
    needs: VIEW,
    screens: ['dayReconciliation'],
  },
  { key: 'cashVariance', section: 'cash', href: href.cashVariance, needs: VIEW, screens: ['cashVariance'] },
  { key: 'exceptions', section: 'support', href: href.exceptions, needs: VIEW, screens: ['exceptions'] },
  { key: 'trace', section: 'support', href: href.trace(), needs: ['support.trace'], screens: ['trace'] },
];

export const mayOpen = (r: ReportEntry, permissions: readonly string[]) =>
  r.needs.some((p) => permissions.includes(p));

/** The report that owns a screen, if any. */
export const reportOf = (screen: Route['screen']): ReportEntry | undefined =>
  REPORTS.find((r) => r.screens.includes(screen));

/** Everyone who may open any report, and every screen a report owns: the Reports row of the menu. */
export const ANY_REPORT: readonly string[] = [...new Set(REPORTS.flatMap((r) => r.needs))];
export const REPORT_SCREENS: readonly Route['screen'][] = [
  'reportsHome',
  ...REPORTS.flatMap((r) => r.screens),
];
