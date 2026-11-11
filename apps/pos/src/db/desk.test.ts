// @vitest-environment node
import {
  CashHandoverV1,
  CashMovementV1,
  CashMovementV2,
  CashSessionV2,
  CustomerCollectionV1,
} from '@erp/contracts';
import { DomainError, money } from '@erp/domain';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OpenBill } from '../bill/open-bill';
import { finalizeSale, recentDocuments, type FinalizeRequest } from './checkout';
import {
  closeSession,
  confirmHandover,
  deskCustomer,
  deskLookups,
  deskState,
  giveBackVoidCash,
  openSession,
  receiveCollection,
  recordCashMovement,
  type HandoverRequest,
} from './desk';
import { migrate } from './migrate';
import { applyPull, saveOpenBill, setDevice } from './repo';
import { wrapOo1, type SqlDb } from './sql';

// The cash desk's local side (W1-10, cash desk spec, rule 6), on real SQLite: sessions and handovers are documents
// written with their outbox rows in one transaction, and a refused one writes nothing.

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
let db: SqlDb;

const ID = (n: string) => `019a0000-0000-7000-8000-0000000000${n}`;
const ALI = ID('a5');
const BILAL = ID('a6');
const SARA = ID('a1');
const T0 = Date.parse('2026-11-02T10:15:30.000Z');
let n = 0;
const made = () => {
  n += 1;
  return {
    id: `019a3f6e-7b10-7c3a-9d2e-${String(n).padStart(12, '0')}`,
    createdAtMs: T0 + n * 1000,
    clientVersion: '0.8.0',
  };
};

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
const queued = (number: string, cashDue: number, over: Record<string, unknown> = {}) =>
  row({
    id: `019a5000-0000-7000-8000-${number.slice(-12).replace(/\D/g, '0').padStart(12, '0')}`,
    number,
    device_id: ID('d3'),
    salesperson_user_id: SARA,
    created_at_device: '2026-11-02T10:10:00.000Z',
    business_date: '2026-11-02',
    cash_due: String(cashDue),
    cash_received: '500000',
    change_due: String(500000 - cashDue),
    handover_status: 'pending',
    status: 'finalized',
    ...over,
  });

/** Desk D01 with Ali and Bilal (cashiers), Sara (a salesman), Delux's cash method and two bills in the queue. */
function ready(kind: 'cash_desk' | 'counter' = 'cash_desk') {
  setDevice(db, { deviceId: ID('d9'), tenantId: ID('f1'), branchId: ID('e1'), code: 'D01', kind });
  applyPull(
    db,
    {
      tenant: [
        row({
          id: ID('f1'),
          name: 'Delux Autos',
          timezone: 'Asia/Karachi',
          cash_rounding_increment: '100',
          day_cutoff_hour: 4,
        }),
      ],
      users: [user(ALI, 'ali'), user(BILAL, 'bilal'), user(SARA, 'sara')],
      roles: [
        role(ID('r5'), ['pos.sale.create', 'cash.handover.receive', 'cash.refund.pay', 'cash.session.close']),
        role(ID('r1'), ['pos.sale.create']),
      ],
      user_roles: [
        row({ id: ID('u5'), user_id: ALI, role_id: ID('r5'), branch_id: null }),
        row({ id: ID('u6'), user_id: BILAL, role_id: ID('r5'), branch_id: null }),
        row({ id: ID('u1'), user_id: SARA, role_id: ID('r1'), branch_id: null }),
      ],
      payment_methods: [
        row({
          id: ID('91'),
          code: 'cash',
          name: 'Cash',
          is_cash: true,
          requires_reference: false,
          is_active: true,
          sort: 1,
        }),
      ],
      device: [row({ id: ID('d9'), code: 'D01', print_profile_id: null, status: 'active' })],
      cash_queue: [
        queued('C03-S000412', 432000),
        queued('C03-S000415', -45000, { cash_received: null, change_due: null }),
      ],
    },
    'cursor',
  );
}

const count = (sql: string) => Number(db.selectValue(sql));
const open = (userId = ALI, float = 500000) =>
  openSession(db, { userId, openingFloat: money(float), ...made() });
