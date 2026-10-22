// Database migrations, run by every deploy before the new version starts (D-075, D-078).
// If this exits non-zero, the deploy stops and the old version keeps running.
// The owner role's URL is given only to this step (migrate.env); the running API never has it.
import { migrate } from '@erp/db';

const url = process.env['MIGRATION_DATABASE_URL'];
if (!url) {
  console.error('migrate: MIGRATION_DATABASE_URL is not set');
  process.exit(1);
}
try {
  await migrate(url);
} catch (err) {
  console.error(`migrate: ${(err as Error).message}`);
  process.exit(1);
}
