import { money, qty, type CashMovementKind, type Money, type PaymentMethodCode, type Qty } from '@erp/domain';
import type pg from 'pg';

import type {
  LedgerState,
  PostingCashMovement,
  PostingCollection,
  PostingContext,
  PostingHandover,
  PostingRole,
  Posting,
  PostingSale,
  PostingSessionEvent,
  PostingVoid,
} from '../types';

// Reading what a posting needs from the database (W1-08). Money comes back as bigint text and quantities as
// numeric; both are turned into whole minor units and thousandths here (rule 1).

const toMoney = (v: string | number): Money => money(String(v));
const toQty = (v: string | number): Qty => qty(Number(v));

/**
 * The sale and who it belongs to, or null when there is no such document. A returned line (W1-13) comes with
 * `returnUnitCost: null`; `originals` maps it to the line it returns, when that is known, for `withReturnCosts`.
 */
export async function loadSale(
  c: pg.ClientBase,
  id: string,
): Promise<{
  sale: PostingSale;
  deviceId: string;
  sellerId: string;
  originals: Map<string, string>;
} | null> {
  const doc = await c.query<{
    number: string;
    branch_id: string;
    business_date: string;
    customer_party_id: string | null;
    bill_discount: string;
    rounding: string;
    tax_total: string;
    device_id: string;
    salesperson_user_id: string;
  }>(
    `SELECT number, branch_id, business_date::text, customer_party_id, bill_discount, rounding, tax_total, device_id,
       salesperson_user_id
     FROM erp.sales_documents WHERE id = $1`,
    [id],
  );
  const d = doc.rows[0];
  if (!d) return null;
  const lines = await c.query<{
    id: string;
    line_no: number;
    item_id: string;
    location_id: string;
    qty: string;
    line_total: string;
    tax_amount: string;
    original_line_id: string | null;
  }>(
    `SELECT id, line_no, item_id, location_id, (qty * 1000)::bigint AS qty, line_total, tax_amount, original_line_id
     FROM erp.sales_lines WHERE document_id = $1 ORDER BY line_no`,
    [id],
  );
  // A method removed since the bill was paid still posts where it did (W1-07 review).
  const payments = await c.query<{ code: PaymentMethodCode; amount: string }>(
    `SELECT m.code, p.amount FROM erp.sales_payments p JOIN erp.payment_methods m ON m.id = p.method_id
     WHERE p.document_id = $1 ORDER BY p.line_no`,
    [id],
  );
  const originals = new Map(
    lines.rows.flatMap((l) => (l.original_line_id === null ? [] : [[l.id, l.original_line_id] as const])),
  );
  return {
    deviceId: d.device_id,
    sellerId: d.salesperson_user_id,
    originals,
    sale: {
      id,
      number: d.number,
      branchId: d.branch_id,
      businessDate: d.business_date,
      customerId: d.customer_party_id,
      lines: lines.rows.map((l) => ({
        id: l.id,
        lineNo: l.line_no,
        itemId: l.item_id,
        locationId: l.location_id,
        qty: toQty(l.qty),
        lineTotal: toMoney(l.line_total),
        taxAmount: toMoney(l.tax_amount),
        ...(toQty(l.qty) < 0 ? { returnUnitCost: null } : {}),
      })),
      amounts: {
        billDiscount: toMoney(d.bill_discount),
        rounding: toMoney(d.rounding),
        taxTotal: toMoney(d.tax_total),
      },
      payments: payments.rows.map((p) => ({ method: p.code, amount: toMoney(p.amount) })),
    },
  };
}

/** How an original line left the stock: its unit cost, and whether a cost was known then. */
export interface LineCost {
  unitCost: Money;
  avgCostAfter: Money | null;
}

/**
 * The sale with each returned line's cost from the line it returns (posting rules §4.2, D-044): the original
 * movement's unit cost, or null (the current average) when the original left with no cost or isn't known. Null when
 * an original line is known but hasn't been posted yet: the return waits for it, like a void (W1-12).
 */
