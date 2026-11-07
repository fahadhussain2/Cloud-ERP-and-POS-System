import { readFileSync } from 'node:fs';

import { TenantSpec } from '@erp/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { MIGRATIONS_DIR } from './migrate';
import { setupTenant } from './setup/tenant';
import { seedCatalog } from './testing/catalog';
import { createTestDatabase, type TestDatabase } from './testing/database';

// Migration 0018 (W1-18, D-107): every existing branch gets its In transit location and every template Manager gets
// inv.transfer.post (owner answer 2), each block as the migration role under the forced RLS, so it must reach every
// tenant. Tenants made before 0018 are made here by taking those back as the superuser. Then the guard: a posted
// transfer or adjustment is never changed (rule 3), a sent one may only be received, and an adjustment awaiting the
// owner keeps its lines.

let db: TestDatabase;
let admin: pg.Client;
const tenants: string[] = [];

const block = (name: string) =>
  new RegExp(`-- BEGIN ${name}\\n([\\s\\S]*?)-- END ${name}`).exec(
    readFileSync(`${MIGRATIONS_DIR}/0018_stock_operations.sql`, 'utf8').replaceAll('\r\n', '\n'),
  )![1]!;

async function asOwner(sql: string) {
  const owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query(sql);
    await owner.query('COMMIT');
  } finally {
    await owner.end();
  }
}

/** As the application role, in the tenant's context, rolled back. */
async function asApp<T>(tenantId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const app = new pg.Client({ connectionString: db.appUrl });
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return await fn(app);
  } finally {
    await app.query('ROLLBACK').catch(() => undefined);
    await app.end();
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  for (const code of ['shop-a', 'shop-b']) {
    const r = await setupTenant(db.ownerUrl, TenantSpec.parse({ ...deluxSpec, code, name: code }), {
      ownerPasswordHash: 'hash',
      mustChangePassword: false,
    });
    tenants.push(r.tenantId);
  }
});

afterAll(async () => {
  await admin?.end();
  await db?.drop();
});

describe('migration 0018', () => {
  it('gives every branch of every tenant one In transit location, never sellable', async () => {
    // Locations are never deleted (they sync): the superuser removes them past the triggers, as before 0018.
    await admin.query('SET session_replication_role = replica');
    await admin.query("DELETE FROM erp.locations WHERE kind = 'transit'");
    await admin.query('SET session_replication_role = origin');
    await asOwner(block('transit-locations'));
    await asOwner(block('transit-locations'));
    const { rows } = await admin.query<{ n: number; sellable: boolean }>(
      `SELECT count(*)::int AS n, bool_or(is_sellable) AS sellable FROM erp.locations
       WHERE kind = 'transit' AND code = 'TRANSIT' GROUP BY tenant_id`,
    );
    expect(rows).toEqual([
      { n: 1, sellable: false },
      { n: 1, sellable: false },
    ]);
    await expect(
      admin.query(
        `INSERT INTO erp.locations (tenant_id, branch_id, code, name, kind, is_sellable)
         SELECT tenant_id, branch_id, 'T2', 'Selling transit', 'transit', true FROM erp.locations LIMIT 1`,
      ),
    ).rejects.toThrow(/locations_transit_not_sellable/);
  });

  it("gives every tenant's template Manager inv.transfer.post, once", async () => {
    await admin.query(
      "UPDATE erp.roles SET permissions = array_remove(permissions, 'inv.transfer.post') WHERE template_key = 'manager'",
    );
    await asOwner(block('manager-transfer-post'));
    await asOwner(block('manager-transfer-post'));
    const { rows } = await admin.query<{ n: number }>(
      `SELECT cardinality(array_positions(permissions, 'inv.transfer.post')) AS n FROM erp.roles
       WHERE template_key = 'manager'`,
    );
    expect(rows).toEqual([{ n: 1 }, { n: 1 }]);
  });
});

