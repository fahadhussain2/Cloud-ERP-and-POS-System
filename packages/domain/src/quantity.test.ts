import parseQtyCases from '../golden/parse-qty.json';
import { parseQty } from './quantity';
import { runGolden, type GoldenFile } from './testing/golden';

runGolden(parseQtyCases as GoldenFile<{ text: string }>, (i) => parseQty(i.text));
