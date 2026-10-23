import { z } from 'zod';

// A tenant described as reviewable data (PLT-11, D-083): `infra/db/tenants/<code>.json`. No secrets.

const code = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);

export const TenantSpec = z.object({
  /** The shop code for login (tenant_directory). */
  code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
  name: z.string().min(1).max(120),
  legalName: z.string().min(1).max(200).nullable(),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  currencyMinorUnits: z.int().min(0).max(3),
  timezone: z.string().min(1),
  locale: z.string().min(2),
  fiscalYearStartMonth: z.int().min(1).max(12),
  taxMode: z.enum(['none', 'inclusive', 'exclusive']),
  /** Minor units, e.g. 100 = Rs 1. */
  cashRoundingIncrement: z.int().positive(),
  dayCutoffHour: z.int().min(0).max(23),
  closingTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  cashHandoverMode: z.enum(['required', 'off']),
  branch: z.object({
    code,
    name: z.string().min(1),
    address: z.string().optional(),
    phone: z.string().optional(),
    receiptHeader: z.record(z.string(), z.unknown()).default({}),
  }),
  locations: z
    .array(
      z.object({
        code,
        name: z.string().min(1),
        kind: z.enum(['shop', 'storage', 'damaged']),
        isSellable: z.boolean(),
      }),
    )
    .min(1),
  chartTemplate: z.literal('retail'),
  /** Banks, wallets and card clearing, each with its own asset account under "Cash and bank" (1100). */
  bankAccounts: z.array(
    z.object({
      code,
      name: z.string().min(1),
      kind: z.enum(['bank', 'wallet', 'card_clearing']),
      accountCode: z.string().regex(/^\d{3,6}$/),
    }),
  ),
  /** Cash and on-account have no account (the posting engine routes them); other methods name a bank account. */
  paymentMethods: z.array(
    z.object({
      code: z.enum(['cash', 'bank_transfer', 'raast', 'jazzcash', 'easypaisa', 'card', 'on_account']),
      name: z.string().min(1),
      bankAccount: code.nullable(),
    }),
  ),
  priceTiers: z.array(z.object({ code, name: z.string().min(1), isDefault: z.boolean() })).min(1),
  taxCodes: z.array(z.object({ code, name: z.string().min(1), rateBp: z.int().min(0).max(10_000) })).min(1),
  expenseCategories: z.array(z.object({ code, name: z.string().min(1), accountCode: z.string() })),
  printProfile: z.object({
    name: z.string().min(1),
    paperFormat: z.enum(['a4', 'a5', 'thermal_80', 'thermal_58']),
    codeType: z.enum(['barcode', 'signed_qr']),
    copies: z.union([z.literal(1), z.literal(2)]),
    templateOptions: z.record(z.string(), z.unknown()).default({}),
  }),
  owner: z.object({ username: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), fullName: z.string().min(1) }),
});
export type TenantSpec = z.infer<typeof TenantSpec>;
