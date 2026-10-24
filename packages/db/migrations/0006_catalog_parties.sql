-- 0006 Catalog and parties: units, categories, brands, origins, vehicle makes, items with identifiers, vehicle
-- tags and tier prices; parties with customer and supplier accounts (W0-13; CAT-01…CAT-04; data model §3, §4;
-- D-014, D-019, D-085). `legacy` keeps the original keys of imported rows (migration doc §2).

CREATE TABLE erp.units (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  allows_fraction boolean NOT NULL DEFAULT false,
  legacy jsonb,
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

CREATE TABLE erp.categories (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  parent_id uuid,
  -- { tier_markups_bp: {...}, floor_min_margin_bp } (CAT-05, CAT-06)
  pricing_rule jsonb NOT NULL DEFAULT '{}',
  -- { returnable, window_days } (PRD Q3)
  return_policy jsonb NOT NULL DEFAULT '{}',
  legacy jsonb,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, parent_id) REFERENCES erp.categories (tenant_id, id),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE erp.brands (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  name text NOT NULL,
  legacy jsonb,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX brands_name_uq ON erp.brands (tenant_id, lower(name));

-- Country of origin (JAPAN, CHINA, TAIWAN…).
CREATE TABLE erp.origins (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  name text NOT NULL,
  legacy jsonb,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX origins_name_uq ON erp.origins (tenant_id, lower(name));

CREATE TABLE erp.vehicle_makes (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  name text NOT NULL,
  legacy jsonb,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX vehicle_makes_name_uq ON erp.vehicle_makes (tenant_id, lower(name));

-- One party can be a customer, a supplier or both (data model §3). Walk-in customers are not parties.
CREATE TABLE erp.parties (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  contact_person text,
  phones text[] NOT NULL DEFAULT '{}',
  email text,
  address text,
  city text,
  country text,
  -- NTN / TRN
  tax_id text,
  -- Printed on labels (D-019), e.g. ADDI.
  label_abbr text,
  notes text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  legacy jsonb,
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

CREATE TABLE erp.customer_accounts (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  party_id uuid NOT NULL,
  price_tier_id uuid NOT NULL,
  credit_allowed boolean NOT NULL DEFAULT false,
  -- Minor units; NULL = no limit (D-085).
  credit_limit bigint CHECK (credit_limit >= 0),
  -- Extra cap per day while a counter is offline (D-013, PRD Q6).
  offline_daily_cap bigint NOT NULL CHECK (offline_daily_cap >= 0),
  payment_terms_days smallint CHECK (payment_terms_days >= 0),
  legacy jsonb,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, party_id) REFERENCES erp.parties (tenant_id, id),
  FOREIGN KEY (tenant_id, price_tier_id) REFERENCES erp.price_tiers (tenant_id, id),
  UNIQUE (tenant_id, party_id)
);

CREATE TABLE erp.supplier_accounts (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  party_id uuid NOT NULL,
  payment_terms_days smallint CHECK (payment_terms_days >= 0),
  default_lead_days smallint CHECK (default_lead_days >= 0),
  legacy jsonb,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, party_id) REFERENCES erp.parties (tenant_id, id),
  UNIQUE (tenant_id, party_id)
);

CREATE TABLE erp.items (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  -- Unique and scannable; legacy codes are kept exactly (shelf labels encode them).
  code text NOT NULL,
  name text NOT NULL,
  category_id uuid NOT NULL,
  brand_id uuid,
  origin_id uuid,
  unit_id uuid NOT NULL,
  -- Position or size: R/H, L/H, FRONT, SET…
  variant text,
  -- Non-vehicle spec: 6PK, H4, 6203…
  spec text,
  bin_location text,
  default_supplier_id uuid,
  min_qty numeric(14, 3),
  max_qty numeric(14, 3),
  exclude_from_reorder boolean NOT NULL DEFAULT false,
  -- Minor units; NULL = the category rule (CAT-05).
  floor_price bigint CHECK (floor_price >= 0),
  -- NULL = the tenant default.
  tax_code_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dormant', 'discontinued')),
  legacy jsonb,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, category_id) REFERENCES erp.categories (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id) REFERENCES erp.brands (tenant_id, id),
  FOREIGN KEY (tenant_id, origin_id) REFERENCES erp.origins (tenant_id, id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES erp.units (tenant_id, id),
  FOREIGN KEY (tenant_id, default_supplier_id) REFERENCES erp.parties (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES erp.tax_codes (tenant_id, id),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE erp.item_identifiers (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('barcode', 'oem', 'alternate', 'supplier_ref')),
  value text NOT NULL,
  -- Upper case without spaces, -, / and . (data model §4); what search matches.
  normalized_value text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  legacy jsonb,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id)
);
-- A barcode identifies one item; OEM and alternate numbers may repeat (alternatives).
CREATE UNIQUE INDEX item_identifiers_barcode_uq ON erp.item_identifiers (tenant_id, normalized_value)
  WHERE kind = 'barcode' AND deleted_at IS NULL;
CREATE INDEX item_identifiers_search_idx ON erp.item_identifiers (tenant_id, normalized_value);
CREATE INDEX item_identifiers_item_idx ON erp.item_identifiers (tenant_id, item_id);

-- A light vehicle tag (D-014): make, model, years.
CREATE TABLE erp.item_compatibility (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  make_id uuid,
  model text,
  year_from smallint,
  year_to smallint,
  note text,
  legacy jsonb,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id),
  FOREIGN KEY (tenant_id, make_id) REFERENCES erp.vehicle_makes (tenant_id, id),
  CHECK (year_to IS NULL OR year_from IS NULL OR year_from <= year_to)
);
CREATE INDEX item_compatibility_item_idx ON erp.item_compatibility (tenant_id, item_id);

CREATE TABLE erp.item_prices (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  tier_id uuid NOT NULL,
  -- Minor units (CLAUDE.md rule 1).
  price bigint NOT NULL CHECK (price >= 0),
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id),
  FOREIGN KEY (tenant_id, tier_id) REFERENCES erp.price_tiers (tenant_id, id),
  UNIQUE (tenant_id, item_id, tier_id)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['units', 'categories', 'brands', 'origins', 'vehicle_makes', 'parties',
    'customer_accounts', 'supplier_accounts', 'items', 'item_identifiers', 'item_compatibility', 'item_prices']
  LOOP
    PERFORM erp.enable_tenant_rls(format('erp.%I', t)::regclass);
    PERFORM erp.enable_sync(format('erp.%I', t)::regclass);
    PERFORM erp.enable_audit(format('erp.%I', t)::regclass);
    PERFORM erp.enable_audit_log(format('erp.%I', t)::regclass);
  END LOOP;
END $$;
