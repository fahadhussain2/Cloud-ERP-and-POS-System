// @vitest-environment node
import { SaleDocumentV1 } from '@erp/contracts';
import { DomainError, money, type Tender } from '@erp/domain';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OpenBill } from '../bill/open-bill';
import {
  checkoutSettings,
  finalizeSale,
  listReprints,
  loadDocument,
  recentDocuments,
  recordReprint,
  setSignature,
  type FinalizeRequest,
} from './checkout';
import { creditFigures, listCustomers } from './customers';
import { migrate } from './migrate';
import { ackPush } from './outbox';
import { applyPull, loadOpenBill, saveOpenBill, setDevice } from './repo';
import { wrapOo1, type SqlDb } from './sql';

// Paying, finalizing and reprinting on the counter (POS spec §12–§13, §15, data model §12, rule 6), on real SQLite.

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
let db: SqlDb;

const ID = (n: string) => `019a0000-0000-7000-8000-0000000000${n}`;
const SARA = ID('a1');
const A5 = ID('p5');
const A4 = ID('p4');
const T0 = Date.parse('2026-11-02T10:15:30.000Z');

const row = (r: Record<string, unknown>) => ({ row_version: '1', deleted_at: null, ...r });
const pull = (changes: Record<string, Record<string, unknown>[]>) => applyPull(db, changes, 'cursor');

/** An enrolled, pulled counter C03 with Sara (a salesman) and Delux's methods and print profile. */
function ready() {
  setDevice(db, { deviceId: ID('d1'), tenantId: ID('f1'), branchId: ID('e1'), code: 'C03', kind: 'counter' });
  pull({
    tenant: [
      row({
        id: ID('f1'),
        name: 'Delux Autos',
        base_currency: 'PKR',
        currency_minor_units: 2,
        timezone: 'Asia/Karachi',
        locale: 'en-PK',
        cash_rounding_increment: '100',
        day_cutoff_hour: 4,
        closing_time: '20:00:00',
      }),
    ],
    users: [
      row({
        id: SARA,
        username: 'sara',
        full_name: 'Sara',
        short_code: null,
        pin_verifier: 'v',
        pin_must_change: false,
        status: 'active',
      }),
    ],
    roles: [
      row({
        id: ID('r1'),
        name: 'Salesman',
        template_key: 'salesman',
        permissions: ['pos.sale.create'],
        limits: { maxDiscountBp: 10000, voidWindow: 'none' },
      }),
    ],
    user_roles: [row({ id: ID('u1'), user_id: SARA, role_id: ID('r1'), branch_id: null })],
    payment_methods: [
      row({
        id: ID('m3'),
        code: 'raast',
        name: 'Raast',
        is_cash: false,
        requires_reference: true,
        is_active: true,
        sort: 3,
      }),
      row({
        id: ID('m1'),
        code: 'cash',
        name: 'Cash',
        is_cash: true,
        requires_reference: false,
        is_active: true,
        sort: 1,
      }),
      row({
        id: ID('m6'),
        code: 'card',
        name: 'Card',
        is_cash: false,
        requires_reference: true,
        is_active: false,
        sort: 6,
      }),
      row({
        id: ID('m4'),
        code: 'jazzcash',
        name: 'JazzCash',
        is_cash: false,
        requires_reference: true,
        is_active: true,
        sort: 4,
        deleted_at: '2026-10-30T10:00:00Z',
      }),
    ],
    print_profiles: [
      row({
        id: A5,
        name: 'A5 landscape dot matrix',
        paper_format: 'a5',
        code_type: 'barcode',
        copies: 1,
        template_options: { headerLines: ['Shop 14, Auto Market'], policyText: 'Returns within 30 days.' },
        is_tenant_default: true,
      }),
      row({
        id: A4,
        name: 'A4 laser',
        paper_format: 'a4',
        code_type: 'barcode',
        copies: 2,
        template_options: {},
        is_tenant_default: false,
      }),
    ],
    device: [row({ id: ID('d1'), code: 'C03', print_profile_id: null, status: 'active' })],
  });
}

