import { signCanonical } from '@erp/contracts';

import type { Counter } from './counter';
import { createDbClient } from './db/client';
import { indexedDbKeys } from './device/keys';
import { createTokenSource, enroll } from './device/session';
import { httpApi } from './net/api';
import { printBill } from './print/print-bill';
import { browserStorage, runStorageChecks } from './storage/checks';
import { changePin } from './sync/pin';
import { pullAll, type PullResult } from './sync/pull';

// The real counter: the database worker, the key in IndexedDB and the API on the same origin (D-065).

export function browserCounter(): Counter {
  const db = createDbClient();
  const keys = indexedDbKeys();
  const api = httpApi();
  const tokens = createTokenSource({ api, keys, device: () => db.getDevice() });
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
    staff: () => db.listStaff(),
    settings: () => db.tenantSettings(),
    getPinState: (id) => db.getPinState(id),
    setPinState: (id, s) => db.setPinState(id, s),
    verifyPin: (verifier, pin) => db.verifyPin(verifier, pin),
    grants: (userId) => db.grantsFor(userId),
    recordPinEvent: (e) => db.recordPinEvent(e),
    changePin: (body) => changePin({ api, tokens }, body),
    status: async () => {
      const [outbox, lastSyncAt] = await Promise.all([db.outboxStats(), db.getSync('last_pull_at')]);
      return { outboxCount: outbox.count, lastSyncAt };
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
          const pair = await keys.get();
          if (!pair) throw new Error('no device key');
          await db.setSignature(r.document.id, await signCanonical(pair.privateKey, r.document));
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
