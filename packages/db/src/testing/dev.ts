// `pnpm dev:db`: the local development database `erp_dev` (W0-13, D-085) with the migrations and the Delux tenant
// from its reviewed spec. Safe to run again. The legacy importer loads into it; it never leaves this PC.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TenantSpec } from '@erp/contracts';

import { setupTenant } from '../setup/tenant';
import { createTestDatabase } from './database';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
process.env['DATABASE_URL'] ??= 'postgres://postgres:postgres@127.0.0.1:54329/postgres';

const db = await createTestDatabase({ name: 'erp_dev' });
const spec = TenantSpec.parse(
  JSON.parse(await readFile(resolve(root, 'infra/db/tenants/delux.json'), 'utf8')),
);
// No usable password: nobody logs in to the dev tenant yet (resetUserPassword sets one when needed).
const report = await setupTenant(db.ownerUrl, spec, { ownerPasswordHash: '!', mustChangePassword: true });
console.info(
  `erp_dev: tenant ${spec.code} ${report.created.length ? `created (${report.created.length} items)` : 'up to date'}`,
);
console.info(`app role URL for the importer: ${db.appUrl.replace(/:[^:@/]+@/, ':***@')}`);
