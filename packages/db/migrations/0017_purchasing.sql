-- 0017 Purchasing (W1-16; PUR-01, PUR-02, PUR-03, PUR-09; posting rules §5.1, §5.2, §6; data model §8). Goods
-- receipts and purchase returns are typed as drafts in the back office and posted once (rule 3): a posted one is never
-- changed, except by the pilot wipe before go-live (D-101), which runs as erp_owner. A supplier payment by bank is
-- posted when it is made. None of them is synced: the counters see only what posting changes (costs, floors).
-- Drafts have no number; posting takes the next one from `document_counters`, so abandoned drafts leave no gap.

CREATE TABLE erp.document_counters (
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  -- GR goods receipt, PR purchase return, SP supplier payment.
  family text NOT NULL CHECK (family IN ('GR', 'PR', 'SP')),
  last_no bigint NOT NULL DEFAULT 0 CHECK (last_no >= 0),
  PRIMARY KEY (tenant_id, family)
);
SELECT erp.enable_tenant_rls('erp.document_counters');

CREATE TABLE erp.goods_receipts (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  -- GR000001…, taken when it is posted.
  number text,
  branch_id uuid NOT NULL,
  supplier_party_id uuid,
  supplier_bill_no text,
  supplier_bill_date date,
  -- The day the goods came in: the posting's business date.
  business_date date NOT NULL,
  location_id uuid NOT NULL,
  -- Paid by bank with the receipt (owner answer 1 to W1-16); null = on the supplier's account (cash: at the desk).
  paid_from_bank_account_id uuid,
  -- Minor units. The bill total as printed on the supplier's bill; posting needs it to equal the lines (PUR-02).
  bill_discount bigint NOT NULL DEFAULT 0 CHECK (bill_discount >= 0),
  bill_total bigint CHECK (bill_total >= 0),
  -- Set when posted: the computed total and the due date (bill date + the supplier's terms).
  total bigint CHECK (total >= 0),
  due_date date,
  notes text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  posted_at timestamptz,
  -- Posting needs these on every source: no device, the exceptions raised.
  device_id uuid,
  exception_count integer NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  -- Counted up by every save of the draft, so a stale save is refused.
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  CHECK ((status = 'posted') = (posted_at IS NOT NULL)),
  CHECK (status = 'draft' OR (number IS NOT NULL AND total IS NOT NULL AND due_date IS NOT NULL
    AND supplier_party_id IS NOT NULL AND supplier_bill_no IS NOT NULL AND supplier_bill_date IS NOT NULL)),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_party_id) REFERENCES erp.parties (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES erp.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, paid_from_bank_account_id) REFERENCES erp.bank_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id)
);
CREATE INDEX goods_receipts_supplier_idx ON erp.goods_receipts (tenant_id, supplier_party_id, business_date);
SELECT erp.enable_tenant_rls('erp.goods_receipts');
SELECT erp.enable_audit('erp.goods_receipts');

