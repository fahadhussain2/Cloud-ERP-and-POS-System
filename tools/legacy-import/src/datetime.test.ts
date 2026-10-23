import cases from '../golden/datetime.json';
import { binaryDateTime } from './datetime';
import { runGolden, type GoldenFile } from './testing/golden';

runGolden(cases as GoldenFile<string>, binaryDateTime);