const hand = (over: Partial<HandoverRequest> = {}) =>
  confirmHandover(db, {
    userId: ALI,
    billNumber: 'C03-S000412',
    cashReceived: null,
    method: 'queue',
    code: null,
    ...made(),
    ...over,
  });
const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    return (err as DomainError).code;
  }
  throw new Error('expected a refusal');
};

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});
beforeEach(() => {
  db = wrapOo1(new sqlite3.oo1.DB(':memory:'));
  migrate(db);
  ready();
});

describe('the session (CSH-01)', () => {
  it('opens with its float: one Z document, its outbox row and the session row', () => {
    const z = open();
    expect(CashSessionV2.safeParse(z).success).toBe(true);
    expect(z).toMatchObject({ number: 'D01-Z000001', event: 'open', openingFloat: 500000, userId: ALI });
    expect(count("SELECT count(*) FROM outbox WHERE family = 'Z'")).toBe(1);
    expect(deskState(db, T0).session).toMatchObject({
      id: z.id,
      cashierId: ALI,
      status: 'open',
      handedIn: 0,
      paidOut: 0,
      expected: 500000,
    });
  });

  it('refuses a second open, and a salesman, and writes nothing', () => {
    open();
    expect(refused(() => open(BILAL))).toBe('session_open');
    db.exec('DELETE FROM cash_sessions');
    expect(refused(() => open(SARA))).toBe('not_permitted');
    expect(count("SELECT count(*) FROM outbox WHERE family = 'Z'")).toBe(1);
    expect(db.selectValue("SELECT next_seq FROM local_series WHERE family = 'Z'")).toBe(2);
  });

  it('closes with the expected cash, by another cashier too (owner answer 1); then nothing more is taken', () => {
    open();
    hand();
    hand({ billNumber: 'C03-S000415' });
    // Counted exactly: Rs 5,000 + 4,320 − 450 (W1-11).
    const z = closeSession(db, {
      userId: BILAL,
      counts: { '500000': 1, '100000': 3, '50000': 1, '10000': 3, '5000': 1, '2000': 1 },
      reason: null,
      note: null,
      acknowledgerId: null,
      leftInDrawer: null,
      ...made(),
    });
    expect(CashSessionV2.safeParse(z).success).toBe(true);
    expect(z).toMatchObject({ event: 'close', expectedCash: 500000 + 432000 - 45000, userId: BILAL });
    expect(deskState(db, T0).session?.status).toBe('closed');
    db.exec("UPDATE cash_queue SET handover_status = 'pending'");
    expect(refused(() => hand({ billNumber: 'C03-S000412', userId: ALI }))).toBe('no_session');
    expect(
      refused(() =>
        closeSession(db, {
          userId: ALI,
          counts: {},
          reason: null,
          note: null,
          acknowledgerId: null,
          leftInDrawer: null,
          ...made(),
        }),
      ),
    ).toBe('no_session');
  });
});

