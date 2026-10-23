import {
  bigint,
  boolean,
  char,
  customType,
  date,
  jsonb,
  pgSchema,
  smallint,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Typed mirror of the SQL migrations (D-078). The migrations are the source of truth; schema.int.test.ts fails
// if this file and the database disagree on any table, column, type or NOT NULL.

export const erp = pgSchema('erp');

const xid8 = customType<{ data: string; driverData: string }>({ dataType: () => 'xid8' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** Set by triggers (erp.enable_sync, erp.enable_audit); never written by the app. */
const syncColumns = {
  rowVersion: bigint('row_version', { mode: 'bigint' }).notNull(),
  txid: xid8('txid').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};
const auditColumns = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdByUserId: uuid('created_by_user_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
};

export const tenants = erp.table('tenants', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  baseCurrency: char('base_currency', { length: 3 }).notNull(),
  currencyMinorUnits: smallint('currency_minor_units').notNull(),
  timezone: text('timezone').notNull(),
  locale: text('locale').notNull(),
  fiscalYearStartMonth: smallint('fiscal_year_start_month').notNull(),
  fiscalYearLocked: boolean('fiscal_year_locked').notNull(),
  taxMode: text('tax_mode', { enum: ['none', 'inclusive', 'exclusive'] }).notNull(),
  cashRoundingIncrement: bigint('cash_rounding_increment', { mode: 'bigint' }).notNull(),
  dayCutoffHour: smallint('day_cutoff_hour').notNull(),
  closingTime: time('closing_time').notNull(),
  cashHandoverMode: text('cash_handover_mode', { enum: ['required', 'off'] }).notNull(),
  lockDate: date('lock_date'),
  settings: jsonb('settings').notNull(),
  status: text('status', { enum: ['active', 'suspended', 'closed'] }).notNull(),
  ...syncColumns,
  ...auditColumns,
});

export const branches = erp.table('branches', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  address: text('address'),
  phone: text('phone'),
  receiptHeader: jsonb('receipt_header').notNull(),
  status: text('status', { enum: ['active', 'closed'] }).notNull(),
  ...syncColumns,
  ...auditColumns,
});

export const locations = erp.table('locations', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['shop', 'storage', 'damaged'] }).notNull(),
  isSellable: boolean('is_sellable').notNull(),
  ...syncColumns,
  ...auditColumns,
});

/** Login directory: shop code → tenant (D-081). The one table readable across tenants. */
export const tenantDirectory = erp.table('tenant_directory', {
  code: text('code').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
});

export const users = erp.table('users', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  username: text('username').notNull(),
  email: text('email'),
  fullName: text('full_name').notNull(),
  shortCode: text('short_code'),
  passwordHash: text('password_hash'),
  pinVerifier: text('pin_verifier'),
  status: text('status', { enum: ['active', 'disabled'] }).notNull(),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  ...syncColumns,
  ...auditColumns,
});

export const userLoginState = erp.table('user_login_state', {
  userId: uuid('user_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  failedLogins: smallint('failed_logins').notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export const roles = erp.table('roles', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  templateKey: text('template_key'),
  permissions: text('permissions').array().notNull(),
  limits: jsonb('limits').notNull(),
  ...syncColumns,
  ...auditColumns,
});

export const userRoles = erp.table('user_roles', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  roleId: uuid('role_id').notNull(),
  branchId: uuid('branch_id'),
  ...syncColumns,
  ...auditColumns,
});

export const sessions = erp.table('sessions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ip: text('ip'),
  userAgent: text('user_agent'),
});

/** Append-only (PLT-08): written by triggers and by the API's login events. */
export const auditLog = erp.table('audit_log', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull(),
  userId: uuid('user_id'),
  deviceId: uuid('device_id'),
  requestId: text('request_id'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: text('ip'),
});

/** Enrolled devices (D-082). The public key verifies device tokens and document signatures. */
export const devices = erp.table('devices', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  code: text('code').notNull(),
  name: text('name'),
  kind: text('kind', { enum: ['counter', 'cash_desk', 'mobile'] }).notNull(),
  publicKey: bytea('public_key').notNull(),
  status: text('status', { enum: ['active', 'revoked'] }).notNull(),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull(),
  enrolledByUserId: uuid('enrolled_by_user_id'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByUserId: uuid('revoked_by_user_id'),
  ...syncColumns,
  ...auditColumns,
});

export const deviceEnrollmentCodes = erp.table('device_enrollment_codes', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  kind: text('kind', { enum: ['counter', 'cash_desk', 'mobile'] }).notNull(),
  name: text('name'),
  codeHash: bytea('code_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedByDeviceId: uuid('used_by_device_id'),
});

export const deviceChallenges = erp.table('device_challenges', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  nonceHash: bytea('nonce_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

export const deviceTokens = erp.table('device_tokens', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
