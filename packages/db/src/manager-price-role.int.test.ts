import { readFileSync } from 'node:fs';

import { TenantSpec } from '@erp/contracts';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { MIGRATIONS_DIR } from './migrate';
import { setupTenant } from './setup/tenant';
import { createTestDatabase, type TestDatabase } from './testing/database';

// Migration 0016 takes cat.price.edit from every existing tenant's Manager roles made from the template (owner answer
// 3 to W1-15: only the owner changes prices). As in 0012 and 0013 it runs as the migration role under the roles'
// forced RLS, so it must still reach every tenant. A tenant made before 0016 is one whose Manager still prices: made
// here by giving it back as the superuser. A role made by hand (no template) keeps what it has.

let db: TestDatabase;
let admin: pg.Client;

const STATEMENTS = /-- BEGIN manager-price\n([\s\S]*?)-- END manager-price/.exec(
  readFileSync(`${MIGRATIONS_DIR}/0016_price_history.sql`, 'utf8').replaceAll('\r\n', '\n'),
)![1]!;

beforeAll(async () => {
  db = await createTestDatabase();
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  for (const code of ['shop-a', 'shop-b'])
    await setupTenant(db.ownerUrl, TenantSpec.parse({ ...deluxSpec, code, name: code }), {
      ownerPasswordHash: 'hash',
      mustChangePassword: false,
    });
  await admin.query(
    `UPDATE erp.roles SET permissions = array_append(permissions, 'cat.price.edit') WHERE template_key = 'manager'`,
  );
  await admin.query(
    `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits)
     SELECT tenant_id, 'Pricing clerk', NULL, ARRAY['cat.price.edit'], limits FROM erp.roles
     WHERE template_key = 'manager'`,
  );
});

afterAll(async () => {
  await admin?.end();
  await db?.drop();
});

it("takes cat.price.edit from every tenant's template Manager, as the migration role under forced RLS", async () => {
  const pricing = async () =>
    (
      await admin.query<{ name: string; prices: boolean }>(
        `SELECT name, 'cat.price.edit' = ANY (permissions) AS prices FROM erp.roles
         WHERE name IN ('Manager', 'Pricing clerk') ORDER BY tenant_id, name`,
      )
    ).rows;
  expect(await pricing()).toEqual([
    { name: 'Manager', prices: true },
    { name: 'Pricing clerk', prices: true },
    { name: 'Manager', prices: true },
    { name: 'Pricing clerk', prices: true },
  ]);
  const owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query(STATEMENTS);
    await owner.query('COMMIT');
  } finally {
    await owner.end();
  }
  expect(await pricing()).toEqual([
    { name: 'Manager', prices: false },
    { name: 'Pricing clerk', prices: true },
    { name: 'Manager', prices: false },
    { name: 'Pricing clerk', prices: true },
  ]);
});
