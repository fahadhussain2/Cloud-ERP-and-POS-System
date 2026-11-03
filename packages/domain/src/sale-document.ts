import {
  billAmounts,
  pendingApprovals,
  type Approval,
  type ApprovalKind,
  type Bill,
  type OverrideReason,
} from './bill';
import { businessDate } from './business-date';
import {
  checkCredit,
  onAccountAmount,
  type CreditApproval,
  type CreditNeed,
  type CreditReason,
  type CreditView,
} from './credit';
import { DomainError } from './errors';
import { toSafeNumber } from './exact';
import { money, sub, type Money } from './money';
import { normalizePhone } from './phone';
import type { Qty } from './quantity';
import { roundCash } from './rounding';
import { settleTender, type PaymentMethodInfo, type SettledPayment, type Tender } from './tender';

// Finalizing a sale (POS spec §12–§13, POS-09, POS-13, POS-15): the rounded total, the document number, the bill code
// and the document itself (sync spec §6.1). The worker takes the sequence in its transaction and builds the document
// here; the server re-checks it with the same functions (W1-07). Clock, ids and sequence are passed in.

/** Document families and their number letter (architecture §4.4). */
export type DocumentFamily = 'S' | 'H' | 'R' | 'M' | 'Z' | 'V';

export interface SaleTotal {
  /** Lines − bill discount. */
  beforeRounding: Money;
  /** total − beforeRounding; posted to the rounding account (POS-15). */
  rounding: Money;
  total: Money;
}

export interface BillCode {
  number: string;
  /** Cash to collect (negative = to pay out), in minor units. */
  cashDue: Money;
}

export interface SaleDocumentLine {
  lineNo: number;
  itemId: string;
  qty: Qty;
  listPrice: Money | null;
  floorPrice: Money | null;
  unitPrice: Money;
  /** List amount − amount; negative above list. */
  lineDiscount: Money;
  billShare: Money;
  /** Amount − bill share. */
  lineTotal: Money;
}

export interface SaleDocumentOverride {
  kind: ApprovalKind | CreditNeed;
  /** null for the bill discount and for credit. */
  lineNo: number | null;
  requestedBy: string;
  approvedBy: string;
  reason: OverrideReason | CreditReason;
  note: string | null;
  at: string;
  values:
    | { list: Money | null; floor: Money | null; price: Money }
    | { billDiscount: Money; lines: { lineNo: number; qty: Qty; unitPrice: Money }[] }
    | { limit: Money | null; balance: Money; unsynced: Money; amount: Money }
    | { cap: Money; offlineToday: Money; amount: Money };
}

/** What the counter saw when it sold on account (POS spec §15); only on a bill with an on-account payment. */
export interface SaleDocumentCredit {
  offline: boolean;
  balance: Money;
  balanceAsOf: string | null;
  unsynced: Money;
  offlineToday: Money;
}

/** `SaleDocumentV1` in `@erp/contracts` is its wire schema (sync spec §6.1). */
export interface SaleDocument {
  version: 1;
  id: string;
  family: 'S';
  seq: number;
  number: string;
  kind: 'sale';
  deviceId: string;
  branchId: string;
  createdAt: string;
  businessDate: string;
  sellerId: string;
  tierId: string;
  customerId: string | null;
  walkinPhone: string | null;
  lines: SaleDocumentLine[];
  amounts: {
    subtotal: Money;
    lineDiscountTotal: Money;
    billDiscount: Money;
    rounding: Money;
    taxTotal: Money;
    total: Money;
  };
  payments: SettledPayment[];
  cashDue: Money;
  handoverStatus: 'pending' | 'not_applicable';
  overrides: SaleDocumentOverride[];
  /** W1-09: absent on a bill without an on-account payment, and on every bill written before. */
  credit?: SaleDocumentCredit;
  /** W1-12: the voided bill this one reissues; absent on every other bill. */
  reissueOf?: { id: string; number: string };
  clientVersion: string;
}

/** What the counter knows at finalize, besides the bill and the tender. */
export interface SaleContext {
  /** UUIDv7 made on the counter. */
  id: string;
  seq: number;
  deviceId: string;
  deviceCode: string;
  branchId: string;
  createdAtMs: number;
  timeZone: string;
  cutoffHour: number;
  /** The tenant's cash rounding increment (Delux: 100 = Rs 1). */
  increment: Money;
  clientVersion: string;
}

