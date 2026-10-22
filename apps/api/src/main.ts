import { onShutdown } from '@erp/observability';

import { buildApp } from './app';

const version = process.env['ERP_VERSION'] ?? 'dev';
const app = buildApp({ logger: true, version });
const port = Number(process.env['PORT'] ?? 3000);
const host = process.env['HOST'] ?? '127.0.0.1';

onShutdown(() => app.close());

try {
  await app.listen({ port, host });
  // Which release is running, for reading logs and the deploy history.
  app.log.info({ version }, 'api started');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
