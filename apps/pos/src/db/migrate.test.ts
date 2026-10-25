// @vitest-environment node
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