const DEVICE_CODE = /^[A-Z]\d{2,}$/;
const DOCUMENT_NUMBER = /^[A-Z]\d{2,}-[A-Z]\d{6,}$/;
const SCANNED_BILL_CODE = /^([A-Z]\d{2,}-[A-Z]\d{6,}) (-?\d+)$/;

/** The bill's total rounded to the tenant's increment, for every tender (POS-15, owner answer 4 to W1-06). */
export function saleTotal(bill: Bill, increment: Money): SaleTotal {
  const beforeRounding = billAmounts(bill).total;
  const { rounded, adjustment } = roundCash(beforeRounding, increment);
  return { beforeRounding, rounding: adjustment, total: rounded };
}

/** `C03` + `S` + 412 → `C03-S000412` (at least 6 digits, POS-13). */
export function documentNumber(deviceCode: string, family: DocumentFamily, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1)
    throw new DomainError('invalid_sequence', `a sequence starts at 1: ${seq}`);
  if (!DEVICE_CODE.test(deviceCode))
    throw new DomainError('invalid_device_code', `not a device code: "${deviceCode}"`);
  return `${deviceCode}-${family}${String(seq).padStart(6, '0')}`;
}

/** The Code 39 text: `<number> <cash due in whole major units>`, e.g. `C03-S000412 4320` (POS spec §13). */
export function billCode(code: BillCode, unit: Money): string {
  if (!DOCUMENT_NUMBER.test(code.number))
    throw new DomainError('invalid_bill_code', `not a document number: "${code.number}"`);
  if (code.cashDue % unit !== 0)
    throw new DomainError('invalid_bill_code', `the cash due isn't whole major units: ${code.cashDue}`);
  return `${code.number} ${BigInt(code.cashDue) / BigInt(unit)}`;
}

/** Reads a scanned bill code back; spaces around it and a trailing Enter are ignored. */
export function parseBillCode(scanned: string, unit: Money): BillCode {
  const m = SCANNED_BILL_CODE.exec(scanned.trim());
  if (m === null) throw new DomainError('invalid_bill_code', `not a bill code: "${scanned}"`);
  const whole = BigInt(m[2]!);
  // A minus marks a refund (W1-10), so a refund of nothing isn't a code the counter prints.
  if (whole === 0n && m[2]!.startsWith('-'))
    throw new DomainError('invalid_bill_code', `not a bill code: "${scanned}"`);
  return { number: m[1]!, cashDue: toSafeNumber(whole * BigInt(unit)) as Money };
}

/** Who the bill is for (POS spec §15): a customer's party id, or a walk-in with an optional phone. */
export interface SaleCustomer {
  id: string | null;
  walkinPhone: string | null;
}

/**
 * The finalized sale. Refuses an empty bill, a pending price approval, a tender `checkTender` refuses, a walk-in
 * phone that isn't one (or on a customer's bill), and an on-account part over the limit or the cap without a credit
 * approval.
 */
