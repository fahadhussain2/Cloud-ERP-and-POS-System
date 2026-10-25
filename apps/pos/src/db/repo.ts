import type { PullResponse } from '@erp/contracts';
import type { PinState } from '@erp/domain';

import type { StaffUser } from '../unlock/unlock';
import type { SqlDb } from './sql';

// The counter's data access (POS spec §1, §5, sync spec §4, D-089). Runs in the database worker.

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

/** One pulled page and its cursor, in one transaction: a crash never leaves the cursor ahead of the data. */
export function applyPull(db: SqlDb, changes: PullResponse['changes'], cursor: string): void {
  db.transaction(() => {
    for (const r of changes.users ?? []) {
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
    setSync(db, 'last_pull_at', now());
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

export function tenantSettings(db: SqlDb): { name: string; closingTime: string; timeZone: string } | null {
  const data = text(db.selectValue('SELECT data FROM tenant WHERE deleted_at IS NULL LIMIT 1'));
  if (!data) return null;
  const t = JSON.parse(data) as Record<string, unknown>;
  return { name: String(t['name']), closingTime: String(t['closing_time']), timeZone: String(t['timezone']) };
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

/** Unsynced documents: how many, and when the oldest was made (POS spec §7). */
export function outboxStats(db: SqlDb): { count: number; oldestAt: string | null } {
  const [r] = db.selectObjects('SELECT count(*) AS n, min(created_at) AS oldest FROM outbox');
  return { count: Number(r?.['n'] ?? 0), oldestAt: text(r?.['oldest']) };
}

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
