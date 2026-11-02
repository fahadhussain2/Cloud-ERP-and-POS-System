import dayCases from '../golden/day-reconciliation.json';
import { money } from './money';
import { reconcileDay, type DayInput } from './reconciliation';
import { runGolden, type GoldenFile } from './testing/golden';

// The defaults every case starts from (the golden file's description).
const DAY: DayInput = {
  businessDate: '2026-11-02',
  dayEndsAt: '2026-11-02T23:00:00.000Z',
  now: '2026-11-03T05:00:00.000Z',
  handoverMode: 'required',
  devices: [],
  gaps: [],
  sessions: [],
  pendingBills: [],
  unmatched: [],
  exceptions: [],
  cashInTransit: money(0),
};

runGolden(dayCases as unknown as GoldenFile<Partial<DayInput>>, (i) => reconcileDay({ ...DAY, ...i }));
