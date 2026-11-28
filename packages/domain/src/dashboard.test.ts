import attentionCases from '../golden/dashboard-attention.json';
import balanceCases from '../golden/dashboard-balances.json';
import chipCases from '../golden/dashboard-chip.json';
import donutCases from '../golden/dashboard-donut.json';
import unusualCases from '../golden/dashboard-unusual.json';
import windowCases from '../golden/dashboard-windows.json';
import minuteCases from '../golden/business-minute.json';
import {
  attentionList,
  biggestBalances,
  businessMinute,
  chipOf,
  dashboardWindows,
  gpDonut,
  unusualTimes,
  type AttentionInput,
  type Balance,
  type DashboardPeriod,
} from './dashboard';
import { runGolden, type GoldenFile } from './testing/golden';

// The owner's dashboard rules (W2-06 plan; RPT-18; D-118): pure, so the API, the screen and the tests agree (rule 1).

runGolden(
  windowCases as unknown as GoldenFile<{
    period: DashboardPeriod;
    today: string;
    minute: number;
    firstDay: string | null;
  }>,
  dashboardWindows,
);
runGolden(minuteCases as unknown as GoldenFile<{ hour: number; minute: number; cutoffHour: number }>, (i) =>
  businessMinute(i.hour, i.minute, i.cutoffHour),
);
runGolden(chipCases as unknown as GoldenFile<{ now: number; before: number; goodWhenUp: boolean }>, chipOf);
runGolden(unusualCases as unknown as GoldenFile<{ count: number; usual: number }>, (i) =>
  unusualTimes(i.count, i.usual),
);
runGolden(
  donutCases as unknown as GoldenFile<{ grossProfit: number; expenses: { name: string; amount: number }[] }>,
  gpDonut,
);
runGolden(balanceCases as unknown as GoldenFile<{ n: number; balances: Balance[] }>, (i) =>
  biggestBalances(i.balances, i.n),
);
runGolden(attentionCases as unknown as GoldenFile<AttentionInput>, attentionList);
