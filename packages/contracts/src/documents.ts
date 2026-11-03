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
    /** W1-12: the voided bill this one reissues; absent on every other bill. */
    reissueOf: z.strictObject({ id: z.uuid(), number: z.string().regex(/^[A-Z]\d{2,}-S\d{6,}$/) }).optional(),
    clientVersion: z.string().min(1),
  })
  .refine((d) => d.customerId === null || d.walkinPhone === null, {
    message: 'a walk-in phone only goes on a walk-in bill',
  });
export type SaleDocumentV1 = z.infer<typeof SaleDocumentV1>;

const BillNumber = z.string().regex(/^[A-Z]\d{2,}-S\d{6,}$/);
const ReturnReason = z.enum(['wrong_part', 'unused_option', 'defective', 'changed_mind', 'other']);
/** Why an approver allowed a return or a refund by transfer (owner answer 3 to W1-13). */
const ReturnApprovalReason = z.enum([
  'regular_customer',
  'manufacturer_defect',
  'lost_bill',
  'before_go_live',
  'owner_instruction',
  'other',
]);

/** A returned line (W1-13): negative, with its refund, what it returns and why; no list, floor or discount. */
const ReturnedLine = z.strictObject({
  lineNo: z.int().positive(),
  itemId: z.uuid(),
  qty: z.int().negative(),
  listPrice: z.null(),
  floorPrice: z.null(),
  unitPrice: NonNegativeMoney,
  lineDiscount: z.literal(0),
  billShare: z.literal(0),
  lineTotal: z.int().negative(),
  /** The original bill's line; null without a receipt. */
  returnOf: z
    .strictObject({ documentId: z.uuid(), number: BillNumber, lineNo: z.int().positive() })
    .nullable(),
  reason: ReturnReason,
  condition: z.enum(['resellable', 'defective']),
  note: z.string().min(1).max(200).nullable(),
});

const returnApprovalFields = {
  lineNo: z.null(),
  reason: ReturnApprovalReason,
  ...approvalFields,
};
const ReturnOverride = z.union([
  z.strictObject({
    kind: z.enum(['return_permission', 'return_outside_policy']),
    ...returnApprovalFields,
    values: z.strictObject({}),
  }),
  z.strictObject({
    kind: z.literal('no_receipt_return'),
    ...returnApprovalFields,
    values: z.strictObject({
      lines: z
        .array(
          z.strictObject({
            lineNo: z.int().positive(),
            suggested: NonNegativeMoney.nullable(),
            price: NonNegativeMoney,
          }),
        )
        .min(1),
    }),
  }),
  z.strictObject({
    kind: z.literal('refund_transfer'),
    ...returnApprovalFields,
    values: z.strictObject({ method: PaymentMethod, amount: z.int().positive() }),
  }),
]);

/** A payment on a return or exchange: as on a sale, or one refund row (negative) with no cash received or change. */
const ReturnPayment = z.strictObject({
  method: PaymentMethod,
  amount: z.int().refine((a) => a !== 0, { message: 'a payment is never 0' }),
  cashReceived: NonNegativeMoney.nullable(),
  changeDue: NonNegativeMoney.nullable(),
  reference: z.string().min(1).max(40).nullable(),
});

/**
 * A finalized return or exchange, version 2 (sync spec §6.1, POS spec §19, D-006, W1-13): what `buildReturnDocument`
 * in `@erp/domain` makes. The returned lines come first, then the sold ones (as on a sale). The total and cash due may
 * be negative (a refund, paid out at the desk) or 0 (an even exchange, with no payment). A plain sale stays version 1.
 */
