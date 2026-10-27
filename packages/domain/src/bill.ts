import { allocate } from './allocate';
import { DomainError } from './errors';
import { parseDecimal, toSafeNumber } from './exact';
import { money, mulQty, parseMoney, sub, sum, type Money } from './money';
import { can, effectiveLimits, type RoleGrant } from './permissions';
import { QTY_SCALE, type Qty } from './quantity';

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

const RANK: Readonly<Record<ApprovalKind, number>> = { below_list: 1, below_floor: 2 };
const rank = (need: ApprovalKind | null) => (need === null ? 0 : RANK[need]);

/** A list price of 0 counts as none (legacy items without a price). */
const hasList = (list: Money | null): list is Money => list !== null && list > 0;

const ZERO = money(0);
const MAX_QTY: number = MAX_LINE_QTY;

export const emptyBill = (sellerId: string, tierId: string): Bill => ({
  version: 1,
  sellerId,
  tierId,
  lines: [],
  billDiscount: ZERO,
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
  const { qty, list, net } = input;
  if (!hasList(list)) return { need: 'below_floor', discountBp: null };
  const listAmount = mulQty(qty, list);
  if (net >= listAmount) return { need: null, discountBp: 0 };
  // Rounded up, so "within the limit" (≤) means exactly that.
  const off = BigInt(listAmount - net) * 10_000n;
  const discountBp = Number((off + BigInt(listAmount) - 1n) / BigInt(listAmount));
  // Unknown floor: the list price is the floor (owner answer 1).
  if (net < mulQty(qty, input.floor ?? list)) return { need: 'below_floor', discountBp };
  if (discountBp > input.maxDiscountBp) return { need: 'below_list', discountBp };
  return { need: null, discountBp };
}

/** May someone with `grants` give this approval in `branchId`? The seller may approve themselves (owner answer 2). */
export function canApprove(
  grants: readonly RoleGrant[],
  branchId: string | null,
  need: ApprovalKind,
  discountBp: number | null,
): boolean {
  if (need === 'below_floor') return can(grants, 'pos.price.below_floor', branchId);
  // A below_list need always has a discount to measure; without one, nobody's limit can be shown to cover it.
  if (discountBp === null) return false;
  return (
    can(grants, 'pos.override.approve', branchId) &&
    effectiveLimits(grants, branchId).maxDiscountBp >= discountBp
  );
}

const lineAmount = (l: BillLine) => mulQty(l.qty, l.unitPrice);

export function billAmounts(bill: Bill): BillAmounts {
  const amounts = bill.lines.map(lineAmount);
  const shares = bill.billDiscount === 0 ? amounts.map(() => ZERO) : allocate(bill.billDiscount, amounts);
  const lines = bill.lines.map((l, i) => {
    const amount = amounts[i]!;
    const billShare = shares[i]!;
    return {
      id: l.id,
      listAmount: hasList(l.list) ? mulQty(l.qty, l.list) : amount,
      amount,
      billShare,
      net: sub(amount, billShare),
    };
  });
  const subtotal = sum(lines.map((l) => l.listAmount));
  const linesTotal = sum(amounts);
  return {
    lines,
    subtotal,
    lineDiscountTotal: sub(subtotal, linesTotal),
    billDiscount: bill.billDiscount,
    total: sub(linesTotal, bill.billDiscount),
  };
}

const lineCovered = (line: BillLine, need: ApprovalKind): boolean => {
  const a = line.approval;
  return (
    a !== null &&
    rank(a.kind) >= rank(need) &&
    a.values.list === line.list &&
    a.values.floor === line.floor &&
    line.unitPrice >= a.values.price
  );
};

const fingerprint = (lines: readonly BillLine[]) =>
  lines.map(({ id, qty, unitPrice }) => ({ id, qty, unitPrice }));

const sameLines = (approved: BillApprovalValues['lines'], lines: readonly BillLine[]): boolean =>
  approved.length === lines.length &&
  lines.every((l, i) => {
    const a = approved[i]!;
    return a.id === l.id && a.qty === l.qty && a.unitPrice === l.unitPrice;
  });

const billCovered = (bill: Bill, need: ApprovalKind): boolean => {
  const a = bill.billApproval;
  return (
    a !== null &&
    rank(a.kind) >= rank(need) &&
    bill.billDiscount <= a.values.billDiscount &&
    sameLines(a.values.lines, bill.lines)
  );
};

/** The approvals the bill still needs: lines first, in order, then the bill discount. */
export function pendingApprovals(bill: Bill, sellerMaxDiscountBp: number): PendingApproval[] {
  const amounts = billAmounts(bill);
  const pending: PendingApproval[] = [];
  let billNeed: ApprovalKind | null = null;
  let billBp = 0;
  bill.lines.forEach((line, i) => {
    const a = amounts.lines[i]!;
    const check = (net: Money) =>
      priceNeed({
        qty: line.qty,
        list: line.list,
        floor: line.floor,
        net,
        maxDiscountBp: sellerMaxDiscountBp,
      });
    // The line on its own price…
    const own = check(a.amount);
    if (own.need !== null && !lineCovered(line, own.need))
      pending.push({ target: { lineId: line.id }, need: own.need, discountBp: own.discountBp });
    // …then what its share of the bill discount adds. Below the floor has no depth; past the limit does. A line made
    // worse by the discount always has a list price, so its discount is a number.
    const shared = check(a.net);
    const worse =
      rank(shared.need) > rank(own.need) ||
      (shared.need === 'below_list' && own.need === 'below_list' && shared.discountBp! > own.discountBp!);
    if (worse) {
      if (rank(shared.need) > rank(billNeed)) billNeed = shared.need;
      billBp = Math.max(billBp, shared.discountBp!);
    }
  });
  if (billNeed !== null && !billCovered(bill, billNeed))
    pending.push({ target: 'bill', need: billNeed, discountBp: billBp });
  return pending;
}

function checkQty(q: number, allowsFraction: boolean): Qty {
  if (q <= 0 || q > MAX_QTY || (!allowsFraction && q % QTY_SCALE !== 0))
    throw new DomainError('invalid_quantity', `not a quantity this line can have: ${q}`);
  return q as Qty;
}

function checkPrice(price: Money): Money {
  if (price < 0) throw new DomainError('invalid_price', `a price can't be negative: ${price}`);
  return price;
}

function lineIndex(bill: Bill, lineId: string): number {
  const i = bill.lines.findIndex((l) => l.id === lineId);
  if (i < 0) throw new DomainError('unknown_line', `no line ${lineId} on this bill`);
  return i;
}

/**
 * Any change to the lines drops the bill-discount approval (the lines it covered changed), and a bill discount that
 * no longer fits under the lines goes back to 0.
 */
function withLines(bill: Bill, lines: BillLine[]): Bill {
  const next: Bill = { ...bill, lines, billApproval: null };
  return next.billDiscount > sum(lines.map(lineAmount)) ? { ...next, billDiscount: ZERO } : next;
}

const replaceLine = (bill: Bill, i: number, line: BillLine): Bill =>
  withLines(
    bill,
    bill.lines.map((l, j) => (j === i ? line : l)),
  );

/** Adds an item; it joins a line of the same item still at list without an approval. A typed price never merges. */
export function addLine(bill: Bill, item: NewLine, qty: Qty, lineId: string, unitPrice?: Money): Bill {
  checkQty(qty, item.allowsFraction);
  const added = (price: Money): Bill =>
    withLines(bill, [
      ...bill.lines,
      {
        id: lineId,
        itemId: item.itemId,
        qty,
        allowsFraction: item.allowsFraction,
        list: item.list,
        floor: item.floor,
        unitPrice: price,
        approval: null,
      },
    ]);
  if (unitPrice !== undefined) return added(checkPrice(unitPrice));
  const list = item.list;
  if (!hasList(list)) throw new DomainError('price_required', `item ${item.itemId} has no price: type one`);
  const i = bill.lines.findIndex(
    (l) => l.itemId === item.itemId && l.list === list && l.unitPrice === list && l.approval === null,
  );
  if (i < 0) return added(list);
  const line = bill.lines[i]!;
  return replaceLine(bill, i, { ...line, qty: checkQty(line.qty + qty, line.allowsFraction) });
}

export function setQty(bill: Bill, lineId: string, qty: Qty): Bill {
  const i = lineIndex(bill, lineId);
  const line = bill.lines[i]!;
  return replaceLine(bill, i, { ...line, qty: checkQty(qty, line.allowsFraction) });
}

/** A new price keeps the line's approval only while it is at or above the approved price and still below list. */
export function setUnitPrice(bill: Bill, lineId: string, price: Money): Bill {
  const i = lineIndex(bill, lineId);
  const line = bill.lines[i]!;
  const a = line.approval;
  const keeps = a !== null && price >= a.values.price && !(hasList(line.list) && price >= line.list);
  return replaceLine(bill, i, { ...line, unitPrice: checkPrice(price), approval: keeps ? a : null });
}

export function removeLine(bill: Bill, lineId: string): Bill {
  const i = lineIndex(bill, lineId);
  return withLines(
    bill,
    bill.lines.filter((_, j) => j !== i),
  );
}

/**
 * Moves the bill to another tier; `prices` gives each item's list price there (missing or null = none). Lines at list
 * take the new price; bargained lines keep theirs. A line whose list price changes loses its approval.
 */
export function changeTier(bill: Bill, tierId: string, prices: Readonly<Record<string, Money | null>>): Bill {
  const lines = bill.lines.map((line) => {
    const list = prices[line.itemId] ?? null;
    const atList = line.unitPrice === line.list;
    return {
      ...line,
      list,
      unitPrice: atList && list !== null ? list : line.unitPrice,
      approval: list === line.list ? line.approval : null,
    };
  });
  return withLines({ ...bill, tierId }, lines);
}

/** A bill discount keeps its approval only while it is at or below the approved one. */
export function setBillDiscount(bill: Bill, amount: Money): Bill {
  if (amount < 0) throw new DomainError('invalid_discount', `a discount can't be negative: ${amount}`);
  const linesTotal = sum(bill.lines.map(lineAmount));
  if (amount > linesTotal)
    throw new DomainError(
      'discount_too_large',
      `a discount of ${amount} is more than the lines (${linesTotal})`,
    );
  const a = bill.billApproval;
  return {
    ...bill,
    billDiscount: amount,
    billApproval: a !== null && amount <= a.values.billDiscount ? a : null,
  };
}

/** Records an approval for what `target` needs now. Who may approve is checked by the caller (`canApprove`). */
export function approve(
  bill: Bill,
  target: ApprovalTarget,
  sellerMaxDiscountBp: number,
  by: ApprovedBy,
): Bill {
  if (by.reason === 'other' && (by.note === null || by.note.trim() === ''))
    throw new DomainError('note_required', 'the reason "other" needs a note');
  const i = target === 'bill' ? -1 : lineIndex(bill, target.lineId);
  const pending = pendingApprovals(bill, sellerMaxDiscountBp).find((p) =>
    target === 'bill' ? p.target === 'bill' : p.target !== 'bill' && p.target.lineId === target.lineId,
  );
  if (pending === undefined) throw new DomainError('nothing_to_approve', 'this needs no approval');
  const base = { kind: pending.need, requestedBy: bill.sellerId, ...by };
  if (i < 0)
    return {
      ...bill,
      billApproval: { ...base, values: { billDiscount: bill.billDiscount, lines: fingerprint(bill.lines) } },
    };
  return {
    ...bill,
    lines: bill.lines.map((l, j) =>
      j === i
        ? { ...l, approval: { ...base, values: { list: l.list, floor: l.floor, price: l.unitPrice } } }
        : l,
    ),
  };
}

/** A typed price in whole major units (D-056): "1,450" → 145000 with 2 minor units. */
export function parseWholeAmount(text: string, minorUnits: number): Money {
  const amount = parseMoney(text, minorUnits);
  if (amount < 0) throw new DomainError('negative_amount', `"${text}" is negative`);
  if (amount % parseMoney('1', minorUnits) !== 0)
    throw new DomainError('too_many_decimals', `"${text}" isn't a whole amount`);
  return amount;
}

/** A typed bill discount: an amount, or a percent of `base` rounded down to whole major units ("5%"). */
export function parseDiscount(text: string, base: Money, minorUnits: number): Money {
  const t = text.trim();
  if (!t.endsWith('%')) return parseWholeAmount(t, minorUnits);
  const bp = parseDecimal(t.slice(0, -1), 2);
  if (bp < 0n) throw new DomainError('negative_amount', `"${text}" is negative`);
  if (bp > 10_000n) throw new DomainError('invalid_discount', `"${text}" is more than 100%`);
  const unit = BigInt(parseMoney('1', minorUnits));
  return toSafeNumber(((BigInt(base) * bp) / (10_000n * unit)) * unit) as Money;
}
