import { z } from 'zod';

// Customers in the back office (W1-22 plan; POS-05, POS-07, CAT-04, PUR-01, ACC-03; D-109). Money in paisa as
// integers (CLAUDE.md rule 1). A customer is a party with a live customer account; the counters get both through
// the W1-09 pull.

const Id = z.uuid();
const RowVersion = z.string().regex(/^\d+$/);
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => (s.trim() === '' ? null : s.trim()))
    .nullable();
const Money = z.number().int().min(0).max(1_000_000_000_000);

/** Tier and credit: only with cust.terms.edit (owner answer 2). */
export const CustomerTerms = z.strictObject({
  tierId: Id,
  creditAllowed: z.boolean(),
  /** Null = no limit (D-085), accepted with credit only when `noLimit` says so on purpose (owner answer 3). */
  creditLimit: Money.nullable(),
  noLimit: z.boolean().default(false),
  offlineDailyCap: Money,
  termsDays: z.number().int().min(0).max(365).nullable(),
});
export type CustomerTerms = z.input<typeof CustomerTerms>;

const Details = {
  name: z.string().trim().min(1).max(120),
  contactPerson: Text(120).optional(),
  phones: z.array(z.string().trim().min(1).max(30)).max(5).optional(),
  address: Text(240).optional(),
  city: Text(60).optional(),
  notes: Text(500).optional(),
};

const NewCustomer = z.strictObject({
  code: z.string().trim().min(1).max(20),
  ...Details,
  terms: CustomerTerms.optional(),
});

/** An existing supplier who also buys (owner answer 8, PUR-01): the same party gets a customer account. */
const FromSupplier = z.strictObject({ partyId: Id, terms: CustomerTerms.optional() });

export const CreateCustomerRequest = z.union([NewCustomer, FromSupplier]);
export type CreateCustomerRequest = z.input<typeof CreateCustomerRequest>;

export const UpdateCustomerRequest = z.strictObject({
  /** The party's row version, and the account's when terms are sent. */
  rowVersion: RowVersion,
  accountVersion: RowVersion.optional(),
  name: Details.name.optional(),
  contactPerson: Details.contactPerson,
  phones: Details.phones,
  address: Details.address,
  city: Details.city,
  notes: Details.notes,
  status: z.enum(['active', 'inactive']).optional(),
  terms: CustomerTerms.optional(),
});
export type UpdateCustomerRequest = z.input<typeof UpdateCustomerRequest>;

export interface CustomerRow {
  id: string;
  code: string;
  name: string;
  phones: string[];
  city: string | null;
  tierId: string;
  tierName: string;
  creditAllowed: boolean;
  creditLimit: number | null;
  offlineDailyCap: number;
  termsDays: number | null;
  status: 'active' | 'inactive';
  /** What the customer owes (+) or has paid in advance (−), from the ledger. */
  balance: number;
  /** Never used anywhere, so Delete is offered (owner answer 5). */
  deletable: boolean;
  /** Came from the legacy import (owner answer 6). */
  imported: boolean;
  /** The party is also a supplier (PUR-01). */
  supplier: boolean;
}

export interface CustomerLedgerLine {
  entryDate: string;
  dueDate: string;
  kind: string;
  sourceId: string;
  number: string;
  amount: number;
  balance: number;
}

export interface CustomerDetail {
  customer: CustomerRow & {
    contactPerson: string | null;
    address: string | null;
    notes: string | null;
    rowVersion: string;
    accountVersion: string;
  };
  balance: number;
  ledger: CustomerLedgerLine[];
}

export interface CustomerLookups {
  tiers: { id: string; code: string; name: string; isDefault: boolean }[];
  defaultOfflineDailyCap: number;
  /** Live suppliers without a customer account, for "From an existing supplier". */
  suppliers: { id: string; code: string; name: string }[];
  /** The shop is live (`go_live_at`); before that, imported customers show the notice. */
  live: boolean;
  money: { locale: string; currency: string; minorUnits: number };
  can: { edit: boolean; terms: boolean };
}
