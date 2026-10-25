// Database access (server only): Drizzle schema, SQL migrations, tenant context and the change feed (D-078).
export { MIGRATIONS_DIR, migrate, type MigrateOptions } from './migrate';
export * as schema from './schema';
export {
  pullChanges,
  pullColumns,
  START,
  SYNCED_TABLES,
  type Cursor,
  type PullSource,
  type SyncedTable,
} from './sync';
export { withTenant, type Db, type TenantContext } from './tenant';
export {
  resetUserPassword,
  setupTenant,
  specProblems,
  TenantSpecError,
  type SetupOptions,
  type SetupReport,
} from './setup/tenant';
