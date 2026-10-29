import type { Money, PaymentMethodCode, Qty, SystemRole } from '@erp/domain';

// What the posting engine reads and writes (posting rules §1–§4, data model §3, §7, §9, W1-08). Pure data: the
// database layer loads it, the engine computes the ledger rows, the database layer writes them.

/** The roles a posting can need; `SUSPENSE` takes the difference of a bill that doesn't add up (D-095). */
export type PostingRole = SystemRole | 'SUSPENSE';

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
  | { code: 'on_account_without_customer' };

export type PostingResult = { ok: true; posting: Posting } | { ok: false; error: PostingError };
