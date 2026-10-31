import { createLogger, initSentry, onShutdown } from '@erp/observability';
import pg from 'pg';

import { jobsFor, startWorker } from './jobs';

const version = process.env['ERP_VERSION'] ?? 'dev';
const env = process.env['ERP_ENV'] ?? 'dev';
const log = createLogger({ app: 'worker', env, version, level: process.env['LOG_LEVEL'] ?? 'info' });
const sentry = initSentry({ dsn: process.env['SENTRY_DSN'], app: 'worker', env, version });
const databaseUrl = process.env['DATABASE_URL'];
// The app role (erp_app), like the API; never the owner role (D-078).
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl, max: 2 }) : undefined;

// Anything that escapes a job is logged and reported, then the container restarts it (D-086).
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception');
  sentry.capture(err);
  void sentry.flush().finally(() => process.exit(1));
});
process.on('unhandledRejection', (err) => {
  log.error({ err }, 'unhandled rejection');
  sentry.capture(err);
});

const jobs = jobsFor({ pool, log });
const stop = startWorker(jobs, (job, err) => {
  log.error({ err, job: job.name }, 'job failed');
  sentry.capture(err);
});
onShutdown(async () => {
  await stop();
  await pool?.end();
  await sentry.flush();
});
log.info({ jobs: jobs.map((j) => j.name), database: pool ? 'configured' : 'none' }, 'worker started');
