import { z } from 'zod';

// Documents a device writes to its outbox and pushes (sync spec §6). The device signs canonicalJson(document).

/** Whole minor units, as a safe integer (CLAUDE.md rule 1). */
const Money = z.int();
const NonNegativeMoney = z.int().nonnegative();
/** Thousandths, above 0. */
const Qty = z.int().positive();
const Instant = z.iso.datetime();

const PaymentMethod = z.enum([
  'cash',
  'bank_transfer',
  'raast',
  'jazzcash',
  'easypaisa',
  'card',
  'on_account',
]);
const PriceReason = z.enum(['customer_bargain', 'old_stock', 'market_price', 'regular_customer', 'other']);
/** Going over a credit limit or the offline cap (W1-09, owner answer 2). */
const CreditReason = z.enum(['pay_soon', 'regular_customer', 'owner_instruction', 'other']);

const SaleLine = z.strictObject({
  lineNo: z.int().positive(),
  itemId: z.uuid(),
  qty: Qty,
  listPrice: NonNegativeMoney.nullable(),
  floorPrice: NonNegativeMoney.nullable(),
  unitPrice: NonNegativeMoney,
  lineDiscount: Money,
  billShare: NonNegativeMoney,
  lineTotal: NonNegativeMoney,
});

const Payment = z.strictObject({
  method: PaymentMethod,
  amount: z.int().positive(),
  cashReceived: NonNegativeMoney.nullable(),
  changeDue: NonNegativeMoney.nullable(),
  reference: z.string().min(1).max(40).nullable(),
});

const approvalFields = {
  requestedBy: z.uuid(),
  approvedBy: z.uuid(),
  note: z.string().nullable(),
  at: Instant,
};

const PriceOverride = z
  .strictObject({
    kind: z.enum(['below_list', 'below_floor']),
    lineNo: z.int().positive().nullable(),
    reason: PriceReason,
    ...approvalFields,
    values: z.union([
      z.strictObject({
        list: NonNegativeMoney.nullable(),
        floor: NonNegativeMoney.nullable(),
        price: NonNegativeMoney,
      }),
      z.strictObject({
        billDiscount: NonNegativeMoney,
        lines: z.array(z.strictObject({ lineNo: z.int().positive(), qty: Qty, unitPrice: NonNegativeMoney })),
      }),
    ]),
  })
  // A line's approval keeps its price; the bill discount's keeps the discount and the lines (W1-07 relies on it).
  .refine((o) => (o.lineNo === null) === 'billDiscount' in o.values, {
    message: 'the values must match the override: a line price, or the bill discount',
  });

// Credit approvals (W1-09, POS spec §15): for the bill, never a line, with the figures they approved.
const CreditLimitOverride = z.strictObject({
  kind: z.literal('credit_limit'),
  lineNo: z.null(),
  reason: CreditReason,
  ...approvalFields,
  values: z.strictObject({
    limit: NonNegativeMoney.nullable(),
    balance: Money,
    unsynced: NonNegativeMoney,
    amount: NonNegativeMoney,
  }),
});
const OfflineCapOverride = z.strictObject({
  kind: z.literal('offline_cap'),
  lineNo: z.null(),
  reason: CreditReason,
  ...approvalFields,
  values: z.strictObject({ cap: NonNegativeMoney, offlineToday: NonNegativeMoney, amount: NonNegativeMoney }),
});

const Override = z.union([PriceOverride, CreditLimitOverride, OfflineCapOverride]);

/** What the counter saw when it sold on account (W1-09); only on a bill with an on-account payment. */
const Credit = z.strictObject({
  offline: z.boolean(),
  balance: Money,
  balanceAsOf: Instant.nullable(),
  unsynced: NonNegativeMoney,
  offlineToday: NonNegativeMoney,
});

/**
 * A finalized sale, version 1 (sync spec §6.1, W1-06): what `buildSaleDocument` in `@erp/domain` makes and what the
 * server accepts in W1-07. Money is whole minor units, quantities thousandths. Unknown fields are refused. W1-09's
 * fields are additive and optional, so every bill written before still parses (D-096).
 */
