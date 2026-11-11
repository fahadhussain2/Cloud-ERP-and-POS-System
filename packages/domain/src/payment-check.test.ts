import { describe, expect, it } from 'vitest';

import guardCases from '../golden/return-guard.json';
import voidOrReturnCases from '../golden/void-or-return.json';
import {
  answeredParts,
  paymentParts,
  returnWouldBeVoid,
  voidOrReturn,
  type BillPayment,
  type PaymentAnswer,
} from './payment-check';
import type { PaymentMethodCode } from './tender';
import { runGolden, type GoldenFile } from './testing/golden';

// Void or return, from where the bill's money is (W1-23, D-111), and guard 1 on a return of an unpaid bill.

type VoidOrReturnInput = {
  payments: BillPayment[];
  deskStatus: 'pending' | 'not_applicable' | 'received' | 'paid_out' | 'unknown';
  answers: Partial<Record<PaymentMethodCode, PaymentAnswer>>;
};

runGolden(voidOrReturnCases as unknown as GoldenFile<VoidOrReturnInput>, (i) => {
  const parts = paymentParts(i.payments, i.deskStatus);
  const checks = answeredParts(parts, i.answers);
  return { parts, checks, decision: checks === null ? null : voidOrReturn(checks) };
});

runGolden(guardCases as unknown as GoldenFile<Parameters<typeof returnWouldBeVoid>[0]>, returnWouldBeVoid);

describe('void or return', () => {
  it('voids when no part brings money in at all', () => {
    expect(voidOrReturn([])).toStrictEqual({ decision: 'void' });
  });
});
