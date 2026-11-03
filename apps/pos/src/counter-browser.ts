import { signCanonical, SYNC_EVENTS, uuidv7, type DeviceHealth } from '@erp/contracts';

import type { Counter } from './counter';
import { createDbClient } from './db/client';
import { LATEST_VERSION } from './db/migrate';
import { indexedDbKeys } from './device/keys';
import { createTokenSource, enroll } from './device/session';
import { httpApi } from './net/api';
import { printDeskSlip } from './print/DeskSlipPrint';
import { printBill } from './print/print-bill';
import { checkDesk } from './sync/bills';
import { browserStorage, runStorageChecks } from './storage/checks';
import { openEventStream } from './sync/events';
import { changePin } from './sync/pin';
import { datasetsFor, pullAll, type PullResult } from './sync/pull';
import { pushAll, type PushOutcome } from './sync/push';
import { singleFlight } from './sync/single-flight';
import { CLIENT_VERSION } from './version';

// The real counter: the database worker, the key in IndexedDB and the API on the same origin (D-065).

/** What the browser says of this origin's storage (PLT-09); nothing when it can't. */
async function storageFigures(): Promise<
  Pick<DeviceHealth, 'storagePersisted' | 'storageUsage' | 'storageQuota'>
> {
  try {
    const [persisted, estimate] = await Promise.all([
      navigator.storage.persisted(),
      navigator.storage.estimate(),
    ]);
    return {
      storagePersisted: persisted,
      storageUsage: estimate.usage ?? null,
      storageQuota: estimate.quota ?? null,
    };
  } catch {
    return { storagePersisted: false, storageUsage: null, storageQuota: null };
  }
}

