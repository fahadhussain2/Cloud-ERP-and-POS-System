import { signCanonical, SYNC_EVENTS, type DeviceHealth } from '@erp/contracts';

import type { Counter } from './counter';
import { createDbClient } from './db/client';
import { LATEST_VERSION } from './db/migrate';
import { indexedDbKeys } from './device/keys';
import { createTokenSource, enroll } from './device/session';
import { httpApi } from './net/api';
import { printBill } from './print/print-bill';
import { browserStorage, runStorageChecks } from './storage/checks';
import { openEventStream } from './sync/events';
import { changePin } from './sync/pin';
import { pullAll, type PullResult } from './sync/pull';
import { pushAll, type PushOutcome } from './sync/push';
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
  // One pull at a time: the first catalog load takes longer than the 60-second timer (W1-03). A caller joining a
  // running pull still hears about its remaining pages.
  let pulling: Promise<PullResult> | null = null;
  const listeners = new Set<() => void>();
  const pullOnce = async () => {
    const started = Date.now();
    const r = await pullAll({
      api,
      tokens,
      cursor: () => db.getSync('pull_cursor'),
      apply: (changes, cursor, done) => db.applyPull(changes, cursor, done),
      onPage: () => listeners.forEach((l) => l()),
    });
    await db.log('sync.pull', { ...r, ms: Date.now() - started });
    return r;
  };
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
      pulling ??= pullOnce().finally(() => {
        pulling = null;
        listeners.clear();
      });
      return pulling;
    },
    push: () =>
      (pushing ??= pushOnce().finally(() => {
        pushing = null;
      })),
    listen: (h) => {
      const stream = openEventStream({
        fetchFn: (input, init) => fetch(input, init),
        tokens,
        onEvent: (name) => {
          if (name === SYNC_EVENTS.changesAvailable) h.onChanges();
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
    checkout: () => db.checkoutSettings(),
    finalize: async (req) => {
      const r = await db.finalizeSale(req);
      // After the commit (POS spec §12): a failed signature leaves the row unsigned, and push signs it (W1-07).
      if (!r.repeated)
        try {
          await db.setSignature(r.document.id, await sign(r.document));
        } catch (err) {
          await db.log('bill.sign_failed', { documentId: r.document.id, error: String(err) });
        }
      return r;
    },
    recentBills: (since, filter) => db.recentDocuments(since, filter),
    bill: (id) => db.loadDocument(id),
    recordReprint: (r) => db.recordReprint(r),
    print: (job) => printBill(job),
  };
}
