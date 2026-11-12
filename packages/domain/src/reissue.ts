import type { Approval, Bill, BillApprovalValues, LineApprovalValues } from './bill';
import { DomainError } from './errors';
import type { Money } from './money';
import { QTY_SCALE, type Qty } from './quantity';
import type { SaleDocument, SaleDocumentOverride } from './sale-document';

// The open bill a reissue starts from (POS-11, PRD W5, POS spec §18, owner answer 3 to W1-12): the voided sale's tier,
// lines, prices and bill discount, with its price approvals as they were, so they hold while the prices stay (POS spec
// §10). Credit approvals are never kept on an open bill (POS spec §15): the credit check runs again at payment.

const PRICE_KINDS = new Set(['below_list', 'below_floor']);

const approvalOf = <V>(o: SaleDocumentOverride, values: V): Approval<V> => ({
  kind: o.kind as Approval<V>['kind'],
  requestedBy: o.requestedBy,
  approvedBy: o.approvedBy,
  reason: o.reason as Approval<V>['reason'],
  note: o.note,
  at: o.at,
  values,
});

export function reissueBill(input: {
  document: SaleDocument;
  /** Who reissues: the new bill is theirs. */
  sellerId: string;
  /** Whether each item's unit allows fractions, from the local catalog. */
  allowsFraction: Readonly<Record<string, boolean>>;
  /** The new lines' ids, in line order. */
  lineIds: readonly string[];
}): Bill {
  const { document: d, lineIds } = input;
  if (lineIds.length !== d.lines.length || new Set(lineIds).size !== lineIds.length)
    throw new DomainError('unknown_line', 'one new line id is needed for every line');
  const idOf = new Map(d.lines.map((l, i) => [l.lineNo, lineIds[i]!]));
  const price = d.overrides.filter((o) => PRICE_KINDS.has(o.kind));
  const lineApproval = (lineNo: number) => {
    const o = price.find((x) => x.lineNo === lineNo);
    return o === undefined ? null : approvalOf(o, o.values as LineApprovalValues);
  };
  const billOverride = price.find((o) => o.lineNo === null);
  /** A bill-discount approval carries the bill's lines by number (sync spec §6.1). */
  const billApproval = (o: SaleDocumentOverride) => {
    const v = o.values as { billDiscount: Money; lines: { lineNo: number; qty: Qty; unitPrice: Money }[] };
    return approvalOf<BillApprovalValues>(o, {
      billDiscount: v.billDiscount,
      lines: v.lines.map((l) => ({ id: idOf.get(l.lineNo)!, qty: l.qty, unitPrice: l.unitPrice })),
    });
  };
  return {
    version: 1,
    sellerId: input.sellerId,
    tierId: d.tierId,
    lines: d.lines.map((l) => ({
      id: idOf.get(l.lineNo)!,
      itemId: l.itemId,
      qty: l.qty,
      // An item gone from the local catalog allows fractions only if its quantity has one.
      allowsFraction: input.allowsFraction[l.itemId] ?? l.qty % QTY_SCALE !== 0,
      list: l.listPrice,
      floor: l.floorPrice,
      unitPrice: l.unitPrice,
      approval: lineApproval(l.lineNo),
    })),
    billDiscount: d.amounts.billDiscount,
    billApproval: billOverride === undefined ? null : billApproval(billOverride),
  };
}
