-- 0008 Sales documents and push sync (W1-07; SYN-02…SYN-06, PLT-09; data model §5, §10; sync spec §6.2–§8; D-094).
-- The server stores each pushed sale as it arrived (rules 3, 7), records what looks wrong as exceptions (SYN-03),
-- tracks each device's sequences for gaps and re-push (SYN-05) and its health (PLT-09), and nudges counters when a
-- pulled table changes (SYN-04).

-- Offline warnings on the counter (SYN-06, owner answer 1 to W1-07): set by the platform for now.
ALTER TABLE erp.tenants
  ADD COLUMN offline_warning_hours smallint NOT NULL DEFAULT 8 CHECK (offline_warning_hours > 0),
  ADD COLUMN offline_strong_warning_hours smallint NOT NULL DEFAULT 48,
  ADD CONSTRAINT tenants_offline_warnings_order CHECK (offline_strong_warning_hours > offline_warning_hours);

-- Re-enable (owner answer 3 to W1-07): the last revocation is kept, so documents made while revoked are flagged.
ALTER TABLE erp.devices
  ADD COLUMN last_revoked_at timestamptz,
  ADD COLUMN reenabled_at timestamptz,
  ADD COLUMN reenabled_by_user_id uuid;

-- Foreign keys from the sales tables stay inside the tenant.
ALTER TABLE erp.payment_methods ADD UNIQUE (tenant_id, id);
ALTER TABLE erp.locations ADD UNIQUE (tenant_id, id);

-- A finalized sale, return or exchange (data model §5). `id` is the device-made UUIDv7, the idempotency key (rule 7).
-- `payload` and `signature` are the document exactly as the device signed it (D-082). Corrections are new documents
-- (rule 3): only the handover status and, later, the void fields ever change.
CREATE TABLE erp.sales_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  number text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  kind text NOT NULL CHECK (kind IN ('sale', 'return', 'exchange')),
  status text NOT NULL DEFAULT 'finalized' CHECK (status IN ('finalized', 'voided')),
  business_date date NOT NULL,
  created_at_device timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  salesperson_user_id uuid NOT NULL,
  customer_party_id uuid,
  walkin_phone text,
  price_tier_id uuid NOT NULL,
  -- Minor units (rule 1). `total` and `cash_due` may be negative for a net refund.
  subtotal bigint NOT NULL,
  line_discount_total bigint NOT NULL,
  bill_discount bigint NOT NULL CHECK (bill_discount >= 0),
  rounding bigint NOT NULL,
  tax_total bigint NOT NULL,
  total bigint NOT NULL,
  cash_due bigint NOT NULL,
  handover_status text NOT NULL CHECK (handover_status IN ('not_applicable', 'pending', 'received', 'paid_out')),
  payload jsonb NOT NULL,
  payload_hash bytea NOT NULL,
  signature bytea NOT NULL,
  client_version text NOT NULL,
  exception_count integer NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  FOREIGN KEY (tenant_id, salesperson_user_id) REFERENCES erp.users (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_party_id) REFERENCES erp.parties (tenant_id, id),
  FOREIGN KEY (tenant_id, price_tier_id) REFERENCES erp.price_tiers (tenant_id, id),
  UNIQUE (tenant_id, id),
  -- Sales, returns and exchanges share the S series (architecture §4.4). The number follows from the device and seq;
  -- one that doesn't is accepted and flagged (document_inconsistent), so it isn't unique on its own.
  UNIQUE (tenant_id, device_id, seq)
);
CREATE INDEX sales_documents_number_idx ON erp.sales_documents (tenant_id, number);
CREATE INDEX sales_documents_day_idx ON erp.sales_documents (tenant_id, branch_id, business_date);
SELECT erp.enable_tenant_rls('erp.sales_documents');
SELECT erp.enable_sync('erp.sales_documents');
SELECT erp.enable_audit('erp.sales_documents');
REVOKE DELETE ON erp.sales_documents FROM erp_app;

