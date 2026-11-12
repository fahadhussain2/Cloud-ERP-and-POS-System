-- 0015 Opening balances and the cost floor (W1-14; MIG-02, MIG-04, CAT-06, INV-02; posting rules §7; migration doc
-- §4; data model §4, §7; sync spec §3; D-092, D-101). The opening is a document posted like any other (source
-- `opening`), so the ledgers stay rebuildable (rule 4): the importer writes a draft, replaces it on a re-run, and
-- posts it once. A posted opening is never changed (rule 3), except by the pilot wipe before go-live (owner answer 1
-- to W1-14), which runs as erp_owner. The cost floor (cost + the category's margin) is its own synced row per item,
-- so it moves with the average without touching `items` (rule 8).

CREATE TABLE erp.opening_balances (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  -- The dump's label (`dec2025`, `pilot`, `final`), one opening per label.
  label text NOT NULL CHECK (label ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  branch_id uuid NOT NULL,
  -- The legacy cutoff the figures are as of, and the date the opening posts on.
  as_of date NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  posted_at timestamptz,
  -- Posting needs these on every source: no device, the person who ran the import, the exceptions raised.
  device_id uuid,
  exception_count integer NOT NULL DEFAULT 0,
  -- Run details: dump file hashes, the importer's totals. Never personal data.
  legacy jsonb,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  CHECK ((status = 'posted') = (posted_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  UNIQUE (tenant_id, label),
  UNIQUE (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.opening_balances');
SELECT erp.enable_audit('erp.opening_balances');

CREATE TABLE erp.opening_balance_lines (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  opening_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  kind text NOT NULL CHECK (kind IN ('stock', 'customer', 'supplier', 'account')),
  item_id uuid,
  location_id uuid,
  qty numeric(14, 3),
  -- Minor units; null = no cost known (posted at the current average, else 0 with `no_cost`).
  unit_cost bigint CHECK (unit_cost >= 0),
  last_cost bigint CHECK (last_cost > 0),
  last_supplier_id uuid,
  last_receipt_at timestamptz,
  party_id uuid,
  account_id uuid,
  -- Minor units: a customer's > 0 is owed to us, a supplier's > 0 owed by us, an account's > 0 a debit.
  amount bigint,
  CHECK (CASE kind
    WHEN 'stock' THEN item_id IS NOT NULL AND location_id IS NOT NULL AND qty IS NOT NULL AND qty <> 0
      AND party_id IS NULL AND account_id IS NULL AND amount IS NULL
    WHEN 'account' THEN account_id IS NOT NULL AND amount IS NOT NULL AND amount <> 0 AND item_id IS NULL
      AND party_id IS NULL
    ELSE party_id IS NOT NULL AND amount IS NOT NULL AND amount <> 0 AND item_id IS NULL AND account_id IS NULL
  END),
  CHECK ((last_cost IS NULL) = (last_receipt_at IS NULL)),
  FOREIGN KEY (tenant_id, opening_id) REFERENCES erp.opening_balances (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES erp.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, last_supplier_id) REFERENCES erp.parties (tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES erp.parties (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES erp.accounts (tenant_id, id),
  UNIQUE (tenant_id, opening_id, line_no)
);
CREATE INDEX opening_balance_lines_opening_idx ON erp.opening_balance_lines (tenant_id, opening_id, line_no);
SELECT erp.enable_tenant_rls('erp.opening_balance_lines');

-- A posted opening is never changed or removed (rule 3); only erp_owner may, for the pilot wipe before go-live
-- (D-101), which also refuses once the tenant is live. Posting may still count its exceptions on the header.
CREATE FUNCTION erp.guard_posted_opening() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  opening uuid;
  bookkeeping text[] := ARRAY['exception_count', 'updated_at', 'updated_by_user_id'];
BEGIN
  IF current_user = 'erp_owner' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_TABLE_NAME = 'opening_balances' THEN
    opening := OLD.id;
    IF TG_OP = 'UPDATE' AND OLD.status = 'posted' AND (to_jsonb(NEW) - bookkeeping) = (to_jsonb(OLD) - bookkeeping) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    opening := NEW.opening_id;
  ELSE
    opening := OLD.opening_id;
  END IF;
  IF EXISTS (SELECT 1 FROM erp.opening_balances o WHERE o.id = opening AND o.status = 'posted') THEN
    RAISE EXCEPTION 'opening % is posted and can''t be changed', opening USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER guard_posted BEFORE UPDATE OR DELETE ON erp.opening_balances
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_opening();
CREATE TRIGGER guard_posted BEFORE INSERT OR UPDATE OR DELETE ON erp.opening_balance_lines
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_opening();

ALTER TABLE erp.postings DROP CONSTRAINT postings_source_type_check;
ALTER TABLE erp.postings ADD CONSTRAINT postings_source_type_check CHECK (source_type IN ('sale', 'cash_handover',
  'payment', 'cash_movement', 'cash_session', 'sales_void', 'opening'));

-- The floor from cost (CAT-06, PRD Q2, D-092): avg × (10,000 + the category's floor_min_margin_bp) / 10,000, written by
-- the posting layer whenever it sets an item's average, rewritten by the rebuild. Items without a cost floor have no
-- row, or a deleted one. Pulled by the counters; never shown there.
CREATE TABLE erp.item_floors (
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  floor bigint NOT NULL CHECK (floor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, item_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.item_floors');
SELECT erp.enable_sync('erp.item_floors');

-- Set by the final run (`erp-tenant go-live`): from then on the pilot wipe is refused (D-101).
ALTER TABLE erp.tenants ADD COLUMN go_live_at timestamptz;
