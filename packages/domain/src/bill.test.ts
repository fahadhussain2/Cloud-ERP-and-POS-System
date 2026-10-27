import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import approvalCases from '../golden/bill-approvals.json';
import approverCases from '../golden/bill-approvers.json';
import editCases from '../golden/bill-edits.json';
import inputCases from '../golden/bill-input.json';
import pricingCases from '../golden/bill-pricing.json';
import totalCases from '../golden/bill-totals.json';
import {
  addLine,
  approve,
  billAmounts,
  canApprove,
  changeTier,
  emptyBill,
  parseDiscount,
  parseWholeAmount,
  pendingApprovals,
  priceNeed,
  removeLine,
  setBillDiscount,
  setQty,
  setUnitPrice,
  type ApprovalKind,
  type ApprovalTarget,
  type Bill,
  type NewLine,
  type OverrideReason,
} from './bill';
import { money, type Money } from './money';
import { ROLE_TEMPLATES, type RoleGrant, type RoleLimits, type RoleTemplateKey } from './permissions';
import { qty } from './quantity';
import { runGolden, type GoldenFile } from './testing/golden';

// The JSON holds plain numbers; the functions take Money and Qty. Bills and lines go in as they are (the numbers are
// already whole minor units and thousandths), single values through money() and qty().
const m = (v: number | null): Money | null => (v === null ? null : money(v));

runGolden(
  pricingCases as GoldenFile<{
    qty: number;
    list: number | null;
    floor: number | null;
    net: number;
    maxDiscountBp: number;
  }>,
  (i) =>
    priceNeed({
      qty: qty(i.qty),
      list: m(i.list),
      floor: m(i.floor),
      net: money(i.net),
      maxDiscountBp: i.maxDiscountBp,
    }),
);

type GrantInput =
  | { template: RoleTemplateKey; branchId: string | null }
  | { permissions: string[]; limits: RoleLimits; branchId: string | null };
const toGrant = (g: GrantInput): RoleGrant =>
  'template' in g ? { ...ROLE_TEMPLATES[g.template], branchId: g.branchId } : g;

runGolden(
  approverCases as GoldenFile<{
    grants: GrantInput[];
    branchId: string;
    need: ApprovalKind;
    discountBp: number | null;
  }>,
  (i) => canApprove(i.grants.map(toGrant), i.branchId, i.need, i.discountBp),
);

runGolden(totalCases as unknown as GoldenFile<Bill>, (bill) => billAmounts(bill));

runGolden(approvalCases as unknown as GoldenFile<{ bill: Bill; sellerMaxDiscountBp: number }>, (i) =>
  pendingApprovals(i.bill, i.sellerMaxDiscountBp),
);

type Op =
  | { op: 'add'; item: NewLine; qty: number; lineId: string; unitPrice?: number }
  | { op: 'qty'; lineId: string; qty: number }
  | { op: 'price'; lineId: string; price: number }
  | { op: 'remove'; lineId: string }
  | { op: 'tier'; tierId: string; prices: Record<string, number | null> }
  | { op: 'discount'; amount: number }
  | {
      op: 'approve';
      target: ApprovalTarget;
      sellerMaxDiscountBp: number;
      approvedBy: string;
      reason: OverrideReason;
      note: string | null;
      at: string;
    };

const apply = (bill: Bill, o: Op): Bill => {
  switch (o.op) {
    case 'add':
      return addLine(
        bill,
        o.item,
        qty(o.qty),
        o.lineId,
        o.unitPrice === undefined ? undefined : money(o.unitPrice),
      );
    case 'qty':
      return setQty(bill, o.lineId, qty(o.qty));
    case 'price':
      return setUnitPrice(bill, o.lineId, money(o.price));
    case 'remove':
      return removeLine(bill, o.lineId);
    case 'tier':
      return changeTier(
        bill,
        o.tierId,
        Object.fromEntries(Object.entries(o.prices).map(([k, v]) => [k, m(v)])),
      );
    case 'discount':
      return setBillDiscount(bill, money(o.amount));
    case 'approve':
      return approve(bill, o.target, o.sellerMaxDiscountBp, {
        approvedBy: o.approvedBy,
        reason: o.reason,
        note: o.note,
        at: o.at,
      });
  }
};

runGolden(editCases as unknown as GoldenFile<{ ops: Op[] }>, (i) =>
  i.ops.reduce(apply, emptyBill('s1', 'retail')),
);

runGolden(
  inputCases as GoldenFile<
    | { kind: 'amount'; text: string; minorUnits: number }
    | { kind: 'discount'; text: string; base: number; minorUnits: number }
  >,
  (i) =>
    i.kind === 'amount'
      ? parseWholeAmount(i.text, i.minorUnits)
      : parseDiscount(i.text, money(i.base), i.minorUnits),
);

describe('bill amount properties', () => {
  const lines = fc.array(
    fc.record({
      qty: fc.integer({ min: 1, max: 9_999_000 }),
      unitPrice: fc.integer({ min: 0, max: 50_000_000 }),
    }),
    { minLength: 1, maxLength: 40 },
  );

  it('the bill discount shares add up to it, and the total is the sum of the nets', () => {
    fc.assert(
      fc.property(lines, fc.integer({ min: 0, max: 10_000 }), (ls, pct) => {
        let bill = emptyBill('s1', 'retail');
        ls.forEach((l, n) => {
          bill = addLine(
            bill,
            { itemId: `i${n}`, list: null, floor: null, allowsFraction: true },
            qty(l.qty),
            `l${n}`,
            money(l.unitPrice),
          );
        });
        const before = billAmounts(bill);
        const discount = money(Math.floor((before.total * pct) / 10_000));
        const after = billAmounts(setBillDiscount(bill, discount));
        expect(after.lines.reduce((s, l) => s + l.billShare, 0)).toBe(discount);
        expect(after.lines.reduce((s, l) => s + l.net, 0)).toBe(after.total);
        expect(after.total).toBe(before.total - discount);
      }),
    );
  });
});
