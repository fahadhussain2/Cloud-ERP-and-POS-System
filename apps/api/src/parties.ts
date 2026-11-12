// Where a party (`p`) is used, so a supplier or customer added by mistake can be deleted and one that was used is
// only deactivated (W1-16 owner review, W1-22 owner answer 5, D-105, D-109). Deleting marks rows deleted (parties are
// synced, rule 8); nothing may be left pointing at a deleted party or account.

/** SQL: `p` appears somewhere as a customer (bills, collections, bank receipts, vouchers, the opening, its ledger). */
export const USED_AS_CUSTOMER = `(
      EXISTS (SELECT 1 FROM erp.party_ledger_entries x WHERE x.party_id = p.id AND x.role = 'customer')
      OR EXISTS (SELECT 1 FROM erp.sales_documents x WHERE x.customer_party_id = p.id)
      OR EXISTS (SELECT 1 FROM erp.payments x WHERE x.party_id = p.id)
      OR EXISTS (SELECT 1 FROM erp.customer_receipts x WHERE x.customer_party_id = p.id)
      OR EXISTS (SELECT 1 FROM erp.journal_voucher_lines x WHERE x.party_id = p.id)
      OR EXISTS (SELECT 1 FROM erp.opening_balance_lines x WHERE x.party_id = p.id AND x.kind = 'customer'))`;

/** SQL: `p` appears somewhere as a supplier (purchases, payments, items, the opening, its ledger). */
export const USED_AS_SUPPLIER = `(
      EXISTS (SELECT 1 FROM erp.party_ledger_entries x WHERE x.party_id = p.id AND x.role = 'supplier')
      OR EXISTS (SELECT 1 FROM erp.goods_receipts x WHERE x.supplier_party_id = p.id)
      OR EXISTS (SELECT 1 FROM erp.purchase_returns x WHERE x.supplier_party_id = p.id)
      OR EXISTS (SELECT 1 FROM erp.supplier_payments x WHERE x.supplier_party_id = p.id)
      OR EXISTS (SELECT 1 FROM erp.cash_movements x WHERE x.party_id = p.id)
      OR EXISTS (SELECT 1 FROM erp.journal_voucher_lines x WHERE x.party_id = p.id)
      OR EXISTS (SELECT 1 FROM erp.opening_balance_lines x
                 WHERE (x.party_id = p.id AND x.kind = 'supplier') OR x.last_supplier_id = p.id)
      OR EXISTS (SELECT 1 FROM erp.items x WHERE x.default_supplier_id = p.id AND x.deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM erp.item_costs x WHERE x.last_supplier_id = p.id))`;

/** SQL: `p` has a live customer account / supplier account. */
export const IS_CUSTOMER = `EXISTS (SELECT 1 FROM erp.customer_accounts x WHERE x.party_id = p.id AND x.deleted_at IS NULL)`;
export const IS_SUPPLIER = `EXISTS (SELECT 1 FROM erp.supplier_accounts x WHERE x.party_id = p.id AND x.deleted_at IS NULL)`;

/** SQL: a supplier `p` that may be deleted with its party: used nowhere, and not a customer too. */
export const SUPPLIER_DELETABLE = `(NOT ${USED_AS_SUPPLIER} AND NOT ${USED_AS_CUSTOMER} AND NOT ${IS_CUSTOMER})`;

/**
 * SQL: a customer account of `p` that may be deleted: never used as a customer. When `p` is also a supplier only the
 * customer account goes; otherwise the party goes too, which needs it unused as a supplier as well.
 */
export const CUSTOMER_DELETABLE = `(NOT ${USED_AS_CUSTOMER} AND (${IS_SUPPLIER} OR NOT ${USED_AS_SUPPLIER}))`;
