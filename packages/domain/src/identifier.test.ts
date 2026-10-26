import identifierCases from '../golden/identifier.json';
import { normalizeIdentifier } from './identifier';
import { runGolden, type GoldenFile } from './testing/golden';

// One normalizer for the importer, the counter's search and the back office (CAT-02, W1-03).
runGolden(identifierCases as GoldenFile<string>, normalizeIdentifier);