const openBill = (unitPrice = 145000): OpenBill =>
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
          list: 145000,
          floor: 130000,
          unitPrice,
          approval: null,
        },
      ],
      billDiscount: 0,
      billApproval: null,
    },
    items: { [ID('c1')]: { code: 'BRPD001', name: 'BRAKE PADS', variant: null, spec: null } },
  }) as unknown as OpenBill;

const cash = (amount: number, received: number | null = null): Tender => ({
  payments: [{ method: 'cash', amount: money(amount), reference: null }],
  cashReceived: received === null ? null : money(received),
});

const request = (n: number, tender: Tender = cash(145000)): FinalizeRequest => ({
  userId: SARA,
  id: `019a3f6e-7b10-7c3a-9d2e-00000000000${n}`,
  createdAtMs: T0 + n * 60_000,
  clientVersion: '0.6.0',
  tender,
  offline: false,
  creditApproval: null,
});

const count = (table: string) => Number(db.selectValue(`SELECT count(*) FROM ${table}`));
const nextSeq = () => db.selectValue("SELECT next_seq FROM local_series WHERE family = 'S'");

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});
beforeEach(() => {
  db = wrapOo1(new sqlite3.oo1.DB(':memory:'));
  migrate(db);
});

describe('checkout settings', () => {
  it('are null before the first pull', () => {
    expect(checkoutSettings(db)).toBeNull();
  });

  it('give the rounding, the business day and the active methods in their order', () => {
    ready();
    const s = checkoutSettings(db)!;
    expect(s).toMatchObject({ increment: 100, timeZone: 'Asia/Karachi', cutoffHour: 4 });
    expect(s.methods).toEqual([
      { id: ID('m1'), code: 'cash', name: 'Cash', isCash: true, requiresReference: false, sort: 1 },
      { id: ID('m3'), code: 'raast', name: 'Raast', isCash: false, requiresReference: true, sort: 3 },
    ]);
  });

  it("use the tenant's default print profile, or the device's own when it has one", () => {
    ready();
    expect(checkoutSettings(db)!.printProfile).toEqual({
      id: A5,
      name: 'A5 landscape dot matrix',
      paperFormat: 'a5',
      codeType: 'barcode',
      copies: 1,
      headerLines: ['Shop 14, Auto Market'],
      policyText: 'Returns within 30 days.',
    });
    pull({
      device: [row({ id: ID('d1'), code: 'C03', print_profile_id: A4, status: 'active', row_version: '2' })],
    });
    expect(checkoutSettings(db)!.printProfile).toEqual({
      id: A4,
      name: 'A4 laser',
      paperFormat: 'a4',
      codeType: 'barcode',
      copies: 2,
      headerLines: [],
      policyText: null,
    });
  });
});