CREATE TABLE erp.goods_receipt_lines (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id uuid,
  qty numeric(14, 3) NOT NULL,
  -- Minor units: the supplier's unit cost (up to 2 decimals, PUR-02) and the line's discount.
  unit_cost bigint NOT NULL CHECK (unit_cost >= 0),
  line_discount bigint NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  -- Set when posted: the line's exact net value, the bill discount spread into it (posting rules §5.1).
  value bigint CHECK (value >= 0),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES erp.goods_receipts (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id),
  UNIQUE (tenant_id, receipt_id, line_no),
  UNIQUE (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.goods_receipt_lines');

CREATE TABLE erp.purchase_returns (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  number text,
  branch_id uuid NOT NULL,
  supplier_party_id uuid,
  -- The receipt it returns from, where known (PRD W12).
  goods_receipt_id uuid,
  location_id uuid NOT NULL,
  business_date date NOT NULL,
  reason_code text CHECK (reason_code IN ('damaged', 'wrong_item', 'excess', 'poor_quality', 'price_dispute', 'other')),
  note text,
  -- Set when posted: Σ qty × unit cost, what the supplier is owed less.
  total bigint CHECK (total >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  posted_at timestamptz,
  device_id uuid,
  exception_count integer NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  row_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  CHECK ((status = 'posted') = (posted_at IS NOT NULL)),
  CHECK (status = 'draft' OR (number IS NOT NULL AND total IS NOT NULL AND supplier_party_id IS NOT NULL
    AND reason_code IS NOT NULL)),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_party_id) REFERENCES erp.parties (tenant_id, id),
  FOREIGN KEY (tenant_id, goods_receipt_id) REFERENCES erp.goods_receipts (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES erp.locations (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id)
);
CREATE INDEX purchase_returns_receipt_idx ON erp.purchase_returns (tenant_id, goods_receipt_id);
SELECT erp.enable_tenant_rls('erp.purchase_returns');
SELECT erp.enable_audit('erp.purchase_returns');

CREATE TABLE erp.purchase_return_lines (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  return_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id uuid,
  -- The receipt line it returns, when the return is linked to a receipt.
  receipt_line_id uuid,
  -- Positive: what goes back.
  qty numeric(14, 3) NOT NULL,
  -- Minor units: what the supplier takes it back for (normally the purchase cost, posting rules §5.2).
  unit_cost bigint NOT NULL CHECK (unit_cost >= 0),
  FOREIGN KEY (tenant_id, return_id) REFERENCES erp.purchase_returns (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_line_id) REFERENCES erp.goods_receipt_lines (tenant_id, id),
  UNIQUE (tenant_id, return_id, line_no)
);
CREATE INDEX purchase_return_lines_receipt_line_idx ON erp.purchase_return_lines (tenant_id, receipt_line_id);
SELECT erp.enable_tenant_rls('erp.purchase_return_lines');

CREATE TABLE erp.supplier_payments (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  number text NOT NULL,
  branch_id uuid NOT NULL,
  supplier_party_id uuid NOT NULL,
  bank_account_id uuid NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  business_date date NOT NULL,
  reference text,
  device_id uuid,
  exception_count integer NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_party_id) REFERENCES erp.parties (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES erp.bank_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  UNIQUE (tenant_id, number)
);
SELECT erp.enable_tenant_rls('erp.supplier_payments');
SELECT erp.enable_audit('erp.supplier_payments');
-- Posted when made; a mistake is a journal voucher (W1-19). Posting still counts its exceptions.
REVOKE DELETE ON erp.supplier_payments FROM erp_app;

-- A posted receipt or return is never changed or removed (rule 3); only erp_owner may, for the pilot wipe before
-- go-live (D-101). Posting may still count its exceptions on the header.
CREATE FUNCTION erp.guard_posted_purchase() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  doc uuid;
  posted boolean;
  bookkeeping text[] := ARRAY['exception_count', 'updated_at', 'updated_by_user_id'];
BEGIN
  IF current_user = 'erp_owner' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_TABLE_NAME IN ('goods_receipts', 'purchase_returns', 'supplier_payments') THEN
    -- A supplier payment is posted from the start; a receipt or return once its status says so.
    IF TG_TABLE_NAME = 'supplier_payments' THEN
      posted := true;
    ELSE
      posted := to_jsonb(OLD)->>'status' = 'posted';
    END IF;
    IF NOT posted THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - bookkeeping) = (to_jsonb(OLD) - bookkeeping) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '% % is posted and can''t be changed', TG_TABLE_NAME, OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'goods_receipt_lines' THEN
    doc := CASE WHEN TG_OP = 'INSERT' THEN NEW.receipt_id ELSE OLD.receipt_id END;
    SELECT r.status = 'posted' INTO posted FROM erp.goods_receipts r WHERE r.id = doc;
  ELSE
    doc := CASE WHEN TG_OP = 'INSERT' THEN NEW.return_id ELSE OLD.return_id END;
    SELECT r.status = 'posted' INTO posted FROM erp.purchase_returns r WHERE r.id = doc;
  END IF;
  -- Posting writes each receipt line's value in the transaction that posts it, before the header says posted.
  IF posted THEN
    RAISE EXCEPTION 'the document % is posted and can''t be changed', doc USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER guard_posted BEFORE UPDATE OR DELETE ON erp.goods_receipts
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_purchase();
CREATE TRIGGER guard_posted BEFORE INSERT OR UPDATE OR DELETE ON erp.goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_purchase();
CREATE TRIGGER guard_posted BEFORE UPDATE OR DELETE ON erp.purchase_returns
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_purchase();
CREATE TRIGGER guard_posted BEFORE INSERT OR UPDATE OR DELETE ON erp.purchase_return_lines
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_purchase();
CREATE TRIGGER guard_posted BEFORE UPDATE ON erp.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_purchase();

ALTER TABLE erp.postings DROP CONSTRAINT postings_source_type_check;
ALTER TABLE erp.postings ADD CONSTRAINT postings_source_type_check CHECK (source_type IN ('sale', 'cash_handover',
  'payment', 'cash_movement', 'cash_session', 'sales_void', 'opening', 'goods_receipt', 'purchase_return',
  'supplier_payment'));
