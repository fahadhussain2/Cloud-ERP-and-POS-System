import { add, money, negate, qty, sum, type Money } from '@erp/domain';

import { averageAfterReceipt, costOf } from './cost';
import { entryDateOf } from './dates';
import type {
  CostState,
  JournalLine,
  LastPurchase,
  LedgerState,
  PartyEntry,
  PostingContext,
  PostingException,
  PostingOpening,
  PostingResult,
  PostingRole,
  StockMovement,
} from './types';

// The opening balances at cutover (posting rules §7, migration doc §4, W1-14): one entry with the stock into its
// location at the legacy cost, one AR or AP line and party entry per customer or supplier (ageing starts at go-live,
// so each is due on the entry date), the counted drawer and the bank statements, and the balance to Opening balance
// equity. A posting like any other, so the ledgers stay rebuildable (rule 4). Never throws for a business reason.

export function postOpening(
  opening: PostingOpening,
  context: PostingContext,
  state: LedgerState,
): PostingResult {
  const role = (r: PostingRole): string | null => context.accounts.roles[r] ?? null;
  const missing = (r: PostingRole): PostingResult => ({
    ok: false,
    error: { code: 'role_unmapped', role: r },
  });

  const entryDate = entryDateOf(opening.businessDate, context.lockDate);
  const exceptions: PostingException[] = [];
  if (entryDate !== opening.businessDate)
    exceptions.push({
      kind: 'posted_after_lock',
      details: { businessDate: opening.businessDate, lockDate: context.lockDate! },
    });

  // Stock, line by line, each line seeing the lines before it.
  const costs: Record<string, CostState> = {};
  const balances: Record<string, Record<string, ReturnType<typeof qty>>> = {};
  const costNow = (item: string): CostState =>
    costs[item] ?? state.costs[item] ?? { avgCost: null, onHand: qty(0) };
  const balanceNow = (loc: string, item: string) =>
    balances[loc]?.[item] ?? state.balances[loc]?.[item] ?? qty(0);
  const movements: StockMovement[] = [];
  const noCost = new Set<string>();
  for (const l of opening.stock) {
    if (l.qty === 0) continue;
    const before = costNow(l.itemId);
    const unit = l.unitCost ?? before.avgCost;
    let after: CostState;
    if (unit === null) after = { avgCost: before.avgCost, onHand: qty(before.onHand + l.qty) };
    else if (l.qty > 0) after = averageAfterReceipt(before, { qty: l.qty, netUnitCost: unit });
    // Stock below zero leaves at its own cost; it sets the average only when none was known.
    else after = { avgCost: before.avgCost ?? unit, onHand: qty(before.onHand + l.qty) };
    if (unit === null && !noCost.has(l.itemId)) {
      noCost.add(l.itemId);
      exceptions.push({ kind: 'no_cost', details: { itemId: l.itemId } });
    }
    costs[l.itemId] = after;
    (balances[l.locationId] ??= {})[l.itemId] = qty(balanceNow(l.locationId, l.itemId) + l.qty);
    movements.push({
      sourceLineId: l.id,
      itemId: l.itemId,
      locationId: l.locationId,
      qtyDelta: l.qty,
      unitCost: unit ?? money(0),
      valueDelta: costOf(l.qty, unit),
      avgCostAfter: after.avgCost,
    });
  }

  // `net` > 0 debits the account, < 0 credits it.
  const legs: { accountId: string; partyId: string | null; net: Money }[] = [];
  const stockValue = sum(movements.map((m) => m.valueDelta));
  if (movements.length > 0) {
    const inventory = role('INVENTORY');
    if (inventory === null) return missing('INVENTORY');
    legs.push({ accountId: inventory, partyId: null, net: stockValue });
  }
  const partyEntries: PartyEntry[] = [];
  for (const r of ['customer', 'supplier'] as const) {
    const lines = opening.parties.filter((p) => p.role === r && p.amount !== 0);
    if (lines.length === 0) continue;
    const control = role(r === 'customer' ? 'AR_CONTROL' : 'AP_CONTROL');
    if (control === null) return missing(r === 'customer' ? 'AR_CONTROL' : 'AP_CONTROL');
    for (const p of lines) {
      legs.push({
        accountId: control,
        partyId: p.partyId,
        net: r === 'customer' ? p.amount : negate(p.amount),
      });
      partyEntries.push({ partyId: p.partyId, role: r, amount: p.amount, dueDate: entryDate });
    }
  }
  for (const a of opening.accounts)
    if (a.amount !== 0) legs.push({ accountId: a.accountId, partyId: null, net: a.amount });

  const balance = legs.reduce((s, l) => add(s, l.net), money(0));
  if (balance !== 0) {
    const equity = role('OPENING_BALANCE_EQUITY');
    if (equity === null) return missing('OPENING_BALANCE_EQUITY');
    legs.push({ accountId: equity, partyId: null, net: negate(balance) });
  }
  const lines: JournalLine[] = legs
    .filter((l) => l.net !== 0)
    .map((l) => ({
      accountId: l.accountId,
      partyId: l.partyId,
      debit: money(Math.max(l.net, 0)),
      credit: money(Math.max(negate(l.net), 0)),
    }));

  const lastPurchases: LastPurchase[] = opening.stock.flatMap((l) =>
    l.lastPurchase === null
      ? []
      : [
          {
            itemId: l.itemId,
            lastCost: l.lastPurchase.cost,
            lastSupplierId: l.lastPurchase.supplierId,
            lastReceiptAt: l.lastPurchase.at,
          },
        ],
  );

  return {
    ok: true,
    posting: {
      entryDate,
      journal: { branchId: opening.branchId, memo: `Opening ${opening.label}`, lines },
      movements,
      partyEntries,
      exceptions,
      state: { costs, balances },
      lastPurchases,
    },
  };
}
