-- 0002 Tenants, branches and locations (W0-07; PLT-01, PLT-02; data model §2).

CREATE TABLE erp.tenants (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  name text NOT NULL,
  legal_name text,
  base_currency char(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  currency_minor_units smallint NOT NULL CHECK (currency_minor_units BETWEEN 0 AND 3),
  timezone text NOT NULL,
  locale text NOT NULL,
  fiscal_year_start_month smallint NOT NULL CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  fiscal_year_locked boolean NOT NULL DEFAULT false,
  tax_mode text NOT NULL DEFAULT 'none' CHECK (tax_mode IN ('none', 'inclusive', 'exclusive')),
  -- Minor units, e.g. 100 = Rs 1 (CLAUDE.md rule 1).
  cash_rounding_increment bigint NOT NULL DEFAULT 1 CHECK (cash_rounding_increment > 0),
  -- The business date rolls over at this hour; it must fall while the shop is closed (D-056).
  day_cutoff_hour smallint NOT NULL DEFAULT 4 CHECK (day_cutoff_hour BETWEEN 0 AND 23),
  closing_time time NOT NULL,
  cash_handover_mode text NOT NULL DEFAULT 'required' CHECK (cash_handover_mode IN ('required', 'off')),
  lock_date date,
  settings jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid
);
SELECT erp.enable_tenant_rls('erp.tenants', 'id');
SELECT erp.enable_sync('erp.tenants', 'id');
SELECT erp.enable_audit('erp.tenants');
-- New tenants come from the platform onboarding path (PLT-11), never from the app.
REVOKE INSERT ON erp.tenants FROM erp_app;

CREATE TABLE erp.branches (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  address text,
  phone text,
  receipt_header jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  UNIQUE (tenant_id, code),
  -- Lets child tables check that their branch belongs to the same tenant.
  UNIQUE (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.branches');
SELECT erp.enable_sync('erp.branches');
SELECT erp.enable_audit('erp.branches');

CREATE TABLE erp.locations (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('shop', 'storage', 'damaged')),
  is_sellable boolean NOT NULL,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  UNIQUE (tenant_id, branch_id, code),
  -- Damaged stock can never be sold (PLT-02).
  CHECK (kind <> 'damaged' OR NOT is_sellable)
);
SELECT erp.enable_tenant_rls('erp.locations');
SELECT erp.enable_sync('erp.locations');
SELECT erp.enable_audit('erp.locations');
