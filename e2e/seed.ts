// The E2E API: a fresh erp_e2e database for each run (the migrations, a test tenant made from the Delux spec, one
// salesman without a PIN), then the API itself on it, as the app role. Needs DATABASE_URL (a PostgreSQL 17+
// superuser; locally `pnpm db:up`).
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TenantSpec } from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTestDatabase } from '@erp/db/testing';
import pg from 'pg';

import { hashPassword } from '../apps/api/src/auth/password';
import { API_PORT, OWNER, OWNER_FIRST_PASSWORD, SALESMAN, SHOP } from './fixtures';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'erp_e2e';

await (await createTestDatabase({ name: NAME })).drop();
const db = await createTestDatabase({ name: NAME });
const delux = JSON.parse(await readFile(resolve(root, 'infra/db/tenants/delux.json'), 'utf8')) as object;
const spec = TenantSpec.parse({ ...delux, code: SHOP, owner: OWNER });
await setupTenant(db.ownerUrl, spec, {
  ownerPasswordHash: await hashPassword(OWNER_FIRST_PASSWORD),
  mustChangePassword: true,
});

const pool = new pg.Pool({ connectionString: db.appUrl });
const dir = await pool.query<{ tenant_id: string }>(
  'SELECT tenant_id FROM erp.tenant_directory WHERE code = $1',
  [SHOP],
);
await withTenant(pool, { tenantId: dir.rows[0]!.tenant_id }, async (_db, c) => {
  const user = await c.query<{ id: string }>(
    `INSERT INTO erp.users (tenant_id, username, full_name, short_code)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [dir.rows[0]!.tenant_id, SALESMAN.username, SALESMAN.fullName, SALESMAN.shortCode],
  );
  await c.query(
    `INSERT INTO erp.user_roles (tenant_id, user_id, role_id)
     SELECT $1, $2, id FROM erp.roles WHERE template_key = 'salesman'`,
    [dir.rows[0]!.tenant_id, user.rows[0]!.id],
  );
});
await pool.end();
console.info(`${NAME}: tenant ${SHOP} ready`);

process.env['DATABASE_URL'] = db.appUrl;
process.env['PORT'] = String(API_PORT);
await import('../apps/api/src/main');
