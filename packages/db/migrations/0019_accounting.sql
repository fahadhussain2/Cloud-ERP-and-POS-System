-- 0019 Back-office accounting (W1-19; ACC-04, ACC-05, ACC-06; posting rules §6; D-108). Customer receipts by bank,
-- expenses and transfers between banks, wallets, card settlement and the safe, posted when saved; journal vouchers,
-- typed as drafts and posted once. A reversal is a posted journal voucher that names the document it reverses (one
-- reversal per document, never edited). The periods are computed from the fiscal year start month: the lock date on
-- `tenants` is the only record (owner answer 5). None of them is synced: the counters see only the party balances
-- posting changes.

-- CR customer receipt, EX expense, FT fund transfer, JV journal voucher.
ALTER TABLE erp.document_counters DROP CONSTRAINT document_counters_family_check;
ALTER TABLE erp.document_counters ADD CONSTRAINT document_counters_family_check
  CHECK (family IN ('GR', 'PR', 'SP', 'TR', 'AD', 'CR', 'EX', 'FT', 'JV'));

-- BEGIN accountant-chart-edit
-- The accountant adds accounts and expense categories (owner answer 4): the Accountant roles made from the template
-- get acc.chart.edit, as the template does. Reopening a period (acc.period.reopen) is the owner's only.
ALTER TABLE erp.roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE erp.roles DISABLE ROW LEVEL SECURITY;
CREATE TEMPORARY TABLE accountant_chart_tenants ON COMMIT DROP AS
  SELECT DISTINCT tenant_id FROM erp.roles
  WHERE template_key = 'accountant' AND NOT 'acc.chart.edit' = ANY (permissions);
ALTER TABLE erp.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.roles FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM accountant_chart_tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE erp.roles SET permissions = array_append(permissions, 'acc.chart.edit')
    WHERE template_key = 'accountant' AND NOT 'acc.chart.edit' = ANY (permissions);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
-- END accountant-chart-edit

-- Expenses and transfer charges name their category by tenant (as every tenant foreign key does).
ALTER TABLE erp.expense_categories ADD CONSTRAINT expense_categories_tenant_id_id_key UNIQUE (tenant_id, id);

-- A customer's payment into a bank account (posting rules §6): Dr the bank / Cr AR_CONTROL (the customer).
CREATE TABLE erp.customer_receipts (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  number text NOT NULL,
  branch_id uuid NOT NULL,
  customer_party_id uuid NOT NULL,
  bank_account_id uuid NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  business_date date NOT NULL,
  reference text,
  note text,
  device_id uuid,
  exception_count integer NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_party_id) REFERENCES erp.parties (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_account_id) REFERENCES erp.bank_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id)
);
CREATE INDEX customer_receipts_date_idx ON erp.customer_receipts (tenant_id, business_date);
SELECT erp.enable_tenant_rls('erp.customer_receipts');
SELECT erp.enable_audit('erp.customer_receipts');

-- An expense paid from a bank account, or from the safe (no bank account): Dr the category's account / Cr the bank or
-- CASH_SAFE. An expense from the drawer is the desk's cash-out (W1-11).
CREATE TABLE erp.expenses (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  number text NOT NULL,
  branch_id uuid NOT NULL,
  expense_category_id uuid NOT NULL,
  paid_from_bank_account_id uuid,
  amount bigint NOT NULL CHECK (amount > 0),
  business_date date NOT NULL,
  reference text,
  note text,
  device_id uuid,
  exception_count integer NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, expense_category_id) REFERENCES erp.expense_categories (tenant_id, id),
  FOREIGN KEY (tenant_id, paid_from_bank_account_id) REFERENCES erp.bank_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id)
);
CREATE INDEX expenses_date_idx ON erp.expenses (tenant_id, business_date);
SELECT erp.enable_tenant_rls('erp.expenses');
SELECT erp.enable_audit('erp.expenses');

-- Money between banks, wallets, card settlement and the safe (no bank account = the safe), with the fee taken on the
-- way (owner answer 6): Dr to (amount − charges), Dr the charges' category account / Cr from (amount).
CREATE TABLE erp.fund_transfers (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  number text NOT NULL,
  branch_id uuid NOT NULL,
  from_bank_account_id uuid,
  to_bank_account_id uuid,
  amount bigint NOT NULL CHECK (amount > 0),
  charges bigint NOT NULL DEFAULT 0,
  charges_category_id uuid,
  business_date date NOT NULL,
  reference text,
  note text,
  device_id uuid,
  exception_count integer NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  CHECK (from_bank_account_id IS DISTINCT FROM to_bank_account_id),
  CHECK (charges >= 0 AND charges < amount),
  CHECK ((charges > 0) = (charges_category_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, from_bank_account_id) REFERENCES erp.bank_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, to_bank_account_id) REFERENCES erp.bank_accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, charges_category_id) REFERENCES erp.expense_categories (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id)
);
CREATE INDEX fund_transfers_date_idx ON erp.fund_transfers (tenant_id, business_date);
SELECT erp.enable_tenant_rls('erp.fund_transfers');
SELECT erp.enable_audit('erp.fund_transfers');