CREATE TABLE erp.sales_lines (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  line_no smallint NOT NULL CHECK (line_no > 0),
  item_id uuid NOT NULL,
  -- + sold, − returned.
  qty numeric(14, 3) NOT NULL CHECK (qty <> 0),
  -- The tier price at the time of sale; null when the item had none.
  list_price bigint,
  unit_price bigint NOT NULL CHECK (unit_price >= 0),
  line_discount bigint NOT NULL,
  -- This line's part of the bill discount (allocated on the counter, sync spec §6.1).
  bill_share bigint NOT NULL,
  line_total bigint NOT NULL,
  -- The floor the counter judged the price by; null = unknown (D-092).
  floor_price_at_sale bigint,
  tax_code_id uuid,
  tax_amount bigint NOT NULL DEFAULT 0,
  -- The branch's SHOP location for a sale (data model §5).
  location_id uuid,
  -- Set by posting (W1-08).
  unit_cost bigint,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, document_id) REFERENCES erp.sales_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES erp.tax_codes (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES erp.locations (tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_id, line_no)
);
CREATE INDEX sales_lines_item_idx ON erp.sales_lines (tenant_id, item_id);
SELECT erp.enable_tenant_rls('erp.sales_lines');
SELECT erp.enable_sync('erp.sales_lines');
SELECT erp.enable_audit('erp.sales_lines');

CREATE TABLE erp.sales_payments (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  -- The order on the bill.
  line_no smallint NOT NULL CHECK (line_no > 0),
  method_id uuid NOT NULL,
  -- Negative for a refund.
  amount bigint NOT NULL,
  -- Cash only: what the customer handed over (null = exact) and the change printed on the bill.
  cash_received bigint,
  change_due bigint,
  reference text,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, document_id) REFERENCES erp.sales_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, method_id) REFERENCES erp.payment_methods (tenant_id, id),
  UNIQUE (tenant_id, document_id, line_no)
);
SELECT erp.enable_tenant_rls('erp.sales_payments');
SELECT erp.enable_sync('erp.sales_payments');
SELECT erp.enable_audit('erp.sales_payments');

-- Approvals on a document (POS spec §10, PLT-07), as the device recorded them; `line_id` null = the bill discount.
CREATE TABLE erp.overrides (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  line_id uuid,
  kind text NOT NULL CHECK (kind IN ('below_list', 'below_floor', 'credit_limit', 'offline_cap', 'no_receipt_return',
    'return_permission', 'return_outside_policy', 'void', 'reprint')),
  requested_by_user_id uuid NOT NULL,
  approved_by_user_id uuid NOT NULL,
  reason_code text NOT NULL,
  note text,
  values jsonb NOT NULL,
  at_device timestamptz NOT NULL,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, document_id) REFERENCES erp.sales_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, line_id) REFERENCES erp.sales_lines (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by_user_id) REFERENCES erp.users (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by_user_id) REFERENCES erp.users (tenant_id, id)
);
CREATE INDEX overrides_document_idx ON erp.overrides (tenant_id, document_id);
SELECT erp.enable_tenant_rls('erp.overrides');
SELECT erp.enable_sync('erp.overrides');
SELECT erp.enable_audit('erp.overrides');

-- What a finalized document is made of never changes (rule 3).
REVOKE UPDATE, DELETE ON erp.sales_lines, erp.sales_payments, erp.overrides FROM erp_app;

-- Every pushed document's result (sync spec §6.2): accepted ones are final and answer re-sends as duplicates; a
-- rejected one is checked again when it comes back. Rejected documents count as arrived for the gap check.
CREATE TABLE erp.sync_inbox (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  device_id uuid NOT NULL,
  family text NOT NULL CHECK (family IN ('S', 'H', 'R', 'M', 'Z')),
  seq integer NOT NULL CHECK (seq > 0),
  status text NOT NULL CHECK (status IN ('accepted', 'rejected')),
  result jsonb NOT NULL,
  payload_hash bytea NOT NULL,
  received_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, document_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id)
);
CREATE INDEX sync_inbox_series_idx ON erp.sync_inbox (tenant_id, device_id, family, seq);
SELECT erp.enable_tenant_rls('erp.sync_inbox');
REVOKE DELETE ON erp.sync_inbox FROM erp_app;

