// @vitest-environment node
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './migrate';
import {
  applyPull,
  getDevice,
  getPinState,
  getSync,
  listStaff,
  log,
  outboxStats,
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
