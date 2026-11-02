import {
  CASH_DESK_COLUMNS,
  CASH_DESK_DATASETS,
  CATALOG_COLUMNS,
  CATALOG_DATASETS,
  CHECKOUT_COLUMNS,
  CHECKOUT_DATASETS,
  CUSTOMER_COLUMNS,
  CUSTOMER_DATASETS,
  uuidv7,
  type CashDeskDataset,
  type CatalogDataset,
  type CheckoutDataset,
  type CustomerDataset,
  type ColumnType,
  type PullResponse,
} from '@erp/contracts';
import { money, type PinState, type RoleGrant, type RoleLimits } from '@erp/domain';

import { parseOpenBill, type OpenBill } from '../bill/open-bill';
import type { StaffUser } from '../unlock/unlock';
import type { SqlDb } from './sql';

// The counter's data access (POS spec §1, §5, sync spec §3–§4, D-089). Runs in the database worker.

export interface DeviceInfo {
  deviceId: string;
  tenantId: string;
  branchId: string;
  code: string;
  kind: string;
}

const now = () => new Date().toISOString();
/** A SQLite or JSON value as text: only plain values are stored in these columns. */
const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean'
    ? String(v)
    : JSON.stringify(v);
const text = (v: unknown) => (v === null || v === undefined ? null : str(v));
const required = (row: Record<string, unknown>, key: string) => {
  const v = row[key];
  if (v === null || v === undefined) throw new Error(`pulled row ${str(row['id'])} has no ${key}`);
  return str(v);
};

export function getDevice(db: SqlDb): DeviceInfo | null {
  const [m] = db.selectObjects(
    'SELECT device_id, tenant_id, branch_id, device_code, device_kind FROM meta WHERE id = 1',
  );
  if (m?.['device_id'] === null || m?.['device_id'] === undefined) return null;
  return {
    deviceId: str(m['device_id']),
    tenantId: str(m['tenant_id']),
    branchId: str(m['branch_id']),
    code: str(m['device_code']),
    kind: str(m['device_kind']),
  };
}

export function setDevice(db: SqlDb, d: DeviceInfo): void {
  db.exec(
    'UPDATE meta SET device_id = ?, tenant_id = ?, branch_id = ?, device_code = ?, device_kind = ? WHERE id = 1',
    [d.deviceId, d.tenantId, d.branchId, d.code, d.kind],
  );
}

export const getSync = (db: SqlDb, key: string): string | null =>
  text(db.selectValue('SELECT value FROM sync_state WHERE key = ?', [key]));

export const setSync = (db: SqlDb, key: string, value: string): void =>
  db.exec(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, value],
  );

/** A pulled value as stored in SQLite: flags as 0/1, JSON as text, money as whole minor units (rule 1). */
function toSql(type: ColumnType, v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'text':
      return str(v);
    case 'bool':
      return v ? 1 : 0;
    case 'json':
      return JSON.stringify(v);
    case 'money':
      return money(v as number | string);
    case 'int': {
      const n = Number(v);
      if (!Number.isSafeInteger(n)) throw new Error(`not a whole number: ${str(v)}`);
      return n;
    }
  }
}

function fromSql(type: ColumnType, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (type === 'bool') return Number(v) === 1;
  if (type === 'json') return JSON.parse(str(v)) as unknown;
  return v;
}

const catalogColumns = (d: CatalogDataset) => Object.entries(CATALOG_COLUMNS[d]) as [string, ColumnType][];

type TypedDataset = CatalogDataset | CheckoutDataset | CustomerDataset | CashDeskDataset;

/**
 * Pulled datasets stored with exactly their typed columns: the catalog (W1-03), checkout (W1-06), customers (W1-09)
 * and the cash desk's queue (W1-10).
 */
const TYPED_COLUMNS: Record<TypedDataset, Record<string, ColumnType>> = {
  ...CATALOG_COLUMNS,
  ...CHECKOUT_COLUMNS,
  ...CUSTOMER_COLUMNS,
  ...CASH_DESK_COLUMNS,
};
const TYPED_DATASETS: TypedDataset[] = [
  ...CATALOG_DATASETS,
  ...CHECKOUT_DATASETS,
  ...CUSTOMER_DATASETS,
  ...CASH_DESK_DATASETS,
];
/** Each row's key: `id`, except a customer's or supplier's balance, one per party. */
const keyOf = (d: TypedDataset) =>
  d === 'customer_balances' || d === 'supplier_balances' ? 'party_id' : 'id';