export function buildSaleDocument(input: {
  bill: Bill;
  tender: Tender;
  methods: readonly PaymentMethodInfo[];
  sellerMaxDiscountBp: number;
  customer: SaleCustomer;
  /** The counter's credit figures; needed for an on-account payment. */
  credit: CreditView | null;
  creditApproval: CreditApproval | null;
  /** The voided bill this one reissues (POS spec §18), or null. */
  reissueOf?: { id: string; number: string } | null;
  context: SaleContext;
}): SaleDocument {
  const { bill, customer, credit, context: c } = input;
  if (bill.lines.length === 0) throw new DomainError('empty_bill', 'a bill needs at least one line');
  if (pendingApprovals(bill, input.sellerMaxDiscountBp).length > 0)
    throw new DomainError('approval_pending', 'a price on this bill still needs an approval');
  let walkinPhone: string | null = null;
  if (customer.walkinPhone !== null) {
    if (customer.id !== null)
      throw new DomainError('invalid_customer', "a customer's bill doesn't take a walk-in phone");
    walkinPhone = normalizePhone(customer.walkinPhone);
    if (walkinPhone === null)
      throw new DomainError('invalid_phone', `not a phone number: "${customer.walkinPhone}"`);
  }
  const total = saleTotal(bill, c.increment);
  const settlement = settleTender({
    total: total.total,
    increment: c.increment,
    methods: input.methods,
    tender: input.tender,
    hasCreditCustomer: customer.id !== null && credit?.account?.creditAllowed === true,
  });
  const onAccount = onAccountAmount(settlement.payments);
  // settleTender has refused on account without a credit customer, so the view is there when it's needed.
  const creditOverrides = onAccount > 0 ? creditOverridesOf(onAccount, credit!, input.creditApproval) : [];
  const amounts = billAmounts(bill);
  const lineNo = new Map(bill.lines.map((l, i) => [l.id, i + 1]));
  const overrides: SaleDocumentOverride[] = [];
  bill.lines.forEach((l, i) => {
    if (l.approval !== null)
      overrides.push({ ...overrideOf(l.approval), lineNo: i + 1, values: l.approval.values });
  });
  if (bill.billApproval !== null) {
    const v = bill.billApproval.values;
    overrides.push({
      ...overrideOf(bill.billApproval),
      lineNo: null,
      values: {
        billDiscount: v.billDiscount,
        lines: v.lines.map((l) => ({ lineNo: lineNo.get(l.id)!, qty: l.qty, unitPrice: l.unitPrice })),
      },
    });
  }
  return {
    version: 1,
    id: c.id,
    family: 'S',
    seq: c.seq,
    number: documentNumber(c.deviceCode, 'S', c.seq),
    kind: 'sale',
    deviceId: c.deviceId,
    branchId: c.branchId,
    createdAt: new Date(c.createdAtMs).toISOString(),
    businessDate: businessDate(c.createdAtMs, c.timeZone, c.cutoffHour),
    sellerId: bill.sellerId,
    tierId: bill.tierId,
    customerId: customer.id,
    walkinPhone,
    lines: bill.lines.map((l, i) => {
      const a = amounts.lines[i]!;
      return {
        lineNo: i + 1,
        itemId: l.itemId,
        qty: l.qty,
        listPrice: l.list,
        floorPrice: l.floor,
        unitPrice: l.unitPrice,
        lineDiscount: sub(a.listAmount, a.amount),
        billShare: a.billShare,
        lineTotal: a.net,
      };
    }),
    amounts: {
      subtotal: amounts.subtotal,
      lineDiscountTotal: amounts.lineDiscountTotal,
      billDiscount: amounts.billDiscount,
      rounding: total.rounding,
      taxTotal: money(0),
      total: total.total,
    },
    payments: settlement.payments,
    cashDue: settlement.cashDue,
    handoverStatus: settlement.cashDue > 0 ? 'pending' : 'not_applicable',
    overrides: [...overrides, ...creditOverrides],
    ...(onAccount > 0 ? { credit: creditBlock(credit!) } : {}),
    ...(input.reissueOf ? { reissueOf: { id: input.reissueOf.id, number: input.reissueOf.number } } : {}),
    clientVersion: c.clientVersion,
  };
}

const creditBlock = (v: CreditView): SaleDocumentCredit => ({
  offline: v.offline,
  balance: v.balance,
  balanceAsOf: v.balanceAsOf,
  unsynced: v.unsynced,
  offlineToday: v.offlineToday,
});

/** The approvals an on-account part needs, as overrides (the limit first); refused when the approval is missing. */
function creditOverridesOf(
  amount: Money,
  credit: CreditView,
  approval: CreditApproval | null,
): SaleDocumentOverride[] {
  const check = checkCredit({ ...credit, amount });
  if (!check.allowed || check.needs.length === 0) return [];
  if (approval === null)
    throw new DomainError(
      'credit_approval_pending',
      `this sale needs a credit approval: ${check.needs.join(', ')}`,
    );
  if (approval.reason === 'other' && (approval.note === null || approval.note.trim() === ''))
    throw new DomainError('note_required', 'the reason "other" needs a note');
  const account = credit.account!;
  const base = { lineNo: null, ...approval };
  return check.needs.map((kind): SaleDocumentOverride =>
    kind === 'credit_limit'
      ? {
          ...base,
          kind,
          values: { limit: account.creditLimit, balance: credit.balance, unsynced: credit.unsynced, amount },
        }
      : {
          ...base,
          kind,
          values: { cap: account.offlineDailyCap, offlineToday: credit.offlineToday, amount },
        },
  );
}

const overrideOf = (a: Approval<unknown>) => ({
  kind: a.kind,
  requestedBy: a.requestedBy,
  approvedBy: a.approvedBy,
  reason: a.reason,
  note: a.note,
  at: a.at,
});
