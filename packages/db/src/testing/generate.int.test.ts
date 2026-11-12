import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTenant, createTestDatabase, type TestDatabase } from './database';
import { seedGeneratedCatalog } from './generate';

// Seeding the generated catalog on a shop (W1-21): once, as the owner role with RLS on, never on production.

let db: TestDatabase;
let admin: pg.Client;
let demo: string;

const count = async (table: string, tenantId: string) =>
  Number(
    (
      await admin.query<{ n: string }>(`SELECT count(*) AS n FROM erp.${table} WHERE tenant_id = $1`, [
        tenantId,
      ])
    ).rows[0]!.n,
  );

beforeAll(async () => {
  db = await createTestDatabase();
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  demo = await createTenant(db.ownerUrl, 'Demo Auto Parts', 'demo');
  await createTenant(db.ownerUrl, 'Other Shop', 'other');
});

afterAll(async () => {
  await admin?.end();
  await db?.drop();
});

describe('seeding a generated catalog', () => {
  it('fills a shop with no items: items, barcodes, prices in three tiers, all under its tenant', async () => {
    const report = await seedGeneratedCatalog(db.ownerUrl, {
      environment: 'staging',
      tenantCode: 'demo',
      items: 300,
      seed: 1,
    });
    expect(report).toMatchObject({ tenantId: demo, items: 300 });
    expect(await count('items', demo)).toBe(300);
    expect(
      Number(
        (
          await admin.query<{ n: string }>(
            "SELECT count(*) AS n FROM erp.item_identifiers WHERE tenant_id = $1 AND kind = 'barcode'",
            [demo],
          )
        ).rows[0]!.n,
      ),
    ).toBe(300);
    expect(await count('item_prices', demo)).toBe(900);
    expect(await count('price_tiers', demo)).toBe(3);
  });

  it('refuses a shop that already has items, and writes nothing', async () => {
    await expect(
      seedGeneratedCatalog(db.ownerUrl, { environment: 'staging', tenantCode: 'demo', items: 10 }),
    ).rejects.toThrow(/already has items/);
    expect(await count('items', demo)).toBe(300);
  });

  it('refuses production, and writes nothing', async () => {
    await expect(
      seedGeneratedCatalog(db.ownerUrl, { environment: 'prod', tenantCode: 'other', items: 10 }),
    ).rejects.toThrow(/production/);
    const other = (
      await admin.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM erp.tenant_directory WHERE code = 'other'",
      )
    ).rows[0]!.tenant_id;
    expect(await count('items', other)).toBe(0);
  });

  it('refuses a shop code that does not exist', async () => {
    await expect(
      seedGeneratedCatalog(db.ownerUrl, { environment: 'staging', tenantCode: 'nope', items: 10 }),
    ).rejects.toThrow(/no shop nope/);
  });
});