export const SaleDocumentV2 = z
  .strictObject({
    version: z.literal(2),
    id: z.uuid(),
    family: z.literal('S'),
    seq: z.int().positive(),
    number: BillNumber,
    kind: z.enum(['return', 'exchange']),
    deviceId: z.uuid(),
    branchId: z.uuid(),
    createdAt: Instant,
    businessDate: z.iso.date(),
    sellerId: z.uuid(),
    tierId: z.uuid(),
    customerId: z.uuid().nullable(),
    walkinPhone: z.string().nullable(),
    lines: z.array(z.union([SaleLine, ReturnedLine])).min(1),
    amounts: z.strictObject({
      subtotal: NonNegativeMoney,
      lineDiscountTotal: Money,
      billDiscount: NonNegativeMoney,
      returnTotal: z.int().positive(),
      rounding: Money,
      taxTotal: NonNegativeMoney,
      total: Money,
    }),
    payments: z.array(ReturnPayment),
    cashDue: Money,
    handoverStatus: z.enum(['pending', 'not_applicable']),
    overrides: z.array(z.union([Override, ReturnOverride])),
    credit: Credit.optional(),
    returnOf: z.strictObject({ id: z.uuid(), number: BillNumber, businessDate: z.iso.date() }).optional(),
    noReceipt: z.strictObject({ ref: z.string().min(1).max(40).nullable() }).optional(),
    clientVersion: z.string().min(1),
  })
  .refine((d) => d.customerId === null || d.walkinPhone === null, {
    message: 'a walk-in phone only goes on a walk-in bill',
  })
  .refine((d) => (d.returnOf === undefined) !== (d.noReceipt === undefined), {
    message: 'a return names its original bill or says it has no receipt, never both',
  })
  .refine(
    (d) => {
      const returned = d.lines.filter((l) => 'returnOf' in l);
      const sold = d.lines.filter((l) => !('returnOf' in l));
      // Returned lines first; a return has only them, an exchange both.
      return (
        returned.length > 0 &&
        d.lines.slice(0, returned.length).every((l) => 'returnOf' in l) &&
        (d.kind === 'return') === (sold.length === 0)
      );
    },
    { message: 'the returned lines come first, and the kind follows from the lines' },
  )
  .refine(
    (d) =>
      d.lines
        .filter((l) => 'returnOf' in l)
        .every((l) => ((l as { returnOf: unknown }).returnOf === null) === (d.noReceipt !== undefined)),
    { message: 'every returned line names its original line, unless there is no receipt' },
  );
export type SaleDocumentV2 = z.infer<typeof SaleDocumentV2>;

/**
 * A void of a finalized bill, version 1 (family V, sync spec §6.2, POS spec §18, W1-12): what `buildVoidDocument` in
 * `@erp/domain` makes. The bill is never changed (rule 3); the void names it by id and number.
 */
export const SaleVoidV1 = z
  .strictObject({
    version: z.literal(1),
    id: z.uuid(),
    family: z.literal('V'),
    seq: z.int().positive(),
    number: z.string().regex(/^[A-Z]\d{2,}-V\d{6,}$/),
    deviceId: z.uuid(),
    branchId: z.uuid(),
    saleId: z.uuid(),
    saleNumber: z.string().regex(/^[A-Z]\d{2,}-S\d{6,}$/),
    saleBusinessDate: z.iso.date(),
    saleTotal: NonNegativeMoney,
    saleCashDue: NonNegativeMoney,
    userId: z.uuid(),
    approvedBy: z.uuid(),
    reason: z.enum([
      'wrong_item',
      'wrong_quantity',
      'wrong_price',
      'wrong_customer_or_payment',
      'duplicate_bill',
      'customer_cancelled',
      'other',
    ]),
    note: z.string().min(1).max(200).nullable(),
    handoverSeen: z.enum(['pending', 'not_applicable', 'unknown']),
    createdAt: Instant,
    businessDate: z.iso.date(),
    clientVersion: z.string().min(1),
  })
  .refine((d) => d.reason !== 'other' || d.note !== null, { message: '"other" needs a note' })
  .refine((d) => (d.saleCashDue === 0) === (d.handoverSeen === 'not_applicable'), {
    message: 'a bill without cash has nothing at the desk, and one with cash has',
  });
export type SaleVoidV1 = z.infer<typeof SaleVoidV1>;

// The cash desk's documents (W1-10, cash desk spec): a handover or refund payout (family H) and a session's open or
// close (family Z). What `buildHandoverDocument` and `buildSessionDocument` in `@erp/domain` make.
const DESK_NUMBER = {
  H: /^[A-Z]\d{2,}-H\d{6,}$/,
  R: /^[A-Z]\d{2,}-R\d{6,}$/,
  M: /^[A-Z]\d{2,}-M\d{6,}$/,
  Z: /^[A-Z]\d{2,}-Z\d{6,}$/,
} as const;
const DeskNumber = (family: keyof typeof DESK_NUMBER) => z.string().regex(DESK_NUMBER[family]);

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

// The desk's other documents (W1-11, cash desk spec): a customer collection (family R), a cash-out or safe movement
// (family M), and the counted session close (CashSessionV2). What `buildCollectionDocument`, `buildCashMovementDocument`
// and `buildSessionDocument` in `@erp/domain` make.
const Note = z.string().min(1).max(200).nullable();
const Reference = z.string().min(1).max(40).nullable();