export function browserCounter(): Counter {
  const db = createDbClient();
  const keys = indexedDbKeys();
  const api = httpApi();
  const tokens = createTokenSource({ api, keys, device: () => db.getDevice() });
  const sign = async (payload: unknown) => {
    const pair = await keys.get();
    if (!pair) throw new Error('no device key');
    return signCanonical(pair.privateKey, payload);
  };
  /**
   * Signs a document already committed with its outbox row (POS spec §12): a failed signature leaves the row unsigned,
   * and push signs it (W1-07).
   */
  const signStored = async <D extends { id: string }>(doc: D): Promise<D> => {
    try {
      await db.setSignature(doc.id, await sign(doc));
    } catch (err) {
      await db.log('document.sign_failed', { documentId: doc.id, error: String(err) });
    }
    return doc;
  };
  /** What every document made here carries: its UUIDv7, this PC's clock and the app version. */
  const made = () => {
    const createdAtMs = Date.now();
    return { id: uuidv7(createdAtMs), createdAtMs, clientVersion: CLIENT_VERSION };
  };
  // One pull at a time: the first catalog load takes longer than the 60-second timer (W1-03). A pull asked for while
  // one runs (a nudge for a new bill) gets one more pull after it, never a share of one that may have passed the
  // change; callers hear about the pages until the pulls stop.
  const listeners = new Set<() => void>();
  const pullOnce = async () => {
    const started = Date.now();
    const device = await db.getDevice();
    const r = await pullAll({
      api,
      tokens,
      // A cash desk also pulls its queue (W1-10); a counter isn't sent it.
      datasets: datasetsFor(device?.kind ?? 'counter'),
      cursor: () => db.getSync('pull_cursor'),
      apply: (changes, cursor, done, startedAt) => db.applyPull(changes, cursor, done, startedAt),
      onPage: () => listeners.forEach((l) => l()),
    });
    await db.log('sync.pull', { ...r, ms: Date.now() - started });
    return r;
  };
  const pullFlight = singleFlight<PullResult>(
    () => pullOnce(),
    () => listeners.clear(),
  );
  // One push at a time too (sync spec §6.2); the scheduler in the app decides when.
  let pushing: Promise<PushOutcome> | null = null;
  const pushOnce = async () => {
    const started = Date.now();
    const r = await pushAll({
      api,
      tokens,
      outbox: {
        batch: () => db.outboxBatch(),
        setSignature: (id, signature) => db.setSignature(id, signature),
        ack: (results, at) => db.ackPush(results, at),
        requeue: (series) => db.requeue(series),
        events: () => db.pendingEvents(),
        ackEvents: (ids, at) => db.ackEvents(ids, at),
        health: async () => {
          const [local, storage] = await Promise.all([db.localHealth(), storageFigures()]);
          return {
            outboxCount: local.outboxCount,
            oldestUnsyncedAt: local.oldestUnsyncedAt,
            quarantinedCount: local.quarantinedCount,
            lastPullAt: local.lastPullAt,
            ...storage,
          };
        },
      },
      sign,
      clientVersion: CLIENT_VERSION,
      schemaVersion: LATEST_VERSION,
      now: () => new Date(),
    });
    if (r.ok) await db.setSync('server_clock_offset_ms', String(Date.parse(r.serverTime) - Date.now()));
    await db.log('sync.push', { ...r, ms: Date.now() - started });
    return r;
  };
  return {
    checkStorage: () => runStorageChecks({ ...browserStorage(), openDatabase: () => db.open() }),
    device: () => db.getDevice(),
    enroll: (input) => enroll(input, { api, keys, setDevice: (d) => db.setDevice(d) }),
    pull: (onPage) => {
      if (onPage) listeners.add(onPage);
      return pullFlight();
    },
    push: () =>
      (pushing ??= pushOnce().finally(() => {
        pushing = null;
      })),
    listen: (h) => {
      const stream = openEventStream({
        fetchFn: (input, init) => fetch(input, init),
        tokens,
        // A cash desk's `queue-changed` pulls like any nudge: the queue is one of its datasets (W1-10).
        onEvent: (name) => {
          if (name === SYNC_EVENTS.changesAvailable || name === SYNC_EVENTS.queueChanged) h.onChanges();
        },
        onConnected: h.onConnected,
      });
      return () => stream.close();
    },
    health: async () => {
      const [local, storage, offset] = await Promise.all([
        db.localHealth(),
        storageFigures(),
        db.getSync('server_clock_offset_ms'),
      ]);
      return {
        ...local,
        ...storage,
        appVersion: CLIENT_VERSION,
        schemaVersion: LATEST_VERSION,
        serverOffsetMs: offset === null ? null : Number(offset),
      };
    },
    needsAttention: () => db.quarantinedRows(),
    retryBill: (id) => db.retryQuarantined(id),
    prune: () => db.pruneDocuments(),
    staff: () => db.listStaff(),
    settings: () => db.tenantSettings(),
    getPinState: (id) => db.getPinState(id),
    setPinState: (id, s) => db.setPinState(id, s),
    verifyPin: (verifier, pin) => db.verifyPin(verifier, pin),
    grants: (userId) => db.grantsFor(userId),
    recordPinEvent: (e) => db.recordPinEvent(e),
    changePin: (body) => changePin({ api, tokens }, body),
    status: async () => {
      const [local, lastSyncAt] = await Promise.all([db.localHealth(), db.getSync('last_pull_at')]);
      return {
        outboxCount: local.outboxCount,
        lastSyncAt,
        lastContactAt: local.lastContactAt,
        attention: local.quarantinedCount,
      };
    },
    log: (kind, detail) => db.log(kind, detail),
    search: (text, opts) => db.search(text, opts),
    catalog: () => db.catalogStatus(),
    tiers: () => db.tiers(),
    billItem: (itemId, tierId) => db.billItem(itemId, tierId),
    tierPrices: (itemIds, tierId) => db.tierPrices(itemIds, tierId),
    openBill: (userId) => db.loadOpenBill(userId),
    saveOpenBill: (userId, bill) => db.saveOpenBill(userId, bill),
    clearOpenBill: (userId) => db.clearOpenBill(userId),
    holdBill: (req) => db.holdBill({ ...req, id: uuidv7(), atMs: Date.now() }),
    heldBills: (userId) => db.heldBills(userId),
    recallBill: (req) =>
      db.recallBill({
        id: req.id,
        userId: req.userId,
        holdCurrent: req.swap && { id: uuidv7(), label: req.swap.label, atMs: Date.now() },
      }),
    clearHeld: (id, userId) => db.clearHeld(id, userId),
    checkout: () => db.checkoutSettings(),
    finalize: async (req) => {
      const r = await db.finalizeSale(req);
      if (!r.repeated) await signStored(r.document);
      if (r.handover) await signStored(r.handover);
      return r;
    },
    voidableBills: (filter) => db.voidableBills(filter),
    deskCheck: async (billNumber) => {
      const local = await db.localDeskStatus(billNumber);
      return local !== null
        ? { status: local, at: null, cashierName: null }
        : checkDesk({ api, tokens }, billNumber);
    },
    voidBill: async (req) => {
      const r = await db.voidBill({ ...req, ...made() });
      await signStored(r.void);
      return r;
    },
    voidOf: (saleId) => db.voidOf(saleId),
    recentBills: (since, filter) => db.recentDocuments(since, filter),
    bill: (id) => db.loadDocument(id),
    recordReprint: (r) => db.recordReprint(r),
    customers: () => db.customers(),
    creditFigures: (customerId, offline) => db.creditFigures(customerId, offline),
    print: (job) => printBill(job),
    deskState: () => db.deskState(),
    openSession: async (req) => signStored(await db.openSession({ ...req, ...made() })),
    closeSession: async (req) => signStored(await db.closeSession({ ...req, ...made() })),
    confirmHandover: async (req) => signStored(await db.confirmHandover({ ...req, ...made() })),
    deskLookups: () => db.deskLookups(),
    deskCustomer: (partyId) => db.deskCustomer(partyId),
    receiveCollection: async (req) => signStored(await db.receiveCollection({ ...req, ...made() })),
    recordCashMovement: async (req) => signStored(await db.recordCashMovement({ ...req, ...made() })),
    printDesk: (job) => printDeskSlip(job),
  };
}
