// @vitest-environment node
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './migrate';
import {
  applyPull,
  getDevice,
  getPinState,
  getSync,
  grantsFor,
  listPinEvents,
  listStaff,
  loadCatalog,
  log,
  outboxStats,
  recordPinEvent,
  setDevice,
  setPinState,
  tenantSettings,
} from './repo';
import { wrapOo1, type SqlDb } from './sql';

// The counter's data access (POS spec §1, §5, sync spec §4, D-089), on real SQLite in memory.

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
let db: SqlDb;

const user = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  username: id,
  full_name: id.toUpperCase(),
  short_code: null,
  pin_verifier: `v-${id}`,
  pin_must_change: false,
  status: 'active',
  row_version: '1',
  deleted_at: null,
  ...over,
});

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});
beforeEach(() => {
  db = wrapOo1(new sqlite3.oo1.DB(':memory:'));
  migrate(db);
});

describe('applying a pull', () => {
  it('inserts, updates and keeps tombstones, and saves the cursor with the rows', () => {
    applyPull(db, { users: [user('sara'), user('ali')] }, 'cursor-1');
    applyPull(
      db,
      {
        users: [
          user('sara', { full_name: 'Sara K', row_version: '2' }),
          user('ali', { deleted_at: '2026-10-25T10:00:00Z' }),
        ],
      },
      'cursor-2',
    );
    expect(listStaff(db).map((u) => [u.id, u.fullName, u.deletedAt])).toEqual([
      ['ali', 'ALI', '2026-10-25T10:00:00Z'],
      ['sara', 'Sara K', null],
    ]);
    expect(getSync(db, 'pull_cursor')).toBe('cursor-2');
    expect(getSync(db, 'last_pull_at')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('stores roles, user roles, the tenant and the branch', () => {
    applyPull(
      db,
      {
        tenant: [
          {
            id: 't1',
            name: 'Delux Autos',
            closing_time: '20:00:00',
            timezone: 'Asia/Karachi',
            locale: 'en-PK',
            base_currency: 'PKR',
            currency_minor_units: 2,
            row_version: '1',
            deleted_at: null,
          },
        ],
        branch: [{ id: 'b1', code: 'MAIN', name: 'Main', row_version: '1', deleted_at: null }],
        roles: [
          {
            id: 'r1',
            name: 'Salesman',
            template_key: 'salesman',
            permissions: ['pos.sale.create'],
            limits: { maxDiscountBp: 10000 },
            row_version: '1',
            deleted_at: null,
          },
        ],
        user_roles: [
          { id: 'ur1', user_id: 'sara', role_id: 'r1', branch_id: null, row_version: '1', deleted_at: null },
        ],
      },
      'c',
    );
    expect(tenantSettings(db)).toEqual({
      name: 'Delux Autos',
      closingTime: '20:00:00',
      timeZone: 'Asia/Karachi',
      locale: 'en-PK',
      currency: 'PKR',
      minorUnits: 2,
    });
    expect(db.selectObjects('SELECT permissions FROM roles')).toEqual([
      { permissions: '["pos.sale.create"]' },
    ]);
    expect(db.selectValue('SELECT count(*) FROM user_roles')).toBe(1);
  });

  it('changes nothing, cursor included, if a row is bad', () => {
    applyPull(db, { users: [user('sara')] }, 'cursor-1');
    expect(() => applyPull(db, { users: [user('ali'), { id: 'broken' }] }, 'cursor-2')).toThrow();
    expect(listStaff(db).map((u) => u.id)).toEqual(['sara']);
    expect(getSync(db, 'pull_cursor')).toBe('cursor-1');
  });
});

describe('applying a catalog pull (W1-03)', () => {
  const row = (id: string, over: Record<string, unknown>) => ({
    id,
    row_version: '1',
    deleted_at: null,
    ...over,
  });
  const catalog = {
    price_tiers: [row('t1', { code: 'RETAIL', name: 'Retail', sort: 1, is_default: true })],
    units: [row('u1', { code: 'PCS', name: 'Pieces', allows_fraction: false })],
    categories: [
      row('c1', {
        code: 'BRPD',
        name: 'Brake pads',
        parent_id: null,
        pricing_rule: { floor_min_margin_bp: 500 },
        return_policy: { returnable: true, window_days: 30 },
      }),
    ],
    brands: [row('b1', { name: 'KASHIYAMA' })],
    origins: [row('o1', { name: 'JAPAN' })],
    vehicle_makes: [row('m1', { name: 'TOYOTA' })],
    items: [
      row('i1', {
        code: 'BRPD001',
        name: 'BRAKE PADS FRONT COROLLA',
        category_id: 'c1',
        brand_id: 'b1',
        origin_id: 'o1',
        unit_id: 'u1',
        variant: 'FRONT',
        spec: null,
        bin_location: 'R3-B2',
        floor_price: '400000',
        tax_code_id: null,
        status: 'active',
      }),
    ],
    item_identifiers: [
      row('x1', {
        item_id: 'i1',
        kind: 'oem',
        value: '04465-02220',
        normalized_value: '0446502220',
        is_primary: true,
      }),
    ],
    item_compatibility: [
      row('v1', {
        item_id: 'i1',
        make_id: 'm1',
        model: 'COROLLA',
        year_from: 2009,
        year_to: 2014,
        note: null,
      }),
    ],
    item_prices: [row('p1', { item_id: 'i1', tier_id: 't1', price: '450000' })],
  };

  it('stores every catalog dataset and loads it back with numbers, flags and JSON restored', () => {
    applyPull(db, catalog, 'cursor-1');
    const loaded = loadCatalog(db);
    expect(loaded.items).toEqual([{ ...catalog.items[0], floor_price: 400000 }]);
    expect(loaded.item_prices).toEqual([{ ...catalog.item_prices[0], price: 450000 }]);
    expect(loaded.price_tiers).toEqual(catalog.price_tiers);
    expect(loaded.categories).toEqual(catalog.categories);
    expect(loaded.item_identifiers).toEqual(catalog.item_identifiers);
    expect(loaded.item_compatibility).toEqual(catalog.item_compatibility);
    expect(getSync(db, 'pull_cursor')).toBe('cursor-1');
  });

  it('updates changed rows and deletes tombstones', () => {
    applyPull(db, catalog, 'cursor-1');
    applyPull(
      db,
      {
        item_prices: [row('p1', { item_id: 'i1', tier_id: 't1', price: '470000', row_version: '2' })],
        item_identifiers: [{ ...catalog.item_identifiers[0], deleted_at: '2026-10-26T10:00:00Z' }],
      },
      'cursor-2',
    );
    const loaded = loadCatalog(db);
    expect(loaded.item_prices.map((p) => p['price'])).toEqual([470000]);
    expect(loaded.item_identifiers).toEqual([]);
  });

  it('marks the first complete pull, so the counter knows its catalog is loaded', () => {
    applyPull(db, catalog, 'cursor-1');
    expect(getSync(db, 'pull_complete_at')).toBeNull();
    applyPull(db, {}, 'cursor-2', true);
    expect(getSync(db, 'pull_complete_at')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('changes nothing, cursor included, if a price is not whole minor units', () => {
    applyPull(db, catalog, 'cursor-1');
    expect(() =>
      applyPull(
        db,
        { item_prices: [row('p2', { item_id: 'i1', tier_id: 't1', price: '12.5' })] },
        'cursor-2',
      ),
    ).toThrow();
    expect(loadCatalog(db).item_prices).toHaveLength(1);
    expect(getSync(db, 'pull_cursor')).toBe('cursor-1');
  });
});

describe('the counter itself', () => {
  it('remembers its enrollment', () => {
    expect(getDevice(db)).toBeNull();
    setDevice(db, { deviceId: 'd1', tenantId: 't1', branchId: 'b1', code: 'C03', kind: 'counter' });
    expect(getDevice(db)).toEqual({
      deviceId: 'd1',
      tenantId: 't1',
      branchId: 'b1',
      code: 'C03',
      kind: 'counter',
    });
  });

  it('keeps PIN mistakes per person', () => {
    expect(getPinState(db, 'sara')).toEqual({ failures: 0, locked: false });
    setPinState(db, 'sara', { failures: 5, locked: true });
    expect(getPinState(db, 'sara')).toEqual({ failures: 5, locked: true });
    expect(getPinState(db, 'ali')).toEqual({ failures: 0, locked: false });
  });

  it('counts unsynced documents and the oldest one', () => {
    expect(outboxStats(db)).toEqual({ count: 0, oldestAt: null });
    db.exec(
      "INSERT INTO outbox (id, family, seq, payload, status, created_at) VALUES ('a', 'S', 1, '{}', 'pending', '2026-10-25T09:00:00Z'), ('b', 'S', 2, '{}', 'pending', '2026-10-25T09:05:00Z')",
    );
    expect(outboxStats(db)).toEqual({ count: 2, oldestAt: '2026-10-25T09:00:00Z' });
  });

  it('keeps the diagnostic log to the last 5,000 events', () => {
    db.transaction(() => {
      for (let i = 0; i < 5003; i++) log(db, 'test', { i });
    });
    expect(db.selectValue('SELECT count(*) FROM diagnostic_log')).toBe(5000);
    expect(db.selectValue("SELECT json_extract(detail, '$.i') FROM diagnostic_log ORDER BY id LIMIT 1")).toBe(
      3,
    );
  });
});

// W1-04 plan: a new PIN from the server clears the lock; lock and unlock events wait for push (W1-07); grants for
// the manager unlock come from the pulled roles.
describe('PIN locks and events (W1-04)', () => {
  it('a pull with a new PIN verifier clears that person’s lock; the same verifier keeps it', () => {
    applyPull(db, { users: [user('sara'), user('ali')] }, 'c1');
    setPinState(db, 'sara', { failures: 5, locked: true });
    setPinState(db, 'ali', { failures: 5, locked: true });
    applyPull(
      db,
      {
        users: [
          user('sara', { pin_verifier: 'v-new', pin_must_change: true, row_version: '2' }),
          user('ali', { full_name: 'Ali K', row_version: '2' }),
        ],
      },
      'c2',
    );
    expect(getPinState(db, 'sara')).toEqual({ failures: 0, locked: false });
    expect(getPinState(db, 'ali')).toEqual({ failures: 5, locked: true });
  });

  it('the first pull of a person clears nothing it shouldn’t (no earlier state)', () => {
    applyPull(db, { users: [user('new')] }, 'c1');
    expect(getPinState(db, 'new')).toEqual({ failures: 0, locked: false });
  });

  it('keeps lock and unlock events in order until they are pushed', () => {
    recordPinEvent(db, { kind: 'locked', userId: 'sara', byUserId: null, at: '2026-10-26T09:00:00.000Z' });
    recordPinEvent(db, {
      kind: 'unlocked',
      userId: 'sara',
      byUserId: 'boss',
      at: '2026-10-26T09:05:00.000Z',
    });
    expect(listPinEvents(db)).toEqual([
      expect.objectContaining({
        kind: 'locked',
        userId: 'sara',
        byUserId: null,
        at: '2026-10-26T09:00:00.000Z',
        pushedAt: null,
      }),
      expect.objectContaining({
        kind: 'unlocked',
        userId: 'sara',
        byUserId: 'boss',
        at: '2026-10-26T09:05:00.000Z',
        pushedAt: null,
      }),
    ]);
    const ids = listPinEvents(db).map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it('builds a person’s grants from the pulled roles, without removed ones', () => {
    applyPull(
      db,
      {
        roles: [
          {
            id: 'r-man',
            name: 'Manager',
            template_key: 'manager',
            permissions: ['admin.devices', 'pos.void'],
            limits: { maxDiscountBp: 10000, voidWindow: 'same_day' },
            row_version: '1',
            deleted_at: null,
          },
          {
            id: 'r-old',
            name: 'Old',
            template_key: null,
            permissions: ['*'],
            limits: { maxDiscountBp: 0, voidWindow: 'none' },
            row_version: '1',
            deleted_at: null,
          },
        ],
        user_roles: [
          {
            id: 'ur1',
            user_id: 'boss',
            role_id: 'r-man',
            branch_id: 'b1',
            row_version: '1',
            deleted_at: null,
          },
          {
            id: 'ur2',
            user_id: 'boss',
            role_id: 'r-old',
            branch_id: null,
            row_version: '2',
            deleted_at: '2026-10-26T08:00:00Z',
          },
          {
            id: 'ur3',
            user_id: 'sara',
            role_id: 'r-man',
            branch_id: null,
            row_version: '1',
            deleted_at: null,
          },
        ],
      },
      'c',
    );
    expect(grantsFor(db, 'boss')).toEqual([
      {
        permissions: ['admin.devices', 'pos.void'],
        limits: { maxDiscountBp: 10000, voidWindow: 'same_day' },
        branchId: 'b1',
      },
    ]);
    expect(grantsFor(db, 'nobody')).toEqual([]);
  });
});
