/// <reference lib="webworker" />
import { verifyPin, type PushResult, type SeriesState } from '@erp/contracts';
import { businessDate, type Money } from '@erp/domain';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import type { OpenBill } from '../bill/open-bill';
import { SearchIndex, type SearchOptions } from '../search/search-index';
import * as checkout from './checkout';
import * as customers from './customers';
import * as desk from './desk';
import { currentVersion, migrate } from './migrate';
import * as outbox from './outbox';
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
      index.warm();
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
    // After the last page of a pull, not each page: a first load is ~125 pages.
    if (args[2]) index.warm();
  },
  search: (text: string, opts?: SearchOptions) => index.search(text, opts),
  /** The bill (POS spec §10): what a line takes from the catalog, the tiers, and each person's open bill. */
  tiers: () => index.tiers(),
  billItem: (itemId: string, tierId: string | null) => index.billItem(itemId, tierId),
  tierPrices: (itemIds: string[], tierId: string) => index.tierPrices(itemIds, tierId),
  loadOpenBill: (userId: string) => repo.loadOpenBill(open(), userId),
  saveOpenBill: (userId: string, bill: OpenBill) => repo.saveOpenBill(open(), userId, bill),
  clearOpenBill: (userId: string) => repo.clearOpenBill(open(), userId),
  /** Paying, finalizing and reprinting (POS spec §12–§13). */
  checkoutSettings: () => checkout.checkoutSettings(open()),
  finalizeSale: (req: checkout.FinalizeRequest) => checkout.finalizeSale(open(), req),
  setSignature: (documentId: string, signature: string) =>
    checkout.setSignature(open(), documentId, signature),
  recentDocuments: (since: string, filter: string) => checkout.recentDocuments(open(), since, filter),
  loadDocument: (id: string) => checkout.loadDocument(open(), id),
  recordReprint: (r: Omit<checkout.Reprint, 'id' | 'pushedAt'>) => checkout.recordReprint(open(), r),
  /** Customers and credit (POS spec §15, W1-09). */
  customers: () => customers.listCustomers(open()),
  /** The figures the On account popup shows, for today's business date: the same ones finalize uses. */
  creditFigures: (customerId: string, offline: boolean) => {
    const s = checkout.checkoutSettings(open());
    if (s === null) throw new Error('this counter is not set up yet');
    const today = businessDate(Date.now(), s.timeZone, s.cutoffHour);
    return customers.creditFigures(open(), customerId, offline, today);
  },
  /** The cash desk (W1-10): its session, the pulled queue, its handovers; each write is one transaction. */
  deskState: () => desk.deskState(open()),
  openSession: (req: desk.DeskRequest & { openingFloat: Money }) => desk.openSession(open(), req),
  closeSession: (req: desk.DeskRequest) => desk.closeSession(open(), req),
  confirmHandover: (req: desk.HandoverRequest) => desk.confirmHandover(open(), req),
  /** Push (sync spec §6.2–§7, W1-07): the outbox, the answer, re-queue after a restore, audit events, health. */
  outboxBatch: () => outbox.outboxBatch(open()),
  ackPush: (results: PushResult[], at: string) => outbox.ackPush(open(), results, at),
  requeue: (series: SeriesState[]) => outbox.requeue(open(), series, Date.now()),
  pendingEvents: () => outbox.pendingEvents(open()),
  ackEvents: (ids: string[], at: string) => outbox.ackEvents(open(), ids, at),
  localHealth: () => outbox.localHealth(open()),
  quarantinedRows: () => outbox.quarantinedRows(open()),
  retryQuarantined: (id: string) => outbox.retryQuarantined(open(), id),
  pruneDocuments: () => outbox.pruneDocuments(open(), Date.now()),
  /** Items in the index, and whether a complete pull has loaded the catalog (POS spec §9). */
  catalogStatus: () => ({ items: index.size, ready: repo.getSync(open(), 'pull_complete_at') !== null }),
  listStaff: () => repo.listStaff(open()),
  tenantSettings: () => repo.tenantSettings(open()),
  getPinState: (userId: string) => repo.getPinState(open(), userId),
  setPinState: (...args: Parameters<typeof repo.setPinState> extends [unknown, ...infer R] ? R : never) =>
    repo.setPinState(open(), ...args),
  grantsFor: (userId: string) => repo.grantsFor(open(), userId),
  recordPinEvent: (e: Omit<repo.PinEvent, 'id' | 'pushedAt'>) => repo.recordPinEvent(open(), e),
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
    const e = err as Error & { code?: unknown };
    // A broken checkout rule keeps its code, so the screen can say which (DomainError).
    const code = typeof e.code === 'string' ? e.code : undefined;
    self.postMessage({ id, ok: false, error: { name: e.name, message: e.message, code } });
  }
};
