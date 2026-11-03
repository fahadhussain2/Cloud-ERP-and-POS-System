// @vitest-environment node
import { DomainError, MAX_HELD_BILLS } from '@erp/domain';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OpenBill } from '../bill/open-bill';
import { clearHeld, heldBills, holdBill, recallBill, sweepHeld, type HoldRequest } from './held';
import { migrate } from './migrate';
import { applyPull, loadOpenBill, saveOpenBill, setDevice } from './repo';
import { wrapOo1, type SqlDb } from './sql';

// Held bills on the counter (POS-08, POS spec §17, owner answer 4 to W1-12), on real SQLite: each write all or
// nothing, recalled only by who held it, gone at the end of their business day, never in the outbox.

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
let db: SqlDb;

const ID = (n: string) => `019a0000-0000-7000-8000-0000000000${n}`;
const SARA = ID('a1');
const ALI = ID('a2');
const NOHOLD = ID('a6');
/** 14:00 in Karachi on 2026-11-03. */
const T0 = Date.parse('2026-11-03T09:00:00.000Z');

const row = (r: Record<string, unknown>) => ({ row_version: '1', deleted_at: null, ...r });

/** Counter C03 with Sara and Ali (salesmen) and someone who sells but can't hold. */
function ready() {
  setDevice(db, { deviceId: ID('d1'), tenantId: ID('f1'), branchId: ID('e1'), code: 'C03', kind: 'counter' });
  const user = (id: string, name: string) =>
    row({
      id,
      username: name,
      full_name: name,
      short_code: null,
      pin_verifier: 'v',
      pin_must_change: false,
      status: 'active',
    });
  applyPull(
    db,
    {
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
      users: [user(SARA, 'sara'), user(ALI, 'ali'), user(NOHOLD, 'nohold')],
      roles: [
        row({
          id: ID('r1'),
          name: 'Salesman',
          template_key: 'salesman',
          permissions: ['pos.sale.create', 'pos.sale.hold'],
          limits: { maxDiscountBp: 10000, voidWindow: 'none' },
        }),
        row({
          id: ID('r2'),
          name: 'Seller',
          template_key: null,
          permissions: ['pos.sale.create'],
          limits: { maxDiscountBp: 10000, voidWindow: 'none' },
        }),
      ],
      user_roles: [
        row({ id: ID('u1'), user_id: SARA, role_id: ID('r1'), branch_id: null }),
        row({ id: ID('u2'), user_id: ALI, role_id: ID('r1'), branch_id: null }),
        row({ id: ID('u6'), user_id: NOHOLD, role_id: ID('r2'), branch_id: null }),
      ],
    },
    'cursor',
  );
}

const bill = (sellerId: string, unitPrice: number, lines = 1): OpenBill =>
  ({
    version: 1,
    bill: {
      version: 1,
      sellerId,
      tierId: ID('b1'),
      lines: Array.from({ length: lines }, (_, i) => ({
        id: `l${i + 1}`,
        itemId: ID('c1'),
        qty: 1000,
        allowsFraction: false,
        list: 145000,
        floor: 130000,
        unitPrice,
        approval: null,
      })),
      billDiscount: 0,
      billApproval: null,
    },
    items: { [ID('c1')]: { code: 'BRPD001', name: 'BRAKE PADS', variant: null, spec: null } },
    customer: { id: ID('p1'), code: 'C0042', name: 'Khan Motors' },
  }) as unknown as OpenBill;

