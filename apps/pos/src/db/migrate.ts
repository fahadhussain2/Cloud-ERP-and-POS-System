import type { SqlDb } from './sql';

// The counter's schema (POS spec §1–§2, data model §12, CLAUDE.md rule 9, D-089): numbered migrations, each in one
// transaction, applied in place. Never drop and rebuild while the outbox has rows. Append new migrations; never
// edit one that a counter may already have run.

export interface Migration {
  version: number;
  statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        device_id TEXT, tenant_id TEXT, branch_id TEXT, device_code TEXT, device_kind TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
      'INSERT INTO meta (id, schema_version) VALUES (1, 0)',
      // Pull cursor, last pull/push, server clock offset: small values by key (sync spec §4).
      'CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      'CREATE TABLE local_series (family TEXT PRIMARY KEY, next_seq INTEGER NOT NULL)',
      `CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        family TEXT NOT NULL,
        seq INTEGER NOT NULL,
        payload TEXT NOT NULL,
        signature TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'quarantined')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (family, seq)
      )`,
      `CREATE TABLE local_documents (
        id TEXT PRIMARY KEY, family TEXT NOT NULL, seq INTEGER NOT NULL, number TEXT NOT NULL,
        kind TEXT NOT NULL, business_date TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      )`,
      // Pulled datasets (sync spec §3). Users get real columns (unlock reads them); the rest stay as JSON.
      `CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, full_name TEXT NOT NULL, short_code TEXT,
        pin_verifier TEXT, pin_must_change INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        row_version TEXT NOT NULL, deleted_at TEXT
      )`,
      `CREATE TABLE roles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, template_key TEXT, permissions TEXT NOT NULL, limits TEXT NOT NULL,
        row_version TEXT NOT NULL, deleted_at TEXT
      )`,
      `CREATE TABLE user_roles (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role_id TEXT NOT NULL, branch_id TEXT,
        row_version TEXT NOT NULL, deleted_at TEXT
      )`,
      'CREATE TABLE tenant (id TEXT PRIMARY KEY, data TEXT NOT NULL, row_version TEXT NOT NULL, deleted_at TEXT)',
      'CREATE TABLE branch (id TEXT PRIMARY KEY, data TEXT NOT NULL, row_version TEXT NOT NULL, deleted_at TEXT)',
      // Wrong PINs per person on this counter (POS spec §5); survives reloads.
      'CREATE TABLE pin_state (user_id TEXT PRIMARY KEY, failures INTEGER NOT NULL, locked INTEGER NOT NULL, updated_at TEXT NOT NULL)',
      // The last ~5,000 events, for "Send diagnostics" (architecture §11.3).
      'CREATE TABLE diagnostic_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)',
    ],
  },
  {
    // The catalog (W1-03, sync spec §3): exactly the pulled columns. Money is whole minor units (rule 1). Removed rows
    // are deleted, so deleted_at stays empty; the search index loads each table with one query.
    version: 2,
    statements: [
      `CREATE TABLE price_tiers (
        id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, sort INTEGER NOT NULL, is_default INTEGER NOT NULL,
        row_version TEXT NOT NULL, deleted_at TEXT
      )`,
      `CREATE TABLE units (
        id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, allows_fraction INTEGER NOT NULL,
        row_version TEXT NOT NULL, deleted_at TEXT
      )`,
      `CREATE TABLE categories (
        id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT, pricing_rule TEXT NOT NULL,
        return_policy TEXT NOT NULL, row_version TEXT NOT NULL, deleted_at TEXT
      )`,
      'CREATE TABLE brands (id TEXT PRIMARY KEY, name TEXT NOT NULL, row_version TEXT NOT NULL, deleted_at TEXT)',
      'CREATE TABLE origins (id TEXT PRIMARY KEY, name TEXT NOT NULL, row_version TEXT NOT NULL, deleted_at TEXT)',
      'CREATE TABLE vehicle_makes (id TEXT PRIMARY KEY, name TEXT NOT NULL, row_version TEXT NOT NULL, deleted_at TEXT)',
      `CREATE TABLE items (
        id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, category_id TEXT, brand_id TEXT, origin_id TEXT,
        unit_id TEXT, variant TEXT, spec TEXT, bin_location TEXT, floor_price INTEGER, tax_code_id TEXT,
        status TEXT NOT NULL, row_version TEXT NOT NULL, deleted_at TEXT
      )`,
      `CREATE TABLE item_identifiers (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
        normalized_value TEXT NOT NULL, is_primary INTEGER NOT NULL, row_version TEXT NOT NULL, deleted_at TEXT
      )`,
      'CREATE INDEX item_identifiers_item ON item_identifiers (item_id)',
      `CREATE TABLE item_compatibility (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL, make_id TEXT, model TEXT, year_from INTEGER, year_to INTEGER,
        note TEXT, row_version TEXT NOT NULL, deleted_at TEXT
      )`,
      'CREATE INDEX item_compatibility_item ON item_compatibility (item_id)',
      `CREATE TABLE item_prices (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL, tier_id TEXT NOT NULL, price INTEGER NOT NULL,
        row_version TEXT NOT NULL, deleted_at TEXT
      )`,
      'CREATE INDEX item_prices_item ON item_prices (item_id)',
    ],
  },
  {
    // PIN locks and manager unlocks on this counter (W1-04, POS spec §5): kept until push reports them to the
    // server's audit log (W1-07). Not documents, so not in the outbox's numbered series.
    version: 3,
    statements: [
      `CREATE TABLE pin_events (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('locked', 'unlocked')), user_id TEXT NOT NULL,
        by_user_id TEXT, at TEXT NOT NULL, pushed_at TEXT
      )`,
    ],
  },
  {
    // The bill each person is building (W1-05, POS spec §10): saved after every change, so a lock or a reload never
    // loses it. Never pushed; finalizing (W1-06) removes it in the same transaction as the document.
    version: 4,
    statements: [
      'CREATE TABLE open_bills (user_id TEXT PRIMARY KEY, bill TEXT NOT NULL, updated_at TEXT NOT NULL)',
    ],
  },
  {
    // Paying and printing (W1-06, POS spec §12–§13, sync spec §3): the pulled payment methods, print profiles and this
    // device's own row, exactly the pulled columns; and the reprints, kept until push reports them (W1-07).
    version: 5,
    statements: [
      `CREATE TABLE payment_methods (
        id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, is_cash INTEGER NOT NULL,
        requires_reference INTEGER NOT NULL, is_active INTEGER NOT NULL, sort INTEGER NOT NULL,
        row_version TEXT NOT NULL, deleted_at TEXT
      )`,
      `CREATE TABLE print_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, paper_format TEXT NOT NULL, code_type TEXT NOT NULL,
        copies INTEGER NOT NULL, template_options TEXT NOT NULL, is_tenant_default INTEGER NOT NULL,
        row_version TEXT NOT NULL, deleted_at TEXT
      )`,
      `CREATE TABLE device (
        id TEXT PRIMARY KEY, code TEXT NOT NULL, print_profile_id TEXT, status TEXT NOT NULL,
        row_version TEXT NOT NULL, deleted_at TEXT
      )`,
      `CREATE TABLE reprints (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL, number TEXT NOT NULL, user_id TEXT NOT NULL, at TEXT NOT NULL,
        pushed_at TEXT
      )`,
      // The reprint list reads the last 30 days, newest first.
      'CREATE INDEX local_documents_created ON local_documents (created_at)',
    ],
  },
  {
    // Push (W1-07, sync spec §7): a document keeps its signature after its outbox row is acked, so it can be pushed
    // again after a server restore; the re-queue reads documents by series.
    version: 6,
    statements: [
      'ALTER TABLE local_documents ADD COLUMN signature TEXT',
      'CREATE INDEX local_documents_series ON local_documents (family, seq)',
    ],
  },
];

