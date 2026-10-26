/// <reference lib="webworker" />
import { verifyPin } from '@erp/contracts';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { SearchIndex, type SearchOptions } from '../search/search-index';
import { currentVersion, migrate } from './migrate';
import * as repo from './repo';
import { wrapOo1, type SqlDb } from './sql';

// The only code that touches the counter's database (POS spec §1, D-039, D-089): SQLite WASM on OPFS with the
// opfs-sahpool VFS, in this dedicated worker. The UI calls the operations below through client.ts. The search index
// (POS spec §9) lives here too: loaded once from the local catalog, patched with every pulled page.

let db: SqlDb | null = null;
const index = new SearchIndex();
let indexLoaded = false;

const open = (): SqlDb => {
  if (!db) throw new Error('the database is not open');
  return db;
};

const ops = {
  /** Opens the database, migrates it and reports its health (POS spec §3). */
  open: async () => {
    if (!db) {
      const sqlite3 = await sqlite3InitModule();
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'erp-pos' });
      db = wrapOo1(new pool.OpfsSAHPoolDb('/erp-pos.sqlite3'));
    }
    const quickCheck = String(db.selectValue('PRAGMA quick_check'));
    if (quickCheck !== 'ok') return { schemaVersion: currentVersion(db), quickCheck, outboxCount: null };
    const schemaVersion = migrate(db);
    let outboxCount: number | null;
    try {
      outboxCount = repo.outboxStats(db).count;
    } catch {
      outboxCount = null;
    }
    repo.log(db, 'storage.checked', { schemaVersion, quickCheck, outboxCount });
    if (!indexLoaded) {
      const started = performance.now();
      index.apply(repo.loadCatalog(db));
      indexLoaded = true;
      repo.log(db, 'search.loaded', { items: index.size, ms: Math.round(performance.now() - started) });
    }
    return { schemaVersion, quickCheck, outboxCount };
  },
  getDevice: () => repo.getDevice(open()),
  setDevice: (d: repo.DeviceInfo) => repo.setDevice(open(), d),
  getSync: (key: string) => repo.getSync(open(), key),
  setSync: (key: string, value: string) => repo.setSync(open(), key, value),
  /** A pulled page: stored with its cursor, then patched into the search index. */
  applyPull: (...args: Parameters<typeof repo.applyPull> extends [unknown, ...infer R] ? R : never) => {
    repo.applyPull(open(), ...args);
    index.apply(args[0]);
  },
  search: (text: string, opts?: SearchOptions) => index.search(text, opts),
  /** Items in the index, and whether a complete pull has loaded the catalog (POS spec §9). */
  catalogStatus: () => ({ items: index.size, ready: repo.getSync(open(), 'pull_complete_at') !== null }),
  listStaff: () => repo.listStaff(open()),
  tenantSettings: () => repo.tenantSettings(open()),
  getPinState: (userId: string) => repo.getPinState(open(), userId),
  setPinState: (...args: Parameters<typeof repo.setPinState> extends [unknown, ...infer R] ? R : never) =>
    repo.setPinState(open(), ...args),
  outboxStats: () => repo.outboxStats(open()),
  log: (kind: string, detail: Record<string, unknown>) => repo.log(open(), kind, detail),
  /** PBKDF2 with 600k iterations (W0-10): run here, so the UI stays responsive. */
  verifyPin: (verifier: string, pin: string) => verifyPin(verifier, pin),
};

export type DbOps = typeof ops;

interface Request {
  id: number;
  op: keyof DbOps;
  args: unknown[];
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, op, args } = event.data;
  try {
    const fn = ops[op] as (...a: unknown[]) => unknown;
    self.postMessage({ id, ok: true, result: await fn(...args) });
  } catch (err) {
    const e = err as Error;
    self.postMessage({ id, ok: false, error: { name: e.name, message: e.message } });
  }
};
