import { allocate } from './allocate';
import { DomainError } from './errors';
import { divRound } from './exact';
import { money, mulQty, type Money } from './money';
import { qty } from './quantity';

// Purchasing in the back office (W1-16; PUR-02, PUR-03; posting rules §5.1, §5.2). Pure; money in paisa, quantities
// in thousandths (CLAUDE.md rule 1). The API checks with these before it saves or posts, the back office as you type.

export interface ReceiptTotalsInput {
  lines: { qty: number; unitCost: number; lineDiscount: number }[];
  billDiscount: number;
}

export interface ReceiptTotals {
  lines: { gross: Money; net: Money; value: Money; netUnitCost: Money }[];
  subtotal: Money;
  lineDiscountTotal: Money;
  billDiscount: Money;
  total: Money;
}

/**
 * A goods receipt's totals: each line's gross and net, the bill discount spread over the nets by largest remainder and
 * capitalized into each line's exact value, Σ values = the total. The net unit cost (value ÷ qty) is for showing.
 */
export function receiptTotals(input: ReceiptTotalsInput): ReceiptTotals {
  const gross = input.lines.map((l) => mulQty(qty(l.qty), money(l.unitCost)));
  const nets = input.lines.map((l, n) => {
    if (l.lineDiscount < 0 || l.lineDiscount > gross[n]!)
      throw new DomainError('invalid_discount', `line ${n + 1}: the discount is more than the line`);
    return gross[n]! - l.lineDiscount;
  });
  const sumNet = nets.reduce((s, x) => s + x, 0);
  if (input.billDiscount < 0 || input.billDiscount > sumNet)
    throw new DomainError('invalid_discount', 'the bill discount is more than the lines');
  const shares =
    input.billDiscount > 0 ? allocate(money(input.billDiscount), nets) : input.lines.map(() => money(0));
  const lines = input.lines.map((l, n) => {
    const value = money(nets[n]! - shares[n]!);
    const netUnitCost = l.qty > 0 ? money(Number(divRound(BigInt(value) * 1000n, BigInt(l.qty)))) : money(0);
    return { gross: gross[n]!, net: money(nets[n]!), value, netUnitCost };
  });
  const subtotal = money(gross.reduce((s, x) => s + x, 0));
  return {
    lines,
    subtotal,
    lineDiscountTotal: money(input.lines.reduce((s, l) => s + l.lineDiscount, 0)),
    billDiscount: money(input.billDiscount),
    total: money(lines.reduce((s, l) => s + l.value, 0)),
  };
}

/**
 * No amount on a goods receipt or a purchase return above Rs 1 crore, in the shop's own money (W2-17, owner answer 1;
 * D-128): a unit cost, a discount, the bill total as printed, a line's amount or the document's total. In major units;
 * `amountLimit` gives it in minor units.
 */
export const AMOUNT_LIMIT = 10_000_000;

/** `AMOUNT_LIMIT` in minor units: Rs 1,00,00,000 = 1,000,000,000 paisa. */
export const amountLimit = (minorUnits: number): number => AMOUNT_LIMIT * 10 ** minorUnits;

/** The largest quantity the books hold, in thousandths: `numeric(14, 3)` (99,999,999,999.999). */
export const QTY_LIMIT = 99_999_999_999_999;

/**
 * A supplier's bill number as compared (W2-18, owner 2026-11-28): one bill is posted once per supplier, and two numbers
 * are the same bill when they match after ignoring case and every space ("inv 4471" = "INV4471"). Dashes, slashes and
 * other characters still count. The API's lookup and its check at Post compare by this.
 */
export const billNoKey = (text: string): string => text.toLowerCase().replace(/\s+/g, '');

export interface ReceiptCheckInput {
  supplierId: string | null;
  billNo: string | null;
  billDate: string | null;
  locationId: string | null;
  billDiscount: number;
  /** The total printed on the supplier's bill; null = not typed yet. */
  billTotal: number | null;
  lines: {
    itemId: string | null;
    qty: number;
    unitCost: number;
    lineDiscount: number;
    allowsFraction: boolean;
    /** The item's last purchase cost and Retail price, for the warnings; null = none. */
    lastCost: number | null;
    retail: number | null;
  }[];
  /** The most any amount may be, in minor units (`amountLimit`); none given = the safe-integer range (W2-17). */
  maxAmount?: number;
  /** The number of a posted receipt that already has this supplier's bill (`billNoKey`); none = null (W2-18). */
  billNoPostedAs?: string | null;
}