describe('handovers (CSH-02, CSH-03, CSH-04)', () => {
  beforeEach(() => {
    open();
  });

  it('confirms a queued bill as shown: an H document with its outbox row, counted in the session', () => {
    const h = hand();
    expect(CashHandoverV1.safeParse(h).success).toBe(true);
    expect(h).toMatchObject({
      number: 'D01-H000001',
      kind: 'in',
      amount: 432000,
      cashReceived: 500000,
      changeGiven: 68000,
      saleDocumentId: expect.any(String) as string,
      method: 'queue',
    });
    expect(count("SELECT count(*) FROM outbox WHERE family = 'H'")).toBe(1);
    const state = deskState(db, T0 + 60_000);
    expect(state.local).toEqual([
      { billNumber: 'C03-S000412', kind: 'in', number: 'D01-H000001', cashierId: ALI, at: h.createdAt },
    ]);
    expect(state.session).toMatchObject({ handedIn: 432000, expected: 932000 });
  });

  it('keeps a correction on the handover, never on the bill', () => {
    const h = hand({ cashReceived: money(1000000) });
    expect(h).toMatchObject({ cashReceived: 1000000, changeGiven: 568000, correctedFrom: 500000 });
    expect(db.selectValue("SELECT cash_received FROM cash_queue WHERE number = 'C03-S000412'")).toBe(500000);
  });

  it('pays out a refund', () => {
    const h = hand({ billNumber: 'C03-S000415' });
    expect(h).toMatchObject({ kind: 'payout', amount: 45000, cashReceived: null, changeGiven: null });
    expect(deskState(db, T0).session).toMatchObject({ paidOut: 45000, expected: 455000 });
  });

  it('records an offline scan of a bill not in the queue from its code', () => {
    const h = hand({ billNumber: 'C04-S000077', method: 'scan', code: { cashDue: money(125000) } });
    expect(h).toMatchObject({
      billNumber: 'C04-S000077',
      saleDocumentId: null,
      amount: 125000,
      cashReceived: null,
    });
    expect(CashHandoverV1.safeParse(h).success).toBe(true);
  });

  it('refuses a second handover of a bill, a bill not in the queue without its code, and another cashier; writing nothing', () => {
    hand();
    expect(refused(() => hand({ method: 'scan' }))).toBe('already_handed_over');
    expect(refused(() => hand({ billNumber: 'C04-S000077' }))).toBe('nothing_to_collect');
    expect(refused(() => hand({ billNumber: 'C03-S000415', userId: BILAL }))).toBe('not_session_cashier');
    expect(count("SELECT count(*) FROM outbox WHERE family = 'H'")).toBe(1);
    expect(db.selectValue("SELECT next_seq FROM local_series WHERE family = 'H'")).toBe(2);
  });

  it('refuses a bill the server says is already received', () => {
    db.exec("UPDATE cash_queue SET handover_status = 'received' WHERE number = 'C03-S000412'");
    expect(refused(() => hand())).toBe('already_handed_over');
  });

  it('leaves handovers and sessions out of the reprint list', () => {
    hand();
    expect(recentDocuments(db, '2000-01-01T00:00:00.000Z')).toEqual([]);
  });
});

describe('a cash sale on the desk itself (PRD W4.5, owner answer 4)', () => {
  const bill = {
    version: 1,
    bill: {
      version: 1,
      sellerId: SARA,
      tierId: ID('b1'),
      lines: [
        {
          id: 'l1',
          itemId: ID('c1'),
          qty: 1000,
          allowsFraction: false,
          list: 80000,
          floor: null,
          unitPrice: 80000,
          approval: null,
        },
      ],
      billDiscount: 0,
      billApproval: null,
    },
    items: { [ID('c1')]: { code: 'OIL001', name: 'OIL', variant: null, spec: null } },
  } as unknown as OpenBill;
  const sell = (): ReturnType<typeof finalizeSale> => {
    saveOpenBill(db, SARA, bill);
    const req: FinalizeRequest = {
      userId: SARA,
      ...made(),
      tender: {
        payments: [{ method: 'cash', amount: money(80000), reference: null }],
        cashReceived: money(100000),
      },
      offline: false,
      creditApproval: null,
    };
    return finalizeSale(db, req);
  };

  it("is handed over to the open session in the same transaction, by the session's cashier", () => {
    open();
    const r = sell();
    expect(r.handover).toMatchObject({
      billNumber: r.document.number,
      saleDocumentId: r.document.id,
      method: 'auto',
      cashierId: ALI,
      amount: 80000,
      cashReceived: 100000,
      changeGiven: 20000,
    });
    expect(db.selectObjects('SELECT family FROM outbox ORDER BY family').map((x) => x['family'])).toEqual([
      'H',
      'S',
      'Z',
    ]);
  });

  it('waits in the queue when no session is open', () => {
    expect(sell().handover).toBeNull();
    expect(count("SELECT count(*) FROM outbox WHERE family = 'H'")).toBe(0);
  });

  it('is never made on a counter', () => {
    open();
    ready('counter');
    expect(sell().handover).toBeNull();
  });
});

