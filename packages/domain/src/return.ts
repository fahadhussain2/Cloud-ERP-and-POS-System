import {
  billAmounts,
  pendingApprovals,
  RETURN_APPROVAL_REASONS,
  RETURN_CONDITIONS,
  RETURN_REASONS,
  type Bill,
  type BillReturn,
  type BillReturnLine,
  type ReturnApproval,
  type ReturnApprovalKind,
  type ReturnApprovalReason,
  type ReturnCondition,
  type ReturnReason,
  type ReturnSource,
} from './bill';
import { businessDate } from './business-date';
import { onAccountAmount, type CreditApproval, type CreditView } from './credit';
import { MAX_NOTE_LENGTH } from './desk-text';
import { DomainError } from './errors';
import { divRound, toSafeNumber } from './exact';
import { money, mulQty, negate, sub, sum, type Money } from './money';
import { can, type Permission, type RoleGrant } from './permissions';
import { QTY_SCALE, qty, type Qty } from './quantity';
import {
  creditBlock,
  creditOverridesOf,
  documentNumber,
  priceOverridesOf,
  saleTotal,
  soldLinesOf,
  walkinPhoneOf,
  type SaleContext,
  type SaleCustomer,
  type SaleDocumentCredit,
  type SaleDocumentLine,
  type SaleDocumentOverride,
} from './sale-document';
import { settleTender, type PaymentMethodInfo, type SettledPayment, type Tender } from './tender';

// Returns and exchanges (POS-12, PRD W6 and W7, D-005, D-006, D-044, D-051, POS spec §19, W1-13): how much of a sold
// line may come back and for how much, what a return needs an approver for, the price suggested without a receipt,
// the returned lines on the open bill, the finalized document (SaleDocumentV2) and the server's review of it. The
// counter decides with these; the server re-checks with the same functions and flags, never refuses (rule 7, D-011).

export {
  RETURN_APPROVAL_REASONS,
  RETURN_CONDITIONS,
  RETURN_REASONS,
  type BillReturn,
  type BillReturnLine,
  type ReturnApproval,
  type ReturnApprovalKind,
  type ReturnApprovalReason,
  type ReturnCondition,
  type ReturnReason,
  type ReturnSource,
};

/** A line of an original bill as sold: its quantity (above 0) and what the customer paid for it. */
export interface OriginalLine {
  lineNo: number;
  itemId: string;
  qty: Qty;
  /** After the line's share of the bill discount: what was paid. */
  lineTotal: Money;
}

/** What earlier returns took from one original line, as positive figures. */
export interface Returned {
  qty: Qty;
  refund: Money;
}

const NOTHING: Returned = { qty: qty(0), refund: money(0) };

/** The returned lines of one original line (negative quantities and line totals), as what they took. */
export function returnedOf(lines: readonly { qty: Qty; lineTotal: Money }[]): Returned {
  return {
    qty: qty(0 - lines.reduce((s, l) => s + l.qty, 0)),
    refund: negate(sum(lines.map((l) => l.lineTotal))),
  };
}

/** What is left to return of a line, and what it is worth. */
export function returnable(line: OriginalLine, returned: Returned): { qty: Qty; value: Money } {
  return { qty: qty(line.qty - returned.qty), value: sub(line.lineTotal, returned.refund) };
}

/**
 * The refund for `k` of what is left: the value left × k / the quantity left, half away from zero, and exactly the
 * value left for all of it, so a line returned in parts adds up to what was paid (PRD W6 step 4).
 */
export function refundFor(line: OriginalLine, returned: Returned, k: Qty): Money {
  if (k <= 0) throw new DomainError('invalid_quantity', `nothing to return: ${k}`);
  const left = returnable(line, returned);
  if (k > left.qty)
    throw new DomainError('return_over_quantity', `only ${left.qty} of line ${line.lineNo} can come back`);
  if (k === left.qty) return left.value;
  return toSafeNumber(divRound(BigInt(left.value) * BigInt(k), BigInt(left.qty))) as Money;
}

/** An item's category return policy (data model §2 `categories.return_policy`); missing keys take the tenant's. */
export interface ItemPolicy {
  returnable?: boolean;
  windowDays?: number;
}

