import { onShutdown } from '@erp/observability';
import pg from 'pg';

import { buildApp } from './app';

const version = process.env['ERP_VERSION'] ?? 'dev';
const databaseUrl = process.env['DATABASE_URL'];
// The app role (erp_app); never the owner role (D-078).
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 10 }) : undefined;
const app = buildApp({ logger: true, version, ...(pool ? { pool } : {}) });
const port = Number(process.env['PORT'] ?? 3000);
const host = process.env['HOST'] ?? '127.0.0.1';

onShutdown(async () => {
  await app.close();
  await pool?.end();
});

try {
  await app.listen({ port, host });
  // Which release is running, for reading logs and the deploy history.
  app.log.info({ version, database: pool ? 'configured' : 'none' }, 'api started');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
