import { z } from 'zod';

// Back-office accounting (W1-19 plan; ACC-04, ACC-05, ACC-06, part of ACC-07; owner answers 1–6; D-108). Money in
// paisa as integers (CLAUDE.md rule 1); dates as YYYY-MM-DD. `safe` stands for the shop's safe wherever a bank account
// could be named.

const Id = z.uuid();
const Day = z.iso.date();
const RowVersion = z.string().regex(/^\d+$/);
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => (s.trim() === '' ? null : s.trim()))
    .nullable();
/** A bank account, or the safe. */
const End = z.union([Id, z.literal('safe')]);
const Amount = z.number().int().positive().max(1_000_000_000_000);

export const CustomerReceiptRequest = z.strictObject({
  customerId: Id,
  bankAccountId: Id,
  amount: Amount,
  receivedOn: Day,
  reference: Text(60),
  note: Text(300),
  /** Save it although the same one looks recorded already (the warning was shown). */
  allowDuplicate: z.boolean().default(false),
});
export type CustomerReceiptRequest = z.input<typeof CustomerReceiptRequest>;

export const ExpenseRequest = z.strictObject({
  categoryId: Id,
  paidFrom: End,
  amount: Amount,
  paidOn: Day,
  reference: Text(60),
  note: Text(300),
  allowDuplicate: z.boolean().default(false),
});
export type ExpenseRequest = z.input<typeof ExpenseRequest>;

export const FundTransferRequest = z.strictObject({
  from: End,
  to: End,
  amount: Amount,
  /** Taken on the way, to its category (owner answer 6). */
  charges: z.number().int().min(0).default(0),
  chargesCategoryId: Id.nullable().default(null),
  movedOn: Day,
  reference: Text(60),
  note: Text(300),
  allowDuplicate: z.boolean().default(false),
});
export type FundTransferRequest = z.input<typeof FundTransferRequest>;

/** A journal voucher as the accountant types it; anything may be half-done until it is posted. */
export const VoucherDraft = z.strictObject({
  date: Day,
  narration: Text(300),
  lines: z
    .array(
      z.strictObject({
        accountId: Id.nullable(),
        partyId: Id.nullable(),
        debit: z.number().int().min(0),
        credit: z.number().int().min(0),
        memo: Text(200),
      }),
    )
    .max(100),
});
export type VoucherDraft = z.input<typeof VoucherDraft>;
export const SaveVoucherRequest = VoucherDraft.extend({ rowVersion: RowVersion });
export const PostVoucherRequest = z.strictObject({ rowVersion: RowVersion });

export const REVERSIBLE_TYPES = [
  'customer_receipt',
  'expense',
  'fund_transfer',
  'supplier_payment',
  'journal_voucher',
] as const;
export type ReversibleType = (typeof REVERSIBLE_TYPES)[number];

export const ReverseRequest = z.strictObject({ type: z.enum(REVERSIBLE_TYPES), id: Id, date: Day });
export type ReverseRequest = z.infer<typeof ReverseRequest>;

/** Move the lock date (owner answer 5): forward by acc.period.close, back by acc.period.reopen with a reason. */
export const LockRequest = z.strictObject({ lockDate: Day, reason: Text(300) });
export type LockRequest = z.input<typeof LockRequest>;

export const CreateAccountRequest = z.strictObject({
  parentId: Id,
  code: z.string().regex(/^[0-9]{3,6}$/),
  name: z.string().trim().min(1).max(120),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>;
export const UpdateAccountRequest = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  active: z.boolean().optional(),
});
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequest>;

export const CreateExpenseCategoryRequest = z.strictObject({
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(120),
  accountId: Id,
});
export type CreateExpenseCategoryRequest = z.infer<typeof CreateExpenseCategoryRequest>;
export const UpdateExpenseCategoryRequest = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  accountId: Id.optional(),
  active: z.boolean().optional(),
});
export type UpdateExpenseCategoryRequest = z.infer<typeof UpdateExpenseCategoryRequest>;

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  parentId: string | null;
  postable: boolean;
  active: boolean;
  role: string | null;
}

