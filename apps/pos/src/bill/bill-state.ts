import {
  addLine,
  changeTier,
  DomainError,
  emptyBill,
  parseQty,
  QTY_SCALE,
  type Bill,
  type DomainErrorCode,
  type Money,
  type Qty,
} from '@erp/domain';

import type { BillItem } from '../search/search-index';
import type { BillCustomer, LineItem, OpenBill } from './open-bill';

// The counter's side of the bill (POS spec §10): the domain rules do the work; this keeps the items' display details
// next to the bill and turns typed text into what the rules take.

export const newOpenBill = (sellerId: string, tierId: string): OpenBill => ({
  version: 1,
  bill: emptyBill(sellerId, tierId),
  items: {},
});

/** Runs a domain edit; a rule it breaks comes back as its error code (shown through i18n), anything else is thrown. */
export function tryEdit(
  ob: OpenBill,
  edit: (bill: Bill) => Bill,
): { ok: true; bill: OpenBill } | { ok: false; error: DomainErrorCode } {
  try {
    const bill = edit(ob.bill);
    // Keep only the display details of items still on the bill.
    const items = Object.fromEntries(
      Object.entries(ob.items).filter(([id]) => bill.lines.some((l) => l.itemId === id)),
    );
    return { ok: true, bill: { ...ob, bill, items } };
  } catch (err) {
    if (err instanceof DomainError) return { ok: false, error: err.code };
    throw err;
  }
}

/** Adds a catalog item (with a typed price when it has none) and keeps what its line shows. */
export function addItem(ob: OpenBill, item: BillItem, qty: Qty, lineId: string, unitPrice?: Money) {
  const { itemId, code, name, variant, spec } = item;
  const shown: LineItem = { code, name, variant, spec };
  return tryEdit({ ...ob, items: { ...ob.items, [itemId]: shown } }, (b) =>
    addLine(b, item, qty, lineId, unitPrice),
  );
}

/**
 * Who the bill is for (POS spec §15): a customer and their tier, or a walk-in (with an optional phone) and the
 * default tier. The tier changes as `F7` would change it: lines at list move, bargained lines are checked again.
 */
export function setCustomer(
  ob: OpenBill,
  who: { customer: BillCustomer | null; walkinPhone: string | null },
  tierId: string,
  prices: Readonly<Record<string, Money | null>>,
) {
  const r = tryEdit(ob, (b) => (b.tierId === tierId ? b : changeTier(b, tierId, prices)));
  if (!r.ok) return r;
  return {
    ok: true as const,
    bill: { ...r.bill, customer: who.customer, walkinPhone: who.customer ? null : who.walkinPhone },
  };
}

const PREFIX = /^\s*(\d+(?:\.\d+)?)\s*\*\s*(.*)$/s;

/** `2*brake pads` → 2 of the first result for "brake pads"; `1.5*hose` → 1.5 m (POS spec §11). No prefix: 1. */
export function quantityPrefix(text: string): { qty: Qty; query: string } {
  const m = PREFIX.exec(text);
  if (!m) return { qty: QTY_SCALE as Qty, query: text };
  try {
    return { qty: parseQty(m[1]!), query: m[2]! };
  } catch {
    // More than 3 decimals: not a quantity, so search for the text as typed.
    return { qty: QTY_SCALE as Qty, query: text };
  }
}

/** Typed quantity → thousandths, or the rule it breaks. */
export function parseQuantity(text: string): Qty | DomainErrorCode {
  try {
    return parseQty(text);
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
}

/**
 * A quantity as people read it: 2, 1.5, 1.005. The decimal text is built from the integer thousandths (no float), then
 * formatted for the locale, as formatMoney does with money.
 */
export function formatQty(q: Qty, locale: string): string {
  const abs = Math.abs(q);
  const fraction = String(abs % QTY_SCALE)
    .padStart(3, '0')
    .replace(/0+$/, '');
  const decimal = `${q < 0 ? '-' : ''}${(abs - (abs % QTY_SCALE)) / QTY_SCALE}${fraction ? `.${fraction}` : ''}`;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(
    decimal as Intl.StringNumericLiteral,
  );
}
