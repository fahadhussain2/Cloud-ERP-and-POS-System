// @vitest-environment node
import { CASH_DESK_COLUMNS, CATALOG_COLUMNS, CATALOG_DATASETS, CUSTOMER_COLUMNS } from '@erp/contracts';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DbTooNewError,
  LATEST_VERSION,
  MIGRATIONS,
  migrate,
  rebuildAllowed,
  type Migration,
} from './migrate';
import { wrapOo1, type SqlDb } from './sql';

// The counter's local database (POS spec §1–§2, CLAUDE.md rule 9, D-089): numbered migrations in place, never a
// drop while the outbox has rows. Real SQLite (the same WASM build as the counter), in memory.

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
const fresh = (): SqlDb => wrapOo1(new sqlite3.oo1.DB(':memory:'));
const tables = (db: SqlDb) =>
  db
    .selectObjects(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((r) => r['name']);

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

describe('migrations', () => {
  it('bring a new database to the latest schema with every table from the spec', () => {
    const db = fresh();
    migrate(db);
    expect(db.selectValue('SELECT schema_version FROM meta')).toBe(LATEST_VERSION);
    expect(tables(db)).toEqual(
      expect.arrayContaining([
        'branch',
        'diagnostic_log',
        'local_documents',
        'local_series',
        'meta',
        'outbox',
        'pin_events',
        'pin_state',
        'roles',
        'sync_state',
        'tenant',
        'user_roles',
        'users',
      ]),
    );
  });

  it('are numbered 1, 2, 3… with no gaps', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(LATEST_VERSION).toBe(MIGRATIONS.length);
  });

  it('upgrade an older database in place and keep its rows', () => {
    const db = fresh();
    const v1 = MIGRATIONS.slice(0, 1);
    migrate(db, v1);
    db.exec(
      "INSERT INTO outbox (id, family, seq, payload, status, attempts, created_at) VALUES ('d1', 'S', 1, '{}', 'pending', 0, 'now')",
    );
    const v2: Migration[] = [...v1, { version: 2, statements: ['ALTER TABLE outbox ADD COLUMN note TEXT'] }];
    migrate(db, v2);
    expect(db.selectValue('SELECT schema_version FROM meta')).toBe(2);
    expect(db.selectObjects('SELECT id, note FROM outbox')).toEqual([{ id: 'd1', note: null }]);
  });

  it("schema 2 adds the catalog tables with exactly the pulled columns, and keeps a W1-02 counter's rows", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.slice(0, 1));
    db.exec(
      "INSERT INTO users (id, username, full_name, status, row_version) VALUES ('u1', 'sara', 'Sara', 'active', '1')",
    );
    db.exec("INSERT INTO pin_state (user_id, failures, locked, updated_at) VALUES ('u1', 3, 0, 'now')");
    db.exec(
      "INSERT INTO outbox (id, family, seq, payload, status, attempts, created_at) VALUES ('d1', 'S', 1, '{}', 'pending', 0, 'now')",
    );
    db.exec("INSERT INTO sync_state (key, value) VALUES ('pull_cursor', 'c1')");
    migrate(db);
    expect(db.selectValue('SELECT schema_version FROM meta')).toBe(LATEST_VERSION);
    expect(db.selectValue('SELECT full_name FROM users')).toBe('Sara');
    expect(db.selectValue('SELECT failures FROM pin_state')).toBe(3);
    expect(db.selectValue('SELECT count(*) FROM outbox')).toBe(1);
    expect(db.selectValue("SELECT value FROM sync_state WHERE key = 'pull_cursor'")).toBe('c1');
    for (const dataset of CATALOG_DATASETS) {
      const columns = db.selectObjects(`PRAGMA table_info(${dataset})`).map((r) => String(r['name']));
      expect(columns.sort(), dataset).toEqual(
        [...Object.keys(CATALOG_COLUMNS[dataset]), 'row_version', 'deleted_at'].sort(),
      );
    }
  });

  it("schema 3 adds the PIN events (W1-04) and keeps a W1-03 counter's rows", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.slice(0, 2));
    db.exec(
      "INSERT INTO users (id, username, full_name, status, row_version) VALUES ('u1', 'sara', 'Sara', 'active', '1')",
    );
    db.exec("INSERT INTO pin_state (user_id, failures, locked, updated_at) VALUES ('u1', 5, 1, 'now')");
    db.exec(
      "INSERT INTO outbox (id, family, seq, payload, status, attempts, created_at) VALUES ('d1', 'S', 1, '{}', 'pending', 0, 'now')",
    );
    db.exec(
      "INSERT INTO items (id, code, name, status, row_version) VALUES ('i1', 'AFLT001', 'AIR FILTER', 'active', '1')",
    );
    migrate(db);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(3);
    expect(db.selectValue('SELECT locked FROM pin_state')).toBe(1);
    expect(db.selectValue('SELECT count(*) FROM outbox')).toBe(1);
    expect(db.selectValue('SELECT name FROM items')).toBe('AIR FILTER');
    const columns = db.selectObjects('PRAGMA table_info(pin_events)').map((r) => String(r['name']));
    expect(columns.sort()).toEqual(['at', 'by_user_id', 'id', 'kind', 'pushed_at', 'user_id']);
  });

  it("schema 4 adds the open bills (W1-05) and keeps a W1-04 counter's rows", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.slice(0, 3));
    db.exec(
      "INSERT INTO pin_events (id, kind, user_id, at) VALUES ('e1', 'locked', 'u1', '2026-11-02T10:00:00Z')",
    );
    db.exec(
      "INSERT INTO outbox (id, family, seq, payload, status, attempts, created_at) VALUES ('d1', 'S', 1, '{}', 'pending', 0, 'now')",
    );
    db.exec(
      "INSERT INTO items (id, code, name, status, row_version) VALUES ('i1', 'AFLT001', 'AIR FILTER', 'active', '1')",
    );
    migrate(db);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(4);
    expect(db.selectValue('SELECT kind FROM pin_events')).toBe('locked');
    expect(db.selectValue('SELECT count(*) FROM outbox')).toBe(1);
    expect(db.selectValue('SELECT name FROM items')).toBe('AIR FILTER');
    const columns = db.selectObjects('PRAGMA table_info(open_bills)').map((r) => String(r['name']));
    expect(columns.sort()).toEqual(['bill', 'updated_at', 'user_id']);
  });

  it("schema 5 adds payment methods, print profiles, the device and reprints (W1-06) and keeps a W1-05 counter's rows", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.slice(0, 4));
    db.exec("INSERT INTO open_bills (user_id, bill, updated_at) VALUES ('sara', '{}', 'now')");
    db.exec(
      "INSERT INTO pin_events (id, kind, user_id, at) VALUES ('e1', 'locked', 'u1', '2026-11-02T10:00:00Z')",
    );
    db.exec(
      "INSERT INTO outbox (id, family, seq, payload, status, attempts, created_at) VALUES ('d1', 'S', 1, '{}', 'pending', 0, 'now')",
    );
    db.exec("INSERT INTO local_series (family, next_seq) VALUES ('S', 2)");
    migrate(db);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(5);
    expect(db.selectValue('SELECT count(*) FROM open_bills')).toBe(1);
    expect(db.selectValue('SELECT count(*) FROM pin_events')).toBe(1);
    expect(db.selectValue('SELECT count(*) FROM outbox')).toBe(1);
    expect(db.selectValue("SELECT next_seq FROM local_series WHERE family = 'S'")).toBe(2);
    const columns = (table: string) =>
      db
        .selectObjects(`PRAGMA table_info(${table})`)
        .map((r) => String(r['name']))
        .sort();
    expect(columns('payment_methods')).toEqual(
      [
        'id',
        'code',
        'name',
        'is_cash',
        'requires_reference',
        'is_active',
        'sort',
        'row_version',
        'deleted_at',
      ].sort(),
    );
    expect(columns('print_profiles')).toEqual(
      [
        'id',
        'name',
        'paper_format',
        'code_type',
        'copies',
        'template_options',
        'is_tenant_default',
        'row_version',
        'deleted_at',
      ].sort(),
    );
    expect(columns('device')).toEqual(
      ['id', 'code', 'print_profile_id', 'status', 'row_version', 'deleted_at'].sort(),
    );
    expect(columns('reprints')).toEqual(['at', 'document_id', 'id', 'number', 'pushed_at', 'user_id']);
  });

  it("schema 6 keeps each document's signature for re-push (W1-07) and keeps a W1-06 counter's rows", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.slice(0, 5));
    db.exec("INSERT INTO open_bills (user_id, bill, updated_at) VALUES ('sara', '{}', 'now')");
    db.exec(
      "INSERT INTO pin_events (id, kind, user_id, at) VALUES ('e1', 'locked', 'u1', '2026-11-02T10:00:00Z')",
    );
    db.exec(
      "INSERT INTO reprints (id, document_id, number, user_id, at) VALUES ('r1', 'd1', 'C03-S000001', 'u1', 'now')",
    );
    db.exec(
      `INSERT INTO local_documents (id, family, seq, number, kind, business_date, payload, created_at)
       VALUES ('d1', 'S', 1, 'C03-S000001', 'sale', '2026-11-02', '{}', 'now')`,
    );
    db.exec(
      "INSERT INTO outbox (id, family, seq, payload, signature, status, attempts, created_at) VALUES ('d1', 'S', 1, '{}', 'sig', 'pending', 0, 'now')",
    );
    db.exec("INSERT INTO local_series (family, next_seq) VALUES ('S', 2)");
    migrate(db);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(6);
    for (const table of ['open_bills', 'pin_events', 'reprints', 'local_documents', 'outbox'])
      expect(db.selectValue(`SELECT count(*) FROM ${table}`)).toBe(1);
    expect(db.selectValue('SELECT signature FROM outbox')).toBe('sig');
    expect(db.selectValue("SELECT next_seq FROM local_series WHERE family = 'S'")).toBe(2);
    const columns = db.selectObjects('PRAGMA table_info(local_documents)').map((r) => String(r['name']));
    expect(columns).toContain('signature');
    expect(db.selectValue('SELECT signature FROM local_documents')).toBeNull();
    const indexes = db.selectObjects('PRAGMA index_list(local_documents)').map((r) => String(r['name']));
    expect(indexes).toContain('local_documents_series');
  });

  it("schema 7 adds customers, accounts and balances (W1-09) and keeps a W1-07 counter's rows", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.slice(0, 6));
    db.exec("INSERT INTO open_bills (user_id, bill, updated_at) VALUES ('sara', '{}', 'now')");
    db.exec(
      `INSERT INTO local_documents (id, family, seq, number, kind, business_date, payload, created_at, signature)
       VALUES ('d1', 'S', 1, 'C03-S000001', 'sale', '2026-11-02', '{}', 'now', 'sig')`,
    );
    db.exec(
      "INSERT INTO outbox (id, family, seq, payload, signature, status, attempts, created_at) VALUES ('d1', 'S', 1, '{}', 'sig', 'quarantined', 1, 'now')",
    );
    migrate(db);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(7);
    for (const table of ['open_bills', 'local_documents', 'outbox'])
      expect(db.selectValue(`SELECT count(*) FROM ${table}`)).toBe(1);
    expect(db.selectValue('SELECT status FROM outbox')).toBe('quarantined');
    expect(db.selectValue('SELECT accepted_at FROM local_documents')).toBeNull();
    const columns = (table: string) =>
      db.selectObjects(`PRAGMA table_info(${table})`).map((r) => String(r['name']));
    for (const [table, list] of Object.entries(CUSTOMER_COLUMNS))
      expect(columns(table)).toEqual([...Object.keys(list), 'row_version', 'deleted_at']);
  });

  it("schema 8 adds the cash queue and the desk's sessions (W1-10) and keeps a W1-09 counter's rows", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.slice(0, 7));
    db.exec(`INSERT INTO open_bills (user_id, bill, updated_at) VALUES ('sara', '{"version":1}', 'now')`);
    db.exec(
      `INSERT INTO local_documents (id, family, seq, number, kind, business_date, payload, created_at, signature)
       VALUES ('d1', 'S', 1, 'C03-S000001', 'sale', '2026-11-02', '{}', 'now', 'sig'),
              ('d2', 'S', 2, 'C03-S000002', 'sale', '2026-11-02', '{}', 'now', null)`,
    );
    db.exec(
      `INSERT INTO outbox (id, family, seq, payload, signature, status, attempts, created_at)
       VALUES ('d1', 'S', 1, '{}', 'sig', 'quarantined', 1, 'now'), ('d2', 'S', 2, '{}', null, 'pending', 0, 'now')`,
    );
    migrate(db);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(8);
    expect(db.selectValue('SELECT count(*) FROM open_bills')).toBe(1);
    expect(db.selectValue('SELECT count(*) FROM local_documents')).toBe(2);
    expect(db.selectObjects('SELECT id, status FROM outbox ORDER BY id')).toEqual([
      { id: 'd1', status: 'quarantined' },
      { id: 'd2', status: 'pending' },
    ]);
    const columns = (table: string) =>
      db.selectObjects(`PRAGMA table_info(${table})`).map((r) => String(r['name']));
    // Exactly the pulled columns; schema 13 (W1-23) adds three at the end.
    expect(columns('cash_queue').sort()).toEqual(
      [...Object.keys(CASH_DESK_COLUMNS.cash_queue), 'row_version', 'deleted_at'].sort(),
    );
    expect(db.selectValue('SELECT count(*) FROM cash_sessions')).toBe(0);
  });

  it("schema 9 adds what a desk's cash-out names and the count (W1-11), and keeps a W1-10 desk's rows", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.slice(0, 8));
    db.exec(
      `INSERT INTO cash_sessions (id, number, cashier_user_id, opened_at, opening_float, status)
       VALUES ('z1', 'D01-Z000001', 'ali', 'now', 500000, 'open')`,
    );
    db.exec(
      `INSERT INTO local_documents (id, family, seq, number, kind, business_date, payload, created_at)
       VALUES ('h1', 'H', 1, 'D01-H000001', 'handover', '2026-11-02', '{"sessionId":"z1","amount":100}', 'now')`,
    );
    db.exec(
      `INSERT INTO outbox (id, family, seq, payload, signature, status, attempts, created_at)
       VALUES ('h1', 'H', 1, '{}', null, 'pending', 0, 'now'), ('z1', 'Z', 1, '{}', 'sig', 'quarantined', 1, 'now')`,
    );
    migrate(db);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(9);
    expect(db.selectObjects('SELECT id, status FROM outbox ORDER BY id')).toEqual([
      { id: 'h1', status: 'pending' },
      { id: 'z1', status: 'quarantined' },
    ]);
    expect(db.selectObjects('SELECT id, status, counted_cash, left_in_drawer FROM cash_sessions')).toEqual([
      { id: 'z1', status: 'open', counted_cash: null, left_in_drawer: null },
    ]);
    const columns = (table: string) =>
      db.selectObjects(`PRAGMA table_info(${table})`).map((r) => String(r['name']));
    for (const table of ['suppliers', 'supplier_balances', 'expense_categories', 'bank_accounts'] as const)
      expect(columns(table)).toEqual([...Object.keys(CASH_DESK_COLUMNS[table]), 'row_version', 'deleted_at']);
  });

  it("schema 10 adds held bills (W1-12), and keeps a W1-11 counter's open bill, outbox and refused rows", () => {
    const db = fresh();
    migrate(db, MIGRATIONS.slice(0, 9));
    db.exec(`INSERT INTO open_bills (user_id, bill, updated_at) VALUES ('sara', '{"version":1}', 'now')`);
    db.exec(
      `INSERT INTO local_documents (id, family, seq, number, kind, business_date, payload, created_at)
       VALUES ('d1', 'S', 1, 'C03-S000001', 'sale', '2026-11-03', '{}', 'now'),
              ('d2', 'S', 2, 'C03-S000002', 'sale', '2026-11-03', '{}', 'now')`,
    );
    db.exec(
      `INSERT INTO outbox (id, family, seq, payload, signature, status, attempts, created_at)
       VALUES ('d1', 'S', 1, '{}', 'sig', 'quarantined', 1, 'now'), ('d2', 'S', 2, '{}', null, 'pending', 0, 'now')`,
    );
    migrate(db);
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(10);
    expect(db.selectValue('SELECT count(*) FROM open_bills')).toBe(1);
    expect(db.selectObjects('SELECT id, status FROM outbox ORDER BY id')).toEqual([
      { id: 'd1', status: 'quarantined' },
      { id: 'd2', status: 'pending' },
    ]);
    const columns = db.selectObjects('PRAGMA table_info(held_bills)').map((r) => String(r['name']));
    expect(columns).toEqual(['id', 'user_id', 'held_at', 'business_date', 'label', 'bill']);
    expect(db.selectValue('SELECT count(*) FROM held_bills')).toBe(0);
  });

  it('roll back a migration that fails and leave the previous schema', () => {
    const db = fresh();
    const v1 = MIGRATIONS.slice(0, 1);
    migrate(db, v1);
    const broken: Migration[] = [
      ...v1,
      { version: 2, statements: ['CREATE TABLE extra (x)', 'THIS IS NOT SQL'] },
    ];
    expect(() => migrate(db, broken)).toThrow();
    expect(db.selectValue('SELECT schema_version FROM meta')).toBe(1);
    expect(tables(db)).not.toContain('extra');
  });

  it('refuse a database newer than the app (an older app after a rollback)', () => {
    const db = fresh();
    migrate(db);
    db.exec('UPDATE meta SET schema_version = ?', [LATEST_VERSION + 1]);
    expect(() => migrate(db)).toThrow(DbTooNewError);
  });

  it('are a no-op when already up to date', () => {
    const db = fresh();
    migrate(db);
    db.exec("INSERT INTO diagnostic_log (at, kind, detail) VALUES ('now', 'test', '{}')");
    migrate(db);
    expect(db.selectValue('SELECT count(*) FROM diagnostic_log')).toBe(1);
  });
});

describe('rebuilding from the server', () => {
  it('is refused while the outbox has rows, allowed when it is empty', () => {
    const db = fresh();
    migrate(db);
    expect(rebuildAllowed(db)).toBe(true);
    db.exec(
      "INSERT INTO outbox (id, family, seq, payload, status, attempts, created_at) VALUES ('d1', 'S', 1, '{}', 'pending', 0, 'now')",
    );
    expect(rebuildAllowed(db)).toBe(false);
    db.exec("UPDATE outbox SET status = 'quarantined'");
    expect(rebuildAllowed(db)).toBe(false);
  });
});
