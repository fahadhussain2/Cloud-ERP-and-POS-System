import { money, mulQty, type Money } from './money';
import { qty } from './quantity';

// Stock operations in the back office (W1-18; INV-03, INV-04, INV-05; owner answers 1–4; D-107). Pure; money in
// paisa, quantities in thousandths (CLAUDE.md rule 1). The API checks with these before it saves, posts, sends or
// receives; the back office as you type. Stock may go below 0: that is a warning, never a problem (INV-03).

/** Why stock is corrected (owner answer 1 to W1-18). A write-off takes damaged goods out of the books. */
export const ADJUSTMENT_REASONS = [
  'found',
  'lost',
  'damaged',
  'theft',
  'count_correction',
  'write_off',
  'other',
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export type LocationKind = 'shop' | 'storage' | 'damaged' | 'transit';

const whole = (v: number) => Number.isSafeInteger(v);

/** Each line's item, once; `repeated` for the lines after the first with the same item. */
function repeatedRows(lines: { itemId: string | null }[]): Set<number> {
  const seen = new Set<string>();
  const out = new Set<number>();
  lines.forEach((l, row) => {
    if (!l.itemId) return;
    if (seen.has(l.itemId)) out.add(row);
    seen.add(l.itemId);
  });
  return out;
}

export interface TransferCheckInput {
  fromLocationId: string | null;
  toLocationId: string | null;
  fromKind: LocationKind | null;
  toKind: LocationKind | null;
  lines: {
    itemId: string | null;
    qty: number;
    allowsFraction: boolean;
    /** What the source has now; null = not known. */
    available: number | null;
  }[];
}

export type TransferProblem =
  | 'from_required'
  | 'to_required'
  | 'same_location'
  | 'transit_location'
  | 'lines_required'
  | 'item_required'
  | 'qty_positive'
  | 'qty_fraction'
  | 'item_repeated';

export type StockWarning = 'below_zero';

/** A transfer before it is posted or sent (INV-04): problems block it, warnings don't. */
export function checkTransfer(input: TransferCheckInput): {
  problems: { problem: TransferProblem; row: number | null }[];
  warnings: { warning: StockWarning; row: number }[];
} {
  const problems: { problem: TransferProblem; row: number | null }[] = [];
  const header = (p: TransferProblem) => problems.push({ problem: p, row: null });
  if (!input.fromLocationId) header('from_required');
  if (!input.toLocationId) header('to_required');
  if (input.fromLocationId && input.fromLocationId === input.toLocationId) header('same_location');
  // Stock gets into In transit only by sending, and out of it only by receiving (owner answer 4).
  else if (input.fromKind === 'transit' || input.toKind === 'transit') header('transit_location');
  if (input.lines.length === 0) header('lines_required');
  const repeated = repeatedRows(input.lines);
  const warnings: { warning: StockWarning; row: number }[] = [];
  input.lines.forEach((l, row) => {
    if (!l.itemId) problems.push({ problem: 'item_required', row });
    if (!whole(l.qty) || l.qty <= 0) problems.push({ problem: 'qty_positive', row });
    else if (!l.allowsFraction && l.qty % 1000 !== 0) problems.push({ problem: 'qty_fraction', row });
    else if (l.available !== null && l.qty > l.available) warnings.push({ warning: 'below_zero', row });
    if (repeated.has(row)) problems.push({ problem: 'item_repeated', row });
  });
  return { problems, warnings };
}

export interface TransferReceiptInput {
  lines: { sent: number; received: number; allowsFraction: boolean }[];
}

export type TransferReceiptProblem = 'received_invalid' | 'more_than_sent' | 'qty_fraction';

/**
 * What arrived of a sent transfer (owner answer 4): from 0 up to what was sent. The rest of each line is the
 * shortfall, a loss out of In transit; empty while there is a problem.
 */
export function checkTransferReceipt(input: TransferReceiptInput): {
  problems: { problem: TransferReceiptProblem; row: number }[];
  shortfall: { row: number; qty: number }[];
} {
  const problems: { problem: TransferReceiptProblem; row: number }[] = [];
  input.lines.forEach((l, row) => {
    if (!whole(l.received) || l.received < 0) problems.push({ problem: 'received_invalid', row });
    else if (l.received > l.sent) problems.push({ problem: 'more_than_sent', row });
    else if (!l.allowsFraction && l.received % 1000 !== 0) problems.push({ problem: 'qty_fraction', row });
  });
  if (problems.length > 0) return { problems, shortfall: [] };
  const shortfall = input.lines.map((l, row) => ({ row, qty: l.sent - l.received })).filter((s) => s.qty > 0);
  return { problems, shortfall };
}

export interface AdjustmentCheckInput {
  locationId: string | null;
  locationKind: LocationKind | null;
  reason: string | null;
  note: string | null;
  lines: {
    itemId: string | null;
    /** Above 0 found, below 0 gone. */
    qty: number;
    allowsFraction: boolean;
    /** What the location has now; null = not known. */
    onHand: number | null;
  }[];
}

export type AdjustmentProblem =
  | 'location_required'
  | 'reason_required'
  | 'reason_unknown'
  | 'note_required'
  | 'write_off_not_damaged'
  | 'lines_required'
  | 'item_required'
  | 'qty_zero'
  | 'qty_fraction'
  | 'item_repeated'
  | 'write_off_gain';

/** An adjustment before it is posted (INV-05): problems block it, warnings don't. */
export function checkAdjustment(input: AdjustmentCheckInput): {
  problems: { problem: AdjustmentProblem; row: number | null }[];
  warnings: { warning: StockWarning; row: number }[];
} {
  const problems: { problem: AdjustmentProblem; row: number | null }[] = [];
  const header = (p: AdjustmentProblem) => problems.push({ problem: p, row: null });
  if (!input.locationId) header('location_required');
  if (input.reason === null) header('reason_required');
  else if (!(ADJUSTMENT_REASONS as readonly string[]).includes(input.reason)) header('reason_unknown');
  else if (input.reason === 'other' && (input.note ?? '').trim() === '') header('note_required');
  // Writing off is taking damaged goods out of the books (posting rules §5.3).
  const writeOff = input.reason === 'write_off';
  if (writeOff && input.locationKind !== 'damaged') header('write_off_not_damaged');
  if (input.lines.length === 0) header('lines_required');
  const repeated = repeatedRows(input.lines);
  const warnings: { warning: StockWarning; row: number }[] = [];
  input.lines.forEach((l, row) => {
    if (!l.itemId) problems.push({ problem: 'item_required', row });
    if (!whole(l.qty) || l.qty === 0) problems.push({ problem: 'qty_zero', row });
    else if (!l.allowsFraction && l.qty % 1000 !== 0) problems.push({ problem: 'qty_fraction', row });
    else if (writeOff && l.qty > 0) problems.push({ problem: 'write_off_gain', row });
    else if (l.qty < 0 && l.onHand !== null && l.onHand + l.qty < 0)
      warnings.push({ warning: 'below_zero', row });
    if (repeated.has(row)) problems.push({ problem: 'item_repeated', row });
  });
  return { problems, warnings };
}

export interface AdjustmentApprovalInput {
  /** The one posting it may approve large losses (inv.adjust.approve): the owner. */
  canApprove: boolean;
  /** Minor units: a loss above this waits for approval (owner answer 3: Rs 10,000 by default). */
  limit: number;
  /** `avgCost` null = no cost known, valued at 0. */
  lines: { qty: number; avgCost: number | null }[];
}

/**
 * An adjustment's gain and loss at the average, and whether it waits for the owner (owner answer 3): only losses
 * count, and only when the one posting it can't approve them.
 */
export function adjustmentApproval(input: AdjustmentApprovalInput): {
  gain: Money;
  loss: Money;
  needsApproval: boolean;
} {
  let gain = 0;
  let loss = 0;
  for (const l of input.lines) {
    const value = mulQty(qty(Math.abs(l.qty)), money(l.avgCost ?? 0));
    if (l.qty > 0) gain += value;
    else loss += value;
  }
  return {
    gain: money(gain),
    loss: money(loss),
    needsApproval: !input.canApprove && loss > input.limit,
  };
}
