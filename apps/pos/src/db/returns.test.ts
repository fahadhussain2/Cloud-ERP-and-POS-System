// @vitest-environment node
import { SaleDocumentV2 } from '@erp/contracts';
import {
  addReturn,
  DomainError,
  emptyBill,
  money,
  qty,
  type Bill,
  type ReturnDocument,
  type SaleDocument,
  type Tender,
} from '@erp/domain';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OpenBill } from '../bill/open-bill';
import { finalizeSale } from './checkout';
import { creditFigures } from './customers';
import { deskState, openSession } from './desk';
import { migrate } from './migrate';
import { applyPull, saveOpenBill, setDevice } from './repo';
import { findBills, noReceiptPrice, pruneBills, returnableBill, returnPolicy } from './returns';
import { wrapOo1, type SqlDb } from './sql';

// Returns on the counter (POS-12, POS spec §19, W1-13, rule 6), on real SQLite: finding the bill among the branch's
// pulled 90-day bills and this counter's own, what each line can still give back, the no-receipt suggestion, and the
// return finalized with its outbox row together or not at all.

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
let db: SqlDb;

const ID = (n: string) => `019a0000-0000-7000-8000-0000000000${n}`;
const SARA = ID('a1');
const ALI = ID('a5');
const KHAN = ID('f7');
const PADS = ID('c1');
const OTHER = ID('d2');
/** 14:15 in Karachi on 2026-11-12. */
const T0 = Date.parse('2026-11-12T09:15:00.000Z');
const RS = money(100);
let n = 0;
const made = (atMs = T0 + ++n * 1000) => ({
  id: `019a3f6e-7b10-7c3a-9d2e-${String(++n).padStart(12, '0')}`,
  createdAtMs: atMs,
  clientVersion: '0.10.0',
});

const row = (r: Record<string, unknown>) => ({ row_version: '1', deleted_at: null, ...r });
const user = (id: string, username: string) =>
  row({
    id,
    username,
    full_name: username,
    short_code: null,
    pin_verifier: 'v',
    pin_must_change: false,
    status: 'active',
  });
const role = (id: string, permissions: string[]) =>
  row({
    id,
    name: id,
    template_key: null,
    permissions,
    limits: { maxDiscountBp: 10000, voidWindow: 'none' },
  });
const method = (id: string, code: string, sort: number, isCash = false) =>
  row({ id, code, name: code, is_cash: isCash, requires_reference: false, is_active: true, sort });

/** C02-S000412, another counter's bill of 2026-11-02, pulled: two pads (Rs 4,350 each, a Rs 100 bill discount). */
const PULLED = {
  id: ID('b9'),
  number: 'C02-S000412',
  lines: [
    row({
      id: ID('91'),
      document_id: ID('b9'),
      line_no: 1,
      item_id: PADS,
      qty: '2.000',
      unit_price: '435000',
      line_total: '860000',
      original_line_id: null,
    }),
  ],
};

