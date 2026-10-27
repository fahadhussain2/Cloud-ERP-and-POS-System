import type { Money } from './money';
import { can, type RoleGrant } from './permissions';
import type { Qty } from './quantity';

// The bill being built on the counter (POS spec §10, POS-04, PLT-07, D-004): lines, amounts, the bill discount, which
// prices need an approval and who may give it. The counter computes with these; the server re-checks synced bills with
// the same functions (W1-07) and records exceptions, never rejecting (D-011). Every edit returns a new bill.

/** Approval reasons (owner answer 3 to W1-05); the labels are i18n keys `override.reason.<code>`. */
export const OVERRIDE_REASONS = [
  'customer_bargain',
  'old_stock',
  'market_price',
  'regular_customer',
  'other',
] as const;
export type OverrideReason = (typeof OVERRIDE_REASONS)[number];

/** The override kinds a price can need (data model §5). */
export type ApprovalKind = 'below_list' | 'below_floor';

/** At most 9,999 of anything on one line. */
export const MAX_LINE_QTY = 9_999_000 as Qty;

export interface Approval<V> {
  kind: ApprovalKind;
  requestedBy: string;
  approvedBy: string;
  reason: OverrideReason;
  /** Required for `other`. */
  note: string | null;
  /** ISO time from the counter's clock, passed in. */
  at: string;
  /** What was approved, so a later change can tell whether it still holds. */
  values: V;
}

export interface LineApprovalValues {
  list: Money | null;
  floor: Money | null;
  price: Money;
}

export interface BillApprovalValues {
  billDiscount: Money;
  lines: { id: string; qty: Qty; unitPrice: Money }[];
}

export interface BillLine {
  id: string;
  itemId: string;
  qty: Qty;
  allowsFraction: boolean;
  /** The bill tier's price when added (the default tier's if none there); null when the item has no price. */
  list: Money | null;
  /** The item's floor when added; null = unknown, and then the list price is the floor (owner answer 1). */
  floor: Money | null;
  unitPrice: Money;
  approval: Approval<LineApprovalValues> | null;
}

export interface Bill {
  version: 1;
  sellerId: string;
  tierId: string;
  lines: BillLine[];
  billDiscount: Money;
  billApproval: Approval<BillApprovalValues> | null;
}

/** An item as it is added: its price in the bill's tier and its floor. */
export interface NewLine {
  itemId: string;
  list: Money | null;
  floor: Money | null;
  allowsFraction: boolean;
}

export interface PriceCheck {
  need: ApprovalKind | null;
  /** The discount below list in basis points, rounded up; null when there is no list price. */
  discountBp: number | null;
}

export interface LineAmounts {
  id: string;
  /** Quantity × list price (the amount itself when there is no list price). */
  listAmount: Money;
  /** Quantity × unit price. */
  amount: Money;
  /** This line's share of the bill discount. */
  billShare: Money;
  net: Money;
}

export interface BillAmounts {
  lines: LineAmounts[];
  subtotal: Money;
  /** List amounts − amounts; negative when lines are above list. */
  lineDiscountTotal: Money;
  billDiscount: Money;
  total: Money;
}

export type ApprovalTarget = { lineId: string } | 'bill';

export interface PendingApproval {
  target: ApprovalTarget;
  need: ApprovalKind;
  discountBp: number | null;
}

export interface ApprovedBy {
  approvedBy: string;
  reason: OverrideReason;
  note: string | null;
  at: string;
}

const notBuilt = (...args: unknown[]): never => {
  throw new Error(`not built yet (W1-05): ${args.length} arguments`);
};

export const emptyBill = (sellerId: string, tierId: string): Bill => ({
  version: 1,
  sellerId,
  tierId,
  lines: [],
  billDiscount: 0 as Money,
  billApproval: null,
});

/** What a line's price needs, given its net amount after its share of the bill discount (POS spec §10). */
export function priceNeed(input: {
  qty: Qty;
  list: Money | null;
  floor: Money | null;
  net: Money;
  maxDiscountBp: number;
}): PriceCheck {
  return notBuilt(input);
}

/** May someone with `grants` give this approval in `branchId`? The seller may approve themselves (owner answer 2). */
export function canApprove(
  grants: readonly RoleGrant[],
  branchId: string | null,
  need: ApprovalKind,
  discountBp: number | null,
): boolean {
  return notBuilt(can, grants, branchId, need, discountBp);
}

export function billAmounts(bill: Bill): BillAmounts {
  return notBuilt(bill);
}

/** The approvals the bill still needs: lines first, in order, then the bill discount. */
export function pendingApprovals(bill: Bill, sellerMaxDiscountBp: number): PendingApproval[] {
  return notBuilt(bill, sellerMaxDiscountBp);
}

/** Adds an item; it joins a line of the same item still at list without an approval. A typed price never merges. */
export function addLine(bill: Bill, item: NewLine, qty: Qty, lineId: string, unitPrice?: Money): Bill {
  return notBuilt(bill, item, qty, lineId, unitPrice);
}

export function setQty(bill: Bill, lineId: string, qty: Qty): Bill {
  return notBuilt(bill, lineId, qty);
}

export function setUnitPrice(bill: Bill, lineId: string, price: Money): Bill {
  return notBuilt(bill, lineId, price);
}

export function removeLine(bill: Bill, lineId: string): Bill {
  return notBuilt(bill, lineId);
}

/** Moves the bill to another tier; `prices` gives each item's list price there (null = none). */
export function changeTier(bill: Bill, tierId: string, prices: Readonly<Record<string, Money | null>>): Bill {
  return notBuilt(bill, tierId, prices);
}

export function setBillDiscount(bill: Bill, amount: Money): Bill {
  return notBuilt(bill, amount);
}

/** Records an approval for what `target` needs now. */
export function approve(
  bill: Bill,
  target: ApprovalTarget,
  sellerMaxDiscountBp: number,
  by: ApprovedBy,
): Bill {
  return notBuilt(bill, target, sellerMaxDiscountBp, by);
}

/** A typed price in whole major units (D-056): "1,450" → 145000 with 2 minor units. */
export function parseWholeAmount(text: string, minorUnits: number): Money {
  return notBuilt(text, minorUnits);
}

/** A typed bill discount: an amount, or a percent of `base` rounded down to whole major units ("5%"). */
export function parseDiscount(text: string, base: Money, minorUnits: number): Money {
  return notBuilt(text, base, minorUnits);
}
