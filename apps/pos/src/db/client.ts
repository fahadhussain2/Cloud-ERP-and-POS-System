import { DomainError, type DomainErrorCode } from '@erp/domain';

import type { DbOps } from './worker';

// The UI's handle on the database worker (POS spec §1): each operation is a promise of its result. Errors come back
// with their name, so the storage checks can tell "too new" from "unavailable", and a broken checkout rule comes back
// as a DomainError with its code.

type Promisified<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
};

export type DbClient = Promisified<DbOps>;

interface Reply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { name: string; message: string; code?: string };
}

export function createDbClient(): DbClient {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 1;
  worker.onmessage = (event: MessageEvent<Reply>) => {
    const { id, ok, result, error } = event.data;
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    if (ok) w.resolve(result);
    else if (error?.name === 'DomainError' && error.code)
      w.reject(new DomainError(error.code as DomainErrorCode, error.message));
    else
      w.reject(
        Object.assign(new Error(error?.message ?? 'database error'), { name: error?.name ?? 'Error' }),
      );
  };
  return new Proxy({} as DbClient, {
    get:
      (_target, op: string) =>
      (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = next++;
          waiting.set(id, { resolve, reject });
          worker.postMessage({ id, op, args });
        }),
  });
}