const UPSERT = Object.fromEntries(
  TYPED_DATASETS.map((d) => {
    const names = [...Object.keys(TYPED_COLUMNS[d]), 'row_version'];
    const updates = names.filter((n) => n !== keyOf(d)).map((n) => `${n} = excluded.${n}`);
    return [
      d,
      `INSERT INTO ${d} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})
       ON CONFLICT (${keyOf(d)}) DO UPDATE SET ${updates.join(', ')}`,
    ];
  }),
) as Record<TypedDataset, string>;

/** The typed rows of a page: upserted with their types; removed rows are deleted. */
function applyTyped(db: SqlDb, changes: PullResponse['changes']): void {
  for (const d of TYPED_DATASETS) {
    const columns = Object.entries(TYPED_COLUMNS[d]);
    for (const r of changes[d] ?? []) {
      if (r['deleted_at'] !== null && r['deleted_at'] !== undefined) {
        db.exec(`DELETE FROM ${d} WHERE ${keyOf(d)} = ?`, [required(r, keyOf(d))]);
        continue;
      }
      db.exec(UPSERT[d], [
        ...columns.map(([name, type]) => toSql(type, r[name])),
        required(r, 'row_version'),
      ]);
    }
  }
}

/** The whole local catalog, typed as pulled, for the search index (worker start-up). */
export function loadCatalog(db: SqlDb): Record<CatalogDataset, Record<string, unknown>[]> {
  const out = {} as Record<CatalogDataset, Record<string, unknown>[]>;
  for (const d of CATALOG_DATASETS) {
    const columns = catalogColumns(d);
    out[d] = db
      .selectObjects(
        `SELECT ${columns.map(([n]) => n).join(', ')}, row_version, deleted_at FROM ${d} ORDER BY id`,
      )
      .map((r) => ({
        ...Object.fromEntries(columns.map(([name, type]) => [name, fromSql(type, r[name])])),
        row_version: r['row_version'],
        deleted_at: r['deleted_at'],
      }));
  }
  return out;
}

/**
 * One pulled page and its cursor, in one transaction: a crash never leaves the cursor ahead of the data. `done` marks
 * the last page of a complete pull, so the counter knows its first catalog load has finished (POS spec §9); with
 * `startedAt`, when that pull began: the customer balances now include every bill the server accepted before it
 * (POS spec §15).
 */
