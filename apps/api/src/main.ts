import { createLogger, initSentry, onShutdown } from '@erp/observability';
import pg from 'pg';

import { buildApp } from './app';

const version = process.env['ERP_VERSION'] ?? 'dev';
// prod or staging, from compose (D-086); local runs are "dev".
const env = process.env['ERP_ENV'] ?? 'dev';
const logger = createLogger({ app: 'api', env, version, level: process.env['LOG_LEVEL'] ?? 'info' });
const sentry = initSentry({ dsn: process.env['SENTRY_DSN'], app: 'api', env, version });
const databaseUrl = process.env['DATABASE_URL'];
// The app role (erp_app); never the owner role (D-078).
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 10 }) : undefined;
const app = buildApp({
  loggerInstance: logger,
  version,
  // The end-to-end error check runs on staging only (W0-06).
  testErrors: env === 'staging',
  reportError: (err, requestId) => sentry.capture(err, requestId),
  ...(pool ? { pool } : {}),
});
const port = Number(process.env['PORT'] ?? 3000);
const host = process.env['HOST'] ?? '127.0.0.1';

onShutdown(async () => {
  await app.close();
  await pool?.end();
  await sentry.flush();
});

try {
  await app.listen({ port, host });
  // Which release is running, for reading logs and the deploy history.
  app.log.info({ version, database: pool ? 'configured' : 'none' }, 'api started');
} catch (err) {
  app.log.error({ err }, 'api failed to start');
  sentry.capture(err);
  await sentry.flush();
  process.exit(1);
}
