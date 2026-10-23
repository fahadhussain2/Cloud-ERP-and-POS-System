-- 0005 Chart of accounts, banks and wallets, payment methods, price tiers, tax codes, print profiles,
-- expense categories and the forced password change (W0-11; PLT-11, ACC-01, ACC-08, ACC-09, POS-16;
-- data model §4, §6, §9; D-055, D-083).

-- A generated password (test or support accounts) must be changed before anything else (D-083).
ALTER TABLE erp.users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

CREATE TABLE erp.accounts (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  code text NOT NULL CHECK (code ~ '^[0-9]{3,6}$'),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  parent_id uuid,
  is_postable boolean NOT NULL,
  -- How the posting engine finds an account (posting rules §2); validateChartOfAccounts checks the tree.
  system_role text CHECK (system_role IN (
    'CASH_DRAWER', 'CASH_IN_TRANSIT', 'AR_CONTROL', 'AP_CONTROL', 'INVENTORY', 'COGS', 'SALES',
    'SALES_RETURNS', 'SALES_DISCOUNT', 'ROUNDING', 'CASH_SHORT_OVER', 'INVENTORY_ADJUSTMENT',
    'PURCHASE_PRICE_VARIANCE', 'OPENING_BALANCE_EQUITY', 'RETAINED_EARNINGS', 'TAX_PAYABLE', 'TAX_RECOVERABLE')),
  is_active boolean NOT NULL DEFAULT true,
  -- The legacy account it was mapped from (migration §5).
  legacy_code text,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, parent_id) REFERENCES erp.accounts (tenant_id, id),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, system_role),
  UNIQUE (tenant_id, id),
  -- Only postable accounts carry a role.
  CHECK (system_role IS NULL OR is_postable)
);
SELECT erp.enable_tenant_rls('erp.accounts');
SELECT erp.enable_sync('erp.accounts');
SELECT erp.enable_audit('erp.accounts');
SELECT erp.enable_audit_log('erp.accounts');

-- Banks, wallets and card settlement clearing, each with its own asset account (ACC-08).
CREATE TABLE erp.bank_accounts (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bank', 'wallet', 'card_clearing')),
  gl_account_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, gl_account_id) REFERENCES erp.accounts (tenant_id, id),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, gl_account_id),
  UNIQUE (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.bank_accounts');
SELECT erp.enable_sync('erp.bank_accounts');
SELECT erp.enable_audit('erp.bank_accounts');
SELECT erp.enable_audit_log('erp.bank_accounts');

-- Cash and on-account have no bank account: the posting engine routes them by role (posting rules §4).
-- A non-cash method without one can't be posted yet; the setup report flags it.
CREATE TABLE erp.payment_methods (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  code text NOT NULL CHECK (code IN ('cash', 'bank_transfer', 'raast', 'jazzcash', 'easypaisa', 'card', 'on_account')),
  name text NOT NULL,
  is_cash boolean NOT NULL,
  requires_reference boolean NOT NULL,
  bank_account_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  sort smallint NOT NULL,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES erp.bank_accounts (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (is_cash = (code = 'cash')),
  CHECK (code NOT IN ('cash', 'on_account') OR bank_account_id IS NULL)
);
SELECT erp.enable_tenant_rls('erp.payment_methods');
SELECT erp.enable_sync('erp.payment_methods');
SELECT erp.enable_audit('erp.payment_methods');
SELECT erp.enable_audit_log('erp.payment_methods');

CREATE TABLE erp.price_tiers (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  sort smallint NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX price_tiers_one_default ON erp.price_tiers (tenant_id) WHERE is_default AND deleted_at IS NULL;
SELECT erp.enable_tenant_rls('erp.price_tiers');
SELECT erp.enable_sync('erp.price_tiers');
SELECT erp.enable_audit('erp.price_tiers');
SELECT erp.enable_audit_log('erp.price_tiers');

CREATE TABLE erp.tax_codes (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  -- Basis points: 1700 = 17 % (ACC-09). Delux: one code at 0.
  rate_bp integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.tax_codes');
SELECT erp.enable_sync('erp.tax_codes');
SELECT erp.enable_audit('erp.tax_codes');
SELECT erp.enable_audit_log('erp.tax_codes');

-- How a device prints bills (D-055, POS-16). A device without its own profile uses the tenant default.
CREATE TABLE erp.print_profiles (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  name text NOT NULL,
  paper_format text NOT NULL CHECK (paper_format IN ('a4', 'a5', 'thermal_80', 'thermal_58')),
  code_type text NOT NULL CHECK (code_type IN ('barcode', 'signed_qr')),
  copies smallint NOT NULL CHECK (copies IN (1, 2)),
  -- Header lines, policy text, font size.
  template_options jsonb NOT NULL DEFAULT '{}',
  is_tenant_default boolean NOT NULL DEFAULT false,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX print_profiles_name_uq ON erp.print_profiles (tenant_id, lower(name));
CREATE UNIQUE INDEX print_profiles_one_default ON erp.print_profiles (tenant_id)
  WHERE is_tenant_default AND deleted_at IS NULL;
SELECT erp.enable_tenant_rls('erp.print_profiles');
SELECT erp.enable_sync('erp.print_profiles');
SELECT erp.enable_audit('erp.print_profiles');
SELECT erp.enable_audit_log('erp.print_profiles');

ALTER TABLE erp.devices ADD COLUMN print_profile_id uuid;
ALTER TABLE erp.devices ADD FOREIGN KEY (tenant_id, print_profile_id) REFERENCES erp.print_profiles (tenant_id, id);

CREATE TABLE erp.expense_categories (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  gl_account_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, gl_account_id) REFERENCES erp.accounts (tenant_id, id),
  UNIQUE (tenant_id, code)
);
SELECT erp.enable_tenant_rls('erp.expense_categories');
SELECT erp.enable_sync('erp.expense_categories');
SELECT erp.enable_audit('erp.expense_categories');
SELECT erp.enable_audit_log('erp.expense_categories');