export function withReturnCosts(
  sale: PostingSale,
  originals: ReadonlyMap<string, string>,
  costOf: (originalLineId: string) => LineCost | undefined,
): PostingSale | null {
  const lines: PostingSale['lines'] = [];
  for (const l of sale.lines) {
    const original = originals.get(l.id);
    if (l.qty >= 0 || original === undefined) {
      lines.push(l);
      continue;
    }
    const cost = costOf(original);
    if (cost === undefined) return null;
    lines.push({ ...l, returnUnitCost: cost.avgCostAfter === null ? null : cost.unitCost });
  }
  return { ...sale, lines };
}

/** The stored stock movement of each of these sale lines (a sale line moves once). */
export async function loadLineCosts(
  c: pg.ClientBase,
  lineIds: readonly string[],
): Promise<Map<string, LineCost>> {
  if (lineIds.length === 0) return new Map();
  const { rows } = await c.query<{
    source_line_id: string;
    unit_cost: string;
    avg_cost_after: string | null;
  }>(
    `SELECT source_line_id, unit_cost, avg_cost_after FROM erp.stock_movements
     WHERE source_line_id = ANY($1::uuid[]) AND qty_delta < 0`,
    [lineIds],
  );
  return new Map(
    rows.map((r) => [
      r.source_line_id,
      {
        unitCost: toMoney(r.unit_cost),
        avgCostAfter: r.avg_cost_after === null ? null : toMoney(r.avg_cost_after),
      },
    ]),
  );
}

/** A stored handover, or null when there is none or it is a duplicate (a duplicate never posts, W1-10). */
export async function loadHandover(c: pg.ClientBase, id: string): Promise<PostingHandover | null> {
  const { rows } = await c.query<{
    number: string;
    bill_number: string;
    branch_id: string;
    business_date: string;
    kind: 'in' | 'payout';
    amount: string;
  }>(
    `SELECT number, bill_number, branch_id, business_date::text, kind, amount FROM erp.cash_handovers
     WHERE id = $1 AND duplicate_of_id IS NULL`,
    [id],
  );
  const h = rows[0];
  if (!h) return null;
  return {
    id,
    number: h.number,
    billNumber: h.bill_number,
    branchId: h.branch_id,
    businessDate: h.business_date,
    kind: h.kind,
    amount: toMoney(h.amount),
  };
}

/** A stored collection (W1-11), or null when there is none. */
export async function loadCollection(c: pg.ClientBase, id: string): Promise<PostingCollection | null> {
  const { rows } = await c.query<{
    number: string;
    branch_id: string;
    business_date: string;
    party_id: string;
    method: PaymentMethodCode;
    amount: string;
  }>(
    `SELECT p.number, p.branch_id, p.business_date::text, p.party_id, m.code AS method, p.amount
     FROM erp.payments p JOIN erp.payment_methods m ON m.id = p.method_id WHERE p.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id,
    number: r.number,
    branchId: r.branch_id,
    businessDate: r.business_date,
    partyId: r.party_id,
    method: r.method,
    amount: toMoney(r.amount),
  };
}

/** A stored cash-out or safe movement (W1-11), or null when there is none. */
export async function loadCashMovement(c: pg.ClientBase, id: string): Promise<PostingCashMovement | null> {
  const { rows } = await c.query<{
    number: string;
    branch_id: string;
    business_date: string;
    kind: CashMovementKind;
    amount: string;
    party_id: string | null;
    target_id: string | null;
  }>(
    `SELECT number, branch_id, business_date::text, kind, amount, party_id,
       coalesce(expense_category_id, bank_account_id) AS target_id
     FROM erp.cash_movements WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id,
    number: r.number,
    branchId: r.branch_id,
    businessDate: r.business_date,
    kind: r.kind,
    amount: toMoney(r.amount),
    partyId: r.party_id,
    targetId: r.target_id,
  };
}

/**
 * A session's open (by the session's id) or close (by its close document's id), or null when there is none: each
 * posts once, under its own document's id (W1-11).
 */
