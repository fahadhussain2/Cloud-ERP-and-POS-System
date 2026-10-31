import { add, money, negate, qty, sum, type Money, type PaymentMethodCode, type Qty } from '@erp/domain';

import { costOf } from './cost';
import { addDays, entryDateOf } from './dates';
import type {
  CostState,
  JournalLine,
  LedgerState,
  PartyEntry,
  PostingContext,
  PostingError,
  PostingException,
  PostingResult,
  PostingRole,
  PostingSale,
  StockMovement,
} from './types';

// A sale's journal entry, stock movements and customer ledger entry (posting rules §4.1, INV-01, INV-03, ACC-03).
// Each line leaves its location at the item's average cost (D-017); an item with no cost yet leaves at 0 and is
// flagged (owner answer 2 to W1-08). A bill that doesn't add up still posts: the difference goes to SUSPENSE
// (owner answer 3). Never throws for a business reason: what can't be posted comes back as an error.

class Unpostable extends Error {
  constructor(readonly error: PostingError) {
    super(error.code);
  }
}

/** Debit and credit lines, one per account and party, kept in the order they were first added. */
class Entry {
  private readonly lines = new Map<string, { accountId: string; partyId: string | null; net: Money }>();

  /** `amount` > 0 debits the account, < 0 credits it. */
  add(accountId: string, amount: Money, partyId: string | null = null): void {
    const key = `${accountId}|${partyId ?? ''}`;
    const line = this.lines.get(key) ?? { accountId, partyId, net: money(0) };
    line.net = add(line.net, amount);
    this.lines.set(key, line);
  }

  /** Debits minus credits so far. */
  balance(): Money {
    return sum([...this.lines.values()].map((l) => l.net));
  }

  journalLines(): JournalLine[] {
    return [...this.lines.values()]
      .filter((l) => l.net !== 0)
      .map((l) => ({
        accountId: l.accountId,
        partyId: l.partyId,
        debit: money(Math.max(l.net, 0)),
        credit: money(Math.max(negate(l.net), 0)),
      }));
  }
}

export function postSale(sale: PostingSale, context: PostingContext, state: LedgerState): PostingResult {
  try {
    return { ok: true, posting: post(sale, context, state) };
  } catch (err) {
    if (err instanceof Unpostable) return { ok: false, error: err.error };
    throw err;
  }
}

function post(sale: PostingSale, context: PostingContext, state: LedgerState) {
  const role = (r: PostingRole): string => {
    const id = context.accounts.roles[r];
    if (id === undefined) throw new Unpostable({ code: 'role_unmapped', role: r });
    return id;
  };
  const methodAccount = (m: PaymentMethodCode): string => {
    if (m === 'cash') return role('CASH_IN_TRANSIT');
    if (m === 'on_account') return role('AR_CONTROL');
    const id = context.accounts.methods[m];
    if (id === undefined || id === null) throw new Unpostable({ code: 'method_unmapped', method: m });
    return id;
  };

  const entryDate = entryDateOf(sale.businessDate, context.lockDate);
  const exceptions: PostingException[] = [];
  if (entryDate !== sale.businessDate)
    exceptions.push({
      kind: 'posted_after_lock',
      details: { businessDate: sale.businessDate, lockDate: context.lockDate! },
    });

  // Tenders, in payment order (posting rules §4.1).
  const entry = new Entry();
  const partyEntries: PartyEntry[] = [];
  for (const p of sale.payments) {
    if (p.method === 'on_account') {
      if (sale.customerId === null) throw new Unpostable({ code: 'on_account_without_customer' });
      entry.add(methodAccount(p.method), p.amount, sale.customerId);
    } else entry.add(methodAccount(p.method), p.amount);
  }
  const onAccount = sum(sale.payments.filter((p) => p.method === 'on_account').map((p) => p.amount));
  if (onAccount !== 0)
    partyEntries.push({
      partyId: sale.customerId!,
      role: 'customer',
      amount: onAccount,
      dueDate: addDays(entryDate, context.customer?.paymentTermsDays ?? 0),
    });

  entry.add(role('SALES'), negate(sum(sale.lines.map((l) => l.lineTotal))));
  if (sale.amounts.billDiscount !== 0) entry.add(role('SALES_DISCOUNT'), sale.amounts.billDiscount);
  if (sale.amounts.rounding !== 0) entry.add(role('ROUNDING'), negate(sale.amounts.rounding));
  if (sale.amounts.taxTotal !== 0) entry.add(role('TAX_PAYABLE'), negate(sale.amounts.taxTotal));
  // A bill that doesn't add up (a counter bug, D-094): the difference waits on SUSPENSE (owner answer 3).
  const difference = entry.balance();
  if (difference !== 0) entry.add(role('SUSPENSE'), negate(difference));

  // Stock out at the average cost, line by line, each line seeing the ones before it (INV-01, D-017).
  const costs: Record<string, CostState> = {};
  const balances: Record<string, Record<string, Qty>> = {};
  const costNow = (item: string) => costs[item] ?? state.costs[item] ?? { avgCost: null, onHand: qty(0) };
  const balanceNow = (loc: string, item: string) =>
    balances[loc]?.[item] ?? state.balances[loc]?.[item] ?? qty(0);
  const movements: StockMovement[] = [];
  const noCost = new Set<string>();
  for (const l of sale.lines) {
    const before = costNow(l.itemId);
    const value = costOf(l.qty, before.avgCost);
    costs[l.itemId] = { avgCost: before.avgCost, onHand: qty(before.onHand - l.qty) };
    const shelf = balanceNow(l.locationId, l.itemId);
    const after = qty(shelf - l.qty);
    (balances[l.locationId] ??= {})[l.itemId] = after;
    movements.push({
      sourceLineId: l.id,
      itemId: l.itemId,
      locationId: l.locationId,
      qtyDelta: qty(0 - l.qty),
      unitCost: before.avgCost ?? money(0),
      valueDelta: negate(value),
      avgCostAfter: before.avgCost,
    });
    if (before.avgCost === null && !noCost.has(l.itemId)) {
      noCost.add(l.itemId);
      exceptions.push({ kind: 'no_cost', details: { itemId: l.itemId } });
    }
    // INV-03: never blocked; flagged once when the shelf crosses below zero.
    if (shelf >= 0 && after < 0)
      exceptions.push({
        kind: 'negative_stock',
        details: { itemId: l.itemId, locationId: l.locationId, balance: after },
      });
  }
  const cost = sum(movements.map((m) => negate(m.valueDelta)));
  if (cost !== 0) {
    entry.add(role('COGS'), cost);
    entry.add(role('INVENTORY'), negate(cost));
  }

  return {
    entryDate,
    journal: { branchId: sale.branchId, memo: sale.number, lines: entry.journalLines() },
    movements,
    partyEntries,
    exceptions,
    state: { costs, balances },
  };
}
