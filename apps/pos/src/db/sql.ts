import type { BindingSpec, Database } from '@sqlite.org/sqlite-wasm';

// The small SQL surface the counter's code uses (POS spec §1), so the same code runs on OPFS in the worker and on
// an in-memory database in tests.

export type Bind = readonly (string | number | bigint | null | Uint8Array)[];

export interface SqlDb {
  exec(sql: string, bind?: Bind): void;
  selectValue(sql: string, bind?: Bind): unknown;
  selectObjects(sql: string, bind?: Bind): Record<string, unknown>[];
  /** Runs `fn` in one transaction: committed if it returns, rolled back if it throws. */
  transaction<T>(fn: () => T): T;
}

export function wrapOo1(db: Database): SqlDb {
  const spec = (bind?: Bind) => bind as BindingSpec | undefined;
  return {
    exec(sql, bind) {
      if (bind === undefined) db.exec(sql);
      else db.exec({ sql, bind });
    },
    selectValue: (sql, bind) => db.selectValue(sql, spec(bind)),
    selectObjects: (sql, bind) => db.selectObjects(sql, spec(bind)),
    transaction: <T>(fn: () => T): T => db.transaction((): T => fn()),
  };
}
