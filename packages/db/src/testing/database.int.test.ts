import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { createTestDatabase } from './database';

// Dropping a test database (CI run 42361860962, PR #116): `pool.end()` resolves before its connections have closed,
// so an afterAll that ends its pool and then drops the database could kill a connection still closing. pg emits
// that FATAL (57P01, "terminating connection due to administrator command") on a client nothing listens to any
// more, and Vitest fails the whole run on the unhandled error. drop() must let the test's connections close first.

describe('dropping a test database', () => {
  it('waits for a connection that is still closing instead of terminating it', async () => {
    const db = await createTestDatabase();
    const client = new pg.Client({ connectionString: db.appUrl });
    const errors: unknown[] = [];
    client.on('error', (err) => errors.push(err));
    await client.connect();
    await client.query('SELECT 1');

    const dropping = db.drop();
    // The connection closes a moment after the drop has started, as a pool's last clients do.
    await new Promise((r) => setTimeout(r, 300));
    await client.end();
    await dropping;

    expect(errors).toEqual([]);
    const admin = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
    await admin.connect();
    try {
      const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db.name]);
      expect(rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it('still drops the database when a connection never closes', async () => {
    const db = await createTestDatabase();
    const client = new pg.Client({ connectionString: db.appUrl });
    client.on('error', () => undefined);
    await client.connect();
    await db.drop();
    const admin = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
    await admin.connect();
    try {
      const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db.name]);
      expect(rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  }, 20_000);
});
