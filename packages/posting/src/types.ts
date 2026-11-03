import type { CashMovementKind, Money, PaymentMethodCode, Qty, SystemRole } from '@erp/domain';

// What the posting engine reads and writes (posting rules §1–§4, data model §3, §7, §9, W1-08). Pure data: the
// database layer loads it, the engine computes the ledger rows, the database layer writes them.

/** The roles a posting can need (posting rules §2); `SUSPENSE` takes the difference of a bill that doesn't add up. */
export type PostingRole = SystemRole;

/** A finalized sale as posting needs it: the stored document, with each line's id, location and tax. */
export interface PostingSale {
  id: string;
  number: string;
  branchId: string;
  businessDate: string;
  customerId: string | null;
  lines: PostingSaleLine[];
  amounts: { billDiscount: Money; rounding: Money; taxTotal: Money };
  /** In the order on the bill. Cash is already net of change. */
  payments: { method: PaymentMethodCode; amount: Money }[];
}

/** A stored cash handover or refund payout as posting needs it (posting rules §4.5, W1-10). */
export interface PostingHandover {
  id: string;
  /** The handover's own number, e.g. `D01-H000031`. */
  number: string;
  billNumber: string;
  branchId: string;
  businessDate: string;
  kind: 'in' | 'payout';
  /** Positive: the cash due, or the refund. Never the cash received or the change. */
  amount: Money;
}

/** A stored void as posting needs it (posting rules §4.4, W1-12): it reverses its sale's own posting. */
export interface PostingVoid {
  id: string;
  /** The void's own number, e.g. `C03-V000001`. */
  number: string;
  saleNumber: string;
  branchId: string;
  businessDate: string;
}

/** A stored customer collection as posting needs it (posting rules §4.5, W1-11). */
export interface PostingCollection {
  id: string;
  /** e.g. `D01-R000001`. */
  number: string;
  branchId: string;
  businessDate: string;
  partyId: string;
  method: PaymentMethodCode;
  amount: Money;
}

/** A stored cash-out or safe movement as posting needs it (posting rules §4.5, W1-11). */
export interface PostingCashMovement {
  id: string;
  number: string;
  branchId: string;
  businessDate: string;
  kind: CashMovementKind;
  amount: Money;
  /** The supplier, for a supplier payment. */
  partyId: string | null;
  /** The expense category or bank account whose account it goes to (`PostingContext.accounts.targets`). */
  targetId: string | null;
}

/** A stored session open or close as posting needs it (posting rules §4.5, owner answer 3 to W1-11). */
export interface PostingSessionEvent {
  id: string;
  number: string;
  branchId: string;
  businessDate: string;
  event: 'open' | 'close';
  /** An open's float, and what stayed at the desk's last close (null for its first session). */
  openingFloat: Money | null;
  floatExpected: Money | null;
  /** A close's counted − expected; null without a count (W1-10). */
  variance: Money | null;
  /** What the close sent to the safe; 0 on an open. */
  toSafe: Money;
}

export interface PostingSaleLine {
  id: string;
  lineNo: number;
  itemId: string;
  locationId: string;
  /** Thousandths, above 0 for a sold line. */
  qty: Qty;
  /** After the line discount, before the bill discount. */
  lineTotal: Money;
  taxAmount: Money;
}

/**
 * The settings a posting uses, kept on its `postings` row so a rebuild uses the same ones (D-095).
 * Accounts are account ids. A method mapped to null (cash, on account) is routed by role.
 */
export interface PostingContext {
  accounts: {
    roles: Partial<Record<PostingRole, string>>;
    methods: Partial<Record<PaymentMethodCode, string | null>>;
    /** Expense categories and bank accounts by id, to their account (desk cash-outs, W1-11). */
    targets?: Partial<Record<string, string>>;
  };
  /** Nothing posts on or before it (posting rules §1.6). */
  lockDate: string | null;
  /** The sale's customer, when it has one. */
  customer: { paymentTermsDays: number | null } | null;
}

/** One item's tenant-wide average and quantity on hand (D-017). `avgCost` null = no cost known yet. */
export interface CostState {
  avgCost: Money | null;
  onHand: Qty;
}

/**
 * The derived figures postings depend on: costs by item, balances by location then item.
 * An item or location that isn't there counts as no cost and 0 on hand.
 */
export interface LedgerState {
  costs: Record<string, CostState>;
  balances: Record<string, Record<string, Qty>>;
}

/** One side only: `debit` or `credit` is 0, never both. */
export interface JournalLine {
  accountId: string;
  /** The customer or supplier, on AR and AP lines. */
  partyId: string | null;
  debit: Money;
  credit: Money;
}

export interface StockMovement {
  sourceLineId: string;
  itemId: string;
  locationId: string;
  qtyDelta: Qty;
  unitCost: Money;
  valueDelta: Money;
  avgCostAfter: Money | null;
}

export interface PartyEntry {
  partyId: string;
  role: 'customer' | 'supplier';
  /** Positive = they owe more (a customer) or we owe more (a supplier). */
  amount: Money;
  dueDate: string;
}

export type PostingException =
  | { kind: 'no_cost'; details: { itemId: string } }
  | { kind: 'negative_stock'; details: { itemId: string; locationId: string; balance: Qty } }
  | { kind: 'posted_after_lock'; details: { businessDate: string; lockDate: string } };

export interface Posting {
  /** The business date, or the day after the lock date when that is later. */
  entryDate: string;
  /**
   * Lines in a fixed order: the tenders (in payment order, one line per account), then SALES, SALES_DISCOUNT,
   * ROUNDING, TAX_PAYABLE, SUSPENSE, COGS, INVENTORY. Zero lines are left out.
   */
  journal: { branchId: string; memo: string; lines: JournalLine[] };
  movements: StockMovement[];
  partyEntries: PartyEntry[];
  /** Document-level first, then in line order. */
  exceptions: PostingException[];
  /** The costs and balances this posting changed, as they are after it. */
  state: LedgerState;
}

export type PostingError =
  | { code: 'method_unmapped'; method: PaymentMethodCode }
  | { code: 'role_unmapped'; role: PostingRole }
  | { code: 'on_account_without_customer' }
  | { code: 'target_unmapped'; targetId: string | null }
  | { code: 'party_missing' }
  /** A void whose sale has no posting yet: it waits for it (W1-12). */
  | { code: 'sale_not_posted' };

export type PostingResult = { ok: true; posting: Posting } | { ok: false; error: PostingError };
