import activityCases from '../golden/activity-kind.json';
import flowStatementCases from '../golden/cash-flow-statement.json';
import flowCases from '../golden/cash-flow-of.json';
import changedCases from '../golden/changed-fields.json';
import limitCases from '../golden/limit-state.json';
import overdueCases from '../golden/overdue.json';
import ledgerCases from '../golden/partner-ledger.json';
import voidCases from '../golden/statement-voids.json';
import trendCases from '../golden/trend-dates.json';
import {
  activityKind,
  cashFlowOf,
  cashFlowStatement,
  changedFields,
  limitState,
  overdueOf,
  partnerLedger,
  trendDates,
  withoutVoidedBills,
  type CashFlowEntry,
  type CashFlowPart,
  type LedgerEntry,
  type PartyRole,
  type VoidableEntry,
} from './partner-reports';
import type { AgeingEntry } from './reports';
import type { Period } from './statements';
import { runGolden, type GoldenFile } from './testing/golden';

// The customer, supplier and control reports' rules (W2-04 plan; RPT-16, RPT-17, ACC-07; D-116): pure, so the API,
// its CSV and the screens agree (rule 1).

runGolden(
  ledgerCases as unknown as GoldenFile<{ role: PartyRole; opening: number; entries: LedgerEntry[] }>,
  partnerLedger,
);
runGolden(voidCases as unknown as GoldenFile<VoidableEntry[]>, withoutVoidedBills);
runGolden(trendCases as unknown as GoldenFile<string>, trendDates);
runGolden(
  overdueCases as unknown as GoldenFile<{
    asOf: string;
    days: number;
    entries: Omit<AgeingEntry, 'partyId'>[];
  }>,
  overdueOf,
);
runGolden(limitCases as unknown as GoldenFile<{ balance: number; limit: number | null }>, limitState);
runGolden(activityCases as unknown as GoldenFile<{ entity: string; action: string }>, (i) =>
  activityKind(i.entity, i.action),
);
runGolden(
  changedCases as unknown as GoldenFile<{
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }>,
  (i) => changedFields(i.before, i.after),
);
runGolden(flowCases as unknown as GoldenFile<CashFlowEntry>, cashFlowOf);
runGolden(
  flowStatementCases as unknown as GoldenFile<{
    columns: Period[];
    opening: number;
    parts: (CashFlowPart & { date: string })[];
  }>,
  cashFlowStatement,
);
