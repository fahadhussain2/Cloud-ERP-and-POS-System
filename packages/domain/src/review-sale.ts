import { allocate } from './allocate';
import {
  canApprove,
  hasListPrice,
  pendingApprovals,
  type Bill,
  type LineApprovalValues,
  type OverrideReason,
  type PendingApproval,
} from './bill';
import { businessDate } from './business-date';
import { money, mulQty, negate, sub, sum, type Money } from './money';
import { effectiveLimits, type RoleGrant } from './permissions';
import type { Qty } from './quantity';
import { roundCash } from './rounding';
import { isReturnedLine, type ReturnDocument } from './return';
import { documentNumber, type SaleDocument, type SaleDocumentLine } from './sale-document';
import {
  checkTender,
  settleTender,
  type PaymentMethodInfo,
  type SettledPayment,
  type TenderProblem,
} from './tender';

// The server's re-check of a synced sale (sync spec §6.2, SYN-03, D-011, W1-07): the same rules the counter used,
// run again on the document as it arrived. It never refuses a sale; it returns findings, which the server records as
// exceptions for review. Prices and floors are judged on the document's own snapshot (architecture §4.7); approvals
// are judged against the roles the server holds for each person.

/** What doesn't add up on a document (`document_inconsistent`), in the order they are checked. */
export type InconsistencyCode =
  | 'number'
  | 'business_date'
  | 'line_numbers'
  | 'line_amounts'
  | 'amounts'
  | 'rounding'
  | 'tender'
  | 'payments'
  | 'cash_due'
  | 'handover_status';

/** Why a price that needed an approval isn't covered. */
export type ApprovalCause = 'no_approval' | 'not_covered' | 'not_permitted';

export type SaleFinding =
  | {
      kind: 'document_inconsistent';
      /** The line, for `line_amounts`; else null. */
      lineNo: number | null;
      code: InconsistencyCode;
      /** The tender problem, for `tender`; else null. */
      problem: TenderProblem | null;
    }
  | {
      kind: 'below_floor_no_override' | 'discount_over_limit';
      /** null for the bill discount. */
      lineNo: number | null;
      /** The discount below list in basis points; null when the line has no list price. */
      discountBp: number | null;
      cause: ApprovalCause;
    };

export interface ReviewContext {
  /** The code of the device the document says made it. */
  deviceCode: string;
  timeZone: string;
  cutoffHour: number;
  increment: Money;
  /** Every payment method of the tenant, active or not: one switched off during an outage is not a finding. */
  methods: readonly PaymentMethodInfo[];
  /** The roles the server holds, by user id, for the seller and every approver on the document. */
  grants: Readonly<Record<string, readonly RoleGrant[]>>;
}

const lineId = (i: number) => `l${i}`;

/**
 * The findings on a synced sale: consistency first, in `InconsistencyCode` order, then prices (lines, then the bill).
 * The document has passed `SaleDocumentV1`, and the context comes from the server's own settings.
 */
export function reviewSale(document: SaleDocument | ReturnDocument, context: ReviewContext): SaleFinding[] {
  const d = document;
  const findings: SaleFinding[] = [];
  const odd = (code: InconsistencyCode, lineNo: number | null = null, problem: TenderProblem | null = null) =>
    findings.push({ kind: 'document_inconsistent', lineNo, code, problem });

  if (d.number !== documentNumber(context.deviceCode, 'S', d.seq)) odd('number');
  if (d.businessDate !== businessDate(Date.parse(d.createdAt), context.timeZone, context.cutoffHour))
    odd('business_date');
  if (d.lines.some((l, i) => l.lineNo !== i + 1)) odd('line_numbers');

  // A return's lines (W1-13) carry their refund; whether it is the right one is reviewReturn's question. Here only
  // their shape: negative, with no discount or share of the bill discount.
  const returned = d.version === 2 ? d.lines.filter(isReturnedLine) : [];
  for (const l of returned)
    if (l.qty >= 0 || l.lineTotal >= 0 || l.lineDiscount !== 0 || l.billShare !== 0)
      odd('line_amounts', l.lineNo);
  const returnTotal = negate(sum(returned.map((l) => l.lineTotal)));
  const sold = d.lines.filter((l): l is SaleDocumentLine => !('returnOf' in l));

  // The sold lines' figures again, from quantity and price; the bill discount split as the counter splits it.
  const figures = sold.map((l) => {
    const amount = mulQty(l.qty, l.unitPrice);
    return { amount, listAmount: hasListPrice(l.listPrice) ? mulQty(l.qty, l.listPrice) : amount };
  });
  const amounts = figures.map((f) => f.amount);
  const linesTotal = sum(amounts);
  const billDiscount = d.amounts.billDiscount;
  const fits = billDiscount <= linesTotal;
  const shares =
    billDiscount === 0 || !fits || amounts.length === 0
      ? amounts.map(() => money(0))
      : allocate(billDiscount, amounts);
  sold.forEach((l, i) => {
    const { amount, listAmount } = figures[i]!;
    const share = shares[i]!;
    if (
      l.lineDiscount !== sub(listAmount, amount) ||
      l.billShare !== share ||
      l.lineTotal !== sub(amount, share)
    )
      odd('line_amounts', l.lineNo);
  });
  const subtotal = sum(figures.map((f) => f.listAmount));
  if (
    d.amounts.subtotal !== subtotal ||
    d.amounts.lineDiscountTotal !== sub(subtotal, linesTotal) ||
    d.amounts.taxTotal !== 0 ||
    (d.version === 2 && d.amounts.returnTotal !== returnTotal) ||
    !fits
  )
    odd('amounts');
  const rounded = roundCash(sub(sub(linesTotal, billDiscount), returnTotal), context.increment);
  if (d.amounts.rounding !== rounded.adjustment || d.amounts.total !== rounded.rounded) odd('rounding');

  // The payments against the document's own total: a wrong total is the rounding finding above.
  const cashRow = d.payments.find((p) => context.methods.some((m) => m.code === p.method && m.isCash));
  const tenderInput = {
    total: d.amounts.total,
    increment: context.increment,
    methods: context.methods,
    tender: {
      payments: d.payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference })),
      cashReceived: cashRow?.cashReceived ?? null,
    },
    hasCreditCustomer: d.customerId !== null,
    hasReturns: d.version === 2,
    hasCustomerAccount: d.customerId !== null,
  };
  const problem = checkTender(tenderInput);
  let cashDue = d.cashDue;
  if (problem !== null) odd('tender', null, problem);
  else {
    const settled = settleTender(tenderInput);
    if (!samePayments(settled.payments, d.payments)) odd('payments');
    if (settled.cashDue !== d.cashDue) odd('cash_due');
    cashDue = settled.cashDue;
  }
  const pending = d.version === 2 ? cashDue !== 0 : cashDue > 0;
  if (d.handoverStatus !== (pending ? 'pending' : 'not_applicable')) odd('handover_status');

  findings.push(...reviewPrices(d, sold, context, fits));
  return findings;
}

