-- 0018 Stock operations (W1-18; INV-04, INV-05, INV-07; posting rules §5.3, §5.4; D-107). Transfers between locations
-- and stock adjustments, typed as drafts in the back office and posted once (rule 3), like purchasing (0017).
--
-- A transfer on a route that moves at once posts in one step. A transfer on a route that needs receiving is sent (out
-- of its location into the branch's In transit location) and later received (into its destination), each step its own
-- posting: the receipt posts under `receipt_id`. A shortfall on arrival becomes a loss adjustment out of In transit.
-- An adjustment whose losses are above the shop's limit waits for the owner's approval before it posts (owner answer
-- 3). None of them is synced: the counters see only the stock balances posting changes.

-- Stock on its way between locations (owner answer 4): one per branch, never sold from.
ALTER TABLE erp.locations DROP CONSTRAINT locations_kind_check;
ALTER TABLE erp.locations ADD CONSTRAINT locations_kind_check
  CHECK (kind IN ('shop', 'storage', 'damaged', 'transit'));
ALTER TABLE erp.locations ADD CONSTRAINT locations_transit_not_sellable CHECK (kind <> 'transit' OR NOT is_sellable);
CREATE UNIQUE INDEX locations_one_transit_uq ON erp.locations (tenant_id, branch_id)
  WHERE kind = 'transit' AND deleted_at IS NULL;

-- BEGIN transit-locations
-- Every branch there is gets its In transit location; a new tenant gets it from the tenant setup. As in 0016, each
-- tenant in its own context, since the migration role is under the forced RLS and the change is audited per tenant.
ALTER TABLE erp.branches NO FORCE ROW LEVEL SECURITY;
ALTER TABLE erp.branches DISABLE ROW LEVEL SECURITY;
CREATE TEMPORARY TABLE transit_branches ON COMMIT DROP AS SELECT tenant_id, id FROM erp.branches;
ALTER TABLE erp.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.branches FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  b record;
BEGIN
  FOR b IN SELECT tenant_id, id FROM transit_branches LOOP
    PERFORM set_config('app.tenant_id', b.tenant_id::text, true);
    INSERT INTO erp.locations (tenant_id, branch_id, code, name, kind, is_sellable)
    VALUES (b.tenant_id, b.id, 'TRANSIT', 'In transit', 'transit', false)
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
-- END transit-locations

-- BEGIN manager-transfer-post
-- Posting a transfer is the owner's and the manager's (owner answer 2): the Manager roles made from the template get
-- inv.transfer.post, as the template does. A purchaser keeps inv.transfer and types drafts only.
ALTER TABLE erp.roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE erp.roles DISABLE ROW LEVEL SECURITY;
CREATE TEMPORARY TABLE manager_transfer_tenants ON COMMIT DROP AS
  SELECT DISTINCT tenant_id FROM erp.roles
  WHERE template_key = 'manager' AND NOT 'inv.transfer.post' = ANY (permissions);
ALTER TABLE erp.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.roles FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM manager_transfer_tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE erp.roles SET permissions = array_append(permissions, 'inv.transfer.post')
    WHERE template_key = 'manager' AND NOT 'inv.transfer.post' = ANY (permissions);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
-- END manager-transfer-post

-- TR stock transfer, AD stock adjustment.
ALTER TABLE erp.document_counters DROP CONSTRAINT document_counters_family_check;
ALTER TABLE erp.document_counters ADD CONSTRAINT document_counters_family_check
  CHECK (family IN ('GR', 'PR', 'SP', 'TR', 'AD'));

-- Which routes need receiving (owner answer 4); a route with no row moves at once.
CREATE TABLE erp.transfer_routes (
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  from_location_id uuid NOT NULL,
  to_location_id uuid NOT NULL,
  needs_receiving boolean NOT NULL,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  PRIMARY KEY (tenant_id, from_location_id, to_location_id),
  CHECK (from_location_id <> to_location_id),
  FOREIGN KEY (tenant_id, from_location_id) REFERENCES erp.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, to_location_id) REFERENCES erp.locations (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.transfer_routes');
SELECT erp.enable_audit('erp.transfer_routes');

CREATE TABLE erp.stock_transfers (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  -- TR000001…, taken when it is posted (or sent).
  number text,
  branch_id uuid NOT NULL,
  from_location_id uuid NOT NULL,
  to_location_id uuid NOT NULL,
  -- The day it was moved (or sent): the posting's business date.
  business_date date NOT NULL,
  note text,
  -- draft → posted (moved at once), or draft → in_transit (sent) → received.
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'in_transit', 'received')),
  posted_at timestamptz,
  posted_by_user_id uuid,
  -- The receiving step: its own posting's source id, its day, who and when.
  receipt_id uuid UNIQUE,
  received_on date,
  received_at timestamptz,
  received_by_user_id uuid,
  device_id uuid,
  exception_count integer NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  -- A draft may say the same place twice (the check says why it can't post); a moved one never does.
  CHECK (status = 'draft' OR from_location_id <> to_location_id),
  CHECK ((status = 'draft') = (posted_at IS NULL)),
  CHECK (status = 'draft' OR number IS NOT NULL),
  CHECK ((status = 'received') = (receipt_id IS NOT NULL AND received_on IS NOT NULL AND received_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, from_location_id) REFERENCES erp.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, to_location_id) REFERENCES erp.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id)
);
CREATE INDEX stock_transfers_status_idx ON erp.stock_transfers (tenant_id, status, business_date);
SELECT erp.enable_tenant_rls('erp.stock_transfers');
SELECT erp.enable_audit('erp.stock_transfers');