/** Counter C03 (or desk D01), with Sara (a salesman), Ali (a cashier) and Khan Motors (phone 0300-1234567). */
function ready(kind: 'counter' | 'cash_desk' = 'counter') {
  const code = kind === 'counter' ? 'C03' : 'D01';
  setDevice(db, { deviceId: ID('d1'), tenantId: ID('f1'), branchId: ID('e1'), code, kind });
  applyPull(
    db,
    {
      tenant: [
        row({
          id: ID('f1'),
          name: 'Delux Autos',
          timezone: 'Asia/Karachi',
          cash_rounding_increment: '100',
          currency_minor_units: 2,
          day_cutoff_hour: 4,
          return_window_days: 30,
        }),
      ],
      users: [user(SARA, 'sara'), user(ALI, 'ali')],
      roles: [
        role(ID('r1'), ['pos.sale.create', 'pos.credit.sell', 'pos.return.create']),
        role(ID('r5'), ['pos.sale.create', 'cash.handover.receive', 'cash.refund.pay', 'cash.session.close']),
      ],
      user_roles: [
        row({ id: ID('u1'), user_id: SARA, role_id: ID('r1'), branch_id: null }),
        row({ id: ID('u5'), user_id: ALI, role_id: ID('r5'), branch_id: null }),
      ],
      payment_methods: [method(ID('m1'), 'cash', 1, true), method(ID('m7'), 'on_account', 7)],
      device: [row({ id: ID('d1'), code, print_profile_id: null, status: 'active' })],
      price_tiers: [row({ id: ID('b1'), code: 'RETAIL', name: 'Retail', sort: 1, is_default: true })],
      units: [row({ id: ID('81'), code: 'PCS', name: 'Pieces', allows_fraction: false })],
      categories: [
        row({
          id: ID('71'),
          code: 'BRK',
          name: 'Brakes',
          parent_id: null,
          pricing_rule: {},
          return_policy: { window_days: 7 },
        }),
      ],
      items: [
        row({
          id: PADS,
          code: 'BRPD001',
          name: 'BRAKE PADS',
          category_id: ID('71'),
          brand_id: null,
          origin_id: null,
          unit_id: ID('81'),
          variant: null,
          spec: null,
          bin_location: null,
          floor_price: null,
          tax_code_id: null,
          status: 'active',
        }),
      ],
      item_prices: [row({ id: ID('61'), item_id: PADS, tier_id: ID('b1'), price: '450000' })],
      customers: [
        row({
          id: KHAN,
          code: 'C0042',
          name: 'Khan Motors',
          phones: ['0300-1234567'],
          city: 'Karachi',
          status: 'active',
        }),
      ],
      customer_accounts: [
        row({
          id: ID('c1'),
          party_id: KHAN,
          price_tier_id: ID('b1'),
          credit_allowed: true,
          credit_limit: '1000000',
          offline_daily_cap: '200000',
        }),
      ],
      bills: [
        row({
          id: PULLED.id,
          number: PULLED.number,
          device_id: OTHER,
          kind: 'sale',
          status: 'finalized',
          business_date: '2026-11-02',
          created_at_device: '2026-11-02T08:00:00.000Z',
          customer_party_id: null,
          walkin_phone: '03219876543',
          total: '860000',
          return_of_id: null,
        }),
      ],
      bill_lines: PULLED.lines,
      bill_payments: [row({ id: ID('41'), document_id: PULLED.id, method_id: ID('m1'), amount: '860000' })],
    },
    'cursor',
  );
}

const padsLine = {
  id: 'l1',
  itemId: PADS,
  qty: qty(1000),
  allowsFraction: false,
  list: money(450000),
  floor: null,
  unitPrice: money(450000),
  approval: null,
};
const items = { [PADS]: { code: 'BRPD001', name: 'BRAKE PADS', variant: null, spec: null } };

const cash = (amount: number): Tender => ({
  payments: [{ method: 'cash', amount: money(amount), reference: null }],
  cashReceived: null,
});

/** Sells one pad on this counter, to Khan Motors on account or to a walk-in in cash. */
function sell(onAccount = false): SaleDocument {
  saveOpenBill(db, SARA, {
    version: 1,
    bill: { ...emptyBill(SARA, ID('b1')), lines: [padsLine] },
    items,
    customer: onAccount ? { id: KHAN, code: 'C0042', name: 'Khan Motors' } : null,
  });
  return finalizeSale(db, {
    userId: SARA,
    ...made(),
    tender: onAccount
      ? { payments: [{ method: 'on_account', amount: money(450000), reference: null }], cashReceived: null }
      : cash(450000),
    offline: false,
    creditApproval: null,
  }).document as SaleDocument;
}

