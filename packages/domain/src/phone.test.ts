import phoneCases from '../golden/phone.json';
import { normalizePhone } from './phone';
import { runGolden, type GoldenFile } from './testing/golden';

runGolden(phoneCases as GoldenFile<string>, (text) => normalizePhone(text));
