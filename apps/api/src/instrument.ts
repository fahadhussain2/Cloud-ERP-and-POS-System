// Loaded first, with `node --import ./dist/instrument.js dist/main.js` (Dockerfile): OpenTelemetry must hook the
// modules (pg) before the app imports them (W0-06, D-086).
import { register } from 'node:module';

import { startTracing } from '@erp/observability/tracing';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
startTracing({
  service: 'erp-api',
  env: process.env['ERP_ENV'] ?? 'dev',
  version: process.env['ERP_VERSION'] ?? 'dev',
});