/** A customer paying what they owe at the desk (CSH-05). */
export const CustomerCollectionV1 = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  family: z.literal('R'),
  seq: z.int().positive(),
  number: DeskNumber('R'),
  deviceId: z.uuid(),
  branchId: z.uuid(),
  sessionId: z.uuid(),
  cashierId: z.uuid(),
  partyId: z.uuid(),
  customerCode: z.string().min(1),
  customerName: z.string().min(1),
  methodId: z.uuid(),
  methodCode: PaymentMethod.exclude(['on_account']),
  amount: z.int().positive(),
  reference: Reference,
  note: Note,
  /** The desk's figure, printed on the receipt; never posted. */
  balanceBefore: Money,
  createdAt: Instant,
  businessDate: z.iso.date(),
  clientVersion: z.string().min(1),
});
export type CustomerCollectionV1 = z.infer<typeof CustomerCollectionV1>;

const MOVEMENT_TARGET = {
  expense: 'expenseCategoryId',
  supplier_payment: 'partyId',
  bank_deposit: 'bankAccountId',
  to_safe: null,
  from_safe: null,
} as const;

/** Cash out of the drawer (CSH-06), or between the drawer and the safe (owner answer 3 to W1-11). */
export const CashMovementV1 = z
  .strictObject({
    version: z.literal(1),
    id: z.uuid(),
    family: z.literal('M'),
    seq: z.int().positive(),
    number: DeskNumber('M'),
    kind: z.enum(['expense', 'supplier_payment', 'bank_deposit', 'to_safe', 'from_safe']),
    deviceId: z.uuid(),
    branchId: z.uuid(),
    sessionId: z.uuid(),
    cashierId: z.uuid(),
    amount: z.int().positive(),
    expenseCategoryId: z.uuid().nullable(),
    partyId: z.uuid().nullable(),
    bankAccountId: z.uuid().nullable(),
    targetName: z.string().min(1).nullable(),
    note: Note,
    reference: Reference,
    createdAt: Instant,
    businessDate: z.iso.date(),
    clientVersion: z.string().min(1),
  })
  .refine(
    (d) =>
      (['expenseCategoryId', 'partyId', 'bankAccountId'] as const).every(
        (field) => (d[field] !== null) === (MOVEMENT_TARGET[d.kind] === field),
      ),
    { message: 'each kind names exactly its own category, supplier or bank account' },
  )
  .refine((d) => d.note !== null || MOVEMENT_TARGET[d.kind] === null, {
    message: 'a cash-out needs a note',
  });
export type CashMovementV1 = z.infer<typeof CashMovementV1>;

/** Counts per denomination, keyed by the denomination in minor units. */
const Denominations = z.record(z.string().regex(/^[1-9]\d*$/), z.int().nonnegative());

/** A session's open (with its float and what stayed at the last close) or its counted close (CSH-07). */
export const CashSessionV2 = z
  .strictObject({
    version: z.literal(2),
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
    floatExpected: NonNegativeMoney.nullable(),
    countedCash: NonNegativeMoney.nullable(),
    denominations: Denominations.nullable(),
    variance: Money.nullable(),
    varianceReason: z
      .enum([
        'change_error',
        'wrong_bill_confirmed',
        'unrecorded_cash_out',
        'counterfeit_note',
        'unknown',
        'other',
      ])
      .nullable(),
    varianceNote: Note,
    acknowledgedByUserId: z.uuid().nullable(),
    leftInDrawer: NonNegativeMoney.nullable(),
    createdAt: Instant,
    businessDate: z.iso.date(),
    clientVersion: z.string().min(1),
  })
  .refine(
    (d) =>
      d.event === 'open'
        ? d.openingFloat !== null &&
          d.sessionId === d.id &&
          [d.expectedCash, d.countedCash, d.denominations, d.variance, d.leftInDrawer].every(
            (v) => v === null,
          ) &&
          d.varianceReason === null &&
          d.acknowledgedByUserId === null
        : d.openingFloat === null &&
          d.floatExpected === null &&
          d.sessionId !== d.id &&
          d.expectedCash !== null &&
          d.countedCash !== null &&
          d.denominations !== null &&
          d.variance === d.countedCash - d.expectedCash &&
          d.leftInDrawer !== null &&
          d.leftInDrawer <= d.countedCash &&
          (d.variance === 0
            ? d.varianceReason === null && d.acknowledgedByUserId === null
            : d.varianceReason !== null),
    {
      message:
        'an open carries its float and is its own session; a close carries its count, its variance (with a reason when not 0) and what stayed',
    },
  );
export type CashSessionV2 = z.infer<typeof CashSessionV2>;
