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
  /** Hours without reaching the server before the counter warns, and warns strongly (SYN-06, W1-07). */
  offlineWarningHours: smallint('offline_warning_hours').notNull(),
  offlineStrongWarningHours: smallint('offline_strong_warning_hours').notNull(),
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
  /** A temporary PIN set by a manager, to be replaced at a counter (D-089). */
  pinMustChange: boolean('pin_must_change').notNull(),
  ...syncColumns,
  ...auditColumns,
});

export const userLoginState = erp.table('user_login_state', {
  userId: uuid('user_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  failedLogins: smallint('failed_logins').notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  pinFailures: smallint('pin_failures').notNull(),
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
  /** Kept through a Re-enable (W1-07): documents made between the two are flagged. */
  lastRevokedAt: timestamp('last_revoked_at', { withTimezone: true }),
  reenabledAt: timestamp('reenabled_at', { withTimezone: true }),
  reenabledByUserId: uuid('reenabled_by_user_id'),
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
  /** Used by items without their own code (ACC-09); one per tenant. */
  isDefault: boolean('is_default').notNull(),
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

/** A finalized sale, return or exchange as pushed (data model §5, W1-07); `id` is the device-made UUIDv7. */
export const salesDocuments = erp.table('sales_documents', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  branchId: uuid('branch_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  number: text('number').notNull(),
  seq: integer('seq').notNull(),
  kind: text('kind', { enum: ['sale', 'return', 'exchange'] }).notNull(),
  status: text('status', { enum: ['finalized', 'voided'] }).notNull(),
  businessDate: date('business_date').notNull(),
  createdAtDevice: timestamp('created_at_device', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  salespersonUserId: uuid('salesperson_user_id').notNull(),
  customerPartyId: uuid('customer_party_id'),
  walkinPhone: text('walkin_phone'),
  priceTierId: uuid('price_tier_id').notNull(),
  subtotal: bigint('subtotal', { mode: 'number' }).notNull(),
  lineDiscountTotal: bigint('line_discount_total', { mode: 'number' }).notNull(),
  billDiscount: bigint('bill_discount', { mode: 'number' }).notNull(),
  rounding: bigint('rounding', { mode: 'number' }).notNull(),
  taxTotal: bigint('tax_total', { mode: 'number' }).notNull(),
  total: bigint('total', { mode: 'number' }).notNull(),
  cashDue: bigint('cash_due', { mode: 'number' }).notNull(),
  handoverStatus: text('handover_status', {
    enum: ['not_applicable', 'pending', 'received', 'paid_out'],
  }).notNull(),
  payload: jsonb('payload').notNull(),
  payloadHash: bytea('payload_hash').notNull(),
  signature: bytea('signature').notNull(),
  clientVersion: text('client_version').notNull(),
  exceptionCount: integer('exception_count').notNull(),
  ...syncColumns,
  ...auditColumns,
});

export const salesLines = erp.table('sales_lines', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  documentId: uuid('document_id').notNull(),
  lineNo: smallint('line_no').notNull(),
  itemId: uuid('item_id').notNull(),
  qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
  listPrice: bigint('list_price', { mode: 'number' }),
  unitPrice: bigint('unit_price', { mode: 'number' }).notNull(),
  lineDiscount: bigint('line_discount', { mode: 'number' }).notNull(),
  billShare: bigint('bill_share', { mode: 'number' }).notNull(),
  lineTotal: bigint('line_total', { mode: 'number' }).notNull(),
  floorPriceAtSale: bigint('floor_price_at_sale', { mode: 'number' }),
  taxCodeId: uuid('tax_code_id'),
  taxAmount: bigint('tax_amount', { mode: 'number' }).notNull(),
  locationId: uuid('location_id'),
  ...syncColumns,
  ...auditColumns,
});

export const salesPayments = erp.table('sales_payments', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  documentId: uuid('document_id').notNull(),
  lineNo: smallint('line_no').notNull(),
  methodId: uuid('method_id').notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  cashReceived: bigint('cash_received', { mode: 'number' }),
  changeDue: bigint('change_due', { mode: 'number' }),
  reference: text('reference'),
  ...syncColumns,
  ...auditColumns,
});

/** Approvals on a document (PLT-07); `lineId` null = the bill discount. */
export const overrides = erp.table('overrides', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  documentId: uuid('document_id').notNull(),
  lineId: uuid('line_id'),
  kind: text('kind', {
    enum: [
      'below_list',
      'below_floor',
      'credit_limit',
      'offline_cap',
      'no_receipt_return',
      'return_permission',
      'return_outside_policy',
      'void',
      'reprint',
    ],
  }).notNull(),
  requestedByUserId: uuid('requested_by_user_id').notNull(),
  approvedByUserId: uuid('approved_by_user_id').notNull(),
  reasonCode: text('reason_code').notNull(),
  note: text('note'),
  values: jsonb('values').notNull(),
  atDevice: timestamp('at_device', { withTimezone: true }).notNull(),
  ...syncColumns,
  ...auditColumns,
});

const family = (name: string) => text(name, { enum: ['S', 'H', 'R', 'M', 'Z'] });

/** Each pushed document's result (sync spec §6.2). */
export const syncInbox = erp.table('sync_inbox', {
  tenantId: uuid('tenant_id').notNull(),
  documentId: uuid('document_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  family: family('family').notNull(),
  seq: integer('seq').notNull(),
  status: text('status', { enum: ['accepted', 'rejected'] }).notNull(),
  result: jsonb('result').notNull(),
  payloadHash: bytea('payload_hash').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull(),
});

/** Exceptions for review (data model §10, RPT-10). */
export const exceptions = erp.table('exceptions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').notNull(),
  severity: text('severity', { enum: ['low', 'medium', 'high'] }).notNull(),
  documentType: text('document_type'),
  documentId: uuid('document_id'),
  deviceId: uuid('device_id'),
  userId: uuid('user_id'),
  businessDate: date('business_date').notNull(),
  details: jsonb('details').notNull(),
  status: text('status', { enum: ['open', 'reviewed', 'dismissed'] }).notNull(),
  reviewedByUserId: uuid('reviewed_by_user_id'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  ...auditColumns,
});

/** Every seq from 1 to `through` has arrived; `maxSeq` is the highest seen (sync spec §7). */
export const deviceSeries = erp.table('device_series', {
  tenantId: uuid('tenant_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  family: family('family').notNull(),
  through: integer('through').notNull(),
  maxSeq: integer('max_seq').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const sequenceGaps = erp.table('sequence_gaps', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  family: family('family').notNull(),
  fromSeq: integer('from_seq').notNull(),
  toSeq: integer('to_seq').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

/** Each device's last health snapshot (PLT-09). */
export const deviceStatus = erp.table('device_status', {
  tenantId: uuid('tenant_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  lastPushAt: timestamp('last_push_at', { withTimezone: true }),
  lastPullAt: timestamp('last_pull_at', { withTimezone: true }),
  clientVersion: text('client_version'),
  schemaVersion: integer('schema_version'),
  outboxCount: integer('outbox_count'),
  oldestUnsyncedAt: timestamp('oldest_unsynced_at', { withTimezone: true }),
  quarantinedCount: integer('quarantined_count'),
  storagePersisted: boolean('storage_persisted'),
  storageUsage: bigint('storage_usage', { mode: 'number' }),
  storageQuota: bigint('storage_quota', { mode: 'number' }),
  clockSkewMs: integer('clock_skew_ms'),
});

// Ledgers (migration 0009, W1-08): written only by packages/posting (rule 4).

const role = (name: string) => text(name, { enum: ['customer', 'supplier'] });

/** One row per tenant, locked by every posting: the last posting seq and journal number. */
export const postingState = erp.table('posting_state', {
  tenantId: uuid('tenant_id').primaryKey(),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull(),
  lastJournalNo: bigint('last_journal_no', { mode: 'number' }).notNull(),
});

/** The order of record, with the settings each posting used. */
export const postings = erp.table('postings', {
  tenantId: uuid('tenant_id').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  sourceType: text('source_type', { enum: ['sale'] }).notNull(),
  sourceId: uuid('source_id').notNull(),
  entryDate: date('entry_date').notNull(),
  postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
  context: jsonb('context').notNull(),
});

export const journalEntries = erp.table('journal_entries', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  number: text('number').notNull(),
  entryDate: date('entry_date').notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id').notNull(),
  memo: text('memo'),
  reversalOfId: uuid('reversal_of_id'),
  postingSeq: bigint('posting_seq', { mode: 'number' }).notNull(),
  postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
  createdByUserId: uuid('created_by_user_id'),
});

export const journalLines = erp.table('journal_lines', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  entryId: uuid('entry_id').notNull(),
  lineNo: smallint('line_no').notNull(),
  accountId: uuid('account_id').notNull(),
  partyId: uuid('party_id'),
  branchId: uuid('branch_id').notNull(),
  debit: bigint('debit', { mode: 'number' }).notNull(),
  credit: bigint('credit', { mode: 'number' }).notNull(),
  memo: text('memo'),
});

export const stockMovements = erp.table('stock_movements', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  postingSeq: bigint('posting_seq', { mode: 'number' }).notNull(),
  itemId: uuid('item_id').notNull(),
  locationId: uuid('location_id').notNull(),
  qtyDelta: numeric('qty_delta', { precision: 14, scale: 3 }).notNull(),
  unitCost: bigint('unit_cost', { mode: 'number' }).notNull(),
  valueDelta: bigint('value_delta', { mode: 'number' }).notNull(),
  avgCostAfter: bigint('avg_cost_after', { mode: 'number' }),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id').notNull(),
  sourceLineId: uuid('source_line_id'),
  businessDate: date('business_date').notNull(),
  postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
});

export const stockBalances = erp.table('stock_balances', {
  tenantId: uuid('tenant_id').notNull(),
  itemId: uuid('item_id').notNull(),
  locationId: uuid('location_id').notNull(),
  qty: numeric('qty', { precision: 14, scale: 3 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  ...syncColumns,
});

/** One weighted average per item, tenant-wide (D-017); `avgCost` null = no cost known yet. */
export const itemCosts = erp.table('item_costs', {
  tenantId: uuid('tenant_id').notNull(),
  itemId: uuid('item_id').notNull(),
  avgCost: bigint('avg_cost', { mode: 'number' }),
  onHand: numeric('on_hand', { precision: 14, scale: 3 }).notNull(),
  lastCost: bigint('last_cost', { mode: 'number' }),
  lastSupplierId: uuid('last_supplier_id'),
  lastReceiptAt: timestamp('last_receipt_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const partyLedgerEntries = erp.table('party_ledger_entries', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  postingSeq: bigint('posting_seq', { mode: 'number' }).notNull(),
  partyId: uuid('party_id').notNull(),
  role: role('role').notNull(),
  entryDate: date('entry_date').notNull(),
  dueDate: date('due_date').notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: uuid('source_id').notNull(),
  memo: text('memo'),
  postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
});

export const partyBalances = erp.table('party_balances', {
  tenantId: uuid('tenant_id').notNull(),
  partyId: uuid('party_id').notNull(),
  role: role('role').notNull(),
  balance: bigint('balance', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  ...syncColumns,
});