const hold = (
  n: number,
  userId = SARA,
  label: string | null = null,
  atMs = T0 + n * 60_000,
): HoldRequest => ({
  id: `019a4000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  userId,
  label,
  atMs,
});

const count = (table: string) => Number(db.selectValue(`SELECT count(*) FROM ${table}`));
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  return null;
};

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});
beforeEach(() => {
  db = wrapOo1(new sqlite3.oo1.DB(':memory:'));
  migrate(db);
  ready();
});

describe('holding a bill', () => {
  it('sets the open bill aside with its label and business day, and leaves an empty one', () => {
    saveOpenBill(db, SARA, bill(SARA, 140000, 3));
    const held = holdBill(db, hold(1, SARA, '  Blue Suzuki  '));
    expect(held).toMatchObject({ userId: SARA, label: 'Blue Suzuki', businessDate: '2026-11-03' });
    expect(held.heldAt).toBe('2026-11-03T09:01:00.000Z');
    expect(loadOpenBill(db, SARA)).toBeNull();
    expect(heldBills(db, SARA, T0)[0]!.bill).toEqual(bill(SARA, 140000, 3));
    // Never pushed (architecture §4.7).
    expect(count('outbox')).toBe(0);
    expect(count('local_documents')).toBe(0);
  });

  it('is refused on an empty bill, without the permission, and past the cap, changing nothing', () => {
    expect(codeOf(() => holdBill(db, hold(1)))).toBe('empty_bill');
    saveOpenBill(db, NOHOLD, bill(NOHOLD, 140000));
    expect(codeOf(() => holdBill(db, hold(2, NOHOLD)))).toBe('not_permitted');
    expect(loadOpenBill(db, NOHOLD)).not.toBeNull();
    for (let n = 0; n < MAX_HELD_BILLS; n++) {
      saveOpenBill(db, n % 2 ? ALI : SARA, bill(SARA, 140000));
      holdBill(db, hold(10 + n, n % 2 ? ALI : SARA));
    }
    saveOpenBill(db, SARA, bill(SARA, 99000));
    expect(codeOf(() => holdBill(db, hold(99)))).toBe('too_many');
    expect(loadOpenBill(db, SARA)?.bill.lines[0]?.unitPrice).toBe(99000);
    expect(count('held_bills')).toBe(MAX_HELD_BILLS);
  });

  it("doesn't count yesterday's held bills against the cap", () => {
    for (let n = 0; n < MAX_HELD_BILLS; n++) {
      saveOpenBill(db, SARA, bill(SARA, 140000));
      holdBill(db, hold(10 + n));
    }
    saveOpenBill(db, SARA, bill(SARA, 99000));
    // 10:00 the next day.
    const next = holdBill(db, hold(99, SARA, null, Date.parse('2026-11-04T05:00:00.000Z')));
    expect(next.businessDate).toBe('2026-11-04');
    expect(count('held_bills')).toBe(1);
  });

  it('is the date of the 04:00 cutoff: a bill held at 01:00 belongs to the day before', () => {
    saveOpenBill(db, SARA, bill(SARA, 140000));
    // 01:00 in Karachi on 2026-11-04.
    expect(holdBill(db, hold(1, SARA, null, Date.parse('2026-11-03T20:00:00.000Z'))).businessDate).toBe(
      '2026-11-03',
    );
  });
});

describe('the held list', () => {
  it("shows only the person's own bills, newest first", () => {
    saveOpenBill(db, SARA, bill(SARA, 100000));
    holdBill(db, hold(1));
    saveOpenBill(db, ALI, bill(ALI, 110000));
    holdBill(db, hold(2, ALI));
    saveOpenBill(db, SARA, bill(SARA, 120000));
    holdBill(db, hold(3));
    expect(heldBills(db, SARA, T0).map((h) => h.bill.bill.lines[0]!.unitPrice)).toEqual([120000, 100000]);
    expect(heldBills(db, ALI, T0)).toHaveLength(1);
  });

  it('sweeps bills whose business day is over at 04:00, everyone’s, keeping the rest', () => {
    saveOpenBill(db, SARA, bill(SARA, 100000));
    holdBill(db, hold(1));
    saveOpenBill(db, ALI, bill(ALI, 110000));
    holdBill(db, hold(2, ALI));
    // 03:59 the next morning: still today's.
    expect(sweepHeld(db, Date.parse('2026-11-03T22:59:00.000Z'))).toBe(0);
    saveOpenBill(db, SARA, bill(SARA, 120000));
    holdBill(db, hold(3, SARA, null, Date.parse('2026-11-03T23:30:00.000Z')));
    expect(heldBills(db, SARA, Date.parse('2026-11-03T23:30:00.000Z')).map((h) => h.businessDate)).toEqual([
      '2026-11-04',
    ]);
    expect(count('held_bills')).toBe(1);
    const logged = db.selectObjects("SELECT detail FROM diagnostic_log WHERE kind = 'held.expired'");
    expect(logged.map((r) => JSON.parse(String(r['detail'])) as unknown)).toEqual([{ count: 2 }]);
  });
});

describe('recalling a held bill', () => {
  it('makes it the open bill again, exactly as it was', () => {
    saveOpenBill(db, SARA, bill(SARA, 140000, 2));
    const held = holdBill(db, hold(1));
    expect(recallBill(db, { id: held.id, userId: SARA, holdCurrent: null })).toEqual(bill(SARA, 140000, 2));
    expect(loadOpenBill(db, SARA)).toEqual(bill(SARA, 140000, 2));
    expect(count('held_bills')).toBe(0);
  });

  it("is refused for someone else's held bill (owner answer 4)", () => {
    saveOpenBill(db, SARA, bill(SARA, 140000));
    const held = holdBill(db, hold(1));
    expect(codeOf(() => recallBill(db, { id: held.id, userId: ALI, holdCurrent: null }))).toBe('not_found');
    expect(count('held_bills')).toBe(1);
    expect(loadOpenBill(db, ALI)).toBeNull();
  });

  it('over a bill with lines needs the swap, and without it changes nothing', () => {
    saveOpenBill(db, SARA, bill(SARA, 100000));
    const first = holdBill(db, hold(1));
    saveOpenBill(db, SARA, bill(SARA, 200000));
    expect(codeOf(() => recallBill(db, { id: first.id, userId: SARA, holdCurrent: null }))).toBe('bill_open');
    expect(loadOpenBill(db, SARA)?.bill.lines[0]?.unitPrice).toBe(200000);
    expect(count('held_bills')).toBe(1);
  });

  it('swaps the two in one transaction, even with the counter at its cap', () => {
    saveOpenBill(db, SARA, bill(SARA, 100000));
    const first = holdBill(db, hold(1));
    for (let n = 1; n < MAX_HELD_BILLS; n++) {
      saveOpenBill(db, ALI, bill(ALI, 110000));
      holdBill(db, hold(10 + n, ALI));
    }
    saveOpenBill(db, SARA, bill(SARA, 200000));
    const swap = hold(2, SARA, 'second customer');
    recallBill(db, {
      id: first.id,
      userId: SARA,
      holdCurrent: { id: swap.id, label: swap.label, atMs: swap.atMs },
    });
    expect(loadOpenBill(db, SARA)?.bill.lines[0]?.unitPrice).toBe(100000);
    expect(heldBills(db, SARA, T0).map((h) => [h.label, h.bill.bill.lines[0]!.unitPrice])).toEqual([
      ['second customer', 200000],
    ]);
    expect(count('held_bills')).toBe(MAX_HELD_BILLS);
  });

  it('over an empty bill needs no swap', () => {
    saveOpenBill(db, SARA, bill(SARA, 100000));
    const first = holdBill(db, hold(1));
    saveOpenBill(db, SARA, bill(SARA, 0, 0));
    recallBill(db, { id: first.id, userId: SARA, holdCurrent: null });
    expect(loadOpenBill(db, SARA)?.bill.lines).toHaveLength(1);
    expect(count('held_bills')).toBe(0);
  });
});

describe('clearing a held bill', () => {
  it("removes the person's own, and never another's", () => {
    saveOpenBill(db, SARA, bill(SARA, 100000));
    const held = holdBill(db, hold(1));
    expect(clearHeld(db, held.id, ALI)).toBe(false);
    expect(clearHeld(db, held.id, SARA)).toBe(true);
    expect(clearHeld(db, held.id, SARA)).toBe(false);
    expect(count('held_bills')).toBe(0);
  });
});
