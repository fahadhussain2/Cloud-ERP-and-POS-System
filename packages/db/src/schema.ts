import {
  bigint,
  boolean,
  char,
  customType,
  date,
  integer,
  jsonb,
  numeric,
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
  mustChangePassword: boolean('must_change_password').notNull(),
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
  /** Null = the tenant's default print profile (D-055). */
  printProfileId: uuid('print_profile_id'),
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

/** Chart of accounts (ACC-01): the posting engine finds accounts by system role. */
export const accounts = erp.table('accounts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  type: text('type', { enum: ['asset', 'liability', 'equity', 'income', 'expense'] }).notNull(),
  parentId: uuid('parent_id'),
  isPostable: boolean('is_postable').notNull(),
  systemRole: text('system_role'),
  isActive: boolean('is_active').notNull(),
  legacyCode: text('legacy_code'),
  ...syncColumns,
  ...auditColumns,
});

export const bankAccounts = erp.table('bank_accounts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['bank', 'wallet', 'card_clearing'] }).notNull(),
  glAccountId: uuid('gl_account_id').notNull(),
  isActive: boolean('is_active').notNull(),
  ...syncColumns,
  ...auditColumns,
});

export const paymentMethods = erp.table('payment_methods', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code', {
    enum: ['cash', 'bank_transfer', 'raast', 'jazzcash', 'easypaisa', 'card', 'on_account'],
  }).notNull(),
  name: text('name').notNull(),
  isCash: boolean('is_cash').notNull(),
  requiresReference: boolean('requires_reference').notNull(),
  bankAccountId: uuid('bank_account_id'),
  isActive: boolean('is_active').notNull(),
  sort: smallint('sort').notNull(),
  ...syncColumns,
  ...auditColumns,
});

export const priceTiers = erp.table('price_tiers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  sort: smallint('sort').notNull(),
  isDefault: boolean('is_default').notNull(),
  ...syncColumns,
  ...auditColumns,
});

export const taxCodes = erp.table('tax_codes', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  rateBp: integer('rate_bp').notNull(),
  ...syncColumns,
  ...auditColumns,
});

export const printProfiles = erp.table('print_profiles', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  paperFormat: text('paper_format', { enum: ['a4', 'a5', 'thermal_80', 'thermal_58'] }).notNull(),
  codeType: text('code_type', { enum: ['barcode', 'signed_qr'] }).notNull(),
  copies: smallint('copies').notNull(),
  templateOptions: jsonb('template_options').notNull(),
  isTenantDefault: boolean('is_tenant_default').notNull(),
  ...syncColumns,
  ...auditColumns,
});

export const expenseCategories = erp.table('expense_categories', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  glAccountId: uuid('gl_account_id').notNull(),
  isActive: boolean('is_active').notNull(),
  ...syncColumns,
  ...auditColumns,
});

/** Catalog (data model §4, D-014); `legacy` keeps imported rows' original keys (D-085). */
export const units = erp.table('units', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  allowsFraction: boolean('allows_fraction').notNull(),
  legacy: jsonb('legacy'),
  ...syncColumns,
  ...auditColumns,
});

export const categories = erp.table('categories', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  parentId: uuid('parent_id'),
  pricingRule: jsonb('pricing_rule').notNull(),
  returnPolicy: jsonb('return_policy').notNull(),
  legacy: jsonb('legacy'),
  ...syncColumns,
  ...auditColumns,
});

export const brands = erp.table('brands', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  legacy: jsonb('legacy'),
  ...syncColumns,
  ...auditColumns,
});

export const origins = erp.table('origins', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  legacy: jsonb('legacy'),
  ...syncColumns,
  ...auditColumns,
});

export const vehicleMakes = erp.table('vehicle_makes', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  legacy: jsonb('legacy'),
  ...syncColumns,
  ...auditColumns,
});

export const parties = erp.table('parties', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  contactPerson: text('contact_person'),
  phones: text('phones').array().notNull(),
  email: text('email'),
  address: text('address'),
  city: text('city'),
  country: text('country'),
  taxId: text('tax_id'),
  labelAbbr: text('label_abbr'),
  notes: text('notes'),
  status: text('status', { enum: ['active', 'inactive'] }).notNull(),
  legacy: jsonb('legacy'),
  ...syncColumns,
  ...auditColumns,
});

export const customerAccounts = erp.table('customer_accounts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  partyId: uuid('party_id').notNull(),
  priceTierId: uuid('price_tier_id').notNull(),
  creditAllowed: boolean('credit_allowed').notNull(),
  /** Minor units; null = no limit (D-085). */
  creditLimit: bigint('credit_limit', { mode: 'number' }),
  offlineDailyCap: bigint('offline_daily_cap', { mode: 'number' }).notNull(),
  paymentTermsDays: smallint('payment_terms_days'),
  legacy: jsonb('legacy'),
  ...syncColumns,
  ...auditColumns,
});

export const supplierAccounts = erp.table('supplier_accounts', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  partyId: uuid('party_id').notNull(),
  paymentTermsDays: smallint('payment_terms_days'),
  defaultLeadDays: smallint('default_lead_days'),
  legacy: jsonb('legacy'),
  ...syncColumns,
  ...auditColumns,
});

export const items = erp.table('items', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  categoryId: uuid('category_id').notNull(),
  brandId: uuid('brand_id'),
  originId: uuid('origin_id'),
  unitId: uuid('unit_id').notNull(),
  variant: text('variant'),
  spec: text('spec'),
  binLocation: text('bin_location'),
  defaultSupplierId: uuid('default_supplier_id'),
  minQty: numeric('min_qty', { precision: 14, scale: 3 }),
  maxQty: numeric('max_qty', { precision: 14, scale: 3 }),
  excludeFromReorder: boolean('exclude_from_reorder').notNull(),
  floorPrice: bigint('floor_price', { mode: 'number' }),
  taxCodeId: uuid('tax_code_id'),
  status: text('status', { enum: ['active', 'dormant', 'discontinued'] }).notNull(),
  legacy: jsonb('legacy'),
  ...syncColumns,
  ...auditColumns,
});

export const itemIdentifiers = erp.table('item_identifiers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  itemId: uuid('item_id').notNull(),
  kind: text('kind', { enum: ['barcode', 'oem', 'alternate', 'supplier_ref'] }).notNull(),
  value: text('value').notNull(),
  normalizedValue: text('normalized_value').notNull(),
  isPrimary: boolean('is_primary').notNull(),
  legacy: jsonb('legacy'),
  ...syncColumns,
  ...auditColumns,
});

export const itemCompatibility = erp.table('item_compatibility', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  itemId: uuid('item_id').notNull(),
  makeId: uuid('make_id'),
  model: text('model'),
  yearFrom: smallint('year_from'),
  yearTo: smallint('year_to'),
  note: text('note'),
  legacy: jsonb('legacy'),
  ...syncColumns,
  ...auditColumns,
});

export const itemPrices = erp.table('item_prices', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  itemId: uuid('item_id').notNull(),
  tierId: uuid('tier_id').notNull(),
  price: bigint('price', { mode: 'number' }).notNull(),
  ...syncColumns,
  ...auditColumns,
});
