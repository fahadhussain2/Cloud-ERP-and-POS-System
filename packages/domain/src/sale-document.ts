import type { ApprovalKind, Bill, OverrideReason } from './bill';
import type { Money } from './money';
import type { Qty } from './quantity';
import type { PaymentMethodInfo, SettledPayment, Tender } from './tender';

// Finalizing a sale (POS spec §12–§13, POS-09, POS-13, POS-15): the rounded total, the document number, the bill code
// and the document itself (sync spec §6.1). The worker takes the sequence in its transaction and builds the document
// here; the server re-checks it with the same functions (W1-07). Clock, ids and sequence are passed in.

/** Document families and their number letter (architecture §4.4). */
export type DocumentFamily = 'S' | 'H' | 'R' | 'M' | 'Z';

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
  kind: ApprovalKind;
  /** null for the bill discount. */
  lineNo: number | null;
  requestedBy: string;
  approvedBy: string;
  reason: OverrideReason;
  note: string | null;
  at: string;
  values:
    | { list: Money | null; floor: Money | null; price: Money }
    | { billDiscount: Money; lines: { lineNo: number; qty: Qty; unitPrice: Money }[] };
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

const notBuilt = (...args: unknown[]): never => {
  throw new Error(`not built yet (W1-06): ${args.length} arguments`);
};

/** The bill's total rounded to the tenant's increment, for every tender (POS-15, owner answer 4 to W1-06). */
export function saleTotal(bill: Bill, increment: Money): SaleTotal {
  return notBuilt(bill, increment);
}

/** `C03` + `S` + 412 → `C03-S000412` (at least 6 digits, POS-13). */
export function documentNumber(deviceCode: string, family: DocumentFamily, seq: number): string {
  return notBuilt(deviceCode, family, seq);
}

/** The Code 39 text: `<number> <cash due in whole major units>`, e.g. `C03-S000412 4320` (POS spec §13). */
export function billCode(code: BillCode, unit: Money): string {
  return notBuilt(code, unit);
}

/** Reads a scanned bill code back; spaces around it and a trailing Enter are ignored. */
export function parseBillCode(scanned: string, unit: Money): BillCode {
  return notBuilt(scanned, unit);
}

/** The finalized sale. Refuses an empty bill, a pending approval or a tender `checkTender` refuses. */
export function buildSaleDocument(input: {
  bill: Bill;
  tender: Tender;
  methods: readonly PaymentMethodInfo[];
  sellerMaxDiscountBp: number;
  hasCreditCustomer: boolean;
  context: SaleContext;
}): SaleDocument {
  return notBuilt(input);
}
