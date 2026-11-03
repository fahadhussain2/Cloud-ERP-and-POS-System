import { readFileSync } from 'node:fs';

import { TenantSpec } from '@erp/contracts';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { MIGRATIONS_DIR } from './migrate';
import { setupTenant } from './setup/tenant';
import { createTestDatabase, type TestDatabase } from './testing/database';

// Migration 0013 moves every existing tenant's `same_day` void window to `same_day_before_handover` (owner answer 1 to
// W1-12): no role voids after the cash handover. It runs as the migration role, and the roles have forced RLS, so the
// statement must still reach every tenant's rows (the lesson of 0012). A tenant made before 0013 is one whose Manager
// and Owner say `same_day`: made here by setting it back as the superuser.

let db: TestDatabase;
let admin: pg.Client;

const WINDOW_STATEMENTS = /-- BEGIN void-window\n([\s\S]*?)-- END void-window/.exec(
  readFileSync(`${MIGRATIONS_DIR}/0013_void_reissue.sql`, 'utf8').replaceAll('\r\n', '\n'),
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
    `UPDATE erp.roles SET limits = jsonb_set(limits, '{voidWindow}', '"same_day"')
     WHERE template_key IN ('owner', 'manager')`,
  );
});

afterAll(async () => {
  await admin?.end();
  await db?.drop();
});

it("moves every tenant's same_day roles to before the handover, as the migration role under forced RLS", async () => {
  const before = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM erp.roles WHERE limits->>'voidWindow' = 'same_day'",
  );
  expect(before.rows[0]!.n).toBe(4);
  const owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query(WINDOW_STATEMENTS);
    await owner.query('COMMIT');
  } finally {
    await owner.end();
  }
  const { rows } = await admin.query<{ template: string; window: string }>(
    `SELECT template_key AS template, limits->>'voidWindow' AS window FROM erp.roles
     WHERE template_key IN ('owner', 'manager', 'salesman') ORDER BY tenant_id, template_key`,
  );
  expect(rows).toEqual([
    { template: 'manager', window: 'same_day_before_handover' },
    { template: 'owner', window: 'same_day_before_handover' },
    { template: 'salesman', window: 'none' },
    { template: 'manager', window: 'same_day_before_handover' },
    { template: 'owner', window: 'same_day_before_handover' },
    { template: 'salesman', window: 'none' },
  ]);
  // The other limits are kept.
  const limits = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM erp.roles WHERE template_key = 'manager' AND (limits->>'maxDiscountBp') IS NOT NULL",
  );
  expect(limits.rows[0]!.n).toBe(2);
});
