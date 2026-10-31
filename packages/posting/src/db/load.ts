import { money, qty, type Money, type PaymentMethodCode, type Qty } from '@erp/domain';
import type pg from 'pg';

import type { LedgerState, PostingContext, PostingRole, PostingSale } from '../types';

// Reading what a posting needs from the database (W1-08). Money comes back as bigint text and quantities as
// numeric; both are turned into whole minor units and thousandths here (rule 1).

const toMoney = (v: string | number): Money => money(String(v));
const toQty = (v: string | number): Qty => qty(Number(v));

/** The sale and who it belongs to, or null when there is no such document. */
export async function loadSale(
  c: pg.ClientBase,
  id: string,
): Promise<{ sale: PostingSale; deviceId: string; sellerId: string } | null> {
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
  }>(
    `SELECT id, line_no, item_id, location_id, (qty * 1000)::bigint AS qty, line_total, tax_amount
     FROM erp.sales_lines WHERE document_id = $1 ORDER BY line_no`,
    [id],
  );
  // A method removed since the bill was paid still posts where it did (W1-07 review).
  const payments = await c.query<{ code: PaymentMethodCode; amount: string }>(
    `SELECT m.code, p.amount FROM erp.sales_payments p JOIN erp.payment_methods m ON m.id = p.method_id
     WHERE p.document_id = $1 ORDER BY p.line_no`,
    [id],
  );
  return {
    deviceId: d.device_id,
    sellerId: d.salesperson_user_id,
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

/** The settings as they are now (ACC-01, ACC-08): accounts by role and by method, the lock date, the terms. */
export async function loadContext(c: pg.ClientBase, customerId: string | null): Promise<PostingContext> {
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
  return {
    accounts: {
      roles: Object.fromEntries(roles.rows.map((r) => [r.system_role, r.id])),
      methods: Object.fromEntries(methods.rows.map((m) => [m.code, m.account])),
    },
    lockDate: tenant.rows[0]?.lock_date ?? null,
    customer,
  };
}

/** The costs and balances a sale's lines touch. */
export async function loadState(c: pg.ClientBase, sale: PostingSale): Promise<LedgerState> {
  const items = [...new Set(sale.lines.map((l) => l.itemId))];
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
    [items, [...new Set(sale.lines.map((l) => l.locationId))]],
  );
  for (const r of balances.rows) (state.balances[r.location_id] ??= {})[r.item_id] = toQty(r.qty);
  return state;
}
