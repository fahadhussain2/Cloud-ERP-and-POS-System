import type { Counter } from './counter';
import { createDbClient } from './db/client';
import { indexedDbKeys } from './device/keys';
import { createTokenSource, enroll } from './device/session';
import { httpApi } from './net/api';
import { browserStorage, runStorageChecks } from './storage/checks';
import { changePin } from './sync/pin';
import { pullAll } from './sync/pull';

// The real counter: the database worker, the key in IndexedDB and the API on the same origin (D-065).

export function browserCounter(): Counter {
  const db = createDbClient();
  const keys = indexedDbKeys();
  const api = httpApi();
  const tokens = createTokenSource({ api, keys, device: () => db.getDevice() });
  return {
    checkStorage: () => runStorageChecks({ ...browserStorage(), openDatabase: () => db.open() }),
    device: () => db.getDevice(),
    enroll: (input) => enroll(input, { api, keys, setDevice: (d) => db.setDevice(d) }),
    pull: async () => {
      const r = await pullAll({
        api,
        tokens,
        cursor: () => db.getSync('pull_cursor'),
        apply: (changes, cursor) => db.applyPull(changes, cursor),
      });
      await db.log('sync.pull', r);
      return r;
    },
    staff: () => db.listStaff(),
    settings: () => db.tenantSettings(),
    getPinState: (id) => db.getPinState(id),
    setPinState: (id, s) => db.setPinState(id, s),
    verifyPin: (verifier, pin) => db.verifyPin(verifier, pin),
    changePin: (body) => changePin({ api, tokens }, body),
    status: async () => {
      const [outbox, lastSyncAt] = await Promise.all([db.outboxStats(), db.getSync('last_pull_at')]);
      return { outboxCount: outbox.count, lastSyncAt };
    },
    log: (kind, detail) => db.log(kind, detail),
  };
}
