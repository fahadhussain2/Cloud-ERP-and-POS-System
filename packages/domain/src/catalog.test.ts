import catalogCodeCases from '../golden/catalog-codes.json';
import itemProblemCases from '../golden/item-problems.json';
import priceChangeCases from '../golden/price-change.json';
import tierProposalCases from '../golden/tier-proposal.json';
import {
  catalogCodeProblems,
  itemProblems,
  priceChange,
  proposeTierPrices,
  type CatalogCodesInput,
  type ItemInput,
  type PriceChangeInput,
} from './catalog';
import { money } from './money';
import { runGolden, type GoldenFile } from './testing/golden';

// Catalog maintenance in the back office (W1-15, CAT-01…CAT-05, CAT-07): what the API checks before it saves, and
// the back office before it sends.

runGolden(itemProblemCases as GoldenFile<ItemInput>, itemProblems);
runGolden(catalogCodeCases as GoldenFile<CatalogCodesInput>, catalogCodeProblems);
runGolden(priceChangeCases as GoldenFile<PriceChangeInput>, priceChange);
runGolden(tierProposalCases as GoldenFile<number>, (retail) => proposeTierPrices(money(retail)));