describe('the posted-document guard', () => {
  const setup = async (c: pg.Client, tenantId: string) => {
    const loc = async (code: string) =>
      (
        await c.query<{ id: string; branch_id: string }>(
          'SELECT id, branch_id FROM erp.locations WHERE code = $1',
          [code],
        )
      ).rows[0]!;
    const godown = await loc('GODOWN');
    const shop = await loc('SHOP');
    const item = (await seedCatalog(c, tenantId, [{ code: 'T001', name: 'Test item', category: 'TEST' }]))[
      'T001'
    ]!;
    return { godown, shop, item };
  };

  it('lets a draft transfer change, a sent one only be received, and a posted one not at all', async () => {
    await asApp(tenants[0]!, async (c) => {
      const { godown, shop, item } = await setup(c, tenants[0]!);
      const t = (
        await c.query<{ id: string }>(
          `INSERT INTO erp.stock_transfers (tenant_id, branch_id, from_location_id, to_location_id, business_date)
           VALUES ($1, $2, $3, $4, '2026-11-08') RETURNING id`,
          [tenants[0], godown.branch_id, godown.id, shop.id],
        )
      ).rows[0]!.id;
      await c.query(
        'INSERT INTO erp.stock_transfer_lines (tenant_id, transfer_id, line_no, item_id, qty) VALUES ($1, $2, 1, $3, 5)',
        [tenants[0], t, item],
      );
      await c.query("UPDATE erp.stock_transfers SET note = 'from the back shelf' WHERE id = $1", [t]);
      await c.query(
        `UPDATE erp.stock_transfers SET status = 'in_transit', number = 'TR000001', posted_at = now() WHERE id = $1`,
        [t],
      );
      await c.query('SAVEPOINT s');
      await expect(
        c.query("UPDATE erp.stock_transfers SET note = 'changed' WHERE id = $1", [t]),
      ).rejects.toThrow(/posted and can't be changed/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      await expect(
        c.query('UPDATE erp.stock_transfer_lines SET qty = 6 WHERE transfer_id = $1', [t]),
      ).rejects.toThrow(/in_transit and its lines can't be changed/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      await c.query('UPDATE erp.stock_transfer_lines SET received_qty = 4 WHERE transfer_id = $1', [t]);
      await c.query(
        `UPDATE erp.stock_transfers SET status = 'received', receipt_id = erp.uuid_v7(), received_on = '2026-11-09',
           received_at = now(), row_version = row_version + 1 WHERE id = $1`,
        [t],
      );
      await c.query('SAVEPOINT r');
      await expect(
        c.query('UPDATE erp.stock_transfer_lines SET received_qty = 5 WHERE transfer_id = $1', [t]),
      ).rejects.toThrow(/received and its lines can't be changed/);
      await c.query('ROLLBACK TO SAVEPOINT r');
      await expect(c.query('DELETE FROM erp.stock_transfers WHERE id = $1', [t])).rejects.toThrow(
        /posted and can't be changed/,
      );
    });
  });

  it('keeps the lines of an adjustment awaiting approval, and a posted one whole', async () => {
    await asApp(tenants[1]!, async (c) => {
      const { shop, item } = await setup(c, tenants[1]!);
      const a = (
        await c.query<{ id: string }>(
          `INSERT INTO erp.stock_adjustments (tenant_id, branch_id, location_id, business_date, reason_code)
           VALUES ($1, $2, $3, '2026-11-08', 'lost') RETURNING id`,
          [tenants[1], shop.branch_id, shop.id],
        )
      ).rows[0]!.id;
      await c.query(
        'INSERT INTO erp.stock_adjustment_lines (tenant_id, adjustment_id, line_no, item_id, qty) VALUES ($1, $2, 1, $3, -3)',
        [tenants[1], a, item],
      );
      await c.query(
        `UPDATE erp.stock_adjustments SET status = 'awaiting_approval', loss_value = 1200000, submitted_at = now()
         WHERE id = $1`,
        [a],
      );
      await c.query('SAVEPOINT s');
      await expect(
        c.query('UPDATE erp.stock_adjustment_lines SET qty = -1 WHERE adjustment_id = $1', [a]),
      ).rejects.toThrow(/awaiting_approval and its lines can't be changed/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      await c.query(
        `UPDATE erp.stock_adjustments SET status = 'posted', number = 'AD000001', posted_at = now(), approved_at = now()
         WHERE id = $1`,
        [a],
      );
      await c.query('SAVEPOINT p');
      await expect(c.query("UPDATE erp.stock_adjustments SET note = 'x' WHERE id = $1", [a])).rejects.toThrow(
        /posted and can't be changed/,
      );
      await c.query('ROLLBACK TO SAVEPOINT p');
      await c.query('UPDATE erp.stock_adjustments SET exception_count = 1 WHERE id = $1', [a]);
    });
  });
});