export interface AccountingLookups {
  live: boolean;
  /** The shop's business date now. */
  today: string;
  lockDate: string | null;
  fiscalYearStartMonth: number;
  money: { currency: string; minorUnits: number; locale: string };
  banks: {
    id: string;
    code: string;
    name: string;
    kind: 'bank' | 'wallet' | 'card_clearing';
    accountId: string;
  }[];
  categories: { id: string; code: string; name: string; accountId: string; active: boolean }[];
  accounts: AccountRow[];
  can: {
    receipt: boolean;
    expense: boolean;
    transfer: boolean;
    journal: boolean;
    close: boolean;
    reopen: boolean;
    chart: boolean;
    financial: boolean;
  };
}

export interface PartyHit {
  id: string;
  code: string;
  name: string;
  customer: boolean;
  supplier: boolean;
  /** What the customer owes (+), and what we owe the supplier (+). */
  customerBalance: number;
  supplierBalance: number;
}

export type AccountingDocumentType = ReversibleType;

/** One row of the money list: every receipt, expense, transfer, supplier payment and voucher. */
export interface AccountingDocumentRow {
  type: AccountingDocumentType;
  id: string;
  /** null for a voucher still a draft. */
  number: string | null;
  date: string;
  status: 'draft' | 'posted';
  amount: number;
  /** The customer, supplier, category, route or narration. */
  description: string;
  reference: string | null;
  reversedBy: { id: string; number: string } | null;
  reverses: { type: AccountingDocumentType; id: string; number: string } | null;
}

export interface JournalLineView {
  accountId: string;
  accountCode: string;
  accountName: string;
  partyName: string | null;
  debit: number;
  credit: number;
}

export interface AccountingDocumentView extends AccountingDocumentRow {
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  /** Its posting as stored; empty for a draft voucher. */
  journal: { number: string | null; entryDate: string | null; lines: JournalLineView[] };
  canReverse: boolean;
}

export interface VoucherView {
  id: string;
  number: string | null;
  status: 'draft' | 'posted';
  date: string;
  narration: string | null;
  rowVersion: string;
  lines: {
    accountId: string | null;
    partyId: string | null;
    partyName: string | null;
    debit: number;
    credit: number;
    memo: string | null;
  }[];
  check: { problems: { problem: string; row: number | null }[]; debit: number; credit: number };
  updatedBy: string | null;
  updatedAt: string;
}

export interface PeriodsView {
  startMonth: number;
  /** Fixed once the first month is locked (D-035). */
  startMonthFixed: boolean;
  lockDate: string | null;
  today: string;
  years: {
    label: string;
    start: string;
    end: string;
    months: { start: string; end: string; locked: boolean }[];
  }[];
  /** The next month end the lock can move to, when that month is over; null when none is. */
  next: string | null;
  /** Who last moved it, and why. */
  history: { at: string; by: string | null; from: string | null; to: string; reason: string | null }[];
}

/** What still looks open on or before a date, before it is locked (owner answer 5): shown, never blocking. */
export interface LockChecklist {
  lockDate: string;
  items: {
    kind:
      | 'draft_vouchers'
      | 'draft_receipts'
      | 'draft_returns'
      | 'draft_transfers'
      | 'draft_adjustments'
      | 'open_exceptions'
      | 'suspense'
      | 'cash_in_transit'
      | 'open_sessions';
    count: number;
    amount: number | null;
  }[];
}

export interface AccountBalanceRow extends AccountRow {
  /** Debits − credits up to the date, its children's included for a heading. */
  balance: number;
  /** Something uses it: a role, a bank, a category or a journal line. */
  inUse: boolean;
}

export interface LedgerView {
  account: AccountRow;
  from: string;
  to: string;
  /** Debits − credits before `from`. */
  opening: number;
  lines: {
    date: string;
    journalNumber: string;
    sourceType: string;
    sourceId: string;
    /** The document's own number, when it has one. */
    number: string | null;
    memo: string | null;
    partyName: string | null;
    debit: number;
    credit: number;
    balance: number;
  }[];
  closing: number;
  /** More lines than one page holds: narrow the dates. */
  truncated: boolean;
}
