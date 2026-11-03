import { describe, expect, it } from 'vitest';

import reissueCases from '../golden/reissue.json';
import { pendingApprovals } from './bill';
import { reissueBill } from './reissue';
import type { SaleDocument } from './sale-document';
import { runGolden, type GoldenFile } from './testing/golden';

// The open bill a reissue starts from (POS-11, PRD W5, POS spec §18, owner answer 3 to W1-12): the voided bill's tier,
// lines and prices, with its price approvals, for the person reissuing it.

interface Case {
  document: SaleDocument;
  sellerId: string;
  /** Whether each item's unit allows fractions, from the local catalog (the document doesn't carry it). */
  allowsFraction: Record<string, boolean>;
  /** The new lines' ids, in line order. */
  lineIds: string[];
}

const file = reissueCases as unknown as GoldenFile<Case>;
runGolden(file, (i) => reissueBill(i));

describe('a reissue as it was', () => {
  for (const c of file.cases.filter((c) => c.error === undefined))
    it(`needs no new approval while nothing changes: ${c.name}`, () => {
      expect(pendingApprovals(reissueBill(c.input), 10_000)).toStrictEqual([]);
    });
});
