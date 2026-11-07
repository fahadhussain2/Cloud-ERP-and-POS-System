import { z } from 'zod';

// Stock operations in the back office (W1-18 plan; INV-04, INV-05, INV-07; owner answers 1–4; D-107). Money in paisa
// and quantities in thousandths, as integers (CLAUDE.md rule 1); dates as YYYY-MM-DD.

const Id = z.uuid();
const Day = z.iso.date();
const RowVersion = z.string().regex(/^\d+$/);
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => (s.trim() === '' ? null : s.trim()))
    .nullable();

const Line = z.strictObject({ itemId: Id.nullable(), qty: z.number().int() });

/** A transfer draft as the storekeeper types it; everything may be half-done until it is posted. */
export const TransferDraft = z.strictObject({
  fromLocationId: Id.nullable(),
  toLocationId: Id.nullable(),
  movedOn: Day,
  note: Text(500),
  lines: z.array(Line).max(200),
});
export type TransferDraft = z.infer<typeof TransferDraft>;
export const SaveTransferRequest = TransferDraft.extend({ rowVersion: RowVersion });

/** What arrived of a sent transfer, per line (owner answer 4). */
export const ReceiveTransferRequest = z.strictObject({
  rowVersion: RowVersion,
  receivedOn: Day,
  lines: z.array(z.strictObject({ lineId: Id, receivedQty: z.number().int() })).max(200),
});
export type ReceiveTransferRequest = z.infer<typeof ReceiveTransferRequest>;

export const AdjustmentDraft = z.strictObject({
  locationId: Id.nullable(),
  adjustedOn: Day,
  reason: z.string().max(40).nullable(),
  note: Text(500),
  lines: z.array(Line).max(200),
});
export type AdjustmentDraft = z.infer<typeof AdjustmentDraft>;
export const SaveAdjustmentRequest = AdjustmentDraft.extend({ rowVersion: RowVersion });

export const StockPostRequest = z.strictObject({ rowVersion: RowVersion });

/** The owner sends an adjustment back to a draft, saying why. */
export const RejectAdjustmentRequest = z.strictObject({
  rowVersion: RowVersion,
  note: z.string().trim().min(1).max(500),
});

/** Inventory settings (owner only): the approval limit and the routes that need receiving. */
export const InventorySettingsRequest = z.strictObject({
  adjustmentApprovalLimit: z.number().int().min(0).max(1_000_000_000_000),
  routes: z
    .array(z.strictObject({ fromLocationId: Id, toLocationId: Id, needsReceiving: z.boolean() }))
    .max(100),
});
export type InventorySettingsRequest = z.infer<typeof InventorySettingsRequest>;

export type LocationKindName = 'shop' | 'storage' | 'damaged' | 'transit';

export interface InventoryLookups {
  /** The locations stock can be moved between or corrected at (not In transit). */
  locations: { id: string; code: string; name: string; kind: LocationKindName }[];
  /** Routes that need receiving; every other route moves at once. */
  routes: { fromLocationId: string; toLocationId: string; needsReceiving: boolean }[];
  /** Minor units: a loss above this waits for the owner (owner answer 3). */
  adjustmentApprovalLimit: number;
  reasons: string[];
  live: boolean;
  money: { locale: string; currency: string; minorUnits: number };
  can: {
    transfer: boolean;
    postTransfer: boolean;
    adjust: boolean;
    approve: boolean;
    viewCost: boolean;
    settings: boolean;
  };
}

/** An item found for a line: what the checks need, its stock per location, and its average with cost.view. */
export interface InventoryItem {
  id: string;
  code: string;
  name: string;
  allowsFraction: boolean;
  /** Thousandths by location id. */
  stock: Record<string, number>;
  avgCost: number | null;
}

export type TransferStatus = 'draft' | 'posted' | 'in_transit' | 'received';

export interface TransferView {
  transfer: {
    id: string;
    number: string | null;
    status: TransferStatus;
    fromLocationId: string;
    toLocationId: string;
    movedOn: string;
    note: string | null;
    /** The route needs receiving: posting sends it. */
    needsReceiving: boolean;
    receivedOn: string | null;
    postedBy: string | null;
    receivedBy: string | null;
    rowVersion: string;
  };
  lines: {
    id: string;
    lineNo: number;
    itemId: string | null;
    code: string | null;
    name: string | null;
    qty: number;
    receivedQty: number | null;
    allowsFraction: boolean;
    available: number | null;
  }[];
  check: {
    problems: { problem: string; row: number | null }[];
    warnings: { warning: string; row: number }[];
  };
  /** The loss adjustment that records a shortfall on arrival. */
  shortfallAdjustment: { id: string; number: string | null; status: AdjustmentStatus } | null;
}

export type AdjustmentStatus = 'draft' | 'awaiting_approval' | 'posted';

export interface AdjustmentView {
  adjustment: {
    id: string;
    number: string | null;
    status: AdjustmentStatus;
    locationId: string;
    adjustedOn: string;
    reason: string | null;
    note: string | null;
    transfer: { id: string; number: string | null } | null;
    submittedBy: string | null;
    approvedBy: string | null;
    rejection: { by: string | null; at: string; note: string | null } | null;
    rowVersion: string;
  };
  lines: {
    id: string;
    lineNo: number;
    itemId: string | null;
    code: string | null;
    name: string | null;
    qty: number;
    allowsFraction: boolean;
    onHand: number | null;
    /** With cost.view: the item's average now (or when it was put up for approval). */
    avgCost: number | null;
  }[];
  check: {
    problems: { problem: string; row: number | null }[];
    warnings: { warning: string; row: number }[];
  };
  /** With cost.view: the gain and the loss at the average. */
  value: { gain: number; loss: number } | null;
  /** Posting it now would wait for the owner. */
  needsApproval: boolean;
}

export interface StockDocumentRow {
  id: string;
  number: string | null;
  status: string;
  date: string;
  /** Transfers: from → to; adjustments: the location and the reason. */
  fromLocationId: string | null;
  toLocationId: string | null;
  locationId: string | null;
  reason: string | null;
  lines: number;
  /** Adjustments awaiting approval: the loss the owner approves (with cost.view). */
  lossValue: number | null;
}

export interface StockCardView {
  item: { id: string; code: string; name: string };
  /** Thousandths by location id, now. */
  balances: Record<string, number>;
  /** Newest first. `balance` is the running balance at that location, `total` across all. */
  movements: {
    seq: number;
    date: string;
    kind: string;
    documentId: string;
    number: string | null;
    locationId: string;
    qty: number;
    unitCost: number | null;
    value: number | null;
    balance: number;
    total: number;
  }[];
  /** Pass as `before` for the next (older) page; null on the last. */
  next: number | null;
}

export interface TransferNeededRow {
  itemId: string;
  code: string;
  name: string;
  shop: number;
  godown: number;
  /** What a transfer Godown → Shop should move: enough to bring the Shop to 0, at most what the Godown has. */
  suggested: number;
}
