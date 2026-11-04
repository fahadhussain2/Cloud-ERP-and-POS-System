import closingStockCases from '../../golden/transform/closing-stock.json';
import lastPurchaseCases from '../../golden/transform/last-purchases.json';
import legacyQtyCases from '../../golden/transform/legacy-qty.json';
import openingCostCases from '../../golden/transform/opening-cost.json';
import partyBalanceCases from '../../golden/transform/party-balances.json';
import stockRecordCases from '../../golden/transform/stock-records.json';
import { runGolden, type GoldenFile } from '../testing/golden';
import {
  closingStock,
  lastPurchases,
  latestStockRecords,
  legacyQty,
  openingCost,
  partyBalances,
  type ClosingStockInput,
  type LastPurchasesInput,
  type OpeningCostInput,
  type PartyBalancesInput,
  type StockRecordsInput,
} from './opening';

// The legacy side of the opening balances (migration doc §4, §5, W1-14): pure rules on staged rows (text, as staged),
// so every judgement call is a case that can't regress. The importer reads the dump; Claude reads only reports
// (rule 11).

runGolden(legacyQtyCases as GoldenFile<string>, legacyQty);
runGolden(closingStockCases as GoldenFile<ClosingStockInput>, closingStock);
runGolden(stockRecordCases as GoldenFile<StockRecordsInput>, latestStockRecords);
runGolden(openingCostCases as GoldenFile<OpeningCostInput>, openingCost);
runGolden(partyBalanceCases as GoldenFile<PartyBalancesInput>, partyBalances);
runGolden(lastPurchaseCases as GoldenFile<LastPurchasesInput>, lastPurchases);
