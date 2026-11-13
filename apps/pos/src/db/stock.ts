import { qty } from '@erp/domain';

import type { StockQty } from '../search/search-index';
import { getSync } from './repo';
import type { SqlDb } from './sql';

// Stock on the counter (W1-27 plan, POS-02, POS spec §9): each item's quantity in the branch's Shop and Godown, as
// pulled (sync spec §3), less this counter's own bills the balance can't include yet (owner answer 1): still in the
// outbox, or accepted after the start of the last complete pull, the rule a customer's credit uses (POS spec §15).
// A sale leaves the Shop (as posting does, from the branch's first shop location); a voided one gives it back, also
// when only its void is still to reach the server; a resellable return adds to the Shop, a defective one goes to
// Damaged, which the counter doesn't show. A held bill isn't a document, so it doesn't count (owner answer 2).
// Information only: nothing here refuses a sale (INV-03).

interface Location {
  id: string;
  name: string;
  kind: 'shop' | 'storage';
}

/** The Shop first (the branch's first shop location by code, where a sale is taken from), then storage by code. */
function locations(db: SqlDb): Location[] {
  return db
    .selectObjects(
      `SELECT id, name, kind FROM locations WHERE deleted_at IS NULL AND kind IN ('shop', 'storage')
       ORDER BY kind = 'shop' DESC, code`,
    )
    .map((r) => ({ id: String(r['id']), name: String(r['name']), kind: r['kind'] as Location['kind'] }));
}

/**
 * The Shop quantity, in thousandths, that this counter's own unsynced bills take from each item: what the pulled
 * balance doesn't have yet. Positive = fewer on the shelf than the balance says.
 */
function unsyncedSold(db: SqlDb, itemIds: string[]): Map<string, number> {
  const asOf = getSync(db, 'complete_pull_started_at') ?? '';
  const ids = itemIds.map(() => '?').join(', ');
  const rows = db.selectObjects(
    `WITH pending AS (
       SELECT id FROM local_documents WHERE id IN (SELECT id FROM outbox) OR accepted_at > ?
     ), lines AS (
       -- This counter's bills the balance doesn't have, unless voided (a void here, sent or not, gives it all back).
       SELECT json_extract(l.value, '$.itemId') AS item_id, json_extract(l.value, '$.qty') AS qty,
              json_extract(l.value, '$.condition') AS condition
       FROM local_documents d, json_each(d.payload, '$.lines') l
       WHERE d.family = 'S' AND d.id IN (SELECT id FROM pending)
         AND NOT EXISTS (SELECT 1 FROM local_documents v
                         WHERE v.family = 'V' AND json_extract(v.payload, '$.saleId') = d.id)
       UNION ALL
       -- A void the balance doesn't have, of a bill it does: the stock comes back.
       SELECT json_extract(l.value, '$.itemId'), -json_extract(l.value, '$.qty'), json_extract(l.value, '$.condition')
       FROM local_documents v
       JOIN local_documents d ON d.family = 'S' AND d.id = json_extract(v.payload, '$.saleId'),
            json_each(d.payload, '$.lines') l
       WHERE v.family = 'V' AND v.id IN (SELECT id FROM pending) AND d.id NOT IN (SELECT id FROM pending)
     )
     SELECT item_id, sum(qty) AS qty FROM lines
     WHERE item_id IN (${ids}) AND (condition IS NULL OR condition <> 'defective')
     GROUP BY item_id`,
    [asOf, ...itemIds],
  );
  return new Map(rows.map((r) => [String(r['item_id']), Number(r['qty'])]));
}

/** Each item's quantity per shown location, the Shop first; an item with no balance has 0. Empty before any pull. */
export function stockFor(db: SqlDb, itemIds: readonly string[]): Map<string, StockQty[]> {
  const shown = locations(db);
  const out = new Map<string, StockQty[]>();
  if (itemIds.length === 0) return out;
  const unique = [...new Set(itemIds)];
  const held = new Map<string, number>();
  if (shown.length > 0) {
    const rows = db.selectObjects(
      `SELECT item_id, location_id, qty FROM stock_balances
       WHERE deleted_at IS NULL AND item_id IN (${unique.map(() => '?').join(', ')})`,
      unique,
    );
    for (const r of rows) held.set(`${String(r['item_id'])} ${String(r['location_id'])}`, Number(r['qty']));
  }
  const sold = shown.length > 0 ? unsyncedSold(db, unique) : new Map<string, number>();
  const shop = shown.find((l) => l.kind === 'shop')?.id ?? null;
  for (const itemId of unique)
    out.set(
      itemId,
      shown.map((l) => ({
        locationId: l.id,
        name: l.name,
        kind: l.kind,
        qty: qty((held.get(`${itemId} ${l.id}`) ?? 0) - (l.id === shop ? (sold.get(itemId) ?? 0) : 0)),
      })),
    );
  return out;
}