export interface ReturnCheck {
  /** In this order: return_permission, return_outside_policy, no_receipt_return. */
  needs: ReturnApprovalKind[];
  /** Business days from the original's to today's; null without a receipt. */
  daysSince: number | null;
  outsideWindow: boolean;
  nonReturnable: boolean;
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from one `YYYY-MM-DD` to another. */
function daysBetween(from: string, to: string): number {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to))
    throw new DomainError('invalid_date', `not a business date: "${from}" or "${to}"`);
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** What a return needs before it can be finalized (PRD W6 steps 5–7, D-005, D-051, PRD Q3). */
export function returnNeeds(input: {
  sellerGrants: readonly RoleGrant[];
  branchId: string;
  /** The original bill; null without a receipt. */
  original: { businessDate: string } | null;
  /** Today's business date. */
  today: string;
  /** The tenant's window (`return_window_days`, Delux 30). */
  windowDays: number;
  /** The policy of each returned item's category. */
  items: readonly ItemPolicy[];
}): ReturnCheck {
  const daysSince = input.original === null ? null : daysBetween(input.original.businessDate, input.today);
  const outsideWindow =
    daysSince !== null && input.items.some((p) => daysSince > (p.windowDays ?? input.windowDays));
  const nonReturnable = input.items.some((p) => p.returnable === false);
  const needs: ReturnApprovalKind[] = [];
  if (!can(input.sellerGrants, 'pos.return.create', input.branchId)) needs.push('return_permission');
  if (outsideWindow || nonReturnable) needs.push('return_outside_policy');
  if (input.original === null) needs.push('no_receipt_return');
  return { needs, daysSince, outsideWindow, nonReturnable };
}

const PERMISSION_FOR: Readonly<Record<ReturnApprovalKind, Permission>> = {
  return_permission: 'pos.return.create',
  return_outside_policy: 'pos.return.outside_policy',
  no_receipt_return: 'pos.return.no_receipt',
  refund_transfer: 'pos.override.approve',
};

/** May someone with `grants` approve every one of `kinds` in this branch? The seller may approve themselves. */
export function canApproveReturn(
  grants: readonly RoleGrant[],
  branchId: string,
  kinds: readonly ReturnApprovalKind[],
): boolean {
  return kinds.every((k) => can(grants, PERMISSION_FOR[k], branchId));
}

/** A line of the branch's bills, for the price suggested without a receipt. */
export interface PricedLine {
  itemId: string;
  businessDate: string;
  /** Below 0 for a returned line. */
  qty: Qty;
  lineTotal: Money;
  voided: boolean;
}

/** How far back the suggestion looks: today and the 89 days before it (SYN-01's 90 days). */
const PRICE_DAYS = 90;

/**
 * The refund per unit suggested for a return without a receipt (PRD W6 step 5, D-005): the lowest net unit price the
 * item sold for in the last 90 days, else `fallback` (the default tier's current price), else null.
 */
export function lowestPrice90(input: {
  itemId: string;
  today: string;
  sales: readonly PricedLine[];
  fallback: Money | null;
}): Money | null {
  let lowest: Money | null = null;
  for (const s of input.sales) {
    if (s.itemId !== input.itemId || s.voided || s.qty <= 0) continue;
    const days = daysBetween(s.businessDate, input.today);
    if (days < 0 || days >= PRICE_DAYS) continue;
    const unit = toSafeNumber(divRound(BigInt(s.lineTotal) * BigInt(QTY_SCALE), BigInt(s.qty))) as Money;
    if (lowest === null || unit < lowest) lowest = unit;
  }
  return lowest ?? input.fallback;
}

/** Who approved a return or a refund by transfer, on the same screen (PLT-07). */
export interface ReturnApprovalBy {
  approvedBy: string;
  reason: ReturnApprovalReason;
  note: string | null;
  at: string;
}

/** A line the salesman marks to come back. */
export interface ReturnLineInput {
  id: string;
  itemId: string;
  qty: Qty;
  allowsFraction: boolean;
  reason: ReturnReason;
  note: string | null;
  condition: ReturnCondition;
  /** From a bill: its line as sold and what earlier returns took; null without a receipt. */
  original: { line: OriginalLine; returned: Returned } | null;
  /** Without a receipt: the refund per unit the approver set. */
  price: Money | null;
  /** Without a receipt: what the counter suggested. */
  suggested: Money | null;
}

const MAX_QTY = 9_999_000;

