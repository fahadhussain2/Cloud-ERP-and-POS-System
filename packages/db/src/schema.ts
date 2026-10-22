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
