import { z } from 'zod';

// Purchasing in the back office (W1-16 plan; PUR-01, PUR-02, PUR-03, PUR-09). Money in paisa and quantities in
// thousandths, as integers (CLAUDE.md rule 1); dates as YYYY-MM-DD.

const Id = z.uuid();
const Day = z.iso.date();
const RowVersion = z.string().regex(/^\d+$/);
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => (s.trim() === '' ? null : s.trim()))
    .nullable();

export const CreateSupplierRequest = z.strictObject({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  contactPerson: Text(120).optional(),
  phones: z.array(z.string().trim().min(1).max(30)).max(5).optional(),
  address: Text(240).optional(),
  city: Text(60).optional(),
  termsDays: z.number().int().min(0).max(365).nullable().optional(),
  labelAbbr: Text(10).optional(),
  notes: Text(500).optional(),
});
export type CreateSupplierRequest = z.infer<typeof CreateSupplierRequest>;

export const UpdateSupplierRequest = CreateSupplierRequest.omit({ code: true })
  .partial()
  .extend({ rowVersion: RowVersion, status: z.enum(['active', 'inactive']).optional() });
export type UpdateSupplierRequest = z.infer<typeof UpdateSupplierRequest>;

const ReceiptLine = z.strictObject({
  itemId: Id.nullable(),
  qty: z.number().int(),
  unitCost: z.number(),
  lineDiscount: z.number().int(),
});

/** A goods receipt draft as the purchaser types it; everything may be half-done until Post. */
export const ReceiptDraft = z.strictObject({
  supplierId: Id.nullable(),
  billNo: Text(40),
  billDate: Day.nullable(),
  receivedOn: Day,
  locationId: Id,
  /** Paid by bank with the receipt; null = on the supplier's account (owner answer 1). */
  paidFrom: Id.nullable(),
  billDiscount: z.number().int(),
  billTotal: z.number().int().nullable(),
  notes: Text(500),
  lines: z.array(ReceiptLine).max(200),
});
export type ReceiptDraft = z.infer<typeof ReceiptDraft>;
export const SaveReceiptRequest = ReceiptDraft.extend({ rowVersion: RowVersion });

const ReturnLine = z.strictObject({
  itemId: Id.nullable(),
  receiptLineId: Id.nullable().optional(),
  qty: z.number().int(),
  unitCost: z.number(),
});

export const ReturnDraft = z.strictObject({
  supplierId: Id.nullable(),
  goodsReceiptId: Id.nullable().optional(),
  locationId: Id,
  returnedOn: Day,
  reason: z.string().max(40).nullable(),
  note: Text(500),
  lines: z.array(ReturnLine).max(200),
});
export type ReturnDraft = z.infer<typeof ReturnDraft>;
export const SaveReturnRequest = ReturnDraft.extend({ rowVersion: RowVersion });

export const PostRequest = z.strictObject({ rowVersion: RowVersion });

export const SupplierPaymentRequest = z.strictObject({
  supplierId: Id,
  bankAccountId: Id,
  amount: z.number().int().positive(),
  paidOn: Day,
  reference: Text(60),
});
export type SupplierPaymentRequest = z.infer<typeof SupplierPaymentRequest>;

export interface SupplierRow {
  id: string;
  code: string;
  name: string;
  phones: string[];
  termsDays: number | null;
  labelAbbr: string | null;
  status: 'active' | 'inactive';
  /** What the shop owes them (paisa); below 0 = they owe the shop. */
  balance: number;
}

export interface SupplierDetail {
  supplier: SupplierRow & {
    contactPerson: string | null;
    address: string | null;
    city: string | null;
    notes: string | null;
    rowVersion: string;
  };
  balance: number;
  /** Oldest first, with the running balance. */
  ledger: {
    entryDate: string;
    dueDate: string;
    kind: string;
    sourceId: string;
    number: string;
    amount: number;
    balance: number;
  }[];
}

export interface ReceiptLineView {
  id: string;
  lineNo: number;
  itemId: string | null;
  code: string | null;
  name: string | null;
  qty: number;
  unitCost: number;
  lineDiscount: number;
  /** After posting: the exact net value; before, as the check computes it. */
  value: number | null;
  netUnitCost: number | null;
  allowsFraction: boolean;
  lastCost: number | null;
  retail: number | null;
}

export interface ReceiptView {
  receipt: {
    id: string;
    number: string | null;
    status: 'draft' | 'posted';
    supplierId: string | null;
    supplierName: string | null;
    billNo: string | null;
    billDate: string | null;
    receivedOn: string;
    locationId: string;
    paidFrom: string | null;
    billDiscount: number;
    billTotal: number | null;
    total: number | null;
    dueDate: string | null;
    notes: string | null;
    rowVersion: string;
    postedAt: string | null;
  };
  lines: ReceiptLineView[];
  check: {
    problems: { problem: string; row: number | null }[];
    warnings: { warning: string; row: number }[];
    total: number | null;
    difference: number | null;
  };
}

export interface ReturnView {
  purchaseReturn: {
    id: string;
    number: string | null;
    status: 'draft' | 'posted';
    supplierId: string | null;
    supplierName: string | null;
    goodsReceiptId: string | null;
    goodsReceiptNumber: string | null;
    locationId: string;
    returnedOn: string;
    reason: string | null;
    note: string | null;
    total: number | null;
    rowVersion: string;
  };
  lines: {
    id: string;
    lineNo: number;
    itemId: string | null;
    code: string | null;
    name: string | null;
    receiptLineId: string | null;
    qty: number;
    unitCost: number;
    allowsFraction: boolean;
    /** What the linked receipt line still has; null = not linked. */
    returnable: number | null;
  }[];
  check: { problems: { problem: string; row: number | null }[]; total: number | null };
}

export interface DocumentRow {
  id: string;
  number: string | null;
  status: 'draft' | 'posted';
  supplierName: string | null;
  date: string;
  billNo: string | null;
  amount: number | null;
}

export interface PurchasingLookups {
  locations: { id: string; code: string; name: string }[];
  bankAccounts: { id: string; code: string; name: string }[];
  suppliers: { id: string; code: string; name: string }[];
  live: boolean;
  money: { locale: string; currency: string; minorUnits: number };
  can: { receive: boolean; payByBank: boolean };
}