function checkNote(reason: string, note: string | null): string | null {
  const text = note?.trim() ?? '';
  if (reason === 'other' && text === '')
    throw new DomainError('note_required', 'the reason "other" needs a note');
  if (text.length > MAX_NOTE_LENGTH)
    throw new DomainError('note_too_long', `a note is at most ${MAX_NOTE_LENGTH} characters`);
  return text === '' ? null : text;
}

function checkApproval(by: ReturnApprovalBy): string | null {
  if (!(RETURN_APPROVAL_REASONS as readonly string[]).includes(by.reason))
    throw new DomainError('invalid_reason', `not an approval reason: ${by.reason}`);
  return checkNote(by.reason, by.note);
}

/**
 * Puts the returned lines on an empty open bill (POS spec §19). From one bill each line's refund is `refundFor`'s;
 * without a receipt it is qty × the approver's price. `needs` is `returnNeeds`' answer: an approval must cover it, and
 * whether the approver may give it is checked by the caller (`canApproveReturn`). The lines can't be edited after:
 * `removeReturn` takes them all off again.
 */
export function addReturn(
  bill: Bill,
  input: {
    source: ReturnSource;
    lines: readonly ReturnLineInput[];
    needs: readonly ReturnApprovalKind[];
    approval: ReturnApprovalBy | null;
  },
): Bill {
  if (bill.lines.length > 0 || (bill.returns ?? null) !== null)
    throw new DomainError('bill_not_empty', 'a return starts on an empty bill: hold this one first');
  if (input.lines.length === 0) throw new DomainError('empty_return', 'nothing marked to come back');
  const seen = new Set<number>();
  const lines = input.lines.map((l): BillReturnLine => {
    if (l.qty <= 0 || l.qty > MAX_QTY || (!l.allowsFraction && l.qty % QTY_SCALE !== 0))
      throw new DomainError('invalid_quantity', `not a quantity this line can have: ${l.qty}`);
    if (!(RETURN_REASONS as readonly string[]).includes(l.reason))
      throw new DomainError('invalid_reason', `not a return reason: ${l.reason}`);
    if (!(RETURN_CONDITIONS as readonly string[]).includes(l.condition))
      throw new DomainError('invalid_condition', `not a condition: ${l.condition}`);
    const note = checkNote(l.reason, l.note);
    const base = {
      id: l.id,
      itemId: l.itemId,
      qty: l.qty,
      allowsFraction: l.allowsFraction,
      reason: l.reason,
      note,
      condition: l.condition,
    };
    if (input.source.kind === 'bill') {
      if (l.original === null)
        throw new DomainError('original_required', 'a line from a bill needs its original line');
      const o = l.original.line;
      if (o.itemId !== l.itemId) throw new DomainError('other_item', `line ${o.lineNo} is another item`);
      if (seen.has(o.lineNo)) throw new DomainError('duplicate_line', `line ${o.lineNo} is marked twice`);
      seen.add(o.lineNo);
      const refund = refundFor(o, l.original.returned, l.qty);
      return {
        ...base,
        originalLineNo: o.lineNo,
        refund,
        unitPrice: perUnit(refund, l.qty),
        suggested: null,
      };
    }
    if (l.price === null || l.price < 0)
      throw new DomainError('price_required', 'a return without a receipt needs a price');
    return {
      ...base,
      originalLineNo: null,
      refund: mulQty(l.qty, l.price),
      unitPrice: l.price,
      suggested: l.suggested,
    };
  });
  let approval: ReturnApproval | null = null;
  if (input.needs.length > 0) {
    if (input.approval === null)
      throw new DomainError(
        'return_approval_pending',
        `this return needs an approval: ${input.needs.join(', ')}`,
      );
    const note = checkApproval(input.approval);
    approval = { kinds: [...input.needs], requestedBy: bill.sellerId, ...input.approval, note };
  }
  return { ...bill, returns: { source: input.source, lines, approval } };
}

/** Takes the returned lines off the bill again. */
export const removeReturn = (bill: Bill): Bill => ({ ...bill, returns: null });

const perUnit = (refund: Money, q: Qty): Money =>
  toSafeNumber(divRound(BigInt(refund) * BigInt(QTY_SCALE), BigInt(q))) as Money;