// W1-11 (cash desk spec, rule 6): a collection, a cash-out and the counted close are documents written with their
// outbox rows in one transaction; the expected cash counts all of them; the next open knows what stayed.
describe('collections, cash-out and the counted close (CSH-05…CSH-07)', () => {
  const CUSTOMER = ID('c1');
  const SUPPLIER = ID('c2');
  beforeEach(() => {
    applyPull(
      db,
      {
        roles: [
          role(ID('r5'), [
            'pos.sale.create',
            'cash.handover.receive',
            'cash.refund.pay',
            'cash.collection.receive',
            'cash.movement.create',
            'cash.session.close',
          ]),
          role(ID('r2'), ['cash.session.close', 'cash.variance.approve']),
        ],
        users: [user(ID('a2'), 'imran')],
        user_roles: [row({ id: ID('u2'), user_id: ID('a2'), role_id: ID('r2'), branch_id: null })],
        payment_methods: [
          row({
            id: ID('92'),
            code: 'raast',
            name: 'Raast',
            is_cash: false,
            requires_reference: true,
            is_active: true,
            sort: 2,
          }),
        ],
        customers: [
          row({ id: CUSTOMER, code: 'C0042', name: 'Ali Autos', phones: [], city: null, status: 'active' }),
        ],
        customer_accounts: [
          row({
            id: ID('ca'),
            party_id: CUSTOMER,
            price_tier_id: ID('t1'),
            credit_allowed: true,
            credit_limit: null,
            offline_daily_cap: '0',
          }),
        ],
        customer_balances: [
          row({ party_id: CUSTOMER, balance: '1250000', updated_at: '2026-11-02T00:00:00Z' }),
        ],
        suppliers: [
          row({
            id: SUPPLIER,
            code: 'S0007',
            name: 'Addi Traders',
            phones: [],
            city: null,
            status: 'active',
          }),
        ],
        supplier_balances: [
          row({ party_id: SUPPLIER, balance: '900000', updated_at: '2026-11-02T00:00:00Z' }),
        ],
        expense_categories: [
          row({ id: ID('e7'), code: 'GENERAL', name: 'General expenses', is_active: true }),
        ],
        bank_accounts: [
          row({ id: ID('b1'), code: 'soneri', name: 'Soneri', kind: 'bank', is_active: true }),
          row({ id: ID('b2'), code: 'jazzcash', name: 'JazzCash', kind: 'wallet', is_active: true }),
        ],
      },
      'cursor-2',
    );
    open();
  });

  const collect = (over: Partial<Parameters<typeof receiveCollection>[1]> = {}) =>
    receiveCollection(db, {
      userId: ALI,
      partyId: CUSTOMER,
      methodId: ID('91'),
      amount: money(500000),
      reference: null,
      note: null,
      ...made(),
      ...over,
    });
  const out = (over: Partial<Parameters<typeof recordCashMovement>[1]> = {}) =>
    recordCashMovement(db, {
      userId: ALI,
      kind: 'expense',
      amount: money(20000),
      expenseCategoryId: ID('e7'),
      supplierId: null,
      bankAccountId: null,
      note: 'tea',
      reference: null,
      overDrawerConfirmed: false,
      ...made(),
      ...over,
    });
  const close = (over: Partial<Parameters<typeof closeSession>[1]> = {}) =>
    closeSession(db, {
      userId: ALI,
      counts: {},
      reason: null,
      note: null,
      acknowledgerId: null,
      leftInDrawer: null,
      ...made(),
      ...over,
    });

  it("offers the desk's methods (not on account), categories, suppliers with balances and banks only", () => {
    const l = deskLookups(db);
    expect(l.methods.map((m) => m.code)).toEqual(['cash', 'raast']);
    expect(l.suppliers).toEqual([
      { partyId: SUPPLIER, code: 'S0007', name: 'Addi Traders', balance: 900000 },
    ]);
    expect(l.banks.map((b) => b.name)).toEqual(['Soneri']);
  });

  it('records a cash collection as an R document with its outbox row; the balance here goes down until synced', () => {
    const r = collect();
    expect(CustomerCollectionV1.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({
      number: 'D01-R000001',
      amount: 500000,
      balanceBefore: 1250000,
      methodCode: 'cash',
    });
    expect(count("SELECT count(*) FROM outbox WHERE family = 'R'")).toBe(1);
    expect(deskCustomer(db, CUSTOMER, T0)?.balance).toBe(750000);
    expect(deskCustomer(db, CUSTOMER, T0)?.lastCollection).toMatchObject({
      number: 'D01-R000001',
      amount: 500000,
    });
    expect(deskState(db, T0).session).toMatchObject({ collected: 500000, expected: 1000000 });
  });

  it('keeps a Raast collection out of the drawer, and refuses one without its reference, writing nothing', () => {
    expect(refused(() => collect({ methodId: ID('92') }))).toBe('reference_required');
    expect(count("SELECT count(*) FROM outbox WHERE family = 'R'")).toBe(0);
    collect({ methodId: ID('92'), reference: 'TX-1', amount: money(250050) });
    expect(deskState(db, T0).session).toMatchObject({ collected: 0, expected: 500000 });
  });

  it('records cash-outs as M documents and asks before paying out more than the drawer should hold', () => {
    const m = out();
    expect(CashMovementV1.safeParse(m).success).toBe(true);
    expect(m).toMatchObject({ number: 'D01-M000001', targetName: 'General expenses' });
    out({
      kind: 'supplier_payment',
      expenseCategoryId: null,
      supplierId: SUPPLIER,
      amount: money(100000),
      note: 'runner',
    });
    expect(
      refused(() => out({ kind: 'bank_deposit', expenseCategoryId: null, bankAccountId: ID('b2') })),
    ).toBe('missing_target');
    expect(refused(() => out({ amount: money(9_000_000) }))).toBe('over_drawer');
    out({
      kind: 'to_safe',
      expenseCategoryId: null,
      note: null,
      amount: money(9_000_000),
      overDrawerConfirmed: true,
    });
    out({ kind: 'from_safe', expenseCategoryId: null, note: null, amount: money(50000) });
    expect(deskState(db, T0).session).toMatchObject({
      cashOut: 20000 + 100000 + 9_000_000,
      fromSafe: 50000,
      expected: 500000 - 20000 - 100000 - 9_000_000 + 50000,
    });
  });

  it("closes with a count Rs 300 short, the manager's acknowledgement and Rs 5,000 left; the next open knows it", () => {
    collect();
    // Expected: 5,000 float + 5,000 collected = 10,000; counted 9,700.
    const z = close({
      counts: { '500000': 1, '100000': 4, '50000': 1, '10000': 2 },
      reason: 'change_error',
      acknowledgerId: ID('a2'),
      leftInDrawer: money(500000),
    });
    expect(CashSessionV2.safeParse(z).success).toBe(true);
    expect(z).toMatchObject({
      expectedCash: 1000000,
      countedCash: 970000,
      variance: -30000,
      acknowledgedByUserId: ID('a2'),
      leftInDrawer: 500000,
    });
    expect(deskState(db, T0).session).toMatchObject({
      status: 'closed',
      variance: -30000,
      leftInDrawer: 500000,
    });
    const next = open(ALI, 480000);
    expect(next).toMatchObject({ openingFloat: 480000, floatExpected: 500000 });
  });

  it('refuses a short close without a reason, or acknowledged by its own cashier, writing nothing', () => {
    expect(refused(() => close({ counts: { '100000': 4 } }))).toBe('reason_required');
    expect(refused(() => close({ counts: { '100000': 4 }, reason: 'unknown', acknowledgerId: ALI }))).toBe(
      'own_variance',
    );
    expect(count("SELECT count(*) FROM outbox WHERE family = 'Z'")).toBe(1);
    expect(deskState(db, T0).session?.status).toBe('open');
  });
});

describe('voids and returns by payment at the desk (W1-23, D-111)', () => {
  const TARIQ = ID('a2');
  const pullQueue = (rows: Record<string, unknown>[]) => applyPull(db, { cash_queue: rows }, 'cursor');
  const giveBack = (over: { userId?: string; approverId?: string; billNumber?: string } = {}) =>
    giveBackVoidCash(db, { userId: ALI, approverId: TARIQ, billNumber: 'C03-S000412', ...made(), ...over });
  beforeEach(() => {
    applyPull(
      db,
      {
        users: [user(TARIQ, 'tariq')],
        roles: [role(ID('r2'), ['pos.sale.create', 'pos.void'])],
        user_roles: [row({ id: ID('u2'), user_id: TARIQ, role_id: ID('r2'), branch_id: null })],
      },
      'cursor',
    );
    open();
  });

  it("keeps a refund until its bill's cash comes in (guard 2): collect the bill first, then pay out", () => {
    pullQueue([
      queued('C03-S000415', -45000, {
        cash_received: null,
        change_due: null,
        return_of_number: 'C03-S000412',
      }),
    ]);
    expect(refused(() => hand({ billNumber: 'C03-S000415' }))).toBe('original_unpaid');
    expect(count("SELECT count(*) FROM outbox WHERE family = 'H'")).toBe(0);
    hand();
    expect(hand({ billNumber: 'C03-S000415' }).kind).toBe('payout');
  });

  it("pays out a refund whose bill was paid at another desk, or that it can't link (a scanned code)", () => {
    pullQueue([
      queued('C03-S000412', 432000, { handover_status: 'received' }),
      queued('C03-S000415', -45000, {
        cash_received: null,
        change_due: null,
        return_of_number: 'C03-S000412',
      }),
    ]);
    expect(hand({ billNumber: 'C03-S000415' }).kind).toBe('payout');
    const scanned = hand({ billNumber: 'C04-S000009', method: 'scan', code: { cashDue: money(-30000) } });
    expect(scanned).toMatchObject({ kind: 'payout', amount: 30000 });
  });

  it("lists the cash it took for a voided bill and gives it back with a manager's PIN, out of the expected cash", () => {
    hand();
    pullQueue([
      queued('C03-S000412', 432000, {
        status: 'voided',
        handover_status: 'received',
        void_number: 'C03-V000004',
      }),
    ]);
    expect(deskState(db, T0).voidCash).toEqual([
      {
        number: 'C03-S000412',
        voidNumber: 'C03-V000004',
        amount: 432000,
        createdAt: '2026-11-02T10:10:00.000Z',
      },
    ]);
    const before = deskState(db, T0).session!.expected;
    // Never the session's cashier, and only someone who may void (owner answer 1).
    expect(refused(() => giveBack({ approverId: ALI }))).toBe('approver_is_cashier');
    expect(refused(() => giveBack({ approverId: SARA }))).toBe('approver_not_permitted');
    expect(refused(() => giveBack({ userId: BILAL }))).toBe('not_session_cashier');
    expect(count("SELECT count(*) FROM outbox WHERE family = 'M'")).toBe(0);

    const m = giveBack();
    expect(m).toMatchObject({
      version: 2,
      kind: 'void_cash',
      amount: 432000,
      billNumber: 'C03-S000412',
      approvedByUserId: TARIQ,
    });
    expect(CashMovementV2.safeParse(m).success).toBe(true);
    expect(count("SELECT count(*) FROM outbox WHERE family = 'M'")).toBe(1);
    const after = deskState(db, T0);
    expect(after.voidCash).toEqual([]);
    expect(after.session!.expected).toBe(before - 432000);
    expect(refused(() => giveBack())).toBe('already_given_back');
  });

  it('lists a voided bill another desk took cash for, and not one given back elsewhere', () => {
    pullQueue([
      queued('C03-S000412', 432000, {
        status: 'voided',
        handover_status: 'received',
        void_number: 'C03-V000004',
      }),
      queued('C03-S000420', 100000, {
        status: 'voided',
        handover_status: 'received',
        void_number: 'C03-V000005',
        cash_given_back_number: 'D02-M000003',
      }),
      queued('C03-S000421', 100000, { status: 'voided', void_number: 'C03-V000006' }),
    ]);
    expect(deskState(db, T0).voidCash.map((v) => [v.number, v.amount])).toEqual([['C03-S000412', 432000]]);
    expect(refused(() => giveBack({ billNumber: 'C03-S000420' }))).toBe('already_given_back');
    expect(refused(() => giveBack({ billNumber: 'C03-S000421' }))).toBe('no_cash_taken');
  });
});
