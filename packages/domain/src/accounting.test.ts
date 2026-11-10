import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import fiscalYearCases from '../golden/fiscal-year.json';
import voucherCases from '../golden/journal-voucher-check.json';
import effectCases from '../golden/voucher-line-effect.json';
import lockCases from '../golden/lock-move.json';
import moneyCases from '../golden/money-document-check.json';
import {
  KEPT_ROLES,
  checkJournalVoucher,
  checkLockMove,
  checkMoneyDocument,
  fiscalYearOf,
  isDateLocked,
  lineEffect,
  monthEnd,
  type LineEffectInput,
  type LockMoveInput,
  type MoneyDocumentInput,
  type VoucherCheckInput,
} from './accounting';
import { DomainError } from './errors';
import { runGolden, type GoldenFile } from './testing/golden';

// Back-office accounting (W1-19; ACC-04, ACC-05, ACC-06; owner answers 1–6; D-108): the checks of a receipt, an
// expense, a transfer and a journal voucher, the fiscal calendar and moving the lock date.

runGolden(moneyCases as unknown as GoldenFile<MoneyDocumentInput>, checkMoneyDocument);
runGolden(voucherCases as unknown as GoldenFile<VoucherCheckInput>, checkJournalVoucher);
runGolden(fiscalYearCases as unknown as GoldenFile<{ date: string; startMonth: number }>, (i) =>
  fiscalYearOf(i.date, i.startMonth),
);
runGolden(lockCases as unknown as GoldenFile<LockMoveInput>, checkLockMove);
runGolden(effectCases as unknown as GoldenFile<LineEffectInput>, (i) =>
  lineEffect(i.account, i.debit, i.credit),
);

const day = fc
  .date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2099-12-31T00:00:00Z'), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10));

describe('the lock date', () => {
  // A back-office document dated on or before it can't post (D-108); the screens grey out Post with it.
  it('locks a date on or before it, and nothing when there is none', () => {
    expect(isDateLocked('2026-10-31', '2026-10-31')).toBe(true);
    expect(isDateLocked('2026-06-15', '2026-10-31')).toBe(true);
    expect(isDateLocked('2026-11-01', '2026-10-31')).toBe(false);
    expect(isDateLocked('2026-06-15', null)).toBe(false);
    expect(isDateLocked('', '2026-10-31')).toBe(false);
  });
});

describe('accounting properties', () => {
  it('a month end needs a real date', () => {
    expect(monthEnd('2028-02-10')).toBe('2028-02-29');
    expect(() => monthEnd('2027-02-30')).toThrow(DomainError);
  });

  it('the accounts a voucher can never touch (D-108)', () => {
    expect(KEPT_ROLES).toEqual(['INVENTORY', 'CASH_DRAWER', 'CASH_IN_TRANSIT']);
  });

  it('a fiscal year holds its date, and its twelve months follow each other without a gap', () => {
    fc.assert(
      fc.property(day, fc.integer({ min: 1, max: 12 }), (date, startMonth) => {
        const y = fiscalYearOf(date, startMonth);
        expect(y.start <= date && date <= y.end).toBe(true);
        expect(y.months).toHaveLength(12);
        expect(y.months[0]!.start).toBe(y.start);
        expect(y.months[11]!.end).toBe(y.end);
        for (const [i, m] of y.months.entries()) {
          expect(m.end).toBe(monthEnd(m.start));
          if (i > 0) {
            const next = new Date(`${y.months[i - 1]!.end}T00:00:00Z`);
            next.setUTCDate(next.getUTCDate() + 1);
            expect(m.start).toBe(next.toISOString().slice(0, 10));
          }
        }
      }),
    );
  });

  it('a balanced voucher of valid lines has no problems, and swapping its sides keeps it so', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000_000 }), { minLength: 1, maxLength: 6 }),
        (amounts) => {
          const total = amounts.reduce((s, a) => s + a, 0);
          const lines = [
            ...amounts.map((a) => ({ accountId: 'a', partyId: null, debit: a, credit: 0 })),
            { accountId: 'b', partyId: null, debit: 0, credit: total },
          ];
          const input = (ls: typeof lines): VoucherCheckInput => ({
            date: '2027-01-10',
            today: '2027-01-10',
            lockDate: null,
            narration: 'n',
            lines: ls,
            accounts: {
              a: { postable: true, active: true, role: null },
              b: { postable: true, active: true, role: null },
            },
            parties: {},
          });
          expect(checkJournalVoucher(input(lines))).toEqual({ problems: [], debit: total, credit: total });
          const swapped = lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
          expect(checkJournalVoucher(input(swapped)).problems).toEqual([]);
        },
      ),
    );
  });
});