describe('finalizing a sale (one transaction)', () => {
  beforeEach(ready);

  it('takes S000001, writes the document and its outbox row, and removes the open bill', () => {
    saveOpenBill(db, SARA, openBill());
    const { document, repeated } = finalizeSale(db, request(1, cash(145000, 150000)));
    expect(repeated).toBe(false);
    expect(document).toMatchObject({
      id: request(1).id,
      seq: 1,
      number: 'C03-S000001',
      deviceId: ID('d1'),
      branchId: ID('e1'),
      sellerId: SARA,
      businessDate: '2026-11-02',
      amounts: { total: 145000, rounding: 0 },
      payments: [{ method: 'cash', amount: 145000, cashReceived: 150000, changeDue: 5000, reference: null }],
      cashDue: 145000,
      handoverStatus: 'pending',
      clientVersion: '0.6.0',
    });
    expect(SaleDocumentV1.safeParse(document).error).toBeUndefined();
    expect(loadOpenBill(db, SARA)).toBeNull();
    expect(nextSeq()).toBe(2);
    const [outbox] = db.selectObjects('SELECT id, family, seq, payload, signature, status FROM outbox');
    expect(outbox).toMatchObject({
      id: document.id,
      family: 'S',
      seq: 1,
      signature: null,
      status: 'pending',
    });
    expect(JSON.parse(String(outbox!['payload']))).toEqual(document);
    const [local] = db.selectObjects('SELECT id, number, kind, business_date, payload FROM local_documents');
    expect(local).toMatchObject({
      id: document.id,
      number: 'C03-S000001',
      kind: 'sale',
      business_date: '2026-11-02',
    });
    expect(JSON.parse(String(local!['payload']))).toEqual(document);
  });

  it('numbers the next bill S000002', () => {
    saveOpenBill(db, SARA, openBill());
    finalizeSale(db, request(1));
    saveOpenBill(db, SARA, openBill());
    expect(finalizeSale(db, request(2)).document.number).toBe('C03-S000002');
    expect(count('outbox')).toBe(2);
    expect(nextSeq()).toBe(3);
  });

  it('a second finalize of the same bill returns the first and writes nothing', () => {
    saveOpenBill(db, SARA, openBill());
    const first = finalizeSale(db, request(1));
    const again = finalizeSale(db, request(2));
    expect(again).toEqual({ document: first.document, repeated: true });
    expect(count('outbox')).toBe(1);
    expect(nextSeq()).toBe(2);
  });

  it('refuses without an open bill or an earlier one', () => {
    expect(() => finalizeSale(db, request(1))).toThrow();
    expect(count('outbox')).toBe(0);
  });

  it('a tender that does not add up changes nothing', () => {
    saveOpenBill(db, SARA, openBill());
    let thrown: unknown;
    try {
      finalizeSale(db, request(1, cash(140000)));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).code).toBe('invalid_tender');
    expect(loadOpenBill(db, SARA)).toEqual(openBill());
    expect(count('outbox')).toBe(0);
    expect(count('local_documents')).toBe(0);
  });

  it('rolls everything back when a write fails: the number is not used and the open bill stays', () => {
    // A leftover outbox row with S 1 makes the insert fail inside the transaction.
    db.exec(
      "INSERT INTO outbox (id, family, seq, payload, status, attempts, created_at) VALUES ('x', 'S', 1, '{}', 'pending', 0, 'now')",
    );
    saveOpenBill(db, SARA, openBill());
    expect(() => finalizeSale(db, request(1))).toThrow();
    expect(loadOpenBill(db, SARA)).toEqual(openBill());
    expect(nextSeq() ?? 1).toBe(1);
    expect(count('local_documents')).toBe(0);
    expect(count('outbox')).toBe(1);
  });

  it('refuses a price below the floor that nobody approved', () => {
    saveOpenBill(db, SARA, openBill(120000));
    expect(() => finalizeSale(db, request(1, cash(120000)))).toThrow(DomainError);
    expect(loadOpenBill(db, SARA)).not.toBeNull();
  });
});

