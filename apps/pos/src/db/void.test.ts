// @vitest-environment node
import { SaleDocumentV1, SaleVoidV1 } from '@erp/contracts';
import { DomainError, money, type Tender } from '@erp/domain';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OpenBill } from '../bill/open-bill';
import { finalizeSale, recentDocuments } from './checkout';
import { creditFigures } from './customers';
import { confirmHandover, deskState, openSession } from './desk';
import { migrate } from './migrate';
import { applyPull, saveOpenBill, setDevice } from './repo';
import { wrapOo1, type SqlDb } from './sql';
import { localDeskStatus, voidableBills, voidBill, voidOf, type VoidRequest } from './void';

// Voiding a bill on the counter that made it (POS-11, POS spec §18, W1-12, rule 6), on real SQLite: the void and its
// outbox row together or not at all, the bill itself never changed, and a voided bill out of the figures.

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
let db: SqlDb;

const ID = (n: string) => `019a0000-0000-7000-8000-0000000000${n}`;
const SARA = ID('a1');
const TARIQ = ID('a2');
const ALI = ID('a5');
const KHAN = ID('f7');
/** 14:15 in Karachi on 2026-11-03. */
const T0 = Date.parse('2026-11-03T09:15:00.000Z');
let n = 0;
const made = (atMs = T0 + ++n * 1000) => ({
  id: `019a3f6e-7b10-7c3a-9d2e-${String(++n).padStart(12, '0')}`,
  createdAtMs: atMs,
  clientVersion: '0.9.0',
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
const role = (id: string, permissions: string[], voidWindow = 'none') =>
  row({ id, name: id, template_key: null, permissions, limits: { maxDiscountBp: 10000, voidWindow } });
const method = (id: string, code: string, sort: number, isCash = false) =>
  row({ id, code, name: code, is_cash: isCash, requires_reference: false, is_active: true, sort });

/** Counter C03 (or desk D01) with Sara (a salesman), Tariq (a manager who may void), Ali (a cashier) and Khan Motors. */
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
          day_cutoff_hour: 4,
        }),
      ],
      users: [user(SARA, 'sara'), user(TARIQ, 'tariq'), user(ALI, 'ali')],
      roles: [
        role(ID('r1'), ['pos.sale.create', 'pos.credit.sell']),
        role(ID('r2'), ['pos.sale.create', 'pos.void'], 'same_day_before_handover'),
        role(ID('r5'), ['pos.sale.create', 'cash.handover.receive', 'cash.session.close']),
      ],
      user_roles: [
        row({ id: ID('u1'), user_id: SARA, role_id: ID('r1'), branch_id: null }),
        row({ id: ID('u2'), user_id: TARIQ, role_id: ID('r2'), branch_id: null }),
        row({ id: ID('u5'), user_id: ALI, role_id: ID('r5'), branch_id: null }),
      ],
      payment_methods: [method(ID('m1'), 'cash', 1, true), method(ID('m7'), 'on_account', 7)],
      device: [row({ id: ID('d1'), code, print_profile_id: null, status: 'active' })],
      customers: [
        row({ id: KHAN, code: 'C0042', name: 'Khan Motors', phones: [], city: 'Karachi', status: 'active' }),
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
    },
    'cursor',
  );
}

const openBill = (customer = false): OpenBill =>
  ({
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
          list: 432000,
          floor: 400000,
          unitPrice: 432000,
          approval: null,
        },
      ],
      billDiscount: 0,
      billApproval: null,
    },
    items: { [ID('c1')]: { code: 'BRPD001', name: 'BRAKE PADS', variant: null, spec: null } },
    customer: customer ? { id: KHAN, code: 'C0042', name: 'Khan Motors' } : null,
  }) as unknown as OpenBill;

const pay = (method: 'cash' | 'on_account'): Tender => ({
  payments: [{ method, amount: money(432000), reference: null }],
  cashReceived: null,
});

/** Sells one bill on this device and returns it. */
function sell(how: 'cash' | 'on_account' = 'cash', atMs?: number, extra: Partial<OpenBill> = {}) {
  saveOpenBill(db, SARA, { ...openBill(how === 'on_account'), ...extra });
  return finalizeSale(db, {
    userId: SARA,
    ...made(atMs),
    tender: pay(how),
    offline: false,
    creditApproval: null,
  }).document;
}

const request = (saleId: string, over: Partial<VoidRequest> = {}): VoidRequest => ({
  ...made(),
  userId: SARA,
  approverId: TARIQ,
  saleId,
  reason: 'wrong_price',
  note: null,
  deskStatus: 'pending',
  ...over,
});

const count = (sql: string) => Number(db.selectValue(sql));
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
});

describe('the Void list', () => {
  beforeEach(() => ready());

  it("shows today's bills of this counter, newest first, filtered by number, without the voided ones", () => {
    const yesterday = sell('cash', Date.parse('2026-11-02T09:00:00.000Z'));
    const first = sell();
    const second = sell();
    expect(voidableBills(db, T0 + 60_000).map((b) => b.number)).toEqual([second.number, first.number]);
    expect(voidableBills(db, T0 + 60_000, 's000002').map((b) => b.id)).toEqual([first.id]);
    voidBill(db, request(second.id));
    expect(voidableBills(db, T0 + 60_000).map((b) => b.id)).toEqual([first.id]);
    expect(yesterday.businessDate).toBe('2026-11-02');
    expect(voidableBills(db, T0 + 60_000)[0]).toMatchObject({
      sellerId: SARA,
      total: 432000,
      cashDue: 432000,
    });
  });
});