const samePayments = (a: readonly SettledPayment[], b: readonly SettledPayment[]) =>
  a.length === b.length &&
  a.every((p, i) => {
    const q = b[i]!;
    return (
      p.method === q.method &&
      p.amount === q.amount &&
      p.cashReceived === q.cashReceived &&
      p.changeDue === q.changeDue &&
      p.reference === q.reference
    );
  });

/**
 * The prices the seller couldn't give alone, and whether an approval on the document covers each one and was given
 * by someone the server says may give it. A bill discount larger than the lines (already a finding) is left out.
 */
function reviewPrices(
  d: SaleDocument | ReturnDocument,
  lines: readonly SaleDocumentLine[],
  context: ReviewContext,
  fits: boolean,
): SaleFinding[] {
  const grantsOf = (userId: string) => context.grants[userId] ?? [];
  const index = new Map(lines.map((l, i) => [l.lineNo, i]));
  const bare: Bill = {
    version: 1,
    sellerId: d.sellerId,
    tierId: d.tierId,
    lines: lines.map((l, i) => ({
      id: lineId(i),
      itemId: l.itemId,
      qty: l.qty,
      allowsFraction: true,
      list: l.listPrice,
      floor: l.floorPrice,
      unitPrice: l.unitPrice,
      approval: null,
    })),
    billDiscount: fits ? d.amounts.billDiscount : money(0),
    billApproval: null,
  };
  const approved: Bill = { ...bare, lines: bare.lines.map((l) => ({ ...l })) };
  for (const o of d.overrides) {
    // Credit approvals (W1-09) are judged by reviewCredit, a return's (W1-13) by reviewReturn, not here.
    if (o.kind !== 'below_list' && o.kind !== 'below_floor') continue;
    const base = {
      kind: o.kind,
      requestedBy: o.requestedBy,
      approvedBy: o.approvedBy,
      // SaleDocumentV1 allows only the price reasons on a price override.
      reason: o.reason as OverrideReason,
      note: o.note,
      at: o.at,
    };
    // SaleDocumentV1 ties the values' shape to lineNo: a line's price, or the bill discount and its lines.
    if (o.lineNo === null) {
      const v = o.values as { billDiscount: Money; lines: { lineNo: number; qty: Qty; unitPrice: Money }[] };
      approved.billApproval = {
        ...base,
        values: {
          billDiscount: v.billDiscount,
          lines: v.lines.map((l) => ({
            id: lineId(index.get(l.lineNo) ?? -1),
            qty: l.qty,
            unitPrice: l.unitPrice,
          })),
        },
      };
    } else {
      const line = approved.lines[index.get(o.lineNo) ?? -1];
      if (line) line.approval = { ...base, values: o.values as LineApprovalValues };
    }
  }

  const sellerBp = effectiveLimits(grantsOf(d.sellerId), d.branchId).maxDiscountBp;
  const stillPending = pendingApprovals(approved, sellerBp);
  const target = (p: PendingApproval) => (p.target === 'bill' ? 'bill' : p.target.lineId);

  return pendingApprovals(bare, sellerBp).flatMap((need): SaleFinding[] => {
    const i = need.target === 'bill' ? null : Number(need.target.lineId.slice(1));
    const approval = i === null ? approved.billApproval : approved.lines[i]!.approval;
    let cause: ApprovalCause | null = null;
    if (approval === null) cause = 'no_approval';
    else if (stillPending.some((p) => target(p) === target(need))) cause = 'not_covered';
    else if (!canApprove(grantsOf(approval.approvedBy), d.branchId, need.need, need.discountBp))
      cause = 'not_permitted';
    if (cause === null) return [];
    return [
      {
        kind: need.need === 'below_floor' ? 'below_floor_no_override' : 'discount_over_limit',
        lineNo: i === null ? null : lines[i]!.lineNo,
        discountBp: need.discountBp,
        cause,
      },
    ];
  });
}
