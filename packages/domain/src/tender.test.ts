import quickCashCases from '../golden/quick-cash.json';
import settleCases from '../golden/tender-settle.json';
import tenderCases from '../golden/tender.json';
import { money } from './money';
import { checkTender, quickCash, settleTender, type Tender } from './tender';
import { runGolden, type GoldenFile } from './testing/golden';
import { DELUX_METHODS } from './testing/methods';

interface TenderInput {
  total: number;
  increment?: number;
  hasCreditCustomer?: boolean;
  tender: Tender;
}

// Tenders go in as they are: the JSON amounts are already whole minor units.
const input = (i: TenderInput) => ({
  total: money(i.total),
  increment: money(i.increment ?? 100),
  methods: DELUX_METHODS,
  tender: i.tender,
  hasCreditCustomer: i.hasCreditCustomer ?? false,
});

runGolden(tenderCases as unknown as GoldenFile<TenderInput>, (i) => checkTender(input(i)));

runGolden(settleCases as unknown as GoldenFile<TenderInput>, (i) => settleTender(input(i)));

runGolden(quickCashCases as GoldenFile<{ total: number; unit: number }>, (i) =>
  quickCash(money(i.total), money(i.unit)),
);