-- A journal voucher (ACC-05): a draft (no number), then posted once. A reversal names what it reverses and has no
-- lines of its own: its posting swaps the original's journal.
CREATE TABLE erp.journal_vouchers (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  -- JV000001…, taken when it is posted.
  number text,
  branch_id uuid NOT NULL,
  business_date date NOT NULL,
  narration text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  reverses_type text CHECK (reverses_type IN ('customer_receipt', 'expense', 'fund_transfer', 'supplier_payment',
    'journal_voucher')),
  reverses_id uuid,
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
  CHECK (status = 'draft' OR number IS NOT NULL),
  CHECK ((reverses_type IS NULL) = (reverses_id IS NULL)),
  -- A reversal is posted when it is made.
  CHECK (reverses_id IS NULL OR status = 'posted'),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, id)
);
-- A document is reversed at most once.
CREATE UNIQUE INDEX journal_vouchers_reverses_uq ON erp.journal_vouchers (tenant_id, reverses_type, reverses_id)
  WHERE reverses_id IS NOT NULL;
CREATE INDEX journal_vouchers_status_idx ON erp.journal_vouchers (tenant_id, status, business_date);
SELECT erp.enable_tenant_rls('erp.journal_vouchers');
SELECT erp.enable_audit('erp.journal_vouchers');

CREATE TABLE erp.journal_voucher_lines (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  voucher_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  account_id uuid,
  party_id uuid,
  debit bigint NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo text,
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES erp.journal_vouchers (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES erp.accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES erp.parties (tenant_id, id),
  UNIQUE (tenant_id, voucher_id, line_no)
);
SELECT erp.enable_tenant_rls('erp.journal_voucher_lines');

-- A posted document is never changed or removed (rule 3; a mistake is reversed); only erp_owner may, for the pilot
-- wipe before go-live (D-101). Receipts, expenses and transfers are posted from the start; a voucher once its status
-- says so, and its lines with it. Posting may still count its exceptions.
CREATE FUNCTION erp.guard_posted_accounting() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  doc uuid;
  posted boolean;
  bookkeeping text[] := ARRAY['exception_count', 'updated_at', 'updated_by_user_id'];
BEGIN
  IF current_user = 'erp_owner' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_TABLE_NAME = 'journal_voucher_lines' THEN
    doc := CASE WHEN TG_OP = 'INSERT' THEN NEW.voucher_id ELSE OLD.voucher_id END;
    SELECT v.status = 'posted' INTO posted FROM erp.journal_vouchers v WHERE v.id = doc;
    IF posted THEN
      RAISE EXCEPTION 'journal voucher % is posted and its lines can''t be changed', doc
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  posted := TG_TABLE_NAME <> 'journal_vouchers' OR to_jsonb(OLD)->>'status' = 'posted';
  IF NOT posted THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - bookkeeping) = (to_jsonb(OLD) - bookkeeping) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% % is posted and can''t be changed', TG_TABLE_NAME, OLD.id USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER guard_posted BEFORE UPDATE OR DELETE ON erp.customer_receipts
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_accounting();
CREATE TRIGGER guard_posted BEFORE UPDATE OR DELETE ON erp.expenses
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_accounting();
CREATE TRIGGER guard_posted BEFORE UPDATE OR DELETE ON erp.fund_transfers
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_accounting();
CREATE TRIGGER guard_posted BEFORE UPDATE OR DELETE ON erp.journal_vouchers
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_accounting();
CREATE TRIGGER guard_posted BEFORE INSERT OR UPDATE OR DELETE ON erp.journal_voucher_lines
  FOR EACH ROW EXECUTE FUNCTION erp.guard_posted_accounting();
REVOKE DELETE ON erp.customer_receipts, erp.expenses, erp.fund_transfers FROM erp_app;

ALTER TABLE erp.postings DROP CONSTRAINT postings_source_type_check;
ALTER TABLE erp.postings ADD CONSTRAINT postings_source_type_check CHECK (source_type IN ('sale', 'cash_handover',
  'payment', 'cash_movement', 'cash_session', 'sales_void', 'opening', 'goods_receipt', 'purchase_return',
  'supplier_payment', 'stock_transfer', 'stock_transfer_receipt', 'stock_adjustment', 'customer_receipt', 'expense',
  'fund_transfer', 'journal_voucher'));
