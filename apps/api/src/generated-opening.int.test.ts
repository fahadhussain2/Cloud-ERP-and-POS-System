import { TenantSpec } from '@erp/contracts';
import { setupTenant } from '@erp/db';
import { createTestDatabase, seedGeneratedCatalog, type TestDatabase } from '@erp/db/testing';
import { checkRebuild } from '@erp/posting';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import demoSpec from '../../../infra/db/tenants/demo.json';
import { seedGeneratedOpening } from './generated-opening';

// The generated opening on staging (W1-14, D-076): costs and floors to try without real data; never on production.

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Client;
let tenantId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 2 });
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  ({ tenantId } = await setupTenant(db.ownerUrl, TenantSpec.parse(demoSpec), {
    ownerPasswordHash: 'x',
    mustChangePassword: true,
  }));
  await seedGeneratedCatalog(db.ownerUrl, { environment: 'staging', tenantCode: demoSpec.code, items: 60, seed: 7 });
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await db?.drop();
});

describe('a generated opening', () => {
  it('is refused on production', async () => {
    await expect(seedGeneratedOpening(db.ownerUrl, { environment: 'prod', tenantId })).rejects.toThrow(
      'never goes to production',
    );
  });

  it('posts every priced item into Shop at 70% of Retail, with a floor at cost + 5%, rebuildably', async () => {
    const r = await seedGeneratedOpening(db.ownerUrl, { environment: 'staging', tenantId });
    expect(r.items).toBeGreaterThan(0);
    expect(r.journal).toBe('J000001');
    const { rows } = await admin.query<{ n: string; wrong: string }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE f.floor <> round(k.avg_cost * 1.05)) AS wrong
       FROM erp.item_costs k JOIN erp.item_floors f ON f.item_id = k.item_id AND f.deleted_at IS NULL`,
    );
    expect(Number(rows[0]!.n)).toBe(r.items);
    expect(rows[0]!.wrong).toBe('0');
    expect((await checkRebuild(pool, tenantId)).differences).toEqual([]);
  });
});
