-- 0013 Hold, void and reissue (W1-12; POS-11; data model §5; posting rules §4.4; sync spec §6.2; POS spec §18; D-099).
-- A device's void of one of its bills (family V) as it pushes it (rules 3, 7), the void and reissue fields on the bill,
-- what posts a void, its exceptions, and no void window after the cash handover for any role (owner answer 1).

-- The void (family V): the counter's own document, matched to its bill by number, so it can arrive first (the bill
-- quarantined, say): `sale_document_id` is linked when the bill is here. A second void of a bill is kept with
-- `duplicate_of_id` and never posted. Only the link ever changes.
CREATE TABLE erp.sales_voids (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  number text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  sale_document_id uuid,
  sale_number text NOT NULL,
  voided_by_user_id uuid NOT NULL,
  approved_by_user_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('wrong_item', 'wrong_quantity', 'wrong_price',
    'wrong_customer_or_payment', 'duplicate_bill', 'customer_cancelled', 'other')),
  note text,
  -- What the counter knew of the bill's cash at the desk: never a handed-over bill (owner answer 1).
  handover_seen text NOT NULL CHECK (handover_seen IN ('pending', 'not_applicable', 'unknown')),
  at_device timestamptz NOT NULL,
  business_date date NOT NULL,
  received_at timestamptz NOT NULL,
  duplicate_of_id uuid,
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
  FOREIGN KEY (tenant_id, voided_by_user_id) REFERENCES erp.users (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by_user_id) REFERENCES erp.users (tenant_id, id),
  FOREIGN KEY (tenant_id, sale_document_id) REFERENCES erp.sales_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, duplicate_of_id) REFERENCES erp.sales_voids (tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, device_id, seq),
  CHECK (reason_code <> 'other' OR note IS NOT NULL)
);
-- One void per bill; a second one is a duplicate.
CREATE UNIQUE INDEX sales_voids_one_per_bill ON erp.sales_voids (tenant_id, sale_number) WHERE duplicate_of_id IS NULL;
CREATE INDEX sales_voids_unlinked_idx ON erp.sales_voids (tenant_id, sale_number) WHERE sale_document_id IS NULL;
SELECT erp.enable_tenant_rls('erp.sales_voids');
SELECT erp.enable_sync('erp.sales_voids');
SELECT erp.enable_audit('erp.sales_voids');
REVOKE DELETE ON erp.sales_voids FROM erp_app;

-- The bill's void (workflow fields, set once by the void, audited, data model §5) and the voided bill a reissue
-- replaces (from the reissue's own document, set at push).
ALTER TABLE erp.sales_documents
  ADD COLUMN void_document_id uuid,
  ADD COLUMN void_reason_code text,
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by_user_id uuid,
  ADD COLUMN void_approved_by_user_id uuid,
  ADD COLUMN reissue_of_id uuid,
  ADD COLUMN reissue_of_number text,
  ADD FOREIGN KEY (tenant_id, void_document_id) REFERENCES erp.sales_voids (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, voided_by_user_id) REFERENCES erp.users (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, void_approved_by_user_id) REFERENCES erp.users (tenant_id, id),
  ADD CHECK ((status = 'voided') = (void_document_id IS NOT NULL)),
  ADD CHECK ((void_document_id IS NULL) = (voided_at IS NULL));
CREATE INDEX sales_documents_reissue_idx ON erp.sales_documents (tenant_id, reissue_of_number)
  WHERE reissue_of_number IS NOT NULL;

-- Family V in the push bookkeeping (sync spec §6.2, §7): its claim, its series and its gaps, like every family.
ALTER TABLE erp.sync_inbox DROP CONSTRAINT sync_inbox_family_check;
ALTER TABLE erp.sync_inbox ADD CONSTRAINT sync_inbox_family_check CHECK (family IN ('S', 'H', 'R', 'M', 'Z', 'V'));
ALTER TABLE erp.device_series DROP CONSTRAINT device_series_family_check;
ALTER TABLE erp.device_series ADD CONSTRAINT device_series_family_check
  CHECK (family IN ('S', 'H', 'R', 'M', 'Z', 'V'));
ALTER TABLE erp.sequence_gaps DROP CONSTRAINT sequence_gaps_family_check;
ALTER TABLE erp.sequence_gaps ADD CONSTRAINT sequence_gaps_family_check
  CHECK (family IN ('S', 'H', 'R', 'M', 'Z', 'V'));

ALTER TABLE erp.postings DROP CONSTRAINT postings_source_type_check;
ALTER TABLE erp.postings ADD CONSTRAINT postings_source_type_check CHECK (source_type IN ('sale', 'cash_handover',
  'payment', 'cash_movement', 'cash_session', 'sales_void'));

ALTER TABLE erp.exceptions DROP CONSTRAINT exceptions_kind_check;
ALTER TABLE erp.exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind IN ('below_floor_no_override',
  'discount_over_limit', 'document_inconsistent', 'credit_limit_exceeded', 'offline_cap_exceeded', 'negative_stock',
  'missing_handover', 'handover_amount_mismatch', 'cash_received_for_void', 'seq_gap', 'clock_skew',
  'revoked_device_doc', 'bad_signature', 'no_cost', 'posting_failed', 'posted_after_lock', 'duplicate_handover',
  'handover_not_permitted', 'cash_not_permitted', 'float_mismatch', 'void_not_permitted', 'duplicate_void'));

-- BEGIN void-window
-- No role voids after the cash handover (owner answer 1 to W1-12): every role whose window is `same_day` (the Manager
-- and Owner templates, and roles copied from them) moves to `same_day_before_handover`. As in 0012, each tenant in its
-- own context, since the migration role is under the forced RLS and the change is audited per tenant.
ALTER TABLE erp.roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE erp.roles DISABLE ROW LEVEL SECURITY;
CREATE TEMPORARY TABLE void_window_tenants ON COMMIT DROP AS
  SELECT DISTINCT tenant_id FROM erp.roles WHERE limits->>'voidWindow' = 'same_day';
ALTER TABLE erp.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.roles FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM void_window_tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE erp.roles SET limits = jsonb_set(limits, '{voidWindow}', '"same_day_before_handover"')
    WHERE limits->>'voidWindow' = 'same_day';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
-- END void-window
