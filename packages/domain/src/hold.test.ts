import expiryCases from '../golden/held-expiry.json';
import holdCases from '../golden/hold.json';
import { checkHold, heldExpired } from './hold';
import { BRANCH, grantsOf } from './testing/counter';
import { runGolden, type GoldenFile } from './testing/golden';

// Holding a bill and when a held bill expires (POS-08, POS spec §17, W1-12).

interface HoldCase {
  userId: string;
  lineCount: number;
  heldCount: number;
  label?: string | null;
}

runGolden(holdCases as unknown as GoldenFile<HoldCase>, (i) =>
  checkHold({
    grants: grantsOf(i.userId),
    branchId: BRANCH,
    lineCount: i.lineCount,
    heldCount: i.heldCount,
    label: i.label ?? null,
  }),
);

runGolden(expiryCases as unknown as GoldenFile<{ heldBusinessDate: string; now: string }>, (i) =>
  heldExpired({
    heldBusinessDate: i.heldBusinessDate,
    nowMs: Date.parse(i.now),
    timeZone: 'Asia/Karachi',
    cutoffHour: 4,
  }),
);