/** A returned line as the document carries it (sync spec §6.1, `SaleDocumentV2`). */
export interface ReturnDocumentLine {
  lineNo: number;
  itemId: string;
  /** Below 0. */
  qty: Qty;
  listPrice: null;
  floorPrice: null;
  /** The refund per unit. */
  unitPrice: Money;
  lineDiscount: Money;
  billShare: Money;
  /** −refund. */
  lineTotal: Money;
  returnOf: { documentId: string; number: string; lineNo: number } | null;
  reason: ReturnReason;
  condition: ReturnCondition;
  note: string | null;
}

/** A return's approval, or a refund by transfer's, as an override (lineNo always null). */
export interface ReturnOverride {
  kind: ReturnApprovalKind;
  lineNo: null;
  requestedBy: string;
  approvedBy: string;
  reason: ReturnApprovalReason;
  note: string | null;
  at: string;
  values:
    | Record<string, never>
    | { lines: { lineNo: number; suggested: Money | null; price: Money }[] }
    | { method: string; amount: Money };
}

/** A finalized return or exchange: `SaleDocumentV2` in `@erp/contracts` (sync spec §6.1). */
export interface ReturnDocument {
  version: 2;
  id: string;
  family: 'S';
  seq: number;
  number: string;
  kind: 'return' | 'exchange';
  deviceId: string;
  branchId: string;
  createdAt: string;
  businessDate: string;
  sellerId: string;
  tierId: string;
  customerId: string | null;
  walkinPhone: string | null;
  /** The returned lines first, then the sold ones. */
  lines: (ReturnDocumentLine | SaleDocumentLine)[];
  amounts: {
    subtotal: Money;
    lineDiscountTotal: Money;
    billDiscount: Money;
    /** The refunds, above 0. */
    returnTotal: Money;
    rounding: Money;
    taxTotal: Money;
    total: Money;
  };
  payments: SettledPayment[];
  /** Below 0: a payout at the desk. */
  cashDue: Money;
  handoverStatus: 'pending' | 'not_applicable';
  overrides: (SaleDocumentOverride | ReturnOverride)[];
  credit?: SaleDocumentCredit;
  /** The original bill; absent without a receipt. */
  returnOf?: { id: string; number: string; businessDate: string };
  /** Without a receipt: what the customer or the manager gave as the old bill. */
  noReceipt?: { ref: string | null };
  clientVersion: string;
}

export const isReturnedLine = (l: ReturnDocumentLine | SaleDocumentLine): l is ReturnDocumentLine =>
  'returnOf' in l;

const TRANSFER_EXCLUDED = new Set(['cash', 'on_account']);

/**
 * The finalized return or exchange (POS spec §19, D-006). Refuses a bill without returned lines, a pending price
 * approval, a return from a customer's bill for anyone else, a tender `checkTender` refuses, an on-account part over
 * the limit or the cap without a credit approval, and a refund by transfer without its approval (owner answer 1).
 */