-- Exceptions for review (data model §10, RPT-10). Written on push; the report is W1-20.
CREATE TABLE erp.exceptions (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('below_floor_no_override', 'discount_over_limit', 'document_inconsistent',
    'credit_limit_exceeded', 'offline_cap_exceeded', 'negative_stock', 'missing_handover', 'handover_amount_mismatch',
    'cash_received_for_void', 'seq_gap', 'clock_skew', 'revoked_device_doc', 'bad_signature')),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  document_type text,
  document_id uuid,
  device_id uuid,
  user_id uuid,
  -- The tenant's business day it belongs to (clock skew is recorded once per device and day).
  business_date date NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id)
);
CREATE INDEX exceptions_open_idx ON erp.exceptions (tenant_id, status, business_date);
CREATE INDEX exceptions_document_idx ON erp.exceptions (tenant_id, document_id);
CREATE UNIQUE INDEX exceptions_clock_skew_daily ON erp.exceptions (tenant_id, device_id, business_date)
  WHERE kind = 'clock_skew';
SELECT erp.enable_tenant_rls('erp.exceptions');
SELECT erp.enable_audit('erp.exceptions');

-- What the server holds of each device's series: every seq from 1 to `through`, the highest seen (sync spec §7).
CREATE TABLE erp.device_series (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  family text NOT NULL CHECK (family IN ('S', 'H', 'R', 'M', 'Z')),
  through integer NOT NULL DEFAULT 0 CHECK (through >= 0),
  max_seq integer NOT NULL DEFAULT 0 CHECK (max_seq >= through),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, device_id, family),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.device_series');

-- Missing numbers (architecture §5.2), open until every seq in the range has arrived. Shown on device health.
CREATE TABLE erp.sequence_gaps (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  family text NOT NULL CHECK (family IN ('S', 'H', 'R', 'M', 'Z')),
  from_seq integer NOT NULL CHECK (from_seq > 0),
  to_seq integer NOT NULL CHECK (to_seq >= from_seq),
  opened_at timestamptz NOT NULL,
  resolved_at timestamptz,
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id)
);
CREATE INDEX sequence_gaps_open_idx ON erp.sequence_gaps (tenant_id, device_id) WHERE resolved_at IS NULL;
SELECT erp.enable_tenant_rls('erp.sequence_gaps');

-- Each device's last health snapshot (PLT-09, architecture §11.3): from every push, and pull times from pull.
CREATE TABLE erp.device_status (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  last_seen_at timestamptz NOT NULL,
  last_push_at timestamptz,
  last_pull_at timestamptz,
  client_version text,
  schema_version integer,
  outbox_count integer,
  oldest_unsynced_at timestamptz,
  quarantined_count integer,
  storage_persisted boolean,
  storage_usage bigint,
  storage_quota bigint,
  -- server time − the device's clock when it pushed.
  clock_skew_ms integer,
  PRIMARY KEY (tenant_id, device_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.device_status');

-- The SSE nudge (SYN-04, sync spec §8): one notice per changed tenant per statement on every pulled table, on the
-- 'erp_sync' channel. PostgreSQL folds identical notices in a transaction, so a large import is one notice.
CREATE FUNCTION erp.notify_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tenant text;
BEGIN
  FOR tenant IN EXECUTE format('SELECT DISTINCT %I::text FROM changed', TG_ARGV[0]) LOOP
    PERFORM pg_notify('erp_sync', tenant);
  END LOOP;
  RETURN NULL;
END $$;

CREATE FUNCTION erp.enable_sync_notify(tbl regclass, tenant_column text DEFAULT 'tenant_id') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER sync_notify_insert AFTER INSERT ON %s REFERENCING NEW TABLE AS changed '
    'FOR EACH STATEMENT EXECUTE FUNCTION erp.notify_sync(%L)', tbl, tenant_column);
  EXECUTE format('CREATE TRIGGER sync_notify_update AFTER UPDATE ON %s REFERENCING NEW TABLE AS changed '
    'FOR EACH STATEMENT EXECUTE FUNCTION erp.notify_sync(%L)', tbl, tenant_column);
END $$;

-- Every table a counter pulls (sync spec §3).
SELECT erp.enable_sync_notify('erp.tenants', 'id');
SELECT erp.enable_sync_notify(t) FROM unnest(ARRAY[
  'erp.branches', 'erp.users', 'erp.roles', 'erp.user_roles', 'erp.price_tiers', 'erp.units', 'erp.categories',
  'erp.brands', 'erp.origins', 'erp.vehicle_makes', 'erp.items', 'erp.item_identifiers', 'erp.item_compatibility',
  'erp.item_prices', 'erp.payment_methods', 'erp.print_profiles', 'erp.devices'
]::regclass[]) AS t;