CREATE TABLE erp.stock_transfer_lines (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id uuid,
  qty numeric(14, 3) NOT NULL,
  -- What arrived, set when a sent transfer is received; the rest is a shortfall.
  received_qty numeric(14, 3) CHECK (received_qty >= 0),
  FOREIGN KEY (tenant_id, transfer_id) REFERENCES erp.stock_transfers (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id),
  UNIQUE (tenant_id, transfer_id, line_no),
  UNIQUE (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.stock_transfer_lines');

CREATE TABLE erp.stock_adjustments (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  -- AD000001…, taken when it is posted.
  number text,
  branch_id uuid NOT NULL,
  location_id uuid NOT NULL,
  business_date date NOT NULL,
  reason_code text CHECK (reason_code IN ('found', 'lost', 'damaged', 'theft', 'count_correction', 'write_off',
    'other')),
  note text,
  -- The transfer whose shortfall on arrival it records.
  stock_transfer_id uuid,
  -- draft → posted, or draft → awaiting_approval → posted (or back to draft when rejected).
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'awaiting_approval', 'posted')),
  -- Minor units, at the average when it was put up for approval: what the owner approves.
  loss_value bigint CHECK (loss_value >= 0),
  submitted_at timestamptz,
  submitted_by_user_id uuid,
  approved_at timestamptz,
  approved_by_user_id uuid,
  -- The last rejection, shown on the draft it went back to.
  rejected_at timestamptz,
  rejected_by_user_id uuid,
  rejection_note text,
  posted_at timestamptz,
  posted_by_user_id uuid,
  device_id uuid,
  exception_count integer NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  CHECK ((status = 'posted') = (posted_at IS NOT NULL)),
  CHECK (status = 'draft' OR (number IS NOT NULL OR status = 'awaiting_approval')),
  CHECK (status = 'draft' OR reason_code IS NOT NULL),
  CHECK (status <> 'awaiting_approval' OR (loss_value IS NOT NULL AND submitted_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES erp.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, stock_transfer_id) REFERENCES erp.stock_transfers (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id)
);
CREATE INDEX stock_adjustments_status_idx ON erp.stock_adjustments (tenant_id, status, business_date);
SELECT erp.enable_tenant_rls('erp.stock_adjustments');
SELECT erp.enable_audit('erp.stock_adjustments');

CREATE TABLE erp.stock_adjustment_lines (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  adjustment_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id uuid,
  -- Above 0 = found (a gain), below 0 = gone (a loss).
  qty numeric(14, 3) NOT NULL,
  FOREIGN KEY (tenant_id, adjustment_id) REFERENCES erp.stock_adjustments (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id),
  UNIQUE (tenant_id, adjustment_id, line_no)
);
SELECT erp.enable_tenant_rls('erp.stock_adjustment_lines');

-- A posted transfer or adjustment is never changed or removed (rule 3); only erp_owner may, for the pilot wipe before
-- go-live (D-101). A sent transfer may still be received once; an adjustment awaiting approval may only be approved
-- (posted) or sent back to a draft, and its lines are fixed meanwhile, so the owner approves what will post.
CREATE FUNCTION erp.guard_posted_stock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  doc uuid;
  state text;
  bookkeeping text[] := ARRAY['exception_count', 'updated_at', 'updated_by_user_id'];
  receiving text[] := ARRAY['status', 'receipt_id', 'received_on', 'received_at', 'received_by_user_id',
    'row_version'];
BEGIN
  IF current_user = 'erp_owner' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_TABLE_NAME = 'stock_transfers' THEN
    IF OLD.status = 'draft' THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - bookkeeping) = (to_jsonb(OLD) - bookkeeping) THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'in_transit' AND NEW.status = 'received'
       AND (to_jsonb(NEW) - bookkeeping - receiving) = (to_jsonb(OLD) - bookkeeping - receiving) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'stock transfer % is posted and can''t be changed', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'stock_adjustments' THEN
    IF OLD.status = 'draft' THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - bookkeeping) = (to_jsonb(OLD) - bookkeeping) THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'awaiting_approval' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'stock adjustment % is posted and can''t be changed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'stock_transfer_lines' THEN
    doc := CASE WHEN TG_OP = 'INSERT' THEN NEW.transfer_id ELSE OLD.transfer_id END;
    SELECT t.status INTO state FROM erp.stock_transfers t WHERE t.id = doc;
    -- Receiving writes what arrived, and nothing else.
    IF state = 'in_transit' AND TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - 'received_qty') = (to_jsonb(OLD) - 'received_qty') THEN
      RETURN NEW;
    END IF;
  ELSE
    doc := CASE WHEN TG_OP = 'INSERT' THEN NEW.adjustment_id ELSE OLD.adjustment_id END;
    SELECT a.status INTO state FROM erp.stock_adjustments a WHERE a.id = doc;
  END IF;
  IF state IS DISTINCT FROM 'draft' AND state IS NOT NULL THEN
    RAISE EXCEPTION 'the document % is % and its lines can''t be changed', doc, state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER guard_posted BEFORE UPDATE OR DELETE ON erp.stock_transfers
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_stock();
CREATE TRIGGER guard_posted BEFORE INSERT OR UPDATE OR DELETE ON erp.stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_stock();
CREATE TRIGGER guard_posted BEFORE UPDATE OR DELETE ON erp.stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_stock();
CREATE TRIGGER guard_posted BEFORE INSERT OR UPDATE OR DELETE ON erp.stock_adjustment_lines
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_stock();

ALTER TABLE erp.postings DROP CONSTRAINT postings_source_type_check;
ALTER TABLE erp.postings ADD CONSTRAINT postings_source_type_check CHECK (source_type IN ('sale', 'cash_handover',
  'payment', 'cash_movement', 'cash_session', 'sales_void', 'opening', 'goods_receipt', 'purchase_return',
  'supplier_payment', 'stock_transfer', 'stock_transfer_receipt', 'stock_adjustment'));