describe('a void', () => {
  beforeEach(() => ready());

  it('is a V document with its outbox row, written together; the bill is not touched', () => {
    const sale = sell();
    const before = db.selectValue('SELECT payload FROM local_documents WHERE id = ?', [sale.id]);
    const { void: v } = voidBill(db, request(sale.id));
    expect(SaleVoidV1.safeParse(v).success).toBe(true);
    expect(v).toMatchObject({
      number: 'C03-V000001',
      saleId: sale.id,
      saleNumber: sale.number,
      userId: SARA,
      approvedBy: TARIQ,
      handoverSeen: 'pending',
      businessDate: '2026-11-03',
    });
    expect(count("SELECT count(*) FROM outbox WHERE family = 'V' AND status = 'pending'")).toBe(1);
    expect(db.selectValue('SELECT payload FROM local_documents WHERE id = ?', [sale.id])).toBe(before);
    expect(voidOf(db, sale.id)).toEqual(v);
    expect(recentDocuments(db, '2026-11-01T00:00:00Z').map((d) => d.voidNumber)).toEqual(['C03-V000001']);
    expect(db.selectValue("SELECT next_seq FROM local_series WHERE family = 'S'")).toBe(2);
  });

  it('offline records that the desk could not be asked', () => {
    const sale = sell();
    expect(voidBill(db, request(sale.id, { deskStatus: 'unknown' })).void.handoverSeen).toBe('unknown');
  });

  it('is refused twice, without pos.void, for a handed-over bill, or yesterday’s, writing nothing', () => {
    const sale = sell();
    const old = sell('cash', Date.parse('2026-11-02T09:00:00.000Z'));
    expect(refused(() => voidBill(db, request(sale.id, { approverId: SARA })))).toBe('not_permitted');
    expect(refused(() => voidBill(db, request(sale.id, { deskStatus: 'received' })))).toBe('handed_over');
    expect(refused(() => voidBill(db, request(old.id)))).toBe('other_day');
    expect(refused(() => voidBill(db, request(sale.id, { reason: 'other' })))).toBe('note_required');
    expect(count("SELECT count(*) FROM local_documents WHERE family = 'V'")).toBe(0);
    expect(count("SELECT count(*) FROM outbox WHERE family = 'V'")).toBe(0);
    expect(db.selectValue("SELECT next_seq FROM local_series WHERE family = 'V'")).toBeUndefined();
    voidBill(db, request(sale.id));
    expect(refused(() => voidBill(db, request(sale.id)))).toBe('already_voided');
    expect(db.selectValue("SELECT next_seq FROM local_series WHERE family = 'V'")).toBe(2);
  });

  it('of an on-account bill takes it out of the credit figures', () => {
    const sale = sell('on_account');
    expect(creditFigures(db, KHAN, false, '2026-11-03').unsynced).toBe(432000);
    voidBill(db, request(sale.id));
    expect(creditFigures(db, KHAN, false, '2026-11-03').unsynced).toBe(0);
  });
});

describe('a reissue', () => {
  beforeEach(() => ready());

  it('names the voided bill on the new document', () => {
    const sale = sell();
    voidBill(db, request(sale.id));
    const again = sell('cash', undefined, { reissueOf: { id: sale.id, number: sale.number } });
    expect(again.reissueOf).toEqual({ id: sale.id, number: sale.number });
    expect(SaleDocumentV1.safeParse(again).success).toBe(true);
    expect(sell().reissueOf).toBeUndefined();
  });
});

describe('on a cash desk', () => {
  beforeEach(() => ready('cash_desk'));

  it('knows a bill it handed over itself, and refuses to void it', () => {
    openSession(db, { userId: ALI, openingFloat: money(0), ...made() });
    const sale = sell();
    // A cash sale on the desk is handed over at once (W1-10).
    expect(localDeskStatus(db, sale.number)).toBe('received');
    expect(refused(() => voidBill(db, request(sale.id, { deskStatus: 'unknown' })))).toBe('handed_over');
  });

  it("drops a bill it voided from its queue at once, and won't take its cash", () => {
    const sale = sell();
    applyPull(
      db,
      {
        cash_queue: [
          row({
            id: sale.id,
            number: sale.number,
            device_id: ID('d1'),
            salesperson_user_id: SARA,
            created_at_device: sale.createdAt,
            business_date: sale.businessDate,
            cash_due: '432000',
            cash_received: null,
            change_due: null,
            handover_status: 'pending',
            status: 'finalized',
          }),
        ],
      },
      'cursor-2',
    );
    expect(localDeskStatus(db, sale.number)).toBe('pending');
    voidBill(db, request(sale.id));
    expect(deskState(db, T0).queue.map((e) => e.status)).toEqual(['voided']);
    openSession(db, { userId: ALI, openingFloat: money(0), ...made() });
    expect(
      refused(() =>
        confirmHandover(db, {
          userId: ALI,
          billNumber: sale.number,
          cashReceived: null,
          method: 'scan',
          code: null,
          ...made(),
        }),
      ),
    ).toBe('bill_voided');
  });
});
