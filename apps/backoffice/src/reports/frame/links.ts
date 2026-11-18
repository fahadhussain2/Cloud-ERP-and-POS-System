import { href, withQuery } from '../../router';

// Drill-down (W2-01 plan): every figure opens the lines behind it, and every line its document.

/** Where a journal line's document opens in the back office: its own screen, or a counter bill's trace (PLT-12). */
export function documentHref(type: string, id: string, number: string | null): string | null {
  if (['customer_receipt', 'expense', 'fund_transfer', 'supplier_payment', 'journal_voucher'].includes(type))
    return href.accountingDocument(type, id);
  if (type === 'goods_receipt') return href.receipt(id);
  if (type === 'purchase_return') return href.purchaseReturn(id);
  if (type === 'stock_transfer' || type === 'stock_transfer_receipt') return href.transfer(id);
  if (type === 'stock_adjustment') return href.adjustment(id);
  if ((type === 'sale' || type === 'sales_void') && number) return href.trace(number);
  return null;
}

/** An account's ledger for a period. */
export const ledgerHref = (accountId: string, from: string, to: string) =>
  withQuery(href.ledger(accountId), { from, to });
