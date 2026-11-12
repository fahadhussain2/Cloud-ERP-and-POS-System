import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createChangeFeed } from './listen';
import { createTestDatabase, type TestDatabase } from './testing/database';

// The change feed's connection after it is handed back (sync spec §8, W1-07; CI failure on PR #84): once closed, the
// feed must not touch that connection again, whatever later happens to it.

let db: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
});

afterAll(async () => {
  await admin?.end();
  await db?.drop();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createChangeFeed', () => {
  it('leaves a connection it handed back alone when the server later ends it', async () => {
    const pool = new pg.Pool({ connectionString: db.appUrl, max: 2 });
    // The pool reports an idle connection's end as an error; that one is expected here.
    pool.on('error', () => undefined);
    const uncaught: unknown[] = [];
    const record = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', record);
    try {
      const feed = createChangeFeed(pool, { retryMs: 50 });
      feed.subscribe('00000000-0000-7000-8000-000000000001', () => undefined);
      for (let i = 0; i < 50 && pool.totalCount === 0; i += 1) await wait(20);
      await wait(100);
      await feed.close();
      // The connection now sits idle in the pool; the server ends it.
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND usename = 'erp_app'",
        [db.name],
      );
      await wait(300);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', record);
      await pool.end().catch(() => undefined);
    }
  });
});
