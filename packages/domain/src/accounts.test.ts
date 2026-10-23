import { describe, expect, it } from 'vitest';

import coaCases from '../golden/coa-rules.json';
import {
  REQUIRED_SYSTEM_ROLES,
  SYSTEM_ROLES,
  validateChartOfAccounts,
  type ChartAccount,
  type SystemRole,
} from './accounts';
import { runGolden, type GoldenFile } from './testing/golden';

runGolden(coaCases as GoldenFile<{ required: SystemRole[]; accounts: ChartAccount[] }>, (i) =>
  validateChartOfAccounts(i.accounts, i.required),
);

describe('system roles', () => {
  it('require every role the posting rules use; the tax roles are optional in the MVP', () => {
    expect(REQUIRED_SYSTEM_ROLES).not.toContain('TAX_RECOVERABLE');
    for (const role of REQUIRED_SYSTEM_ROLES) expect(SYSTEM_ROLES).toContain(role);
    expect(REQUIRED_SYSTEM_ROLES).toEqual(
      expect.arrayContaining([
        'CASH_DRAWER',
        'CASH_IN_TRANSIT',
        'AR_CONTROL',
        'AP_CONTROL',
        'INVENTORY',
        'COGS',
        'SALES',
        'ROUNDING',
      ]),
    );
  });

  it('check the full required list by default', () => {
    const problems = validateChartOfAccounts([]);
    expect(problems).toHaveLength(REQUIRED_SYSTEM_ROLES.length);
  });
});
