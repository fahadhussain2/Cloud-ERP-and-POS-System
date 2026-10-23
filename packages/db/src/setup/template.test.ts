import { validateChartOfAccounts } from '@erp/domain';
import { describe, expect, it } from 'vitest';

import retail from '../../templates/retail-coa.json';

// The retail chart-of-accounts template (posting rules §2) must pass the CoA rules on its own (D-083).
describe('retail chart-of-accounts template', () => {
  it('is a valid chart with every required system role', () => {
    expect(validateChartOfAccounts(retail.accounts)).toEqual([]);
  });

  it('keeps bank and wallet accounts out of the template: each tenant adds its own', () => {
    expect(retail.accounts.map((a) => a.name).filter((n) => /bank:|wallet:/i.test(n))).toEqual([]);
  });
});
