-- 0009 Posting (W1-08; INV-01, INV-02, INV-03, ACC-02, ACC-03, ACC-08, ACC-09; posting rules §1–§5; data model §3,
-- §4, §7, §9; architecture §7; D-017, D-095). The ledgers are derived from the documents by packages/posting only, in
-- the transaction that accepts each document (rule 4). The append-only ledgers can be added to, never changed, by the
-- app; the balances beside them are kept in place by the engine. `postings` records the order and the settings of
-- every posting, so a rebuild reproduces the ledgers exactly.

-- Bills that don't add up are posted with the difference on a suspense account (owner answer 3 to W1-08).
ALTER TABLE erp.accounts DROP CONSTRAINT accounts_system_role_check;
ALTER TABLE erp.accounts ADD CONSTRAINT accounts_system_role_check CHECK (system_role IN (
  'CASH_DRAWER', 'CASH_IN_TRANSIT', 'AR_CONTROL', 'AP_CONTROL', 'INVENTORY', 'COGS', 'SALES', 'SALES_RETURNS',
  'SALES_DISCOUNT', 'ROUNDING', 'CASH_SHORT_OVER', 'INVENTORY_ADJUSTMENT', 'PURCHASE_PRICE_VARIANCE',
  'OPENING_BALANCE_EQUITY', 'RETAINED_EARNINGS', 'TAX_PAYABLE', 'TAX_RECOVERABLE', 'SUSPENSE'));

-- An item without its own tax code uses the tenant's default (ACC-09). The tenant setup marks it.
ALTER TABLE erp.tax_codes ADD COLUMN is_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX tax_codes_one_default ON erp.tax_codes (tenant_id) WHERE is_default AND deleted_at IS NULL;

-- A finalized line is never updated (rule 3): its cost lives on its stock movement instead (D-095).
ALTER TABLE erp.sales_lines DROP COLUMN unit_cost;

ALTER TABLE erp.exceptions DROP CONSTRAINT exceptions_kind_check;
ALTER TABLE erp.exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind IN ('below_floor_no_override',
  'discount_over_limit', 'document_inconsistent', 'credit_limit_exceeded', 'offline_cap_exceeded', 'negative_stock',
  'missing_handover', 'handover_amount_mismatch', 'cash_received_for_void', 'seq_gap', 'clock_skew',
  'revoked_device_doc', 'bad_signature', 'no_cost', 'posting_failed', 'posted_after_lock'));
-- A document that keeps failing to post has one open exception, not one per attempt.
CREATE UNIQUE INDEX exceptions_posting_failed_once ON erp.exceptions (tenant_id, document_id)
  WHERE kind = 'posting_failed';

-- One row per tenant, locked by every posting: postings run one at a time, in this order (D-017).
CREATE TABLE erp.posting_state (
  tenant_id uuid PRIMARY KEY REFERENCES erp.tenants (id),
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_journal_no bigint NOT NULL DEFAULT 0 CHECK (last_journal_no >= 0)
);
SELECT erp.enable_tenant_rls('erp.posting_state');

-- The order of record (rule 4): every posting, with the settings it used (accounts, lock date, terms).
CREATE TABLE erp.postings (
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  seq bigint NOT NULL CHECK (seq > 0),
  source_type text NOT NULL CHECK (source_type IN ('sale')),
  source_id uuid NOT NULL,
  entry_date date NOT NULL,
  posted_at timestamptz NOT NULL,
  context jsonb NOT NULL,
  PRIMARY KEY (tenant_id, seq),
  UNIQUE (tenant_id, source_type, source_id)
);
SELECT erp.enable_tenant_rls('erp.postings');

CREATE TABLE erp.journal_entries (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  -- J000001, per tenant, from posting_state.
  number text NOT NULL,
  entry_date date NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  memo text,
  reversal_of_id uuid,
  posting_seq bigint NOT NULL,
  posted_at timestamptz NOT NULL,
  created_by_user_id uuid,
  FOREIGN KEY (tenant_id, posting_seq) REFERENCES erp.postings (tenant_id, seq),
  FOREIGN KEY (tenant_id, reversal_of_id) REFERENCES erp.journal_entries (tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number)
);
CREATE INDEX journal_entries_source_idx ON erp.journal_entries (tenant_id, source_type, source_id);
CREATE INDEX journal_entries_date_idx ON erp.journal_entries (tenant_id, entry_date);
SELECT erp.enable_tenant_rls('erp.journal_entries');

