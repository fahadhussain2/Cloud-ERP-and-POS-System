import type { PaymentMethodCode } from '@erp/domain';

import saleCases from '../golden/post-sale.json';
import { postSale } from './sale';
import { runGolden, type GoldenFile } from './testing/golden';
import type { LedgerState, PostingContext, PostingRole, PostingSale } from './types';

// Delux's accounts by code (posting rules §2), with Raast and bank transfer on HBL (owner answer 1 to W1-08).
const ROLES: Partial<Record<PostingRole, string>> = {
  CASH_IN_TRANSIT: '1120',
  SUSPENSE: '1190',
  AR_CONTROL: '1200',
  INVENTORY: '1300',
  TAX_PAYABLE: '2300',
  SALES: '4100',
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
  context?: {
    lockDate?: string;
    customer?: PostingContext['customer'];
    methods?: Partial<Record<PaymentMethodCode, string | null>>;
    withoutRoles?: PostingRole[];
  };
}

function contextOf(o: Input['context'] = {}): PostingContext {
  const roles = { ...ROLES };
  for (const r of o.withoutRoles ?? []) delete roles[r];
  return {
    accounts: { roles, methods: { ...METHODS, ...o.methods } },
    lockDate: o.lockDate ?? null,
    customer: o.customer ?? null,
  };
}

runGolden(saleCases as unknown as GoldenFile<Input>, (i) => postSale(i.sale, contextOf(i.context), i.state));
