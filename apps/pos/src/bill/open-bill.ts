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
