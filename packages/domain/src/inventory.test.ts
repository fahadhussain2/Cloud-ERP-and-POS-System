import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import approvalCases from '../golden/adjustment-approval.json';
import adjustmentCases from '../golden/adjustment-check.json';
import transferCases from '../golden/transfer-check.json';
import receiptCases from '../golden/transfer-receipt-check.json';
import {
  ADJUSTMENT_REASONS,
  adjustmentApproval,
  checkAdjustment,
  checkTransfer,
  checkTransferReceipt,
  type AdjustmentApprovalInput,
  type AdjustmentCheckInput,
  type TransferCheckInput,
  type TransferReceiptInput,
} from './inventory';
import { runGolden, type GoldenFile } from './testing/golden';

// Stock operations in the back office (W1-18; INV-04, INV-05; owner answers 1–4): a transfer's checks, what arrives
// of a sent one, an adjustment's checks, and when a loss waits for the owner.

runGolden(transferCases as unknown as GoldenFile<TransferCheckInput>, checkTransfer);
runGolden(receiptCases as unknown as GoldenFile<TransferReceiptInput>, checkTransferReceipt);
runGolden(adjustmentCases as unknown as GoldenFile<AdjustmentCheckInput>, checkAdjustment);
runGolden(approvalCases as unknown as GoldenFile<AdjustmentApprovalInput>, adjustmentApproval);

describe('stock operation properties', () => {
  it('the reasons are the owner’s list (owner answer 1)', () => {
    expect(ADJUSTMENT_REASONS).toEqual([
      'found',
      'lost',
      'damaged',
      'theft',
      'count_correction',
      'write_off',
      'other',
    ]);
  });

  it('what arrived and the shortfall always add up to what was sent', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 0, max: 1000 })), {
          minLength: 1,
          maxLength: 8,
        }),
        (pairs) => {
          const lines = pairs.map(([sent, permille]) => ({
            sent,
            received: Math.floor((sent * permille) / 1000),
            allowsFraction: true,
          }));
          const { problems, shortfall } = checkTransferReceipt({ lines });
          expect(problems).toEqual([]);
          lines.forEach((l, row) => {
            const short = shortfall.find((s) => s.row === row)?.qty ?? 0;
            expect(l.received + short).toBe(l.sent);
          });
        },
      ),
    );
  });

  it('a gain never waits, and the owner never waits', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: -1_000_000, max: 1_000_000 }),
            avgCost: fc.option(fc.integer({ min: 0, max: 10_000_000 })),
          }),
          { maxLength: 6 },
        ),
        fc.integer({ min: 0, max: 100_000_000 }),
        (lines, limit) => {
          expect(adjustmentApproval({ canApprove: true, limit, lines }).needsApproval).toBe(false);
          const gains = lines.map((l) => ({ ...l, qty: Math.abs(l.qty) }));
          expect(adjustmentApproval({ canApprove: false, limit, lines: gains }).needsApproval).toBe(false);
        },
      ),
    );
  });
});