describe('after finalizing', () => {
  beforeEach(() => {
    ready();
    for (const n of [1, 2, 3]) {
      saveOpenBill(db, SARA, openBill());
      finalizeSale(db, request(n));
    }
  });

  it("stores the device's signature on the outbox row", () => {
    setSignature(db, request(2).id, 'sig-2');
    expect(db.selectValue('SELECT signature FROM outbox WHERE id = ?', [request(2).id])).toBe('sig-2');
    expect(db.selectValue('SELECT count(*) FROM outbox WHERE signature IS NULL')).toBe(2);
  });

  it("lists this counter's recent bills, newest first, filtered by number", () => {
    expect(recentDocuments(db, '2026-11-01T00:00:00Z').map((d) => d.number)).toEqual([
      'C03-S000003',
      'C03-S000002',
      'C03-S000001',
    ]);
    expect(recentDocuments(db, '2026-11-01T00:00:00Z', '0002')).toEqual([
      {
        id: request(2).id,
        number: 'C03-S000002',
        createdAt: new Date(T0 + 2 * 60_000).toISOString(),
        total: 145000,
        cashDue: 145000,
      },
    ]);
    expect(recentDocuments(db, new Date(T0 + 2 * 60_000).toISOString()).map((d) => d.number)).toEqual([
      'C03-S000003',
      'C03-S000002',
    ]);
  });

  it('loads a bill back exactly as finalized', () => {
    const doc = loadDocument(db, request(1).id)!;
    expect(doc.number).toBe('C03-S000001');
    expect(SaleDocumentV1.safeParse(doc).error).toBeUndefined();
    expect(loadDocument(db, ID('99'))).toBeNull();
  });

  it('keeps each reprint for the audit log and the diagnostic log', () => {
    const r = recordReprint(db, {
      documentId: request(1).id,
      number: 'C03-S000001',
      userId: SARA,
      at: '2026-11-02T11:00:00.000Z',
    });
    expect(r).toMatchObject({ number: 'C03-S000001', userId: SARA, pushedAt: null });
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(listReprints(db)).toEqual([r]);
    expect(db.selectValue("SELECT count(*) FROM diagnostic_log WHERE kind = 'bill.reprinted'")).toBe(1);
  });
});

