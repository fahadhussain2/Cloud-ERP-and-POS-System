import { describe, expect, it } from 'vitest';

import cases from '../golden/bill-header.json';
import { billHeaderLines, type BillHeaderSource } from './bill-header';

// The header under the shop name (W1-25): one rule for the counter, the cash desk and the back office's preview.
describe(cases.description, () => {
  for (const c of cases.cases as { name: string; input: BillHeaderSource; expected: string[] }[]) {
    it(c.name, () => {
      expect(billHeaderLines(c.input)).toStrictEqual(c.expected);
    });
  }
});