export function applyPull(
  db: SqlDb,
  changes: PullResponse['changes'],
  cursor: string,
  done = false,
  startedAt: string | null = null,
): void {
  db.transaction(() => {
    applyTyped(db, changes);
    for (const r of changes.users ?? []) {
      // A new PIN from the server clears this person's lock here: the lock protected the old PIN (W1-04 plan).
      const before = db.selectObjects('SELECT pin_verifier FROM users WHERE id = ?', [required(r, 'id')])[0];
      if (before && text(before['pin_verifier']) !== text(r['pin_verifier']))
        db.exec('DELETE FROM pin_state WHERE user_id = ?', [required(r, 'id')]);
      db.exec(
        `INSERT INTO users (id, username, full_name, short_code, pin_verifier, pin_must_change, status, row_version, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET username = excluded.username, full_name = excluded.full_name,
           short_code = excluded.short_code, pin_verifier = excluded.pin_verifier,
           pin_must_change = excluded.pin_must_change, status = excluded.status,
           row_version = excluded.row_version, deleted_at = excluded.deleted_at`,
        [
          required(r, 'id'),
          required(r, 'username'),
          required(r, 'full_name'),
          text(r['short_code']),
          text(r['pin_verifier']),
          r['pin_must_change'] ? 1 : 0,
          required(r, 'status'),
          required(r, 'row_version'),
          text(r['deleted_at']),
        ],
      );
    }
    for (const r of changes.roles ?? []) {
      db.exec(
        `INSERT INTO roles (id, name, template_key, permissions, limits, row_version, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, template_key = excluded.template_key,
           permissions = excluded.permissions, limits = excluded.limits, row_version = excluded.row_version,
           deleted_at = excluded.deleted_at`,
        [
          required(r, 'id'),
          required(r, 'name'),
          text(r['template_key']),
          JSON.stringify(r['permissions'] ?? []),
          JSON.stringify(r['limits'] ?? {}),
          required(r, 'row_version'),
          text(r['deleted_at']),
        ],
      );
    }
    for (const r of changes.user_roles ?? []) {
      db.exec(
        `INSERT INTO user_roles (id, user_id, role_id, branch_id, row_version, deleted_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, role_id = excluded.role_id,
           branch_id = excluded.branch_id, row_version = excluded.row_version, deleted_at = excluded.deleted_at`,
        [
          required(r, 'id'),
          required(r, 'user_id'),
          required(r, 'role_id'),
          text(r['branch_id']),
          required(r, 'row_version'),
          text(r['deleted_at']),
        ],
      );
    }
    for (const [table, rows] of [
      ['tenant', changes.tenant],
      ['branch', changes.branch],
    ] as const) {
      for (const r of rows ?? []) {
        db.exec(
          `INSERT INTO ${table} (id, data, row_version, deleted_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET data = excluded.data, row_version = excluded.row_version,
             deleted_at = excluded.deleted_at`,
          [required(r, 'id'), JSON.stringify(r), required(r, 'row_version'), text(r['deleted_at'])],
        );
      }
    }
    setSync(db, 'pull_cursor', cursor);
    const at = now();
    setSync(db, 'last_pull_at', at);
    // What the offline warnings count from (SYN-06): any successful push or pull.
    setSync(db, 'last_contact_at', at);
    if (done) setSync(db, 'pull_complete_at', now());
    if (done && startedAt !== null) setSync(db, 'complete_pull_started_at', startedAt);
  });
}

export const listStaff = (db: SqlDb): StaffUser[] =>
  db
    .selectObjects(
      'SELECT id, full_name, short_code, pin_verifier, pin_must_change, status, deleted_at FROM users ORDER BY id',
    )
    .map((r) => ({
      id: String(r['id']),
      fullName: String(r['full_name']),
      shortCode: text(r['short_code']),
      pinVerifier: text(r['pin_verifier']),
      pinMustChange: Number(r['pin_must_change']) === 1,
      status: String(r['status']),
      deletedAt: text(r['deleted_at']),
    }));

export interface TenantSettings {
  name: string;
  closingTime: string;
  timeZone: string;
  /** For formatting numbers, money and dates (CLAUDE.md rule 10). */
  locale: string;
  currency: string;
  minorUnits: number;
  /** Hours without reaching the server before the warning and the strong warning (SYN-06, W1-07). */
  offlineWarningHours: number;
  offlineStrongWarningHours: number;
}

export function tenantSettings(db: SqlDb): TenantSettings | null {
  const data = text(db.selectValue('SELECT data FROM tenant WHERE deleted_at IS NULL LIMIT 1'));
  if (!data) return null;
  const t = JSON.parse(data) as Record<string, unknown>;
  return {
    name: str(t['name']),
    closingTime: str(t['closing_time']),
    timeZone: str(t['timezone']),
    locale: str(t['locale'] ?? 'en'),
    currency: str(t['base_currency'] ?? 'PKR'),
    minorUnits: Number(t['currency_minor_units'] ?? 2),
    // The PRD's defaults until the tenant row carries them (pulled before W1-07).
    offlineWarningHours: Number(t['offline_warning_hours'] ?? 8),
    offlineStrongWarningHours: Number(t['offline_strong_warning_hours'] ?? 48),
  };
}

export function getPinState(db: SqlDb, userId: string): PinState {
  const [r] = db.selectObjects('SELECT failures, locked FROM pin_state WHERE user_id = ?', [userId]);
  return r
    ? { failures: Number(r['failures']), locked: Number(r['locked']) === 1 }
    : { failures: 0, locked: false };
}