/** Puts `units` pads of `billId`'s line 1 on Sara's open bill, as the return dialog does. */
function returning(billId: string, units: number, customer: OpenBill['customer'] = null): void {
  const original = returnableBill(db, billId)!;
  const l = original.lines[0]!;
  const bill: Bill = addReturn(emptyBill(SARA, ID('b1')), {
    source: {
      kind: 'bill',
      id: original.id,
      number: original.number,
      businessDate: original.businessDate,
      customerId: original.customerId,
    },
    lines: [
      {
        id: 'r1',
        itemId: l.itemId,
        qty: qty(units * 1000),
        allowsFraction: false,
        reason: 'wrong_part',
        note: null,
        condition: 'resellable',
        original: { line: l, returned: l.returned },
        price: null,
        suggested: null,
      },
    ],
    needs: [],
    approval: null,
  });
  saveOpenBill(db, SARA, { version: 1, bill, items, customer });
}

const finalizeReturn = (tender: Tender) =>
  finalizeSale(db, { userId: SARA, ...made(), tender, offline: false, creditApproval: null })
    .document as ReturnDocument;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

beforeEach(() => {
  db = wrapOo1(new sqlite3.oo1.DB(':memory:'));
  migrate(db);
});

describe('finding the bill (POS spec §19)', () => {
  beforeEach(() => ready());

  it('by its scanned code, its number, the end of its number and its date', () => {
    expect(findBills(db, 'C02-S000412 8600', RS).map((b) => b.number)).toEqual(['C02-S000412']);
    expect(findBills(db, 'c02-s000412', RS).map((b) => b.number)).toEqual(['C02-S000412']);
    expect(findBills(db, 'S412', RS).map((b) => b.number)).toEqual(['C02-S000412']);
    expect(findBills(db, '2026-11-02', RS).map((b) => b.number)).toEqual(['C02-S000412']);
    expect(findBills(db, '2/11/2026', RS).map((b) => b.number)).toEqual(['C02-S000412']);
    expect(findBills(db, '2026-11-03', RS)).toEqual([]);
  });

  it("by a walk-in's phone, and by a customer's phone; this counter's own bills too", () => {
    expect(findBills(db, '9876', RS).map((b) => b.number)).toEqual(['C02-S000412']);
    const own = sell(true);
    expect(findBills(db, '0300 1234567', RS).map((b) => b.number)).toEqual([own.number]);
    expect(findBills(db, own.number, RS).map((b) => b.id)).toEqual([own.id]);
  });
});

describe('what a bill can still give back', () => {
  beforeEach(() => ready());

  it("counts the server's returns and this counter's own unsynced ones", () => {
    expect(returnableBill(db, PULLED.id)!.lines[0]!.returned).toEqual({ qty: 0, refund: 0 });
    // Another counter returned one pad: the pull brings it.
    applyPull(
      db,
      {
        bills: [
          row({
            id: ID('b8'),
            number: 'C02-S000420',
            device_id: OTHER,
            kind: 'return',
            status: 'finalized',
            business_date: '2026-11-05',
            created_at_device: '2026-11-05T08:00:00.000Z',
            customer_party_id: null,
            walkin_phone: null,
            total: '-430000',
            return_of_id: PULLED.id,
          }),
        ],
        bill_lines: [
          row({
            id: ID('92'),
            document_id: ID('b8'),
            line_no: 1,
            item_id: PADS,
            qty: '-1.000',
            unit_price: '430000',
            line_total: '-430000',
            original_line_id: ID('91'),
          }),
        ],
      },
      'cursor2',
    );
    expect(returnableBill(db, PULLED.id)!.lines[0]!.returned).toEqual({ qty: 1000, refund: 430000 });
    // This counter returns the last one: refunded what is left, so the two add up to Rs 8,600.
    returning(PULLED.id, 1);
    const r = finalizeReturn(cash(-430000));
    expect(r.lines[0]!.lineTotal).toBe(-430000);
    expect(returnableBill(db, PULLED.id)!.lines[0]!.returned).toEqual({ qty: 2000, refund: 860000 });
  });

  it('suggests the lowest price of the last 90 days without a receipt, else the default tier’s', () => {
    // The pulled bill: Rs 8,600 for two pads, Rs 4,300 each.
    expect(noReceiptPrice(db, PADS, '2026-11-12')).toBe(430000);
    // 90 days later the bill no longer counts: today's Retail price.
    expect(noReceiptPrice(db, PADS, '2027-01-31')).toBe(450000);
    expect(noReceiptPrice(db, ID('c9'), '2026-11-12')).toBeNull();
  });

  it("reads the tenant's window and the category's own", () => {
    expect(returnPolicy(db, [PADS, ID('c9')])).toEqual({ windowDays: 30, items: [{ windowDays: 7 }, {}] });
  });

  it('drops the pulled bills older than 90 days', () => {
    expect(pruneBills(db, '2027-01-30')).toBe(0);
    expect(returnableBill(db, PULLED.id)).not.toBeNull();
    pruneBills(db, '2027-01-31');
    expect(returnableBill(db, PULLED.id)).toBeNull();
    expect(Number(db.selectValue('SELECT count(*) FROM bill_lines'))).toBe(0);
  });
});

