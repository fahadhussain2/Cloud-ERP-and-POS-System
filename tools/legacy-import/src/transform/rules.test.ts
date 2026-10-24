import account from '../../golden/transform/account.json';
import brand from '../../golden/transform/brand.json';
import identifier from '../../golden/transform/identifier.json';
import manufacture from '../../golden/transform/manufacture.json';
import mappingFile from '../../golden/transform/mapping.json';
import mask from '../../golden/transform/mask.json';
import model from '../../golden/transform/model.json';
import money from '../../golden/transform/money.json';
import oemInName from '../../golden/transform/oem-in-name.json';
import origin from '../../golden/transform/origin.json';
import partno from '../../golden/transform/partno.json';
import phones from '../../golden/transform/phones.json';
import text from '../../golden/transform/text.json';
import tierPrice from '../../golden/transform/tier-price.json';
import { runGolden, type GoldenFile } from '../testing/golden';
import { parseMapping } from './mapping';
import {
  classifyBrand,
  classifyManufacture,
  cleanText,
  isPartNumber,
  legacyMoney,
  mapLegacyAccount,
  maskPhone,
  normalizeIdentifier,
  oemNumbersInName,
  originName,
  parseModel,
  partyPhones,
  tierPrice as tierPriceOf,
} from './rules';

// Every legacy mapping rule (migration doc §3, D-085), on a fixed mapping so owner edits never break tests.
const m = parseMapping(mappingFile);
type Text = string | null;

runGolden(brand as GoldenFile<Text>, (v) => classifyBrand(v, m));
runGolden(origin as GoldenFile<Text>, (v) => originName(v, m));
runGolden(manufacture as GoldenFile<Text>, (v) => classifyManufacture(v, m));
runGolden(model as GoldenFile<Text>, (v) => parseModel(v, m));
runGolden(partno as GoldenFile<string>, isPartNumber);
runGolden(oemInName as GoldenFile<string>, oemNumbersInName);
runGolden(text as GoldenFile<Text>, cleanText);
runGolden(identifier as GoldenFile<string>, normalizeIdentifier);
runGolden(money as GoldenFile<string>, legacyMoney);
runGolden(tierPrice as GoldenFile<{ retail: number; bp: number }>, (i) => tierPriceOf(i.retail, i.bp));
runGolden(phones as GoldenFile<Text[]>, partyPhones);
runGolden(mask as GoldenFile<string>, maskPhone);
runGolden(account as GoldenFile<string>, (code) => mapLegacyAccount(code, m));