export const setPinState = (db: SqlDb, userId: string, s: PinState): void =>
  db.exec(
    `INSERT INTO pin_state (user_id, failures, locked, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET failures = excluded.failures, locked = excluded.locked, updated_at = excluded.updated_at`,
    [userId, s.failures, s.locked ? 1 : 0, now()],
  );

export interface PinEvent {
  id: string;
  kind: 'locked' | 'unlocked';
  userId: string;
  /** Who unlocked them (a manager); null for a lock. */
  byUserId: string | null;
  at: string;
  pushedAt: string | null;
}

/** A lock or a manager unlock, kept for the server's audit log (pushed with W1-07). */
export const recordPinEvent = (db: SqlDb, e: Omit<PinEvent, 'id' | 'pushedAt'>): void =>
  db.exec('INSERT INTO pin_events (id, kind, user_id, by_user_id, at) VALUES (?, ?, ?, ?, ?)', [
    uuidv7(Date.parse(e.at)),
    e.kind,
    e.userId,
    e.byUserId,
    e.at,
  ]);

export const listPinEvents = (db: SqlDb): PinEvent[] =>
  db
    .selectObjects('SELECT id, kind, user_id, by_user_id, at, pushed_at FROM pin_events ORDER BY at, id')
    .map((r) => ({
      id: String(r['id']),
      kind: String(r['kind']) as PinEvent['kind'],
      userId: String(r['user_id']),
      byUserId: text(r['by_user_id']),
      at: String(r['at']),
      pushedAt: text(r['pushed_at']),
    }));

/** A person's roles on this counter, from the pulled roles (D-081), for checks like the manager unlock. */
export const grantsFor = (db: SqlDb, userId: string): RoleGrant[] =>
  db
    .selectObjects(
      `SELECT r.permissions, r.limits, ur.branch_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = ? AND ur.deleted_at IS NULL AND r.deleted_at IS NULL ORDER BY ur.id`,
      [userId],
    )
    .map((r) => ({
      permissions: JSON.parse(String(r['permissions'])) as string[],
      limits: JSON.parse(String(r['limits'])) as RoleLimits,
      branchId: text(r['branch_id']),
    }));

/** Unsynced documents: how many, and when the oldest was made (POS spec §7). */
export function outboxStats(db: SqlDb): { count: number; oldestAt: string | null } {
  const [r] = db.selectObjects('SELECT count(*) AS n, min(created_at) AS oldest FROM outbox');
  return { count: Number(r?.['n'] ?? 0), oldestAt: text(r?.['oldest']) };
}

/** Saves a person's open bill on this counter (POS spec §10): one per person, replaced on every change. */
export const saveOpenBill = (db: SqlDb, userId: string, bill: OpenBill): void =>
  db.exec(
    `INSERT INTO open_bills (user_id, bill, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET bill = excluded.bill, updated_at = excluded.updated_at`,
    [userId, JSON.stringify(bill), now()],
  );

/** A person's open bill, or null. One this version can't read is set aside in the diagnostic log, never crashed on. */
export function loadOpenBill(db: SqlDb, userId: string): OpenBill | null {
  const stored = text(db.selectValue('SELECT bill FROM open_bills WHERE user_id = ?', [userId]));
  if (stored === null) return null;
  const bill = parseOpenBill(stored);
  if (bill) return bill;
  db.transaction(() => {
    log(db, 'bill.set_aside', { userId, bill: stored });
    clearOpenBill(db, userId);
  });
  return null;
}

export const clearOpenBill = (db: SqlDb, userId: string): void =>
  db.exec('DELETE FROM open_bills WHERE user_id = ?', [userId]);

const LOG_KEEP = 5000;

/** One diagnostic event (architecture §11.3); keeps the last 5,000. */
export function log(db: SqlDb, kind: string, detail: Record<string, unknown>): void {
  db.exec('INSERT INTO diagnostic_log (at, kind, detail) VALUES (?, ?, ?)', [
    now(),
    kind,
    JSON.stringify(detail),
  ]);
  db.exec('DELETE FROM diagnostic_log WHERE id <= (SELECT max(id) FROM diagnostic_log) - ?', [LOG_KEEP]);
}