describe('customers and credit on the counter (POS spec §15, W1-09)', () => {
  const KHAN = ID('f9');
  const onAccount = (amount = 145000): Tender => ({
    payments: [{ method: 'on_account', amount: money(amount), reference: null }],
    cashReceived: null,
  });
  const forKhan = (unitPrice = 145000): OpenBill => ({
    ...openBill(unitPrice),
    customer: { id: KHAN, code: 'C0042', name: 'Khan Motors' },
  });
  const sell = (n: number, tender: Tender, over: Partial<FinalizeRequest> = {}) => {
    saveOpenBill(db, SARA, forKhan());
    return finalizeSale(db, { ...request(n, tender), ...over });
  };
  const balance = (amount: number) =>
    pull({
      customer_balances: [
        row({ party_id: KHAN, balance: String(amount), updated_at: '2026-11-02T09:00:00Z' }),
      ],
    });
  const figures = (offline = false) => creditFigures(db, KHAN, offline, '2026-11-02');

  beforeEach(() => {
    ready();
    pull({
      payment_methods: [
        row({
          id: ID('m7'),
          code: 'on_account',
          name: 'On account',
          is_cash: false,
          requires_reference: false,
          is_active: true,
          sort: 7,
        }),
      ],
      customers: [
        row({
          id: KHAN,
          code: 'C0042',
          name: 'Khan Motors',
          phones: ['0300-1234567'],
          city: 'Karachi',
          status: 'active',
        }),
        row({
          id: ID('f8'),
          code: 'C0043',
          name: 'Gone Traders',
          phones: [],
          city: null,
          status: 'inactive',
        }),
        row({ id: ID('f7'), code: 'S0007', name: 'A Supplier', phones: [], city: null, status: 'active' }),
      ],
      customer_accounts: [
        row({
          id: ID('a1'),
          party_id: KHAN,
          price_tier_id: ID('b2'),
          credit_allowed: true,
          credit_limit: '1000000',
          offline_daily_cap: '200000',
        }),
        row({
          id: ID('a2'),
          party_id: ID('f8'),
          price_tier_id: ID('b1'),
          credit_allowed: true,
          credit_limit: null,
          offline_daily_cap: '0',
        }),
      ],
    });
    balance(450000);
  });

  it('lists active customers with a live account, with their terms and pulled balance', () => {
    expect(listCustomers(db)).toEqual([
      {
        id: KHAN,
        code: 'C0042',
        name: 'Khan Motors',
        phones: ['0300-1234567'],
        city: 'Karachi',
        account: { tierId: ID('b2'), creditAllowed: true, creditLimit: 1000000, offlineDailyCap: 200000 },
        balance: 450000,
      },
    ]);
    // A removed account takes the customer off the list (sync spec §3).
    pull({ customer_accounts: [row({ id: ID('a1'), deleted_at: '2026-11-02T11:00:00Z' })] });
    expect(listCustomers(db)).toEqual([]);
  });

  it('finalizes a sale on account for the customer, with the credit view the counter decided on', () => {
    const { document } = sell(1, onAccount());
    expect(document).toMatchObject({
      customerId: KHAN,
      walkinPhone: null,
      cashDue: 0,
      handoverStatus: 'not_applicable',
      overrides: [],
      credit: { offline: false, balance: 450000, balanceAsOf: null, unsynced: 0, offlineToday: 0 },
    });
    expect(SaleDocumentV1.safeParse(document).error).toBeUndefined();
  });

  it('counts a bill as unsynced until a complete pull that started after the server took it', () => {
    const { document } = sell(1, onAccount());
    expect(figures().unsynced).toBe(145000);
    ackPush(
      db,
      [{ id: document.id, status: 'accepted', exceptions: [], error: null }],
      '2026-11-02T10:20:00.000Z',
    );
    expect(count('outbox')).toBe(0);
    expect(figures().unsynced).toBe(145000);
    // A pull that began before the bill was accepted may not have it.
    applyPull(db, {}, 'c2', true, '2026-11-02T10:19:00.000Z');
    expect(figures().unsynced).toBe(145000);
    applyPull(db, {}, 'c3', true, '2026-11-02T10:21:00.000Z');
    expect(figures()).toMatchObject({ unsynced: 0, balanceAsOf: '2026-11-02T10:21:00.000Z' });
  });

  it('keeps counting a bill the server refused', () => {
    const { document } = sell(1, onAccount());
    ackPush(
      db,
      [{ id: document.id, status: 'rejected', exceptions: [], error: 'bad_schema' }],
      '2026-11-02T10:20:00Z',
    );
    applyPull(db, {}, 'c2', true, '2026-11-02T10:21:00.000Z');
    expect(figures().unsynced).toBe(145000);
  });

  it('refuses a bill over the limit without an approval, and records the approval when given', () => {
    balance(900000);
    expect(() => sell(1, onAccount())).toThrow(expect.objectContaining({ code: 'credit_approval_pending' }));
    expect(count('outbox')).toBe(0);
    const approval = {
      requestedBy: SARA,
      approvedBy: ID('a9'),
      reason: 'pay_soon' as const,
      note: null,
      at: '2026-11-02T10:16:00Z',
    };
    const { document } = sell(2, onAccount(), { creditApproval: approval });
    expect(document.overrides).toEqual([
      {
        kind: 'credit_limit',
        lineNo: null,
        ...approval,
        values: { limit: 1000000, balance: 900000, unsynced: 0, amount: 145000 },
      },
    ]);
  });

  it('holds offline bills to the day’s cap; online bills don’t count towards it', () => {
    sell(1, onAccount());
    sell(2, onAccount(), { offline: true });
    expect(figures(true)).toMatchObject({ offline: true, offlineToday: 145000, unsynced: 290000 });
    expect(() => sell(3, onAccount(), { offline: true })).toThrow(
      expect.objectContaining({ code: 'credit_approval_pending' }),
    );
    // Online, the cap doesn't apply.
    expect(sell(4, onAccount()).document.overrides).toEqual([]);
  });

  it('stores a walk-in’s phone normalized, and refuses on account for a walk-in', () => {
    saveOpenBill(db, SARA, { ...openBill(), walkinPhone: '+92 300 1234567' });
    expect(finalizeSale(db, request(1)).document.walkinPhone).toBe('03001234567');
    saveOpenBill(db, SARA, openBill());
    expect(() => finalizeSale(db, request(2, onAccount()))).toThrow(
      expect.objectContaining({ code: 'invalid_tender' }),
    );
  });
});
