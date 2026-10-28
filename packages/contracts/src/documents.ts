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
const OverrideReason = z.enum(['customer_bargain', 'old_stock', 'market_price', 'regular_customer', 'other']);

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

const Override = z.strictObject({
  kind: z.enum(['below_list', 'below_floor']),
  lineNo: z.int().positive().nullable(),
  requestedBy: z.uuid(),
  approvedBy: z.uuid(),
  reason: OverrideReason,
  note: z.string().nullable(),
  at: Instant,
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
});

/**
 * A finalized sale, version 1 (sync spec §6.1, W1-06): what `buildSaleDocument` in `@erp/domain` makes and what the
 * server accepts in W1-07. Money is whole minor units, quantities thousandths. Unknown fields are refused.
 */
export const SaleDocumentV1 = z.strictObject({
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
  clientVersion: z.string().min(1),
});
export type SaleDocumentV1 = z.infer<typeof SaleDocumentV1>;