export const SaleDocumentV1 = z
  .strictObject({
    version: z.literal(1),
    id: z.uuid(),
    family: z.literal('S'),
    seq: z.int().positive(),
    number: z.string().regex(/^[A-Z]\d{2,}-S\d{6,}$/),
    kind: z.literal('sale'),
    deviceId: z.uuid(),
    branchId: z.uuid(),
    createdAt: Instant,
    businessDate: z.iso.date(),
    sellerId: z.uuid(),
    tierId: z.uuid(),
    customerId: z.uuid().nullable(),
    walkinPhone: z.string().nullable(),
    lines: z.array(SaleLine).min(1),
    amounts: z.strictObject({
      subtotal: NonNegativeMoney,
      lineDiscountTotal: Money,
      billDiscount: NonNegativeMoney,
      rounding: Money,
      taxTotal: NonNegativeMoney,
      total: NonNegativeMoney,
    }),
    payments: z.array(Payment).min(1),
    cashDue: NonNegativeMoney,
    handoverStatus: z.enum(['pending', 'not_applicable']),
    overrides: z.array(Override),
    credit: Credit.optional(),
    clientVersion: z.string().min(1),
  })
  .refine((d) => d.customerId === null || d.walkinPhone === null, {
    message: 'a walk-in phone only goes on a walk-in bill',
  });
export type SaleDocumentV1 = z.infer<typeof SaleDocumentV1>;

// The cash desk's documents (W1-10, cash desk spec): a handover or refund payout (family H) and a session's open or
// close (family Z). What `buildHandoverDocument` and `buildSessionDocument` in `@erp/domain` make.
const DESK_NUMBER = { H: /^[A-Z]\d{2,}-H\d{6,}$/, Z: /^[A-Z]\d{2,}-Z\d{6,}$/ } as const;
const DeskNumber = (family: 'H' | 'Z') => z.string().regex(DESK_NUMBER[family]);
const BillNumber = z.string().regex(/^[A-Z]\d{2,}-S\d{6,}$/);

/** A cash handover in, or a refund paid out: its own document; the sale is never touched (rule 3). */
export const CashHandoverV1 = z
  .strictObject({
    version: z.literal(1),
    id: z.uuid(),
    family: z.literal('H'),
    seq: z.int().positive(),
    number: DeskNumber('H'),
    kind: z.enum(['in', 'payout']),
    deviceId: z.uuid(),
    branchId: z.uuid(),
    sessionId: z.uuid(),
    cashierId: z.uuid(),
    billNumber: BillNumber,
    /** null when the desk knew the bill only from its scanned code. */
    saleDocumentId: z.uuid().nullable(),
    /** The posted figure: the cash due, or the refund, as a positive amount. */
    amount: z.int().positive(),
    cashReceived: NonNegativeMoney.nullable(),
    changeGiven: NonNegativeMoney.nullable(),
    correctedFrom: NonNegativeMoney.nullable(),
    method: z.enum(['queue', 'scan', 'auto']),
    createdAt: Instant,
    businessDate: z.iso.date(),
    clientVersion: z.string().min(1),
  })
  .refine(
    (d) => d.kind === 'in' || (d.cashReceived === null && d.changeGiven === null && d.correctedFrom === null),
    {
      message: 'a payout records no cash received, change or correction',
    },
  );
export type CashHandoverV1 = z.infer<typeof CashHandoverV1>;

/** A cash session's open (with its float) or close (with the expected cash, not a count, until W1-11). */
export const CashSessionV1 = z
  .strictObject({
    version: z.literal(1),
    id: z.uuid(),
    family: z.literal('Z'),
    seq: z.int().positive(),
    number: DeskNumber('Z'),
    event: z.enum(['open', 'close']),
    sessionId: z.uuid(),
    deviceId: z.uuid(),
    branchId: z.uuid(),
    userId: z.uuid(),
    openingFloat: NonNegativeMoney.nullable(),
    expectedCash: Money.nullable(),
    createdAt: Instant,
    businessDate: z.iso.date(),
    clientVersion: z.string().min(1),
  })
  .refine(
    (d) =>
      d.event === 'open'
        ? d.openingFloat !== null && d.expectedCash === null && d.sessionId === d.id
        : d.openingFloat === null && d.expectedCash !== null && d.sessionId !== d.id,
    { message: 'an open carries its float and is its own session; a close carries the expected cash' },
  );
export type CashSessionV1 = z.infer<typeof CashSessionV1>;