CREATE TABLE erp.journal_lines (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  line_no smallint NOT NULL CHECK (line_no > 0),
  account_id uuid NOT NULL,
  -- The customer or supplier on AR and AP lines (the sub-ledger).
  party_id uuid,
  branch_id uuid NOT NULL,
  -- Minor units (rule 1); exactly one side is above zero.
  debit bigint NOT NULL,
  credit bigint NOT NULL,
  memo text,
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0)),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES erp.journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES erp.accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES erp.parties (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  UNIQUE (tenant_id, entry_id, line_no)
);
CREATE INDEX journal_lines_account_idx ON erp.journal_lines (tenant_id, account_id);
CREATE INDEX journal_lines_party_idx ON erp.journal_lines (tenant_id, party_id) WHERE party_id IS NOT NULL;
SELECT erp.enable_tenant_rls('erp.journal_lines');

-- Every entry balances (posting rules §1.4), checked once all its lines are in: at commit.
CREATE FUNCTION erp.check_entry_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  debits bigint;
  credits bigint;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0) INTO debits, credits
  FROM erp.journal_lines WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.entry_id;
  IF debits <> credits THEN
    RAISE EXCEPTION 'journal entry % does not balance: debits %, credits %', NEW.entry_id, debits, credits
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON erp.journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION erp.check_entry_balance();

-- The stock ledger (INV-01, data model §7): quantity and value per item and location.
CREATE TABLE erp.stock_movements (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  posting_seq bigint NOT NULL,
  item_id uuid NOT NULL,
  location_id uuid NOT NULL,
  qty_delta numeric(14, 3) NOT NULL CHECK (qty_delta <> 0),
  -- Minor units: the average the line was valued at (0 when no cost was known), and qty × it.
  unit_cost bigint NOT NULL CHECK (unit_cost >= 0),
  value_delta bigint NOT NULL,
  -- The item's average after this movement; null while no cost is known.
  avg_cost_after bigint,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  source_line_id uuid,
  -- The posting's entry date.
  business_date date NOT NULL,
  posted_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, posting_seq) REFERENCES erp.postings (tenant_id, seq),
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES erp.locations (tenant_id, id)
);
CREATE INDEX stock_movements_item_idx ON erp.stock_movements (tenant_id, item_id, posting_seq);
CREATE INDEX stock_movements_source_idx ON erp.stock_movements (tenant_id, source_type, source_id);
SELECT erp.enable_tenant_rls('erp.stock_movements');

-- Quantity per item and location (INV-01); pulled by the counters later.
CREATE TABLE erp.stock_balances (
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  location_id uuid NOT NULL,
  qty numeric(14, 3) NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, item_id, location_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES erp.locations (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.stock_balances');
SELECT erp.enable_sync('erp.stock_balances');

-- One weighted average per item, tenant-wide (INV-02, D-017). `avg_cost` null = no cost known yet.
CREATE TABLE erp.item_costs (
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  avg_cost bigint CHECK (avg_cost >= 0),
  on_hand numeric(14, 3) NOT NULL DEFAULT 0,
  last_cost bigint CHECK (last_cost >= 0),
  last_supplier_id uuid,
  last_receipt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id),
  FOREIGN KEY (tenant_id, last_supplier_id) REFERENCES erp.parties (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.item_costs');

-- Customer and supplier sub-ledgers (ACC-03, data model §3). `amount` > 0 = owed more.
CREATE TABLE erp.party_ledger_entries (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  posting_seq bigint NOT NULL,
  party_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('customer', 'supplier')),
  entry_date date NOT NULL,
  due_date date NOT NULL,
  amount bigint NOT NULL CHECK (amount <> 0),
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  memo text,
  posted_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, posting_seq) REFERENCES erp.postings (tenant_id, seq),
  FOREIGN KEY (tenant_id, party_id) REFERENCES erp.parties (tenant_id, id)
);
CREATE INDEX party_ledger_entries_party_idx ON erp.party_ledger_entries (tenant_id, party_id, role, entry_date);
CREATE INDEX party_ledger_entries_source_idx ON erp.party_ledger_entries (tenant_id, source_type, source_id);
SELECT erp.enable_tenant_rls('erp.party_ledger_entries');

-- What each party owes or is owed (pulled for customers in W1-09).
CREATE TABLE erp.party_balances (
  tenant_id uuid NOT NULL,
  party_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('customer', 'supplier')),
  balance bigint NOT NULL,
  updated_at timestamptz NOT NULL,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, party_id, role),
  FOREIGN KEY (tenant_id, party_id) REFERENCES erp.parties (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.party_balances');
SELECT erp.enable_sync('erp.party_balances');

-- The app adds ledger rows and never changes them (rule 4); a rebuild runs as erp_owner.
REVOKE UPDATE, DELETE ON erp.postings, erp.journal_entries, erp.journal_lines, erp.stock_movements,
  erp.party_ledger_entries FROM erp_app;
