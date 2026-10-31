import type { SaleDocument } from '@erp/domain';
import type { MoneyFormat } from '@erp/ui';

import type { PrintProfile } from '../db/checkout';

// What a printed bill needs besides the document itself (POS spec §13): the document carries ids, the paper shows
// names. Made by the counter screen at finalize and at reprint.

export interface PrintJob {
  document: SaleDocument;
  /** null before the first pull: the A5 layout, one copy. */
  profile: PrintProfile | null;
  shopName: string;
  /** The branch's header lines, then the profile's. */
  headerLines: string[];
  /** Code and name of each item on the bill, by item id. */
  items: Record<string, { code: string; name: string }>;
  sellerName: string;
  /** The customer's code and name (POS spec §15); null for a walk-in. Never their balance or phone. */
  customer: { code: string; name: string } | null;
  /** Payment methods as the tenant names them, by code. */
  methodNames: Record<string, string>;
  money: MoneyFormat;
  timeZone: string;
  /** A reprint carries a band with when and who (owner answer 3 to W1-06). */
  reprint: { at: string; by: string } | null;
}
