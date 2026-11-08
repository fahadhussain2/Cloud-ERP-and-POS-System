import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { money, type SystemRole } from '@erp/domain';

import receiptCases from '../golden/post-customer-receipt.json';
import expenseCases from '../golden/post-expense.json';
import transferCases from '../golden/post-fund-transfer.json';
import voucherCases from '../golden/post-journal-voucher.json';
import reversalCases from '../golden/post-reversal.json';
import {
  postCustomerReceipt,
  postExpense,
  postFundTransfer,
  postJournalVoucher,
  postReversal,
} from './accounting';
import { runGolden, type GoldenFile } from './testing/golden';
import type {
  Posting,
  PostingContext,
  PostingCustomerReceipt,
  PostingExpense,
  PostingFundTransfer,
  PostingJournalVoucher,
  PostingReversal,
} from './types';

// Back-office accounting in the books (posting rules §6; W1-19; D-108): a customer receipt by bank, an expense from a
// bank or the safe, a transfer with its charges, a journal voucher, and the reversal of any of them.

const ROLES: Partial<Record<SystemRole, string>> = {
  AR_CONTROL: '1200',
  AP_CONTROL: '2100',
  CASH_SAFE: '1130',
  SUSPENSE: '1190',
  ROUNDING: '4210',
};
const context = (lockDate: string | null = null, unmapped: SystemRole | null = null): PostingContext => ({
  accounts: {
    roles: Object.fromEntries(Object.entries(ROLES).filter(([r]) => r !== unmapped)),
    methods: {},
    targets: {
      'bank-hbl': '1160',
      'bank-soneri': '1150',
      'bank-card': '1180',
      'cat-utilities': '6210',
      'cat-bank-charges': '6310',
    },
  },
  lockDate,
  customer: null,
});

type Opts = { lockDate?: string; unmapped?: SystemRole };
runGolden(receiptCases as unknown as GoldenFile<{ receipt: PostingCustomerReceipt } & Opts>, (i) =>
  postCustomerReceipt(i.receipt, context(i.lockDate ?? null, i.unmapped ?? null)),
);
runGolden(expenseCases as unknown as GoldenFile<{ expense: PostingExpense } & Opts>, (i) =>
  postExpense(i.expense, context(i.lockDate ?? null, i.unmapped ?? null)),
);
runGolden(transferCases as unknown as GoldenFile<{ transfer: PostingFundTransfer } & Opts>, (i) =>
  postFundTransfer(i.transfer, context(i.lockDate ?? null, i.unmapped ?? null)),
);
runGolden(voucherCases as unknown as GoldenFile<{ voucher: PostingJournalVoucher } & Opts>, (i) =>
  postJournalVoucher(i.voucher, context(i.lockDate ?? null, i.unmapped ?? null)),
);
runGolden(
  reversalCases as unknown as GoldenFile<{ reversal: PostingReversal; original: Posting } & Opts>,
  (i) => postReversal(i.reversal, i.original, context(i.lockDate ?? null)),
);

const balanced = (p: Posting) => {
  const dr = p.journal.lines.reduce((s, l) => s + l.debit, 0);
  const cr = p.journal.lines.reduce((s, l) => s + l.credit, 0);
  return dr === cr;
};

describe('accounting posting properties', () => {
  it('a transfer always balances, and the source goes down by the whole amount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 1000 }),
        (amount, permille) => {
          const charges = Math.min(amount - 1, Math.floor((amount * permille) / 1000));
          const r = postFundTransfer(
            {
              id: 'ft',
              number: 'FT000001',
              branchId: 'b',
              businessDate: '2027-01-10',
              from: 'bank-card',
              to: 'bank-hbl',
              amount: money(amount),
              charges: money(charges),
              chargesCategoryId: charges > 0 ? 'cat-bank-charges' : null,
            },
            context(),
          );
          if (!r.ok) throw new Error(r.error.code);
          expect(balanced(r.posting)).toBe(true);
          expect(r.posting.journal.lines.find((l) => l.accountId === '1180')?.credit).toBe(amount);
        },
      ),
    );
  });

  it('a reversal nets its original to nothing, line by line and party by party', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), (amount) => {
        const original = postCustomerReceipt(
          {
            id: 'cr',
            number: 'CR000001',
            branchId: 'b',
            businessDate: '2027-01-10',
            customerId: 'c',
            amount: money(amount),
            bankAccountId: 'bank-hbl',
          },
          context(),
        );
        if (!original.ok) throw new Error(original.error.code);
        const r = postReversal(
          {
            id: 'jv',
            number: 'JV000001',
            branchId: 'b',
            businessDate: '2027-01-11',
            originalNumber: 'CR000001',
          },
          original.posting,
          context(),
        );
        if (!r.ok) throw new Error(r.error.code);
        const net = new Map<string, number>();
        for (const l of [...original.posting.journal.lines, ...r.posting.journal.lines])
          net.set(l.accountId, (net.get(l.accountId) ?? 0) + l.debit - l.credit);
        expect([...net.values()].every((v) => v === 0)).toBe(true);
        const owed = [...original.posting.partyEntries, ...r.posting.partyEntries].reduce(
          (s, e) => s + e.amount,
          0,
        );
        expect(owed).toBe(0);
      }),
    );
  });
});
