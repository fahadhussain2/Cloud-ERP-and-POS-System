import { readFileSync } from 'node:fs';

import { TenantSpec } from '@erp/contracts';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { MIGRATIONS_DIR } from './migrate';
import { setupTenant } from './setup/tenant';
import { createTestDatabase, type TestDatabase } from './testing/database';

// Migration 0020 gives cust.edit to every existing tenant's Manager and Accountant roles made from the templates
// (owner answer 1 to W1-22, D-109). It runs as the migration role under the roles' forced RLS, so it must still reach
// every tenant. A tenant made before 0020 is one whose roles lack it: made here by taking it away as the superuser.
// A role made by hand (no template) keeps what it has, and nobody but the Owner gets cust.terms.edit.

let db: TestDatabase;
let admin: pg.Client;

const STATEMENTS = /-- BEGIN customer-edit\n([\s\S]*?)-- END customer-edit/.exec(
  readFileSync(`${MIGRATIONS_DIR}/0020_customer_permissions.sql`, 'utf8').replaceAll('\r\n', '\n'),
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
  await admin.query(`UPDATE erp.roles SET permissions = array_remove(permissions, 'cust.edit')`);
  await admin.query(
    `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits)
     SELECT tenant_id, 'Counter lead', NULL, ARRAY['pos.sale.create'], limits FROM erp.roles
     WHERE template_key = 'manager'`,
  );
});

afterAll(async () => {
  await admin?.end();
  await db?.drop();
});

it("gives cust.edit to every tenant's template Manager and Accountant, as the migration role under forced RLS", async () => {
  const editing = async () =>
    (
      await admin.query<{ name: string; edit: boolean; terms: boolean }>(
        `SELECT name, 'cust.edit' = ANY (permissions) AS edit, 'cust.terms.edit' = ANY (permissions) AS terms
         FROM erp.roles WHERE name IN ('Manager', 'Accountant', 'Counter lead') ORDER BY tenant_id, name`,
      )
    ).rows;
  const before = await editing();
  expect(before.every((r) => !r.edit && !r.terms)).toBe(true);
  expect(before).toHaveLength(6);
  const owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query(STATEMENTS);
    await owner.query('COMMIT');
  } finally {
    await owner.end();
  }
  expect(await editing()).toEqual(
    [0, 1].flatMap(() => [
      { name: 'Accountant', edit: true, terms: false },
      { name: 'Counter lead', edit: false, terms: false },
      { name: 'Manager', edit: true, terms: false },
    ]),
  );
});
