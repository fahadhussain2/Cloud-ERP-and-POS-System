import { createLogger, initSentry, onShutdown } from '@erp/observability';

import { jobs, startWorker } from './jobs';

const version = process.env['ERP_VERSION'] ?? 'dev';
const env = process.env['ERP_ENV'] ?? 'dev';
const log = createLogger({ app: 'worker', env, version, level: process.env['LOG_LEVEL'] ?? 'info' });
const sentry = initSentry({ dsn: process.env['SENTRY_DSN'], app: 'worker', env, version });

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

const stop = startWorker();
onShutdown(async () => {
  await stop();
  await sentry.flush();
});
log.info({ jobs: jobs.length }, 'worker started');
