import type { PaymentMethodCode } from '@erp/domain';
import { describe, expect, it } from 'vitest';

import returnCases from '../golden/post-return.json';
import { postSale } from './sale';
import { runGolden, type GoldenFile } from './testing/golden';
import type { LedgerState, PostingContext, PostingRole, PostingSale } from './types';

// A return or exchange is a sale document with negative lines (posting rules §4.2, §4.3, D-006, W1-13): returned
// lines debit SALES_RETURNS at their refund and come back into stock at the original line's cost (D-044); only the net
// settles, in one entry.

const ROLES: Partial<Record<PostingRole, string>> = {
  CASH_IN_TRANSIT: '1120',
  SUSPENSE: '1190',
  AR_CONTROL: '1200',
  INVENTORY: '1300',
  TAX_PAYABLE: '2300',
  SALES: '4100',
  SALES_RETURNS: '4110',
  SALES_DISCOUNT: '4120',
  ROUNDING: '4210',
  COGS: '5100',
};
const METHODS: Partial<Record<PaymentMethodCode, string | null>> = {
  cash: null,
  bank_transfer: '1160',
  raast: '1160',
  jazzcash: '1170',
  easypaisa: '1171',
  card: '1180',
  on_account: null,
};

interface Input {
  sale: PostingSale;
  state: LedgerState;
  context?: { customer?: PostingContext['customer'] };
}

const contextOf = (o: Input['context'] = {}): PostingContext => ({
  accounts: { roles: ROLES, methods: METHODS },
  lockDate: null,
  customer: o.customer ?? null,
});

const file = returnCases as unknown as GoldenFile<Input>;
runGolden(file, (i) => postSale(i.sale, contextOf(i.context), i.state));

describe('a return posts a balanced entry', () => {
  for (const c of file.cases)
    it(c.name, () => {
      const r = postSale(c.input.sale, contextOf(c.input.context), c.input.state);
      if (!r.ok) throw new Error(r.error.code);
      const debit = r.posting.journal.lines.reduce((s, l) => s + l.debit, 0);
      const credit = r.posting.journal.lines.reduce((s, l) => s + l.credit, 0);
      expect(debit).toBe(credit);
      // No SUSPENSE: every case adds up.
      expect(r.posting.journal.lines.some((l) => l.accountId === '1190')).toBe(false);
    });
});
