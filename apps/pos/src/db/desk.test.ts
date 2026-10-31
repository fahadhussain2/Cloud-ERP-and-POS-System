// @vitest-environment node
import { CashHandoverV1, CashSessionV1 } from '@erp/contracts';
import { DomainError, money } from '@erp/domain';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OpenBill } from '../bill/open-bill';
import { finalizeSale, recentDocuments, type FinalizeRequest } from './checkout';
import { closeSession, confirmHandover, deskState, openSession, type HandoverRequest } from './desk';
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
          id: ID('m1'),
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
    expect(CashSessionV1.safeParse(z).success).toBe(true);
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
    const z = closeSession(db, { userId: BILAL, ...made() });
    expect(CashSessionV1.safeParse(z).success).toBe(true);
    expect(z).toMatchObject({ event: 'close', expectedCash: 500000 + 432000 - 45000, userId: BILAL });
    expect(deskState(db, T0).session?.status).toBe('closed');
    db.exec("UPDATE cash_queue SET handover_status = 'pending'");
    expect(refused(() => hand({ billNumber: 'C03-S000412', userId: ALI }))).toBe('no_session');
    expect(refused(() => closeSession(db, { userId: ALI, ...made() }))).toBe('no_session');
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