export function buildReturnDocument(input: {
  bill: Bill;
  tender: Tender;
  methods: readonly PaymentMethodInfo[];
  sellerMaxDiscountBp: number;
  customer: SaleCustomer;
  /** The customer's credit figures; null for a walk-in. */
  credit: CreditView | null;
  creditApproval: CreditApproval | null;
  refundApproval: ReturnApprovalBy | null;
  context: SaleContext;
}): ReturnDocument {
  const { bill, customer, credit, context: c } = input;
  const ret = bill.returns ?? null;
  if (ret === null || ret.lines.length === 0)
    throw new DomainError('no_return', 'a bill without returned lines is a sale');
  if (pendingApprovals(bill, input.sellerMaxDiscountBp).length > 0)
    throw new DomainError('approval_pending', 'a price on this bill still needs an approval');
  if (ret.source.kind === 'bill' && customer.id !== ret.source.customerId)
    throw new DomainError('return_customer_mismatch', "a return keeps the original bill's customer");
  const walkinPhone = walkinPhoneOf(customer);
  const total = saleTotal(bill, c.increment);
  const hasAccount = customer.id !== null && credit !== null && credit.account !== null;
  const settlement = settleTender({
    total: total.total,
    increment: c.increment,
    methods: input.methods,
    tender: input.tender,
    hasCreditCustomer: hasAccount && credit.account!.creditAllowed,
    hasReturns: true,
    hasCustomerAccount: hasAccount,
  });
  const onAccount = onAccountAmount(settlement.payments);
  const creditOverrides = onAccount > 0 ? creditOverridesOf(onAccount, credit!, input.creditApproval) : [];

  const transfer = settlement.payments.find((p) => p.amount < 0 && !TRANSFER_EXCLUDED.has(p.method));
  const transferOverrides: ReturnOverride[] = [];
  if (transfer !== undefined) {
    if (input.refundApproval === null)
      throw new DomainError('refund_approval_pending', 'a refund by transfer needs an approval');
    const note = checkApproval(input.refundApproval);
    transferOverrides.push({
      kind: 'refund_transfer',
      lineNo: null,
      requestedBy: bill.sellerId,
      ...input.refundApproval,
      note,
      values: { method: transfer.method, amount: negate(transfer.amount) },
    });
  }

  const r = ret.lines.length;
  const source = ret.source;
  const returned = ret.lines.map((l, i): ReturnDocumentLine => ({
    lineNo: i + 1,
    itemId: l.itemId,
    qty: qty(0 - l.qty),
    listPrice: null,
    floorPrice: null,
    unitPrice: l.unitPrice,
    lineDiscount: money(0),
    billShare: money(0),
    lineTotal: negate(l.refund),
    returnOf:
      source.kind === 'bill' && l.originalLineNo !== null
        ? { documentId: source.id, number: source.number, lineNo: l.originalLineNo }
        : null,
    reason: l.reason,
    condition: l.condition,
    note: l.note,
  }));
  const returnOverrides: ReturnOverride[] = (ret.approval?.kinds ?? []).map((kind) => ({
    kind,
    lineNo: null,
    requestedBy: ret.approval!.requestedBy,
    approvedBy: ret.approval!.approvedBy,
    reason: ret.approval!.reason,
    note: ret.approval!.note,
    at: ret.approval!.at,
    values:
      kind === 'no_receipt_return'
        ? { lines: ret.lines.map((l, i) => ({ lineNo: i + 1, suggested: l.suggested, price: l.unitPrice })) }
        : {},
  }));
  const amounts = billAmounts(bill);
  return {
    version: 2,
    id: c.id,
    family: 'S',
    seq: c.seq,
    number: documentNumber(c.deviceCode, 'S', c.seq),
    kind: bill.lines.length === 0 ? 'return' : 'exchange',
    deviceId: c.deviceId,
    branchId: c.branchId,
    createdAt: new Date(c.createdAtMs).toISOString(),
    businessDate: businessDate(c.createdAtMs, c.timeZone, c.cutoffHour),
    sellerId: bill.sellerId,
    tierId: bill.tierId,
    customerId: customer.id,
    walkinPhone,
    lines: [...returned, ...soldLinesOf(bill, r)],
    amounts: {
      subtotal: amounts.subtotal,
      lineDiscountTotal: amounts.lineDiscountTotal,
      billDiscount: amounts.billDiscount,
      returnTotal: sum(ret.lines.map((l) => l.refund)),
      rounding: total.rounding,
      taxTotal: money(0),
      total: total.total,
    },
    payments: settlement.payments,
    cashDue: settlement.cashDue,
    handoverStatus: settlement.cashDue !== 0 ? 'pending' : 'not_applicable',
    overrides: [...priceOverridesOf(bill, r), ...creditOverrides, ...returnOverrides, ...transferOverrides],
    ...(onAccount > 0 ? { credit: creditBlock(credit!) } : {}),
    ...(source.kind === 'bill'
      ? { returnOf: { id: source.id, number: source.number, businessDate: source.businessDate } }
      : { noReceipt: { ref: source.ref } }),
    clientVersion: c.clientVersion,
  };
}

/** The original bill as the server holds it, for the review. */
export interface ReturnReviewOriginal {
  id: string;
  number: string;
  status: 'finalized' | 'voided';
  businessDate: string;
  /** Each line as sold, with what other returns took of it, and whether it is itself a returned line. */
  lines: (OriginalLine & { returned: Returned; isReturn: boolean })[];
}

export type ReturnFinding =
  | {
      kind: 'return_original_invalid';
      lineNo: number;
      cause: 'missing' | 'voided' | 'other_item' | 'returned_line';
    }
  | { kind: 'return_over_quantity'; lineNo: number; sold: Qty; returnedBefore: Qty; qty: Qty }
  | {
      kind: 'return_price_mismatch';
      lineNo: number;
      cause: 'linked' | 'no_receipt';
      expected: Money | null;
      refund: Money;
    }
  | {
      kind: 'return_not_permitted';
      cause: 'permission' | 'outside_policy' | 'no_receipt' | 'transfer';
      approval: 'missing' | 'not_permitted';
    };

