import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import mappingFile from '../../golden/transform/mapping.json';
import { parseMapping } from './mapping';

// The owner's mapping file (D-085): reviewed decisions, codes and catalog words only.
describe('the mapping file', () => {
  it('reads the real Delux mapping', () => {
    const real: unknown = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../mapping/delux.json'), 'utf8'),
    );
    expect(() => parseMapping(real)).not.toThrow();
  });

  it('upper-cases its keys, so lookups ignore case', () => {
    const m = parseMapping({ ...mappingFile, countryBrands: { 'made in uae': 'United Arab Emirates' } });
    expect(m.countryBrands.get('MADE IN UAE')).toBe('United Arab Emirates');
  });

  it('refuses a misspelt section or a tier that is not RETAIL, MECHANIC or WHOLESALE', () => {
    expect(() => parseMapping({ ...mappingFile, countryBrand: {} })).toThrow(/countryBrand/);
    expect(() => parseMapping({ ...mappingFile, partyTiers: { '0150': 'VIP' } })).toThrow(/partyTiers/);
  });
});
