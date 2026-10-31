import type { Money, Qty } from '@erp/domain';

import averageCases from '../golden/average.json';
import { averageAfterReceipt } from './cost';
import { runGolden, type GoldenFile } from './testing/golden';
import type { CostState } from './types';

runGolden(
  averageCases as unknown as GoldenFile<{ state: CostState; receipt: { qty: Qty; netUnitCost: Money } }>,
  (i) => averageAfterReceipt(i.state, i.receipt),
);
