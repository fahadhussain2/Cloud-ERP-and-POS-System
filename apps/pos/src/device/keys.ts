import type { KeyStore } from './session';

// The counter's key pair in IndexedDB (D-082): a CryptoKey is stored as it is, and its private half stays
// non-extractable, so it can sign here but never be read out.

const DB = 'erp-pos-keys';
const STORE = 'keys';
const KEY = 'device';

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB failed'));
  });

const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB failed'));
    });
  } finally {
    db.close();
  }
};

export const indexedDbKeys = (): KeyStore => ({
  get: async () => (await run<CryptoKeyPair | undefined>('readonly', (s) => s.get(KEY))) ?? null,
  put: async (pair) => {
    await run('readwrite', (s) => s.put(pair, KEY));
  },
});
