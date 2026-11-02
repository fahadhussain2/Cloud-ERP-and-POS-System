-- 0012 Cash desk 2 (W1-11; CSH-05…CSH-08, RPT-02; data model §6; posting rules §4.5; sync spec §3, §6.2; cash desk
-- spec; D-098). The desk's collections and cash-outs as it pushes them (rules 3, 7), the counted close on the session,
-- the safe as a system role, and what posts them.

-- 1130 Cash in safe gets its role (owner answer 3): what leaves the drawer at close, and the safe movements.
ALTER TABLE erp.accounts DROP CONSTRAINT accounts_system_role_check;
ALTER TABLE erp.accounts ADD CONSTRAINT accounts_system_role_check CHECK (system_role IN (
  'CASH_DRAWER', 'CASH_IN_TRANSIT', 'AR_CONTROL', 'AP_CONTROL', 'INVENTORY', 'COGS', 'SALES', 'SALES_RETURNS',
  'SALES_DISCOUNT', 'ROUNDING', 'CASH_SHORT_OVER', 'INVENTORY_ADJUSTMENT', 'PURCHASE_PRICE_VARIANCE',
  'OPENING_BALANCE_EQUITY', 'RETAINED_EARNINGS', 'TAX_PAYABLE', 'TAX_RECOVERABLE', 'SUSPENSE', 'CASH_SAFE'));
-- BEGIN cash-safe-role
-- The migration role is under the forced RLS too, and the change is audited per tenant: so each tenant in its own
-- context. RLS is lifted only to read which tenants have accounts.
ALTER TABLE erp.accounts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE erp.accounts DISABLE ROW LEVEL SECURITY;
CREATE TEMPORARY TABLE cash_safe_tenants ON COMMIT DROP AS SELECT DISTINCT tenant_id FROM erp.accounts;
ALTER TABLE erp.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.accounts FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM cash_safe_tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE erp.accounts a SET system_role = 'CASH_SAFE'
    WHERE a.code = '1130' AND a.is_postable AND a.system_role IS NULL
      AND NOT EXISTS (SELECT 1 FROM erp.accounts b WHERE b.tenant_id = a.tenant_id AND b.system_role = 'CASH_SAFE');
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
-- END cash-safe-role

-- A customer collection at the desk (family R, CSH-05). The back office's bank receipts and payments join it later
-- (W1-16, W1-19); a desk's supplier payment is a cash movement. Never changed once stored.
CREATE TABLE erp.payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  number text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  party_id uuid NOT NULL,
  method_id uuid NOT NULL,
  -- Minor units (rule 1): the posted figure.
  amount bigint NOT NULL CHECK (amount > 0),
  reference text,
  note text,
  -- No foreign key: a collection is never refused for its session (rule 7).
  session_id uuid NOT NULL,
  cashier_user_id uuid NOT NULL,
  at_device timestamptz NOT NULL,
  business_date date NOT NULL,
  received_at timestamptz NOT NULL,
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
  FOREIGN KEY (tenant_id, cashier_user_id) REFERENCES erp.users (tenant_id, id),
  FOREIGN KEY (tenant_id, method_id) REFERENCES erp.payment_methods (tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, device_id, seq)
);
-- No foreign key on the party either: a customer the server doesn't know yet is stored and fails to post (D-095).
CREATE INDEX payments_session_idx ON erp.payments (tenant_id, session_id);
CREATE INDEX payments_party_idx ON erp.payments (tenant_id, party_id, business_date);
SELECT erp.enable_tenant_rls('erp.payments');
SELECT erp.enable_sync('erp.payments');
SELECT erp.enable_audit('erp.payments');
REVOKE UPDATE, DELETE ON erp.payments FROM erp_app;

-- Cash out of the drawer, or between it and the safe (family M, CSH-06, owner answer 3). Never changed once stored.
CREATE TABLE erp.cash_movements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  number text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  kind text NOT NULL CHECK (kind IN ('expense', 'supplier_payment', 'bank_deposit', 'to_safe', 'from_safe')),
  amount bigint NOT NULL CHECK (amount > 0),
  -- Exactly the one its kind names; no foreign keys, so an unknown one is stored and fails to post (D-095).
  expense_category_id uuid,
  party_id uuid,
  bank_account_id uuid,
  note text,
  reference text,
  session_id uuid NOT NULL,
  cashier_user_id uuid NOT NULL,
  at_device timestamptz NOT NULL,
  business_date date NOT NULL,
  received_at timestamptz NOT NULL,
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
  FOREIGN KEY (tenant_id, cashier_user_id) REFERENCES erp.users (tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, device_id, seq),
  CHECK ((expense_category_id IS NOT NULL) = (kind = 'expense')),
  CHECK ((party_id IS NOT NULL) = (kind = 'supplier_payment')),
  CHECK ((bank_account_id IS NOT NULL) = (kind = 'bank_deposit'))
);
CREATE INDEX cash_movements_session_idx ON erp.cash_movements (tenant_id, session_id);
SELECT erp.enable_tenant_rls('erp.cash_movements');
SELECT erp.enable_sync('erp.cash_movements');
SELECT erp.enable_audit('erp.cash_movements');
REVOKE UPDATE, DELETE ON erp.cash_movements FROM erp_app;

-- The counted close (CSH-07, CashSessionV2): set by the close document; only the acknowledgement may come later, from
-- the back office (owner answer 1). A V1 close (W1-10) leaves the count empty.
ALTER TABLE erp.cash_sessions
  ADD COLUMN float_expected bigint CHECK (float_expected >= 0),
  ADD COLUMN counted_cash bigint CHECK (counted_cash >= 0),
  ADD COLUMN denominations jsonb,
  ADD COLUMN variance bigint,
  ADD COLUMN variance_reason_code text CHECK (variance_reason_code IN ('change_error', 'wrong_bill_confirmed',
    'unrecorded_cash_out', 'counterfeit_note', 'unknown', 'other')),
  ADD COLUMN variance_note text,
  ADD COLUMN left_in_drawer bigint CHECK (left_in_drawer >= 0),
  ADD COLUMN acknowledged_by_user_id uuid,
  ADD COLUMN acknowledged_at timestamptz,
  -- Exceptions on the open or the close (a posting that failed, a float mismatch, a close by someone not permitted).
  ADD COLUMN exception_count integer NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  ADD FOREIGN KEY (tenant_id, acknowledged_by_user_id) REFERENCES erp.users (tenant_id, id),
  ADD CHECK (variance IS NULL OR variance = counted_cash - expected_cash),
  ADD CHECK ((acknowledged_by_user_id IS NULL) = (acknowledged_at IS NULL));
CREATE INDEX cash_sessions_day_idx ON erp.cash_sessions (tenant_id, branch_id, business_date);

ALTER TABLE erp.postings DROP CONSTRAINT postings_source_type_check;
ALTER TABLE erp.postings ADD CONSTRAINT postings_source_type_check CHECK (source_type IN ('sale', 'cash_handover',
  'payment', 'cash_movement', 'cash_session'));

ALTER TABLE erp.exceptions DROP CONSTRAINT exceptions_kind_check;
ALTER TABLE erp.exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind IN ('below_floor_no_override',
  'discount_over_limit', 'document_inconsistent', 'credit_limit_exceeded', 'offline_cap_exceeded', 'negative_stock',
  'missing_handover', 'handover_amount_mismatch', 'cash_received_for_void', 'seq_gap', 'clock_skew',
  'revoked_device_doc', 'bad_signature', 'no_cost', 'posting_failed', 'posted_after_lock', 'duplicate_handover',
  'handover_not_permitted', 'cash_not_permitted', 'float_mismatch'));
