import { readFileSync } from 'node:fs';

import { TenantSpec } from '@erp/contracts';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { MIGRATIONS_DIR } from './migrate';
import { setupTenant } from './setup/tenant';
import { createTestDatabase, type TestDatabase } from './testing/database';

// Migration 0012 gives every existing tenant's 1130 Cash in safe the CASH_SAFE role (owner answer 3 to W1-11). It runs
// as the migration role, and the accounts have forced RLS, so the statement must still reach every tenant's rows.
// A tenant made before 0012 is one whose 1130 has no role: made here by clearing it as the superuser.

let db: TestDatabase;
let admin: pg.Client;

const ROLE_STATEMENTS = /-- BEGIN cash-safe-role\n([\s\S]*?)-- END cash-safe-role/.exec(
  readFileSync(`${MIGRATIONS_DIR}/0012_cash_desk_close.sql`, 'utf8').replaceAll('\r\n', '\n'),
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
  await admin.query("UPDATE erp.accounts SET system_role = NULL WHERE system_role = 'CASH_SAFE'");
});

afterAll(async () => {
  await admin?.end();
  await db?.drop();
});

it("gives every tenant's 1130 the CASH_SAFE role, as the migration role under forced RLS", async () => {
  const owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  try {
    await owner.query(ROLE_STATEMENTS);
  } finally {
    await owner.end();
  }
  const { rows } = await admin.query<{ code: string; role: string | null }>(
    "SELECT code, system_role AS role FROM erp.accounts WHERE code = '1130' ORDER BY tenant_id",
  );
  expect(rows).toEqual([
    { code: '1130', role: 'CASH_SAFE' },
    { code: '1130', role: 'CASH_SAFE' },
  ]);
});
