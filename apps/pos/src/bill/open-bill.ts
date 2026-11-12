import type { Bill } from '@erp/domain';

// The bill a person is building on this counter (POS spec §10): the domain bill, plus what the screen shows for each
// item as it was when added. Saved after every change (local `open_bills`, one per person), never pushed.

/** What a line shows: the item as it was when added, so a later pull doesn't change an open bill. */
export interface LineItem {
  code: string;
  name: string;
  variant: string | null;
  spec: string | null;
}

/** Who the bill is for, as the customer dialog picked them (POS spec §15). */
export interface BillCustomer {
  id: string;
  code: string;
  name: string;
}

export interface OpenBill {
  version: 1;
  bill: Bill;
  /** By item id. */
  items: Record<string, LineItem>;
  /** A customer's bill (W1-09); absent or null = a walk-in. Bills saved before W1-09 have neither field. */
  customer?: BillCustomer | null;
  /** A walk-in's phone as typed, only without a customer. */
  walkinPhone?: string | null;
  /** The voided bill this one reissues (POS spec §18, W1-12); absent or null on every other bill. */
  reissueOf?: { id: string; number: string } | null;
}

/** A stored open bill, or null for one this version doesn't know (another version, or not JSON at all). */
export function parseOpenBill(stored: string): OpenBill | null {
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  const b = value as Partial<OpenBill> | null;
  return b?.version === 1 && b.bill?.version === 1 && typeof b.items === 'object' ? (b as OpenBill) : null;
}