describe('finalizing a return (rule 6)', () => {
  beforeEach(() => ready());

  it('writes the return and its outbox row, and deletes the open bill, in one transaction', () => {
    returning(PULLED.id, 1);
    const r = finalizeReturn(cash(-430000));
    expect(r.version).toBe(2);
    expect(r.kind).toBe('return');
    expect(r.cashDue).toBe(-430000);
    expect(SaleDocumentV2.safeParse(r).success).toBe(true);
    const local = db.selectObjects('SELECT kind, family FROM local_documents WHERE id = ?', [r.id]);
    expect(local).toEqual([{ kind: 'return', family: 'S' }]);
    expect(Number(db.selectValue('SELECT count(*) FROM outbox WHERE id = ?', [r.id]))).toBe(1);
    expect(db.selectValue('SELECT bill FROM open_bills WHERE user_id = ?', [SARA])).toBeUndefined();
  });

  it('refuses a return of what came back since, and writes nothing', () => {
    returning(PULLED.id, 2);
    // Meanwhile this counter returned both pads on another bill of Sara's (a second open bill, as by another login).
    const saved = String(db.selectValue('SELECT bill FROM open_bills WHERE user_id = ?', [SARA]));
    finalizeReturn(cash(-860000));
    db.exec('INSERT INTO open_bills (user_id, bill, updated_at) VALUES (?, ?, ?)', [
      SARA,
      saved,
      '2026-11-12',
    ]);
    const before = Number(db.selectValue('SELECT count(*) FROM outbox'));
    expect(() => finalizeReturn(cash(-860000))).toThrow(DomainError);
    expect(Number(db.selectValue('SELECT count(*) FROM outbox'))).toBe(before);
    expect(db.selectValue('SELECT bill FROM open_bills WHERE user_id = ?', [SARA])).toBe(saved);
  });

  it('keeps a refund to account out of the unsynced credit (POS spec §15)', () => {
    const sale = sell(true);
    expect(creditFigures(db, KHAN, false, '2026-11-12').unsynced).toBe(450000);
    returning(sale.id, 1, { id: KHAN, code: 'C0042', name: 'Khan Motors' });
    finalizeReturn({
      payments: [{ method: 'on_account', amount: money(-450000), reference: null }],
      cashReceived: null,
    });
    expect(creditFigures(db, KHAN, false, '2026-11-12').unsynced).toBe(450000);
  });
});

describe('a return on the cash desk', () => {
  it('is paid out to the open session in the same transaction (cash desk spec §7)', () => {
    ready('cash_desk');
    openSession(db, { userId: ALI, openingFloat: money(0), ...made() });
    returning(PULLED.id, 1);
    const saved = finalizeSale(db, {
      userId: SARA,
      ...made(),
      tender: cash(-430000),
      offline: false,
      creditApproval: null,
    });
    expect(saved.handover?.kind).toBe('payout');
    expect(saved.handover?.amount).toBe(430000);
    expect(deskState(db).local.map((h) => h.billNumber)).toContain(saved.document.number);
  });
});