export type ReceiptProblem =
  | 'supplier_required'
  | 'bill_no_required'
  | 'bill_no_taken'
  | 'bill_date_required'
  | 'location_required'
  | 'lines_required'
  | 'item_required'
  | 'qty_positive'
  | 'qty_fraction'
  | 'qty_too_large'
  | 'cost_invalid'
  | 'cost_too_large'
  | 'line_too_large'
  | 'discount_invalid'
  | 'bill_discount_invalid'
  | 'total_required'
  | 'total_mismatch'
  | 'total_too_large';

export type ReceiptWarning = 'cost_up' | 'cost_down' | 'retail_at_or_below_cost';

/** More than this much up or down from the last cost warns (PUR-02). */
const COST_CHANGE_BP = 1000;

const whole = (v: number) => Number.isSafeInteger(v);

type LineProblem =
  | 'item_required'
  | 'qty_positive'
  | 'qty_fraction'
  | 'qty_too_large'
  | 'cost_invalid'
  | 'cost_too_large'
  | 'line_too_large';

/** Quantity × unit cost, exactly, in a big integer: never too big to work out (W2-17). */
const grossOf = (q: number, cost: number) => divRound(BigInt(q) * BigInt(cost), 1000n);

/**
 * A line's own problems (item, quantity, unit cost, and its amount over the limit), in a fixed order. Anything too
 * large is a problem, never an error (W2-17: a huge unit cost used to stop the screen).
 */
function lineProblems(
  l: { itemId: string | null; qty: number; unitCost: number; allowsFraction: boolean },
  max: number,
): LineProblem[] {
  const out: LineProblem[] = [];
  if (!l.itemId) out.push('item_required');
  if (!whole(l.qty) || l.qty <= 0) out.push('qty_positive');
  else if (l.qty > QTY_LIMIT) out.push('qty_too_large');
  else if (!l.allowsFraction && l.qty % 1000 !== 0) out.push('qty_fraction');
  if (!whole(l.unitCost) || l.unitCost < 0) out.push('cost_invalid');
  else if (l.unitCost > max) out.push('cost_too_large');
  const sized = !out.some((p) => p !== 'item_required' && p !== 'qty_fraction');
  if (sized && grossOf(l.qty, l.unitCost) > BigInt(max)) out.push('line_too_large');
  return out;
}

/** Problems that leave a line without an amount to work with. */
const UNSIZED: readonly LineProblem[] = [
  'qty_positive',
  'qty_too_large',
  'cost_invalid',
  'cost_too_large',
  'line_too_large',
];

/**
 * A receipt before posting (PUR-02): problems block it, warnings don't. The bill-total check compares the printed
 * total with the computed one; totals and the difference are null while a line or a discount is invalid.
 */
export function checkReceipt(input: ReceiptCheckInput): {
  problems: { problem: ReceiptProblem; row: number | null }[];
  warnings: { warning: ReceiptWarning; row: number }[];
  total: Money | null;
  difference: number | null;
} {
  const problems: { problem: ReceiptProblem; row: number | null }[] = [];
  const header = (p: ReceiptProblem) => problems.push({ problem: p, row: null });
  if (!input.supplierId) header('supplier_required');
  if ((input.billNo ?? '').trim() === '') header('bill_no_required');
  // The same supplier's bill is posted once (W2-18): another posted receipt already has it.
  else if (input.billNoPostedAs) header('bill_no_taken');
  if (!input.billDate) header('bill_date_required');
  if (!input.locationId) header('location_required');
  if (input.lines.length === 0) header('lines_required');

  const max = input.maxAmount ?? Number.MAX_SAFE_INTEGER;
  let linesOk = true;
  input.lines.forEach((l, row) => {
    const own = lineProblems(l, max);
    for (const p of own) problems.push({ problem: p, row });
    const costOk = !own.some((p) => UNSIZED.includes(p));
    const gross = costOk ? mulQty(qty(l.qty), money(l.unitCost)) : null;
    const discountBad =
      !whole(l.lineDiscount) || l.lineDiscount < 0 || (gross !== null && l.lineDiscount > gross);
    if (discountBad) problems.push({ problem: 'discount_invalid', row });
    if (own.length > 0 || discountBad) linesOk = false;
  });

  const warnings: { warning: ReceiptWarning; row: number }[] = [];
  if (!linesOk) return { problems, warnings, total: null, difference: null };
  // The lines together, in a big integer: over the limit is a problem at the bill total (W2-17).
  const sumBig = input.lines.reduce((s, l) => s + grossOf(l.qty, l.unitCost) - BigInt(l.lineDiscount), 0n);
  if (sumBig > BigInt(max)) {
    header('total_too_large');
    return { problems, warnings, total: null, difference: null };
  }
  const sumNet = Number(sumBig);
  if (!whole(input.billDiscount) || input.billDiscount < 0 || input.billDiscount > sumNet) {
    header('bill_discount_invalid');
    return { problems, warnings, total: null, difference: null };
  }
  const totals = receiptTotals(input);
  totals.lines.forEach((t, row) => {
    const l = input.lines[row]!;
    const unit = BigInt(t.netUnitCost) * 10_000n;
    if (l.lastCost !== null) {
      const last = BigInt(l.lastCost);
      if (unit > last * BigInt(10_000 + COST_CHANGE_BP)) warnings.push({ warning: 'cost_up', row });
      else if (unit < last * BigInt(10_000 - COST_CHANGE_BP)) warnings.push({ warning: 'cost_down', row });
    }
    if (l.retail !== null && l.retail <= t.netUnitCost)
      warnings.push({ warning: 'retail_at_or_below_cost', row });
  });
  if (input.billTotal === null) {
    header('total_required');
    return { problems, warnings, total: totals.total, difference: null };
  }
  if (!whole(input.billTotal) || input.billTotal > max) {
    header('total_too_large');
    return { problems, warnings, total: totals.total, difference: null };
  }
  const difference = input.billTotal - totals.total;
  if (difference !== 0) header('total_mismatch');
  return { problems, warnings, total: totals.total, difference };
}