const CAUSE_OF: Readonly<
  Record<ReturnApprovalKind, 'permission' | 'outside_policy' | 'no_receipt' | 'transfer'>
> = {
  return_permission: 'permission',
  return_outside_policy: 'outside_policy',
  no_receipt_return: 'no_receipt',
  refund_transfer: 'transfer',
};

/**
 * The server's review of a synced return (sync spec §6.2, W1-13): the returned lines against the original bill as
 * the server holds it, the no-receipt prices against their approval, and every approval the return needed against
 * the roles the server holds now. Findings only; the document is never refused. The figures are `reviewSale`'s.
 */
export function reviewReturn(
  d: ReturnDocument,
  context: {
    original: ReturnReviewOriginal | null;
    windowDays: number;
    items: Readonly<Record<string, ItemPolicy>>;
    grants: Readonly<Record<string, readonly RoleGrant[]>>;
  },
): ReturnFinding[] {
  const findings: ReturnFinding[] = [];
  const original = context.original;
  const taken = new Map<number, Returned>();
  const noReceiptPrices = new Map<number, Money>();
  for (const o of d.overrides)
    if (o.kind === 'no_receipt_return' && 'lines' in o.values)
      for (const l of o.values.lines as { lineNo: number; price: Money }[])
        noReceiptPrices.set(l.lineNo, l.price);

  const returnedLines = d.lines.filter(isReturnedLine);
  for (const l of returnedLines) {
    const k = qty(0 - l.qty);
    const refund = negate(l.lineTotal);
    if (l.returnOf === null) {
      const price = noReceiptPrices.get(l.lineNo);
      const expected = price === undefined ? null : mulQty(k, price);
      if (expected !== refund)
        findings.push({
          kind: 'return_price_mismatch',
          lineNo: l.lineNo,
          cause: 'no_receipt',
          expected,
          refund,
        });
      continue;
    }
    const sold = original?.lines.find((x) => x.lineNo === l.returnOf!.lineNo);
    let cause: 'missing' | 'voided' | 'other_item' | 'returned_line' | null = null;
    if (original === null || sold === undefined) cause = 'missing';
    else if (original.status === 'voided') cause = 'voided';
    else if (sold.isReturn) cause = 'returned_line';
    else if (sold.itemId !== l.itemId) cause = 'other_item';
    if (cause !== null) {
      findings.push({ kind: 'return_original_invalid', lineNo: l.lineNo, cause });
      continue;
    }
    const before = taken.get(sold!.lineNo) ?? NOTHING;
    const returned: Returned = {
      qty: qty(sold!.returned.qty + before.qty),
      refund: money(sold!.returned.refund + before.refund),
    };
    taken.set(sold!.lineNo, { qty: qty(before.qty + k), refund: money(before.refund + refund) });
    if (k > sold!.qty - returned.qty) {
      findings.push({
        kind: 'return_over_quantity',
        lineNo: l.lineNo,
        sold: sold!.qty,
        returnedBefore: returned.qty,
        qty: k,
      });
      continue;
    }
    const expected = refundFor(sold!, returned, k);
    if (expected !== refund)
      findings.push({ kind: 'return_price_mismatch', lineNo: l.lineNo, cause: 'linked', expected, refund });
  }

  const grantsOf = (userId: string) => context.grants[userId] ?? [];
  const check = returnNeeds({
    sellerGrants: grantsOf(d.sellerId),
    branchId: d.branchId,
    original:
      d.returnOf === undefined ? null : { businessDate: original?.businessDate ?? d.returnOf.businessDate },
    today: d.businessDate,
    windowDays: context.windowDays,
    items: returnedLines.map((l) => context.items[l.itemId] ?? {}),
  });
  const needs = [...check.needs];
  if (d.payments.some((p) => p.amount < 0 && !TRANSFER_EXCLUDED.has(p.method))) needs.push('refund_transfer');
  for (const need of needs) {
    const o = d.overrides.find((x) => x.kind === need);
    if (o === undefined)
      findings.push({ kind: 'return_not_permitted', cause: CAUSE_OF[need], approval: 'missing' });
    else if (!canApproveReturn(grantsOf(o.approvedBy), d.branchId, [need]))
      findings.push({ kind: 'return_not_permitted', cause: CAUSE_OF[need], approval: 'not_permitted' });
  }
  return findings;
}