export const LATEST_VERSION = MIGRATIONS.length;

export class DbTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly known: number,
  ) {
    super(`the local database is version ${found}; this app knows up to ${known}`);
    this.name = 'DbTooNewError';
  }
}

/** The schema version, 0 for a database that has never been migrated. */
export function currentVersion(db: SqlDb): number {
  const hasMeta = db.selectValue("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
  return hasMeta ? Number(db.selectValue('SELECT schema_version FROM meta WHERE id = 1')) : 0;
}

/** Brings the database to the latest version, one transaction per migration. Returns the new version. */
export function migrate(db: SqlDb, migrations: readonly Migration[] = MIGRATIONS): number {
  const latest = migrations.at(-1)?.version ?? 0;
  const found = currentVersion(db);
  if (found > latest) throw new DbTooNewError(found, latest);
  for (const m of migrations) {
    if (m.version <= found) continue;
    db.transaction(() => {
      for (const statement of m.statements) db.exec(statement);
      db.exec('UPDATE meta SET schema_version = ? WHERE id = 1', [m.version]);
    });
  }
  return Math.max(found, latest);
}

/** A rebuild from the server is allowed only with an empty outbox (rule 9): unsynced bills are never dropped. */
export const rebuildAllowed = (db: SqlDb): boolean =>
  Number(db.selectValue('SELECT count(*) FROM outbox')) === 0;
