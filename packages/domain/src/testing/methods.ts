import type { PaymentMethodInfo } from '../tender';

/** Delux's payment methods (infra/db/tenants/delux.json): every method with a bank account needs a reference. */
export const DELUX_METHODS: PaymentMethodInfo[] = [
  { code: 'cash', isCash: true, requiresReference: false },
  { code: 'bank_transfer', isCash: false, requiresReference: true },
  { code: 'raast', isCash: false, requiresReference: true },
  { code: 'jazzcash', isCash: false, requiresReference: true },
  { code: 'easypaisa', isCash: false, requiresReference: true },
  { code: 'card', isCash: false, requiresReference: true },
  { code: 'on_account', isCash: false, requiresReference: false },
];
