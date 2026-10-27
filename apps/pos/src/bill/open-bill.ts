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

export interface OpenBill {
  version: 1;
  bill: Bill;
  /** By item id. */
  items: Record<string, LineItem>;
}
