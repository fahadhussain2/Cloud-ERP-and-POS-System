import { money, qty, removeLine, setBillDiscount } from '@erp/domain';
import { describe, expect, it } from 'vitest';

import type { BillItem } from '../search/search-index';
import {
  addItem,
  formatQty,
  newOpenBill,
  parseQuantity,
  quantityPrefix,
  setCustomer,
  tryEdit,
} from './bill-state';

// The counter's side of the bill (POS spec §10–§11): the rules themselves are golden-tested in packages/domain.

const pads: BillItem = {
  itemId: 'i1',
  code: 'BRPD001',
  name: 'BRAKE PADS FRONT COROLLA',
  variant: 'FRONT',
  spec: null,
  list: money(450000),
  floor: money(400000),
  allowsFraction: false,
};

describe('the quantity prefix (POS spec §11)', () => {
  it.each([
    ['2*brake pads', 2000, 'brake pads'],
    [' 3 * ABEA001', 3000, 'ABEA001'],
    ['1.5*hose', 1500, 'hose'],
    ['2*', 2000, ''],
    ['brake pads', 1000, 'brake pads'],
    ['17801-0Y040', 1000, '17801-0Y040'],
    ['1.2345*hose', 1000, '1.2345*hose'],
  ])('%j → %d of %j', (text, q, query) => {
    expect(quantityPrefix(text)).toEqual({ qty: q, query });
  });
});

describe('the open bill', () => {
  it('starts empty on the given tier', () => {
    expect(newOpenBill('s1', 't-retail')).toEqual({
      version: 1,
      bill: {
        version: 1,
        sellerId: 's1',
        tierId: 't-retail',
        lines: [],
        billDiscount: 0,
        billApproval: null,
      },
      items: {},
    });
  });

  it('keeps what a line shows, and forgets it when the line goes', () => {
    const added = addItem(newOpenBill('s1', 't'), pads, qty(2000), 'l1');
    if (!added.ok) throw new Error(added.error);
    expect(added.bill.items).toEqual({
      i1: { code: 'BRPD001', name: 'BRAKE PADS FRONT COROLLA', variant: 'FRONT', spec: null },
    });
    expect(added.bill.bill.lines.map((l) => [l.itemId, l.qty, l.unitPrice])).toEqual([['i1', 2000, 450000]]);
    const removed = tryEdit(added.bill, (b) => removeLine(b, 'l1'));
    expect(removed.ok && removed.bill.items).toEqual({});
  });

  it('returns the broken rule instead of throwing', () => {
    expect(addItem(newOpenBill('s1', 't'), { ...pads, list: null }, qty(1000), 'l1')).toEqual({
      ok: false,
      error: 'price_required',
    });
    expect(tryEdit(newOpenBill('s1', 't'), (b) => setBillDiscount(b, money(100)))).toEqual({
      ok: false,
      error: 'discount_too_large',
    });
  });

  it('rethrows anything that is not a broken rule', () => {
    expect(() =>
      tryEdit(newOpenBill('s1', 't'), () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });
});

describe('typed quantities', () => {
  it('reads whole and fractional quantities, and names the rule a bad one breaks', () => {
    expect(parseQuantity('3')).toBe(3000);
    expect(parseQuantity('1.25')).toBe(1250);
    expect(parseQuantity('1.2345')).toBe('too_many_decimals');
    expect(parseQuantity('two')).toBe('invalid_number');
  });

  it('shows quantities as people read them', () => {
    expect(formatQty(qty(2000), 'en-PK')).toBe('2');
    expect(formatQty(qty(1500), 'en-PK')).toBe('1.5');
    expect(formatQty(qty(1005), 'en-PK')).toBe('1.005');
    expect(formatQty(qty(9999000), 'en-PK')).toBe('9,999');
    expect(formatQty(qty(-1500), 'en-PK')).toBe('-1.5');
  });
});

describe('the customer on the bill (POS spec §15)', () => {
  const khan = { id: 'p1', code: 'C0042', name: 'Khan Motors' };
  const withPads = () => {
    const r = addItem(newOpenBill('s1', 't-retail'), pads, qty(1000), 'l1');
    if (!r.ok) throw new Error(r.error);
    return r.bill;
  };

  it("takes the customer's tier: a line at list moves to its price", () => {
    const r = setCustomer(withPads(), { customer: khan, walkinPhone: null }, 't-mech', { i1: money(427500) });
    expect(r.ok && r.bill.customer).toEqual(khan);
    expect(r.ok && r.bill.bill.tierId).toBe('t-mech');
    expect(r.ok && r.bill.bill.lines[0]!.unitPrice).toBe(427500);
  });

  it('drops a walk-in phone once there is a customer, and keeps it for a walk-in', () => {
    const r = setCustomer(withPads(), { customer: khan, walkinPhone: '0300' }, 't-retail', {});
    expect(r.ok && r.bill.walkinPhone).toBeNull();
    const w = setCustomer(withPads(), { customer: null, walkinPhone: '03001234567' }, 't-retail', {});
    expect(w.ok && [w.bill.customer, w.bill.walkinPhone]).toEqual([null, '03001234567']);
  });

  it('back to walk-in returns to the default tier (owner answer 3)', () => {
    const mech = setCustomer(withPads(), { customer: khan, walkinPhone: null }, 't-mech', {
      i1: money(427500),
    });
    if (!mech.ok) throw new Error(mech.error);
    const back = setCustomer(mech.bill, { customer: null, walkinPhone: null }, 't-retail', {
      i1: money(450000),
    });
    expect(back.ok && [back.bill.bill.tierId, back.bill.bill.lines[0]!.unitPrice]).toEqual([
      't-retail',
      450000,
    ]);
  });
});
