import { add, money, qty, type CashMovementKind, type Money, type PaymentMethodCode, type Qty } from '@erp/domain';
import type pg from 'pg';

import type {
  LedgerState,
  PostingCashMovement,
  PostingCollection,
  PostingContext,
  PostingHandover,
  PostingOpening,
  PostingRole,
  Posting,
  PostingSale,
  PostingSessionEvent,
  PostingVoid,
  PostingGoodsReceipt,
  PostingPurchaseReturn,
  PostingStockAdjustment,
  PostingStockTransfer,
  PostingSupplierPayment,
  PostingCustomerReceipt,
  PostingExpense,
  PostingFundTransfer,
  PostingJournalVoucher,
  PostingReversal,
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
    bill_share: string;
    tax_amount: string;
    original_line_id: string | null;
  }>(
    `SELECT id, line_no, item_id, location_id, (qty * 1000)::bigint AS qty, line_total, bill_share, tax_amount,
       original_line_id
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
        // The counter stores a line after its share of the bill discount; posting takes it before, and debits the
        // bill discount on its own (posting rules §4.1). A returned line has no share, so its refund is unchanged.
        lineTotal: add(toMoney(l.line_total), toMoney(l.bill_share)),
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

/** A stored cash-out or safe movement (W1-11), or cash given back (W1-23), or null for none or a duplicate. */
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
     FROM erp.cash_movements WHERE id = $1 AND duplicate_of_id IS NULL`,
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
  target: string | null | readonly (string | null)[] = null,
): Promise<PostingContext> {
  const targetIds = (Array.isArray(target) ? target : [target]).filter((t): t is string => t !== null);
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
  if (targetIds.length > 0) {
    const t = await c.query<{ id: string; account: string }>(
      `SELECT id, gl_account_id AS account FROM erp.expense_categories WHERE id = ANY($1::uuid[])
       UNION ALL SELECT id, gl_account_id FROM erp.bank_accounts WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [targetIds],
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

/** A stored opening (W1-14), lines in line order, or null when there is none. */
export async function loadOpening(c: pg.ClientBase, id: string): Promise<PostingOpening | null> {
  const head = await c.query<{ label: string; branch_id: string; business_date: string }>(
    'SELECT label, branch_id, business_date::text FROM erp.opening_balances WHERE id = $1',
    [id],
  );
  const h = head.rows[0];
  if (!h) return null;
  const { rows } = await c.query<{
    id: string;
    kind: 'stock' | 'customer' | 'supplier' | 'account';
    item_id: string | null;
    location_id: string | null;
    qty: string | null;
    unit_cost: string | null;
    last_cost: string | null;
    last_supplier_id: string | null;
    last_receipt_at: Date | null;
    party_id: string | null;
    account_id: string | null;
    amount: string | null;
  }>(
    `SELECT id, kind, item_id, location_id, (qty * 1000)::bigint AS qty, unit_cost, last_cost, last_supplier_id,
       last_receipt_at, party_id, account_id, amount
     FROM erp.opening_balance_lines WHERE opening_id = $1 ORDER BY line_no`,
    [id],
  );
  const opening: PostingOpening = {
    id,
    label: h.label,
    branchId: h.branch_id,
    businessDate: h.business_date,
    stock: [],
    parties: [],
    accounts: [],
  };
  for (const r of rows) {
    if (r.kind === 'stock')
      opening.stock.push({
        id: r.id,
        itemId: r.item_id!,
        locationId: r.location_id!,
        qty: toQty(r.qty!),
        unitCost: r.unit_cost === null ? null : toMoney(r.unit_cost),
        lastPurchase:
          r.last_cost === null
            ? null
            : {
                cost: toMoney(r.last_cost),
                supplierId: r.last_supplier_id,
                at: r.last_receipt_at!.toISOString(),
              },
      });
    else if (r.kind === 'account')
      opening.accounts.push({ id: r.id, accountId: r.account_id!, amount: toMoney(r.amount!) });
    else opening.parties.push({ id: r.id, partyId: r.party_id!, role: r.kind, amount: toMoney(r.amount!) });
  }
  return opening;
}

/** A posted goods receipt as posting needs it (W1-16): its lines' values were written when it was posted. */
export async function loadGoodsReceipt(c: pg.ClientBase, id: string): Promise<PostingGoodsReceipt | null> {
  const head = await c.query<{
    number: string;
    branch_id: string;
    business_date: string;
    supplier_party_id: string;
    due_date: string;
    total: string;
    posted_at: Date;
    paid_from_bank_account_id: string | null;
  }>(
    `SELECT number, branch_id, business_date::text, supplier_party_id, due_date::text, total, posted_at,
       paid_from_bank_account_id
     FROM erp.goods_receipts WHERE id = $1 AND status = 'posted'`,
    [id],
  );
  const h = head.rows[0];
  if (!h) return null;
  const lines = await c.query<{
    id: string;
    item_id: string;
    qty: string;
    value: string;
    location_id: string;
  }>(
    `SELECT l.id, l.item_id, (l.qty * 1000)::bigint AS qty, l.value, r.location_id
     FROM erp.goods_receipt_lines l JOIN erp.goods_receipts r ON r.id = l.receipt_id
     WHERE l.receipt_id = $1 ORDER BY l.line_no`,
    [id],
  );
  return {
    id,
    number: h.number,
    branchId: h.branch_id,
    businessDate: h.business_date,
    supplierId: h.supplier_party_id,
    dueDate: h.due_date,
    total: money(h.total),
    receivedAt: h.posted_at.toISOString(),
    paidFrom: h.paid_from_bank_account_id,
    lines: lines.rows.map((l) => ({
      id: l.id,
      itemId: l.item_id,
      locationId: l.location_id,
      qty: qty(Number(l.qty)),
      value: money(l.value),
    })),
  };
}

/** A posted purchase return as posting needs it (W1-16). */
export async function loadPurchaseReturn(
  c: pg.ClientBase,
  id: string,
): Promise<PostingPurchaseReturn | null> {
  const head = await c.query<{
    number: string;
    branch_id: string;
    business_date: string;
    supplier_party_id: string;
  }>(
    `SELECT number, branch_id, business_date::text, supplier_party_id FROM erp.purchase_returns
     WHERE id = $1 AND status = 'posted'`,
    [id],
  );
  const h = head.rows[0];
  if (!h) return null;
  const lines = await c.query<{
    id: string;
    item_id: string;
    qty: string;
    unit_cost: string;
    location_id: string;
  }>(
    `SELECT l.id, l.item_id, (l.qty * 1000)::bigint AS qty, l.unit_cost, r.location_id
     FROM erp.purchase_return_lines l JOIN erp.purchase_returns r ON r.id = l.return_id
     WHERE l.return_id = $1 ORDER BY l.line_no`,
    [id],
  );
  return {
    id,
    number: h.number,
    branchId: h.branch_id,
    businessDate: h.business_date,
    supplierId: h.supplier_party_id,
    lines: lines.rows.map((l) => ({
      id: l.id,
      itemId: l.item_id,
      locationId: l.location_id,
      qty: qty(Number(l.qty)),
      unitCost: money(l.unit_cost),
    })),
  };
}

/** A supplier payment by bank as posting needs it (W1-16). */
export async function loadSupplierPayment(
  c: pg.ClientBase,
  id: string,
): Promise<PostingSupplierPayment | null> {
  const { rows } = await c.query<{
    number: string;
    branch_id: string;
    business_date: string;
    supplier_party_id: string;
    amount: string;
    bank_account_id: string;
  }>(
    `SELECT number, branch_id, business_date::text, supplier_party_id, amount, bank_account_id
     FROM erp.supplier_payments WHERE id = $1`,
    [id],
  );
  const h = rows[0];
  if (!h) return null;
  return {
    id,
    number: h.number,
    branchId: h.branch_id,
    businessDate: h.business_date,
    supplierId: h.supplier_party_id,
    amount: money(h.amount),
    bankAccountId: h.bank_account_id,
  };
}

/** A transfer's lines: thousandths, in line order. */
async function transferLines(c: pg.ClientBase, id: string) {
  const { rows } = await c.query<{ id: string; item_id: string; qty: string; received: string | null }>(
    `SELECT id, item_id, (qty * 1000)::bigint AS qty, (received_qty * 1000)::bigint AS received
     FROM erp.stock_transfer_lines WHERE transfer_id = $1 ORDER BY line_no`,
    [id],
  );
  return rows;
}

/**
 * A transfer's first step as posting needs it (W1-18): moved at once (from → to) or sent (from → the branch's
 * In transit location); null for a draft.
 */
export async function loadStockTransfer(c: pg.ClientBase, id: string): Promise<PostingStockTransfer | null> {
  const { rows } = await c.query<{
    number: string;
    branch_id: string;
    business_date: string;
    from_location_id: string;
    to_location_id: string;
    sent: boolean;
    transit_id: string | null;
  }>(
    `SELECT t.number, t.branch_id, t.business_date::text, t.from_location_id, t.to_location_id,
       t.status IN ('in_transit', 'received') AS sent,
       (SELECT l.id FROM erp.locations l WHERE l.branch_id = t.branch_id AND l.kind = 'transit'
        AND l.deleted_at IS NULL) AS transit_id
     FROM erp.stock_transfers t WHERE t.id = $1 AND t.status <> 'draft'`,
    [id],
  );
  const h = rows[0];
  if (!h) return null;
  if (h.sent && h.transit_id === null) throw new Error(`branch ${h.branch_id} has no In transit location`);
  const to = h.sent ? h.transit_id! : h.to_location_id;
  return {
    id,
    number: h.number,
    branchId: h.branch_id,
    businessDate: h.business_date,
    lines: (await transferLines(c, id)).map((l) => ({
      id: l.id,
      itemId: l.item_id,
      fromLocationId: h.from_location_id,
      toLocationId: to,
      qty: toQty(l.qty),
    })),
  };
}

/**
 * A sent transfer's receiving as posting needs it (W1-18), by its `receipt_id`: what arrived, out of In transit into
 * the destination, on the day it was received. A line where nothing arrived has nothing to move.
 */
export async function loadStockTransferReceipt(
  c: pg.ClientBase,
  receiptId: string,
): Promise<PostingStockTransfer | null> {
  const { rows } = await c.query<{
    id: string;
    number: string;
    branch_id: string;
    received_on: string;
    to_location_id: string;
    transit_id: string | null;
  }>(
    `SELECT t.id, t.number, t.branch_id, t.received_on::text, t.to_location_id,
       (SELECT l.id FROM erp.locations l WHERE l.branch_id = t.branch_id AND l.kind = 'transit'
        AND l.deleted_at IS NULL) AS transit_id
     FROM erp.stock_transfers t WHERE t.receipt_id = $1 AND t.status = 'received'`,
    [receiptId],
  );
  const h = rows[0];
  if (!h) return null;
  if (h.transit_id === null) throw new Error(`branch ${h.branch_id} has no In transit location`);
  return {
    id: receiptId,
    number: h.number,
    branchId: h.branch_id,
    businessDate: h.received_on,
    lines: (await transferLines(c, h.id))
      .filter((l) => l.received !== null && Number(l.received) > 0)
      .map((l) => ({
        id: l.id,
        itemId: l.item_id,
        fromLocationId: h.transit_id!,
        toLocationId: h.to_location_id,
        qty: toQty(l.received!),
      })),
  };
}

/** A posted stock adjustment as posting needs it (W1-18). */
export async function loadStockAdjustment(
  c: pg.ClientBase,
  id: string,
): Promise<PostingStockAdjustment | null> {
  const head = await c.query<{
    number: string;
    branch_id: string;
    business_date: string;
    location_id: string;
  }>(
    `SELECT number, branch_id, business_date::text, location_id FROM erp.stock_adjustments
     WHERE id = $1 AND status = 'posted'`,
    [id],
  );
  const h = head.rows[0];
  if (!h) return null;
  const lines = await c.query<{ id: string; item_id: string; qty: string }>(
    `SELECT id, item_id, (qty * 1000)::bigint AS qty FROM erp.stock_adjustment_lines
     WHERE adjustment_id = $1 ORDER BY line_no`,
    [id],
  );
  return {
    id,
    number: h.number,
    branchId: h.branch_id,
    businessDate: h.business_date,
    lines: lines.rows.map((l) => ({
      id: l.id,
      itemId: l.item_id,
      locationId: h.location_id,
      qty: toQty(l.qty),
    })),
  };
}
/** A customer receipt by bank as posting needs it (W1-19). */
export async function loadCustomerReceipt(
  c: pg.ClientBase,
  id: string,
): Promise<PostingCustomerReceipt | null> {
  const { rows } = await c.query<{
    number: string;
    branch_id: string;
    business_date: string;
    customer_party_id: string;
    amount: string;
    bank_account_id: string;
  }>(
    `SELECT number, branch_id, business_date::text, customer_party_id, amount, bank_account_id
     FROM erp.customer_receipts WHERE id = $1`,
    [id],
  );
  const h = rows[0];
  if (!h) return null;
  return {
    id,
    number: h.number,
    branchId: h.branch_id,
    businessDate: h.business_date,
    customerId: h.customer_party_id,
    amount: toMoney(h.amount),
    bankAccountId: h.bank_account_id,
  };
}

/** An expense as posting needs it (W1-19); paid from null = the safe. */
export async function loadExpense(c: pg.ClientBase, id: string): Promise<PostingExpense | null> {
  const { rows } = await c.query<{
    number: string;
    branch_id: string;
    business_date: string;
    expense_category_id: string;
    paid_from_bank_account_id: string | null;
    amount: string;
  }>(
    `SELECT number, branch_id, business_date::text, expense_category_id, paid_from_bank_account_id, amount
     FROM erp.expenses WHERE id = $1`,
    [id],
  );
  const h = rows[0];
  if (!h) return null;
  return {
    id,
    number: h.number,
    branchId: h.branch_id,
    businessDate: h.business_date,
    categoryId: h.expense_category_id,
    paidFrom: h.paid_from_bank_account_id,
    amount: toMoney(h.amount),
  };
}

/** A transfer between banks and the safe as posting needs it (W1-19); null = the safe. */
export async function loadFundTransfer(c: pg.ClientBase, id: string): Promise<PostingFundTransfer | null> {
  const { rows } = await c.query<{
    number: string;
    branch_id: string;
    business_date: string;
    from_bank_account_id: string | null;
    to_bank_account_id: string | null;
    amount: string;
    charges: string;
    charges_category_id: string | null;
  }>(
    `SELECT number, branch_id, business_date::text, from_bank_account_id, to_bank_account_id, amount, charges,
       charges_category_id FROM erp.fund_transfers WHERE id = $1`,
    [id],
  );
  const h = rows[0];
  if (!h) return null;
  return {
    id,
    number: h.number,
    branchId: h.branch_id,
    businessDate: h.business_date,
    from: h.from_bank_account_id,
    to: h.to_bank_account_id,
    amount: toMoney(h.amount),
    charges: toMoney(h.charges),
    chargesCategoryId: h.charges_category_id,
  };
}

/** The documents a reversal may name, and where each lives (W1-19, D-108). */
export const REVERSIBLE = {
  customer_receipt: 'customer_receipts',
  expense: 'expenses',
  fund_transfer: 'fund_transfers',
  supplier_payment: 'supplier_payments',
  journal_voucher: 'journal_vouchers',
} as const;
export type ReversibleType = keyof typeof REVERSIBLE;

/**
 * A posted journal voucher as posting needs it (W1-19): its lines in line order, or, for a reversal, what it
 * reverses and that document's number. Null for a draft or no such voucher.
 */
export async function loadJournalVoucher(
  c: pg.ClientBase,
  id: string,
): Promise<
  | { voucher: PostingJournalVoucher }
  | {
      reversal: PostingReversal;
      reverses: { type: ReversibleType; id: string };
    }
  | null
> {
  const head = await c.query<{
    number: string;
    branch_id: string;
    business_date: string;
    narration: string | null;
    reverses_type: ReversibleType | null;
    reverses_id: string | null;
  }>(
    `SELECT number, branch_id, business_date::text, narration, reverses_type, reverses_id
     FROM erp.journal_vouchers WHERE id = $1 AND status = 'posted'`,
    [id],
  );
  const h = head.rows[0];
  if (!h) return null;
  const base = {
    id,
    number: h.number,
    branchId: h.branch_id,
    businessDate: h.business_date,
  };
  if (h.reverses_type !== null && h.reverses_id !== null) {
    const original = await c.query<{ number: string }>(
      `SELECT number FROM erp.${REVERSIBLE[h.reverses_type]} WHERE id = $1`,
      [h.reverses_id],
    );
    return {
      reversal: { ...base, originalNumber: original.rows[0]?.number ?? '' },
      reverses: { type: h.reverses_type, id: h.reverses_id },
    };
  }
  const lines = await c.query<{
    account_id: string;
    party_id: string | null;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, party_id, debit, credit FROM erp.journal_voucher_lines WHERE voucher_id = $1
     ORDER BY line_no`,
    [id],
  );
  return {
    voucher: {
      ...base,
      narration: h.narration ?? '',
      lines: lines.rows.map((l) => ({
        accountId: l.account_id,
        partyId: l.party_id,
        debit: toMoney(l.debit),
        credit: toMoney(l.credit),
      })),
    },
  };
}

/** A back-office document's stored posting (journal and party entries; they move no stock), or null (W1-19). */
export async function loadMoneyPosting(
  c: pg.ClientBase,
  type: ReversibleType,
  id: string,
): Promise<Posting | null> {
  const posting = await c.query<{ seq: string; entry_date: string }>(
    'SELECT seq, entry_date::text FROM erp.postings WHERE source_type = $1 AND source_id = $2',
    [type, id],
  );
  const p = posting.rows[0];
  if (!p) return null;
  const lines = await c.query<{
    account_id: string;
    party_id: string | null;
    branch_id: string;
    memo: string | null;
    debit: string;
    credit: string;
  }>(
    `SELECT l.account_id, l.party_id, l.branch_id, e.memo, l.debit, l.credit FROM erp.journal_entries e
     JOIN erp.journal_lines l ON l.entry_id = e.id WHERE e.posting_seq = $1 ORDER BY l.line_no`,
    [p.seq],
  );
  const parties = await c.query<{
    party_id: string;
    role: 'customer' | 'supplier';
    amount: string;
    due_date: string;
  }>(
    `SELECT party_id, role, amount, due_date::text FROM erp.party_ledger_entries WHERE posting_seq = $1 ORDER BY id`,
    [p.seq],
  );
  return {
    entryDate: p.entry_date,
    journal: {
      branchId: lines.rows[0]?.branch_id ?? '',
      memo: lines.rows[0]?.memo ?? '',
      lines: lines.rows.map((l) => ({
        accountId: l.account_id,
        partyId: l.party_id,
        debit: toMoney(l.debit),
        credit: toMoney(l.credit),
      })),
    },
    movements: [],
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