export async function loadSessionEvent(c: pg.ClientBase, id: string): Promise<PostingSessionEvent | null> {
  const { rows } = await c.query<{
    is_open: boolean;
    number: string;
    close_number: string | null;
    branch_id: string;
    business_date: string;
    close_business_date: string | null;
    opening_float: string;
    float_expected: string | null;
    variance: string | null;
    to_safe: string | null;
  }>(
    `SELECT id = $1 AS is_open, number, close_number, branch_id, business_date::text,
       close_payload->>'businessDate' AS close_business_date, opening_float, float_expected, variance,
       counted_cash - left_in_drawer AS to_safe
     FROM erp.cash_sessions WHERE id = $1 OR close_document_id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const common = { id, branchId: r.branch_id };
  if (r.is_open)
    return {
      ...common,
      number: r.number,
      businessDate: r.business_date,
      event: 'open',
      openingFloat: toMoney(r.opening_float),
      floatExpected: r.float_expected === null ? null : toMoney(r.float_expected),
      variance: null,
      toSafe: money(0),
    };
  return {
    ...common,
    number: r.close_number!,
    businessDate: r.close_business_date!,
    event: 'close',
    openingFloat: null,
    floatExpected: null,
    variance: r.variance === null ? null : toMoney(r.variance),
    toSafe: r.to_safe === null ? money(0) : toMoney(r.to_safe),
  };
}

/**
 * The settings as they are now (ACC-01, ACC-08): accounts by role and by method, the lock date, the terms, and for a
 * cash-out the account of its category or bank (W1-11).
 */
export async function loadContext(
  c: pg.ClientBase,
  customerId: string | null,
  targetId: string | null = null,
): Promise<PostingContext> {
  const roles = await c.query<{ system_role: PostingRole; id: string }>(
    'SELECT system_role, id FROM erp.accounts WHERE system_role IS NOT NULL ORDER BY system_role',
  );
  const methods = await c.query<{ code: PaymentMethodCode; account: string | null }>(
    `SELECT m.code, b.gl_account_id AS account FROM erp.payment_methods m
     LEFT JOIN erp.bank_accounts b ON b.id = m.bank_account_id ORDER BY m.code`,
  );
  const tenant = await c.query<{ lock_date: string | null }>('SELECT lock_date::text FROM erp.tenants');
  let customer: PostingContext['customer'] = null;
  if (customerId !== null) {
    const terms = await c.query<{ payment_terms_days: number | null }>(
      'SELECT payment_terms_days FROM erp.customer_accounts WHERE party_id = $1',
      [customerId],
    );
    customer = { paymentTermsDays: terms.rows[0]?.payment_terms_days ?? null };
  }
  let targets: Record<string, string> | undefined;
  if (targetId !== null) {
    const t = await c.query<{ id: string; account: string }>(
      `SELECT id, gl_account_id AS account FROM erp.expense_categories WHERE id = $1
       UNION ALL SELECT id, gl_account_id FROM erp.bank_accounts WHERE id = $1`,
      [targetId],
    );
    targets = Object.fromEntries(t.rows.map((r) => [r.id, r.account]));
  }
  return {
    accounts: {
      roles: Object.fromEntries(roles.rows.map((r) => [r.system_role, r.id])),
      methods: Object.fromEntries(methods.rows.map((m) => [m.code, m.account])),
      ...(targets === undefined ? {} : { targets }),
    },
    lockDate: tenant.rows[0]?.lock_date ?? null,
    customer,
  };
}

/** The costs and balances a sale's lines touch. */
export const loadState = (c: pg.ClientBase, sale: PostingSale): Promise<LedgerState> =>
  loadStateOf(
    c,
    sale.lines.map((l) => l.itemId),
    sale.lines.map((l) => l.locationId),
  );

/** The costs of these items and their balances in these locations. */
export async function loadStateOf(
  c: pg.ClientBase,
  itemIds: readonly string[],
  locationIds: readonly string[],
): Promise<LedgerState> {
  const items = [...new Set(itemIds)];
  const state: LedgerState = { costs: {}, balances: {} };
  const costs = await c.query<{ item_id: string; avg_cost: string | null; on_hand: string }>(
    'SELECT item_id, avg_cost, (on_hand * 1000)::bigint AS on_hand FROM erp.item_costs WHERE item_id = ANY ($1)',
    [items],
  );
  for (const r of costs.rows)
    state.costs[r.item_id] = {
      avgCost: r.avg_cost === null ? null : toMoney(r.avg_cost),
      onHand: toQty(r.on_hand),
    };
  const balances = await c.query<{ item_id: string; location_id: string; qty: string }>(
    `SELECT item_id, location_id, (qty * 1000)::bigint AS qty FROM erp.stock_balances
     WHERE item_id = ANY ($1) AND location_id = ANY ($2)`,
    [items, [...new Set(locationIds)]],
  );
  for (const r of balances.rows) (state.balances[r.location_id] ??= {})[r.item_id] = toQty(r.qty);
  return state;
}

/**
 * A stored void (W1-12) and the sale it voids, or null when there is none, it is a duplicate, or its bill hasn't
 * arrived yet: none of those posts.
 */
export async function loadVoid(
  c: pg.ClientBase,
  id: string,
): Promise<{ void: PostingVoid; saleId: string } | null> {
  const { rows } = await c.query<{
    number: string;
    sale_number: string;
    sale_document_id: string;
    branch_id: string;
    business_date: string;
  }>(
    `SELECT number, sale_number, sale_document_id, branch_id, business_date::text FROM erp.sales_voids
     WHERE id = $1 AND duplicate_of_id IS NULL AND sale_document_id IS NOT NULL`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    saleId: r.sale_document_id,
    void: {
      id,
      number: r.number,
      saleNumber: r.sale_number,
      branchId: r.branch_id,
      businessDate: r.business_date,
    },
  };
}

/**
 * A sale's posting as it was stored (posting rules §4.4: a void swaps it): its journal lines in order, its stock
 * movements in line order, its customer entries. Null when the sale has no posting yet.
 */
export async function loadSalePosting(c: pg.ClientBase, saleId: string): Promise<Posting | null> {
  const posting = await c.query<{ seq: string; entry_date: string }>(
    "SELECT seq, entry_date::text FROM erp.postings WHERE source_type = 'sale' AND source_id = $1",
    [saleId],
  );
  const p = posting.rows[0];
  if (!p) return null;
  const entry = await c.query<{ branch_id: string; memo: string | null }>(
    `SELECT l.branch_id, e.memo FROM erp.journal_entries e JOIN erp.journal_lines l ON l.entry_id = e.id
     WHERE e.posting_seq = $1 LIMIT 1`,
    [p.seq],
  );
  const lines = await c.query<{ account_id: string; party_id: string | null; debit: string; credit: string }>(
    `SELECT l.account_id, l.party_id, l.debit, l.credit FROM erp.journal_entries e
     JOIN erp.journal_lines l ON l.entry_id = e.id WHERE e.posting_seq = $1 ORDER BY l.line_no`,
    [p.seq],
  );
  const movements = await c.query<{
    source_line_id: string;
    item_id: string;
    location_id: string;
    qty: string;
    unit_cost: string;
    value_delta: string;
    avg_cost_after: string | null;
  }>(
    `SELECT m.source_line_id, m.item_id, m.location_id, (m.qty_delta * 1000)::bigint AS qty, m.unit_cost,
       m.value_delta, m.avg_cost_after
     FROM erp.stock_movements m LEFT JOIN erp.sales_lines l ON l.id = m.source_line_id
     WHERE m.posting_seq = $1 ORDER BY l.line_no, m.id`,
    [p.seq],
  );
  const parties = await c.query<{
    party_id: string;
    role: 'customer' | 'supplier';
    amount: string;
    due_date: string;
  }>(
    `SELECT party_id, role, amount, due_date::text FROM erp.party_ledger_entries WHERE posting_seq = $1
     ORDER BY id`,
    [p.seq],
  );
  return {
    entryDate: p.entry_date,
    journal: {
      branchId: entry.rows[0]?.branch_id ?? '',
      memo: entry.rows[0]?.memo ?? '',
      lines: lines.rows.map((l) => ({
        accountId: l.account_id,
        partyId: l.party_id,
        debit: toMoney(l.debit),
        credit: toMoney(l.credit),
      })),
    },
    movements: movements.rows.map((m) => ({
      sourceLineId: m.source_line_id,
      itemId: m.item_id,
      locationId: m.location_id,
      qtyDelta: toQty(m.qty),
      unitCost: toMoney(m.unit_cost),
      valueDelta: toMoney(m.value_delta),
      avgCostAfter: m.avg_cost_after === null ? null : toMoney(m.avg_cost_after),
    })),
    partyEntries: parties.rows.map((e) => ({
      partyId: e.party_id,
      role: e.role,
      amount: toMoney(e.amount),
      dueDate: e.due_date,
    })),
    exceptions: [],
    state: { costs: {}, balances: {} },
  };
}