/** Why goods go back to the supplier (owner answer 3 to W1-16). */
export const PURCHASE_RETURN_REASONS = [
  'damaged',
  'wrong_item',
  'excess',
  'poor_quality',
  'price_dispute',
  'other',
] as const;
export type PurchaseReturnReason = (typeof PURCHASE_RETURN_REASONS)[number];

export interface ReturnCheckInput {
  supplierId: string | null;
  locationId: string | null;
  reason: string | null;
  note: string | null;
  lines: {
    itemId: string | null;
    qty: number;
    unitCost: number;
    allowsFraction: boolean;
    /** What the linked receipt line still has (received less earlier returns); null = not linked. */
    returnable: number | null;
  }[];
  /** The most any amount may be, in minor units (`amountLimit`); none given = the safe-integer range (W2-17). */
  maxAmount?: number;
}

export type ReturnProblem =
  | 'supplier_required'
  | 'location_required'
  | 'reason_required'
  | 'reason_unknown'
  | 'note_required'
  | 'lines_required'
  | 'item_required'
  | 'qty_positive'
  | 'qty_fraction'
  | 'qty_too_large'
  | 'cost_invalid'
  | 'cost_too_large'
  | 'line_too_large'
  | 'more_than_received'
  | 'total_too_large';

/** A purchase return before posting (PUR-03): problems, and its total once every line is valid. */
export function checkReturn(input: ReturnCheckInput): {
  problems: { problem: ReturnProblem; row: number | null }[];
  total: Money | null;
} {
  const problems: { problem: ReturnProblem; row: number | null }[] = [];
  const header = (p: ReturnProblem) => problems.push({ problem: p, row: null });
  if (!input.supplierId) header('supplier_required');
  if (!input.locationId) header('location_required');
  if (input.reason === null) header('reason_required');
  else if (!(PURCHASE_RETURN_REASONS as readonly string[]).includes(input.reason)) header('reason_unknown');
  else if (input.reason === 'other' && (input.note ?? '').trim() === '') header('note_required');
  if (input.lines.length === 0) header('lines_required');
  const max = input.maxAmount ?? Number.MAX_SAFE_INTEGER;
  let ok = true;
  input.lines.forEach((l, row) => {
    const own: ReturnProblem[] = lineProblems(l, max);
    const sized = !own.includes('qty_positive') && !own.includes('qty_too_large');
    if (sized && l.returnable !== null && l.qty > l.returnable) own.push('more_than_received');
    for (const p of own) problems.push({ problem: p, row });
    if (own.length > 0) ok = false;
  });
  if (!ok) return { problems, total: null };
  // The lines together, in a big integer: over the limit is a problem of the return (W2-17).
  const sum = input.lines.reduce((s, l) => s + grossOf(l.qty, l.unitCost), 0n);
  if (sum > BigInt(max)) {
    header('total_too_large');
    return { problems, total: null };
  }
  return { problems, total: money(Number(sum)) };
}
