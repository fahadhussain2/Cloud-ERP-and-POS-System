import { readFileSync } from 'node:fs';

import { TenantSpec } from '@erp/contracts';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { MIGRATIONS_DIR } from './migrate';
import { setupTenant } from './setup/tenant';
import { createTestDatabase, type TestDatabase } from './testing/database';

// Migration 0021 gives exceptions.review to every existing tenant's Manager role made from the template (owner answer
// 5 to W1-20, D-110). It runs as the migration role under the roles' forced RLS, so it must still reach every tenant.
// A tenant made before 0021 is one whose roles lack it: made here by taking it away as the superuser. A role made by
// hand keeps what it has, and nobody but the Owner gets support.trace.

let db: TestDatabase;
let admin: pg.Client;

const STATEMENTS = /-- BEGIN exceptions-review\n([\s\S]*?)-- END exceptions-review/.exec(
  readFileSync(`${MIGRATIONS_DIR}/0021_reports_support.sql`, 'utf8').replaceAll('\r\n', '\n'),
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
  await admin.query(`UPDATE erp.roles SET permissions = array_remove(permissions, 'exceptions.review')`);
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

it("gives exceptions.review to every tenant's template Manager, as the migration role under forced RLS", async () => {
  const reviewing = async () =>
    (
      await admin.query<{ name: string; review: boolean; trace: boolean }>(
        `SELECT name, 'exceptions.review' = ANY (permissions) AS review, 'support.trace' = ANY (permissions) AS trace
         FROM erp.roles WHERE name IN ('Manager', 'Accountant', 'Counter lead') ORDER BY tenant_id, name`,
      )
    ).rows;
  const before = await reviewing();
  expect(before.every((r) => !r.review && !r.trace)).toBe(true);
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
  expect(await reviewing()).toEqual(
    [0, 1].flatMap(() => [
      { name: 'Accountant', review: false, trace: false },
      { name: 'Counter lead', review: false, trace: false },
      { name: 'Manager', review: true, trace: false },
    ]),
  );
});
